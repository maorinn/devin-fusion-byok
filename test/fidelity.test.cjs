'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { s, v, m } = require('../src/protocol/wire.cjs');
const { parseChat } = require('../src/protocol/chat.cjs');
const { serveChat, buildRequestBody } = require('../src/protocol/responses.cjs');
const { replayScope, createReplayStore, anthropicCapture, responsesCapture } = require('../src/protocol/reasoning-replay.cjs');

const nativeMessage = (source, text, extra = []) => m(3, Buffer.concat([v(2, source), s(3, text), ...extra]));
function nativeRequest() {
  return Buffer.concat([
    s(2, 'System prompt'), s(21, 'local-model'), v(6, 9901),
    nativeMessage(1, 'User message'),
    nativeMessage(2, 'Assistant before tool', [m(6, Buffer.concat([s(1, 'call_aqqqqqqqqqqqqqq'), s(2, 'shell_command'), s(3, '{"cmd":"ls"}')]))]),
    nativeMessage(4, 'first result', [s(7, 'call_aqqqqqqqqqqqqqq')]),
    nativeMessage(1, 'User after tool'),
    m(10, Buffer.concat([s(1, 'shell_command'), s(2, 'Run a command'), s(3, '{"type":"object","properties":{"cmd":{"type":"string"}}}')])),
    m(10, Buffer.concat([s(1, 'read_file'), s(2, 'Read a file'), s(3, '{"type":"object","properties":{"path":{"type":"string"}}}')])),
  ]);
}

const anthropicProvider = { id: 'p1', apiFormat: 'anthropic' };
const responsesProvider = { id: 'p2', apiFormat: 'responses' };
const claudeRoute = { model: 'claude-opus-5-5', effort: 'high' };
const gptRoute = { model: 'gpt-6.1-sol', effort: 'high' };
const ephemeral = { type: 'ephemeral' };

// ---------- store ----------

test('replay store isolates scopes and returns copies', () => {
  const store = createReplayStore();
  const scope = replayScope(anthropicProvider, claudeRoute);
  store.save(scope, ['toolu_t1qqqqqqqqqqqqqq', 'toolu_t2qqqqqqqqqqqqqq'], [{ type: 'thinking', thinking: 'x', signature: 's' }]);
  assert.deepEqual(store.lookup(scope, ['toolu_t2qqqqqqqqqqqqqq']), [{ type: 'thinking', thinking: 'x', signature: 's' }]);
  assert.deepEqual(store.lookup(replayScope(anthropicProvider, { model: 'other' }), ['toolu_t1qqqqqqqqqqqqqq']), []);
  assert.deepEqual(store.lookup(scope, ['missing']), []);
  assert.deepEqual(store.lookup('', ['toolu_t1qqqqqqqqqqqqqq']), []);
  const copy = store.lookup(scope, ['toolu_t1qqqqqqqqqqqqqq']);
  copy.push('mutated');
  assert.equal(store.lookup(scope, ['toolu_t1qqqqqqqqqqqqqq']).length, 1);
});

test('replay store evicts least recently saved entries', () => {
  const store = createReplayStore({ maxEntries: 2 });
  store.save('s', ['toolu_aqqqqqqqqqqqqqq'], [{ n: 1 }]);
  store.save('s', ['toolu_bqqqqqqqqqqqqqq'], [{ n: 2 }]);
  store.save('s', ['toolu_cqqqqqqqqqqqqqq'], [{ n: 3 }]);
  assert.equal(store.size, 2);
  assert.deepEqual(store.lookup('s', ['toolu_aqqqqqqqqqqqqqq']), []);
  assert.deepEqual(store.lookup('s', ['toolu_cqqqqqqqqqqqqqq']), [{ n: 3 }]);
});

test('replay scope requires a provider identity and a model', () => {
  assert.equal(replayScope({}, { model: 'x' }), '');
  assert.equal(replayScope({ id: 'p' }, {}), '');
  assert.notEqual(replayScope({ id: 'p' }, { model: 'toolu_aqqqqqqqqqqqqqq' }), replayScope({ id: 'p' }, { model: 'toolu_bqqqqqqqqqqqqqq' }));
});

// ---------- capture ----------

test('Anthropic capture keeps signed thinking and redacted thinking in order, drops unsigned', () => {
  const capture = anthropicCapture();
  const ev = (type, data) => capture.observe({ type, data });
  ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Plan ' } });
  ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'it' } });
  ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG' } });
  ev('content_block_start', { index: 1, content_block: { type: 'redacted_thinking', data: 'ENC' } });
  ev('content_block_start', { index: 2, content_block: { type: 'thinking', thinking: 'unsigned' } });
  ev('content_block_start', { index: 3, content_block: { type: 'tool_use', id: 'toolu_1', name: 'x', input: {} } });
  assert.deepEqual(capture.result(), {
    toolIds: ['toolu_1'],
    items: [{ type: 'thinking', thinking: 'Plan it', signature: 'SIG' }, { type: 'redacted_thinking', data: 'ENC' }],
  });
});

