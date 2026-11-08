'use strict';
// Locates the installed Devin picker logic by code shape instead of minified
// identifiers, which change on every Devin build. Since the 2026-11 builds the
// picker lives in hashed webapp chunks and identifiers may contain `$`.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appOut = '/Applications/Devin.app/Contents/Resources/app/out/vs/workbench';
const legacyRenderer = path.join(appOut, 'windsurf-chat-client/index.js');
const webappAssets = path.join(appOut, 'devin-webapp-host/assets');

function candidateFiles() {
  const files = fs.existsSync(legacyRenderer) ? [legacyRenderer] : [];
  if (fs.existsSync(webappAssets)) {
    for (const name of fs.readdirSync(webappAssets).sort()) if (name.endsWith('.js')) files.push(path.join(webappAssets, name));
  }
  return files;
}

const available = candidateFiles().length > 0;
const rendererFile = available ? candidateFiles()[0] : legacyRenderer;
const sources = new Map();
const read = file => { if (!sources.has(file)) sources.set(file, fs.readFileSync(file, 'utf8')); return sources.get(file); };

// Returns the source of the first installed file whose code matches `anchor`.
function sourceWith(anchor) {
  for (const file of candidateFiles()) {
    const source = read(file);
    if (anchor.test(source)) return source;
  }
  return '';
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`function ${name} is unterminated`);
}

const escapeRe = text => text.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');

// Source of `name=<expression>` as declared in a minified `const a=...,name=...` list.
function bindingSource(source, name) {
  const hit = new RegExp(`[,;{\\s]${escapeRe(name)}=(?!=)`).exec(source);
  if (!hit) return '';
  const start = hit.index + hit[0].length;
  const stack = [];
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const top = stack.at(-1);
    if (top === '`') {
      if (ch === '\\') i++;
      else if (ch === '`') stack.pop();
      else if (ch === '$' && source[i + 1] === '{') { stack.push('${'); i++; }
      continue;
    }
    if (top === '"' || top === "'") {
      if (ch === '\\') i++;
      else if (ch === top) stack.pop();
      continue;
    }
    if (ch === '`' || ch === '"' || ch === "'") stack.push(ch);
    else if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (!stack.length) return `var ${name}=${source.slice(start, i)};`;
      stack.pop();
    } else if (!stack.length && (ch === ',' || ch === ';')) return `var ${name}=${source.slice(start, i)};`;
  }
  return '';
}

// Evaluates `entry` from minified source, pulling in each free identifier it
// needs on demand while `probe(fn)` exercises it. Identifiers that are not
// plain functions or bindings (icons, React) are supplied through `stubs`.
function resolveClosure(source, entry, probe, stubs = {}) {
  const parts = [functionSource(source, entry)];
  const added = new Set([entry, ...Object.keys(stubs)]);
  for (let round = 0; round < 64; round++) {
    try {
      const fn = vm.runInNewContext(`${parts.join(';\n')};${entry}`, { ...stubs });
      probe(fn);
      return fn;
    } catch (err) {
      const name = err?.name === 'ReferenceError' && /^(\S+) is not defined$/.exec(err.message)?.[1];
      if (!name || added.has(name)) throw err;
      const found = source.includes(`function ${name}(`) ? functionSource(source, name) : bindingSource(source, name);
      // Cross-chunk imports and JSX renderers (icons) are presentation-only
      // for the picker logic under test, so they become inert functions.
      const own = /\.jsxs?\b/.test(found) ? '' : found;
      const imported = new RegExp(`import\\{[^}]*\\b(?:\\w+ as )?${escapeRe(name)}[,}]`).test(source);
      if (!own && !imported && !found) throw new Error(`installed Devin dependency not found: ${name}`);
      added.add(name);
      parts.unshift(own || `var ${name}=()=>undefined;`);
    }
  }
  throw new Error('installed Devin closure did not resolve');
}

function required(match, what) {
  if (!match) throw new Error(`installed Devin anchor not found: ${what}`);
  return match;
}

