'use strict';

// Devin's native history keeps tool calls but drops provider reasoning state
// (Anthropic thinking signatures, OpenAI encrypted reasoning items). We keep
// that state locally, keyed by the tool call ids of the turn that produced it,
// and splice it back when the same provider + model sees that turn again.
// A miss (restart, compaction, different model) degrades to the old behaviour.

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_ITEM_BYTES = 256 * 1024;
// Provider-issued ids (toolu_…, call_…) are long random strings. Short ids such
// as `call_0` are minted per conversation by some gateways and would collide
// across chats, so their reasoning is never stored or replayed.
const MIN_TOOL_ID_LENGTH = 16;

const distinctive = id => typeof id === 'string' && id.length >= MIN_TOOL_ID_LENGTH;

function replayScope(provider = {}, route = {}) {
  const owner = provider.id || provider.baseUrl || '';
  return owner && route.model ? `${owner}\u0000${route.model}` : '';
}

function createReplayStore({ maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const entries = new Map();
  const disabled = new Set();
  let bytes = 0;
  const key = (scope, id) => `${scope}\u0000${id}`;
  const remove = k => {
    const entry = entries.get(k);
    if (!entry) return;
    bytes -= entry.bytes;
    entries.delete(k);
  };
  return {
    save(scope, toolIds, items) {
      if (!scope || disabled.has(scope) || !items?.length) return;
      const ids = (toolIds || []).filter(distinctive);
      if (!ids.length) return;
      const frozen = Object.freeze(items.map(item => Object.freeze({ ...item })));
      const size = Buffer.byteLength(JSON.stringify(frozen));
      if (size > maxBytes) return;
      for (const id of ids) {
        const k = key(scope, id);
        remove(k);
        entries.set(k, { items: frozen, bytes: size });
        bytes += size;
      }
      while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys().next().value);
    },
    lookup(scope, toolIds) {
      if (!scope || disabled.has(scope) || !distinctive(toolIds?.[0])) return [];
      const found = entries.get(key(scope, toolIds[0]));
      return found ? [...found.items] : [];
    },
    // Called when the provider rejects replayed state; stops sending it for this
    // provider + model until the plugin restarts.
    disable(scope) {
      if (!scope) return;
      disabled.add(scope);
      for (const k of [...entries.keys()]) if (k.startsWith(`${scope}\u0000`)) remove(k);
    },
    isDisabled(scope) { return disabled.has(scope); },
    get size() { return entries.size; },
    get bytes() { return bytes; },
  };
}

// Per-request view: returns each saved item at most once, so a response whose
// tool calls Devin splits across several assistant messages is replayed once.
function replayReader(replay, scope) {
  const seen = new Set();
  return toolIds => {
    if (!replay || !toolIds?.length) return [];
    return replay.lookup(scope, toolIds).filter(item => {
      const id = item.id || item.signature || item.data || JSON.stringify(item);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  };
}

const sizeOk = item => Buffer.byteLength(JSON.stringify(item)) <= MAX_ITEM_BYTES;

function anthropicCapture() {
  const blocks = new Map();
  const toolIds = [];
  return {
    observe(event) {
      const data = event?.data;
      if (!data) return;
      const index = data.index ?? 0;
      if (event.type === 'content_block_start') {
        const block = data.content_block || {};
        if (block.type === 'thinking') blocks.set(index, { type: 'thinking', thinking: block.thinking || '', signature: block.signature || '' });
        else if (block.type === 'redacted_thinking' && block.data) blocks.set(index, { type: 'redacted_thinking', data: block.data });
        else if (block.type === 'tool_use' && block.id) toolIds.push(block.id);
      } else if (event.type === 'content_block_delta') {
        const block = blocks.get(index);
        const delta = data.delta || {};
        if (!block || block.type !== 'thinking') return;
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') blocks.set(index, { ...block, thinking: block.thinking + delta.thinking });
        if (delta.type === 'signature_delta' && typeof delta.signature === 'string') blocks.set(index, { ...block, signature: block.signature + delta.signature });
      }
    },
    result() {
      const items = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block)
        .filter(block => (block.type === 'redacted_thinking' || block.signature) && sizeOk(block));
      return { toolIds: [...toolIds], items };
    },
  };
}

function responsesCapture() {
  const reasoning = new Map();
  const toolIds = new Set();
  const take = item => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'reasoning' && item.id && typeof item.encrypted_content === 'string' && item.encrypted_content) {
      const kept = { type: 'reasoning', id: item.id, summary: Array.isArray(item.summary) ? item.summary : [], encrypted_content: item.encrypted_content };
      if (sizeOk(kept)) reasoning.set(item.id, kept);
    } else if (item.type === 'function_call' && (item.call_id || item.id)) {
      toolIds.add(item.call_id || item.id);
    }
  };
  return {
    observe(event) {
      const data = event?.data;
      if (!data) return;
      if (event.type === 'response.output_item.done') take(data.item);
      else if (event.type === 'response.completed') for (const item of data.response?.output || []) take(item);
    },
    result() { return { toolIds: [...toolIds], items: [...reasoning.values()] }; },
  };
}

const defaultStore = createReplayStore();

module.exports = { replayScope, createReplayStore, replayReader, anthropicCapture, responsesCapture, defaultStore };