test('Responses capture keeps encrypted reasoning items and function call ids', () => {
  const capture = responsesCapture();
  capture.observe({ type: 'response.output_item.done', data: { item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC1' } } });
  capture.observe({ type: 'response.output_item.done', data: { item: { type: 'reasoning', id: 'rs_2', summary: [] } } });
  capture.observe({ type: 'response.completed', data: { response: { output: [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC1' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'x', arguments: '{}' }] } } });
  assert.deepEqual(capture.result(), { toolIds: ['call_1'], items: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC1' }] });
});

// ---------- Anthropic prompt caching ----------

test('Anthropic body marks system, last tool and last message for prompt caching', () => {
  const body = buildRequestBody(parseChat(nativeRequest()), claudeRoute, anthropicProvider);
  assert.deepEqual(body.system, [{ type: 'text', text: 'System prompt', cache_control: ephemeral }]);
  assert.equal(body.tools[0].cache_control, undefined);
  assert.deepEqual(body.tools[1].cache_control, ephemeral);
  const last = body.messages.at(-1).content.at(-1);
  assert.deepEqual(last, { type: 'text', text: 'User after tool', cache_control: ephemeral });
  const marks = JSON.stringify(body).split('"cache_control"').length - 1;
  assert.ok(marks <= 4, `at most 4 cache breakpoints, got ${marks}`);
});

test('Anthropic prompt caching can be turned off per provider', () => {
  const body = buildRequestBody(parseChat(nativeRequest()), claudeRoute, { ...anthropicProvider, promptCache: false });
  assert.equal(body.system, 'System prompt');
  assert.equal(JSON.stringify(body).includes('cache_control'), false);
});

test('Anthropic cache breakpoint never lands on a thinking block', () => {
  const store = createReplayStore();
  const request = parseChat(Buffer.concat([
    s(2, 'Sys'), s(21, 'local-model'),
    nativeMessage(1, 'Go'),
    nativeMessage(2, '', [m(6, Buffer.concat([s(1, 'call_zqqqqqqqqqqqqqq'), s(2, 'shell_command'), s(3, '{}')]))]),
  ]));
  store.save(replayScope(anthropicProvider, claudeRoute), ['call_zqqqqqqqqqqqqqq'], [{ type: 'thinking', thinking: 't', signature: 'S' }]);
  const body = buildRequestBody(request, claudeRoute, anthropicProvider, { replay: store });
  const assistant = body.messages.at(-1);
  assert.equal(assistant.content[0].cache_control, undefined);
  assert.deepEqual(assistant.content.at(-1).cache_control, ephemeral);
});

// ---------- Anthropic thinking replay ----------

test('Anthropic body replays saved thinking before the matching tool_use turn', () => {
  const store = createReplayStore();
  store.save(replayScope(anthropicProvider, claudeRoute), ['call_aqqqqqqqqqqqqqq'], [{ type: 'thinking', thinking: 'why', signature: 'SIG' }]);
  const body = buildRequestBody(parseChat(nativeRequest()), claudeRoute, anthropicProvider, { replay: store });
  const assistant = body.messages.find(message => message.role === 'assistant');
  assert.deepEqual(assistant.content.map(block => block.type), ['thinking', 'text', 'tool_use']);
  assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'why', signature: 'SIG' });
});

test('Anthropic body ignores thinking saved for another model', () => {
  const store = createReplayStore();
  store.save(replayScope(anthropicProvider, { model: 'claude-haiku-5-5' }), ['call_aqqqqqqqqqqqqqq'], [{ type: 'thinking', thinking: 'why', signature: 'SIG' }]);
  const body = buildRequestBody(parseChat(nativeRequest()), claudeRoute, anthropicProvider, { replay: store });
  const assistant = body.messages.find(message => message.role === 'assistant');
  assert.deepEqual(assistant.content.map(block => block.type), ['text', 'tool_use']);
});

// ---------- Responses reasoning replay ----------

test('Responses body requests encrypted reasoning statelessly for reasoning routes', () => {
  const body = buildRequestBody(parseChat(nativeRequest()), gptRoute, responsesProvider);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.equal(body.store, false);
  const plain = buildRequestBody(parseChat(nativeRequest()), { model: 'gpt-x' }, responsesProvider);
  assert.equal(plain.include, undefined);
  assert.equal(plain.store, undefined);
  const off = buildRequestBody(parseChat(nativeRequest()), gptRoute, { ...responsesProvider, replayReasoning: false });
  assert.equal(off.include, undefined);
  const chat = buildRequestBody(parseChat(nativeRequest()), gptRoute, { id: 'p3', apiFormat: 'chat' });
  assert.equal(chat.include, undefined);
});

test('Responses body replays saved reasoning items before the matching function calls', () => {
  const store = createReplayStore();
  const item = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' };
  store.save(replayScope(responsesProvider, gptRoute), ['call_aqqqqqqqqqqqqqq'], [item]);
  const body = buildRequestBody(parseChat(nativeRequest()), gptRoute, responsesProvider, { replay: store });
  const types = body.input.map(entry => entry.type || entry.role);
  const reasoningAt = types.indexOf('reasoning');
  assert.ok(reasoningAt > 0, 'reasoning item present');
  assert.deepEqual(body.input[reasoningAt], item);
  assert.equal(types[reasoningAt + 1], 'assistant');
  assert.equal(types[reasoningAt + 2], 'function_call');
});

// ---------- serveChat end-to-end capture ----------

async function server(handler, t) {
  const instance = http.createServer(handler);
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}

async function serveOnce(t, events, route, provider, replay) {
  const requests = [];
  const upstream = await server(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks)));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(event);
    res.end();
  }, t);
  const metrics = [];
  const proxy = await server((req, res) => {
    serveChat({ request: parseChat(nativeRequest()), route, provider: { ...provider, baseUrl: `${upstream}/v1`, apiKey: 'k' }, res, replay,
      onMetrics: value => metrics.push(value) });
  }, t);
  await (await fetch(proxy)).arrayBuffer();
  return { requests, metrics };
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

test('serveChat saves Anthropic signed thinking under the emitted tool ids', async t => {
  const replay = createReplayStore();
  const { metrics } = await serveOnce(t, [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_9qqqqqqqqqqqqq', name: 'shell_command', input: {} } }),
    sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } }),
    sse('content_block_stop', { index: 1 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
    sse('message_stop', {}),
  ], claudeRoute, anthropicProvider, replay);
  assert.equal(metrics[0].status, 'success');
  assert.deepEqual(replay.lookup(replayScope(anthropicProvider, claudeRoute), ['toolu_9qqqqqqqqqqqqq']), [{ type: 'thinking', thinking: 'reason', signature: 'SIG' }]);
});

test('serveChat does not save reasoning from a failed stream', async t => {
  const replay = createReplayStore();
  await serveOnce(t, [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: 'r', signature: 'S' } }),
    sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_xqqqqqqqqqqqqq', name: 'shell_command', input: {} } }),
    sse('error', { error: { type: 'overloaded_error' } }),
  ], claudeRoute, anthropicProvider, replay);
  assert.equal(replay.size, 0);
});

test('serveChat saves Responses encrypted reasoning and sends include/store', async t => {
  const replay = createReplayStore();
  const reasoning = { type: 'reasoning', id: 'rs_7', summary: [], encrypted_content: 'ENC7' };
  const call = { type: 'function_call', id: 'fc_7', call_id: 'call_7qqqqqqqqqqqqqq', name: 'shell_command', arguments: '{"cmd":"ls"}' };
  const { requests, metrics } = await serveOnce(t, [
    sse('response.output_item.done', { output_index: 0, item: reasoning }),
    sse('response.output_item.added', { output_index: 1, item: { ...call, arguments: '' } }),
    sse('response.output_item.done', { output_index: 1, item: call }),
    sse('response.completed', { response: { status: 'completed', output: [reasoning, call], usage: { input_tokens: 3, output_tokens: 4 } } }),
  ], gptRoute, responsesProvider, replay);
  assert.equal(metrics[0].status, 'success');
  assert.deepEqual(requests[0].include, ['reasoning.encrypted_content']);
  assert.deepEqual(replay.lookup(replayScope(responsesProvider, gptRoute), ['call_7qqqqqqqqqqqqqq']), [reasoning]);
});

// ---------- review hardening ----------

test('replay store ignores low-entropy tool ids that gateways may reuse across conversations', () => {
  const store = createReplayStore();
  store.save('s', ['call_0'], [{ n: 1 }]);
  assert.equal(store.size, 0);
  assert.deepEqual(store.lookup('s', ['call_0']), []);
});

test('replay store enforces a total byte budget', () => {
  const store = createReplayStore({ maxBytes: 3000 });
  const big = { type: 'thinking', thinking: 'x'.repeat(1000), signature: 'S' };
  for (const id of ['toolu_aaaaaaaaaaaaaaaa1', 'toolu_aaaaaaaaaaaaaaaa2', 'toolu_aaaaaaaaaaaaaaaa3', 'toolu_aaaaaaaaaaaaaaaa4']) store.save('s', [id], [big]);
  assert.ok(store.bytes <= 3000, `bytes ${store.bytes}`);
  assert.deepEqual(store.lookup('s', ['toolu_aaaaaaaaaaaaaaaa1']), []);
  assert.equal(store.lookup('s', ['toolu_aaaaaaaaaaaaaaaa4']).length, 1);
});

test('replay store can disable a scope after the provider rejects replayed state', () => {
  const store = createReplayStore();
  store.save('s', ['toolu_aaaaaaaaaaaaaaaa1'], [{ n: 1 }]);
  store.disable('s');
  assert.equal(store.isDisabled('s'), true);
  assert.deepEqual(store.lookup('s', ['toolu_aaaaaaaaaaaaaaaa1']), []);
  store.save('s', ['toolu_aaaaaaaaaaaaaaaa2'], [{ n: 2 }]);
  assert.deepEqual(store.lookup('s', ['toolu_aaaaaaaaaaaaaaaa2']), []);
});

test('the same saved reasoning is replayed only once per request', () => {
  const store = createReplayStore();
  const id1 = 'call_aaaaaaaaaaaaaaaaaaaa1', id2 = 'call_aaaaaaaaaaaaaaaaaaaa2';
  const item = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC' };
  store.save(replayScope(responsesProvider, gptRoute), [id1, id2], [item]);
  const call = (id, cmd) => m(6, Buffer.concat([s(1, id), s(2, 'shell_command'), s(3, `{"cmd":"${cmd}"}`)]));
  const request = parseChat(Buffer.concat([s(2, 'Sys'), s(21, 'local-model'), nativeMessage(1, 'Go'),
    nativeMessage(2, '', [call(id1, 'ls')]), nativeMessage(2, '', [call(id2, 'pwd')]),
    nativeMessage(4, 'a', [s(7, id1)]), nativeMessage(4, 'b', [s(7, id2)])]));
  const body = buildRequestBody(request, gptRoute, responsesProvider, { replay: store });
  assert.equal(body.input.filter(entry => entry.type === 'reasoning').length, 1);
});

test('replayReasoning:false also disables Anthropic thinking capture and replay', async t => {
  const replay = createReplayStore();
  const provider = { ...anthropicProvider, replayReasoning: false };
  await serveOnce(t, [
    sse('message_start', { message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
    sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: 'r', signature: 'S' } }),
    sse('content_block_stop', { index: 0 }),
    sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_bbbbbbbbbbbbbbbb1', name: 'shell_command', input: {} } }),
    sse('content_block_stop', { index: 1 }),
    sse('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
    sse('message_stop', {}),
  ], claudeRoute, provider, replay);
  assert.equal(replay.size, 0);
});

test('a 400 caused by replayed state or reasoning fields retries once without them and disables the scope', async t => {
  const replay = createReplayStore();
  replay.save(replayScope(responsesProvider, gptRoute), ['call_aqqqqqqqqqqqqqq'.padEnd(20, 'x')], [{ type: 'reasoning', id: 'rs_bad', summary: [], encrypted_content: 'BAD' }]);
  const bodies = [];
  const upstream = await server(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    bodies.push(body);
    if (body.include || body.input.some(entry => entry.type === 'reasoning')) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad"}}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse('response.completed', { response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } } }));
  }, t);
  const id = 'call_aqqqqqqqqqqqqqq'.padEnd(20, 'x');
  const request = Buffer.concat([s(2, 'Sys'), s(21, 'local-model'), nativeMessage(1, 'Go'),
    nativeMessage(2, '', [m(6, Buffer.concat([s(1, id), s(2, 'shell_command'), s(3, '{}')]))]), nativeMessage(4, 'r', [s(7, id)])]);
  const metrics = [];
  const proxy = await server((req, res) => {
    serveChat({ request: parseChat(request), route: gptRoute, provider: { ...responsesProvider, baseUrl: `${upstream}/v1`, apiKey: 'k' }, res, replay,
      onMetrics: value => metrics.push(value) });
  }, t);
  await (await fetch(proxy)).arrayBuffer();
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].include, undefined);
  assert.equal(bodies[1].store, undefined);
  assert.equal(bodies[1].input.some(entry => entry.type === 'reasoning'), false);
  assert.equal(metrics[0].status, 'success');
  assert.equal(replay.isDisabled(replayScope(responsesProvider, gptRoute)), true);
});

test('a 400 without any replay-related fields is not retried', async t => {
  let calls = 0;
  const upstream = await server(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    calls++;
    res.writeHead(400, { 'content-type': 'application/json' }); res.end('{}');
  }, t);
  const metrics = [];
  const proxy = await server((req, res) => {
    serveChat({ request: parseChat(nativeRequest()), route: { model: 'plain' }, provider: { ...responsesProvider, baseUrl: `${upstream}/v1` }, res,
      replay: createReplayStore(), onMetrics: value => metrics.push(value) });
  }, t);
  await (await fetch(proxy)).arrayBuffer();
  assert.equal(calls, 1);
  assert.equal(metrics[0].status, 'error');
});