const FAMILY_GROUPING = /function ([\w$]+)\(e\)\{let [\w$]+=new Map,[\w$]+=\[\];for\(let [\w$]+ of e\)\{let e=[\w$]+\.familyUid;/;
const PICKER_ROWS = /function ([\w$]+)\(e,[\w$]+,[\w$]+,[\w$]+,[\w$]+\)\{let\{fullFamilies:[\w$]+,families:[\w$]+,ordered:[\w$]+\}=e/;
const EFFORT_SELECT = /function ([\w$]+)\(e,([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=([\w$]+)\(\2,e\.dimensions\),([\w$]+)=e\.dimensions\[\3\];if\(!\7\)return;let ([\w$]+)=\7\.name,[\w$]+=([\w$]+)\(e,\{\.\.\.\5,\[\8\]:\4\}\);/;
// Up to 2026-10: separate ACP intersection and featured-group sorter.
const LEGACY_ACP = /let e=([\w$]+)\(([\w$]+)\.options\);return ([\w$]+)\.filter\(([\w$]+)=>e\.has\(\4\.modelUid\)\|\|\4\.disabled\)/;
const LEGACY_SORTER = /function ([\w$]+)\(e,([\w$]+)=[\w$]+,([\w$]+)=\(\)=>!0\)\{return e\.map\(e=>\{let [\w$]+=e\.groups\.map\(e=>\(\{groupName:e\.groupName,options:e\.options\.filter\(\3\)\.map\(e=>\2\(e\)\),isFeatured:!!\(e\.options\.length>0&&e\.options\.every\(e=>e\.modelInfo\?\.displayOption===([\w$]+)\.MODEL_ROUTER\)\)\|\|void 0/;
// From 2026-11: one function intersects ACP options with the catalog and
// builds the sorted groups, featuring groups made only of model routers.
const SESSION_PICKER = /function ([\w$]+)\(e,t=null,n=!1\)\{let r=[\w$]+\(e\.options\),i=t\?new Map\(t\.models\.map\(e=>\[e\.modelUid,e\]\)\):void 0;if\(t&&n\)\{[^]*?isFeatured:t\.length>0&&t\.every\(e=>e\.displayOption===`model-router`\)\?!0:void 0/;
const ROUTER_DISPLAY = /case [\w$]+\.MODEL_ROUTER:return`model-router`/;
const MODEL_ROUTER_ENUM = /[\w$]+\[[\w$]+\.MODEL_ROUTER=(\d+)\]/;

const sameRealm = value => JSON.parse(JSON.stringify(value ?? null));

// Family grouping + row selection: returns { group(models), rows(grouped) }.
function loadFamilyPicker() {
  const source = sourceWith(FAMILY_GROUPING);
  const grouping = required(source.match(FAMILY_GROUPING), 'family grouping');
  const wrapper = required(source.match(new RegExp(`function ([\\w$]+)\\(e,[\\w$]+\\)\\{let\\{families:[\\w$]+\\}=${escapeRe(grouping[1])}\\([\\w$]+\\?\\?e\\)`)), 'grouped picker input');
  const rows = required(source.match(PICKER_ROWS), 'picker rows');
  const start = source.indexOf(grouping[0]);
  const rowsStart = source.indexOf(rows[0], start);
  const end = rowsStart + functionSource(source, rows[1]).length;
  if (!(start >= 0 && rowsStart > start)) throw new Error('installed Devin family picker range');
  const api = vm.runInNewContext(`${source.slice(start, end)};({group:${wrapper[1]},rows:${rows[1]}})`);
  return { group: models => api.group(models), rows: models => api.rows(api.group(models), [], undefined, false) };
}

// The probe pins observable behaviour so a stubbed dependency cannot silently
// turn the extracted picker into a no-op: it must intersect session options
// with the catalog, report misses and feature groups made only of routers.
function probeSessionPicker(fn) {
  const session = { name: 'Model', options: [{ group: 'g', name: 'G', options: [{ value: 'a', name: 'A' }] }, { value: 'b', name: 'B' }] };
  const catalog = { models: [{ modelUid: 'a', label: 'A', displayOption: 'model-router' }, { modelUid: 'c', label: 'C', disabled: true }],
    sorts: [{ name: 'All', groups: [{ name: 'Mixed', modelUids: ['a', 'c'] }, { name: 'Routers', modelUids: ['a'] }] }] };
  const out = sameRealm(fn(session, catalog, true));
  const groups = out?.sorts?.[0]?.groups || [];
  const ok = out?.models?.some(model => model.modelUid === 'a')
    && out.catalogMisses?.includes('b')
    && groups.find(group => group.groupName === 'Routers')?.isFeatured === true
    && groups.find(group => group.groupName === 'Mixed')?.isFeatured === undefined;
  if (!ok) throw new Error(`installed Devin session picker probe failed: ${JSON.stringify(out)}`);
  const fallback = sameRealm(fn(session, null, false));
  if (!fallback?.models?.some(model => model.modelUid === 'b')) throw new Error('installed Devin session picker fallback probe failed');
}

function loadSessionPicker() {
  const source = required(sourceWith(SESSION_PICKER), 'session/catalog picker');
  return resolveClosure(source, source.match(SESSION_PICKER)[1], probeSessionPicker);
}

// Numeric ModelInfo.displayOption the installed build uses for model routers.
function modelRouterValue() {
  const hit = required(sourceWith(MODEL_ROUTER_ENUM).match(MODEL_ROUTER_ENUM), 'MODEL_ROUTER enum value');
  return Number(hit[1]);
}

// ACP session option intersection: returns { filter(session, models) } -> catalog models the picker offers.
function loadAcpPicker() {
  const legacy = sourceWith(LEGACY_ACP);
  if (legacy) {
    const use = legacy.match(LEGACY_ACP);
    const collector = required(legacy.match(new RegExp(`function ${escapeRe(use[1])}\\(e\\)\\{let [\\w$]+=new Set;for\\(let ([\\w$]+) of e\\)if\\(([\\w$]+)\\(\\1\\)\\)`)), 'session option collector');
    const collect = vm.runInNewContext(`${functionSource(legacy, collector[2])};${functionSource(legacy, use[1])};${use[1]}`);
    const select = new Function(use[1], use[2], use[3], use[0]);
    return { filter: (session, models) => select(collect, session, models) };
  }
  const picker = loadSessionPicker();
  return { filter: (session, models) => {
    const catalog = { models, sorts: [{ name: 'All', groups: [{ name: 'All', modelUids: models.map(model => model.modelUid) }] }] };
    const own = new Set(models.map(model => model.modelUid));
    return sameRealm(picker(session, catalog, true).models).filter(model => own.has(model.modelUid));
  } };
}

// Recommended-group sorter: (sorts, map) -> sorts with isFeatured on router-only groups.
function loadGroupSorter() {
  const legacy = sourceWith(LEGACY_SORTER);
  if (legacy) {
    const hit = legacy.match(LEGACY_SORTER);
    return vm.runInNewContext(`${functionSource(legacy, hit[1]).replace(new RegExp(`${escapeRe(hit[2])}=[\\w$]+,${escapeRe(hit[3])}=`), `${hit[2]}=e=>e,${hit[3]}=`)};${hit[1]}`, { [hit[4]]: { MODEL_ROUTER: 3 } });
  }
  required(sourceWith(ROUTER_DISPLAY), 'model-router display option');
  const picker = loadSessionPicker();
  const router = modelRouterValue();
  return sorts => {
    const models = [], session = { name: 'Model', options: [] }, out = [];
    for (const sort of sorts) out.push({ name: sort.name, groups: sort.groups.map(group => ({ name: group.groupName, modelUids: group.options.map(json => {
      const info = json.modelInfo || json;
      const uid = info.modelUid || json.uid;
      models.push({ modelUid: uid, label: info.label || uid, displayOption: info.displayOption === router ? 'model-router' : 'standard-picker' });
      session.options.push({ value: uid, name: info.label || uid });
      return uid;
    }) })) });
    return sameRealm(picker(session, { models, sorts: out }, true).sorts);
  };
}

function loadEffortPicker() {
  const source = sourceWith(EFFORT_SELECT);
  const select = required(source.match(EFFORT_SELECT), 'family variant selection');
  const start = source.indexOf(`function ${select[9]}(`);
  const end = source.indexOf(select[0]) + functionSource(source, select[1]).length;
  if (start < 0 || start >= end) throw new Error('installed Devin effort picker range');
  return vm.runInNewContext(`${source.slice(start, end)};${select[1]}`);
}

module.exports = { rendererFile, available, loadFamilyPicker, loadAcpPicker, loadGroupSorter, loadEffortPicker };
