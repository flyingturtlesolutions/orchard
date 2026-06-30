// Core/recipeFromObservedWrite.js — CX-8 (DESIGN_connectors.md §10, §17 build-order #5): the WRITE analog of
// recipeFromHarvest. A demonstrate-once capture of an app's OWN write request (the user creates an event / sends a
// message) → a proto RIDE WRITE-recipe. v2.74.1296.
//
// Reads are body-blind-harvestable: their params live in the URL the tee already sees. A WRITE carries its payload
// in the BODY, so passive harvest yields only an un-runnable stub (the Google-Calendar "/hello" recipe: right
// endpoint guess, no body). The demonstrate-once path closes that: when the USER performs the write, the demo
// captures the real request INCLUDING its body, and this core TEMPLATES the body — the values the user typed during
// the demo (`demonstratedValues`, from the TYPE fragments) become `{param}` placeholders; app-protocol CONSTANTS
// stay literal. Privacy: the user's inputs become PARAMS (filled fresh at invoke, NEVER banked as literals); only
// the structural template + protocol constants persist. Safety is method-derived (§9) — POST/PUT/PATCH → gated,
// DELETE → destructive — and the recipe lands reviewState:'pending' behind the §18 arm guard until a human accepts.
// PURE: no chrome / DOM / LLM / clock.
//
// @module Core/recipeFromObservedWrite

import { safetyClassForMethod } from './rideRecipe.js';
import { parseUrl, templatePath, templateQuery } from './recipeFromHarvest.js';   // reuse the read core's URL templating

const _slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

function _uniqName(base, params) {
  const used = new Set(params.map((p) => p.name));
  let n = _slug(base) || 'field'; if (!used.has(n)) return n;
  for (let i = 2; ; i++) if (!used.has(`${n}${i}`)) return `${n}${i}`;
}

// The set of values the user TYPED in the demo (trimmed strings). A body leaf EQUAL to one is a param; else constant.
function _demoSet(demonstratedValues) {
  const s = new Set();
  for (const v of (Array.isArray(demonstratedValues) ? demonstratedValues : [])) {
    const t = String(v ?? '').trim();
    if (t) s.add(t);
  }
  return s;
}

// A single leaf → a `{param}` placeholder (matched a demonstrated value) or the literal constant. PURE.
function _templateLeaf(val, demo, params, keyHint) {
  if (val === null || val === undefined) return val;
  const s = String(val).trim();
  if (s && demo.has(s)) {
    const name = _uniqName(keyHint || 'field', params);
    const type = typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string';
    params.push({ name, type, required: true });   // NO literal value — privacy: the user's input never banks
    return `{${name}}`;
  }
  return val;   // a constant (app protocol) — kept literal so the request stays valid
}

// Recursively template a parsed JSON body. PURE. Demonstrated values → `{param}`; constants stay.
function _templateJson(node, demo, params, keyHint) {
  if (Array.isArray(node)) return node.map((v) => (v && typeof v === 'object') ? _templateJson(v, demo, params, keyHint) : _templateLeaf(v, demo, params, keyHint));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = (v && typeof v === 'object') ? _templateJson(v, demo, params, k) : _templateLeaf(v, demo, params, k);
    return out;
  }
  return _templateLeaf(node, demo, params, keyHint);
}

// Parse + template a form-urlencoded body → a { key: tmpl|literal } object. PURE.
function _templateForm(raw, demo, params) {
  const out = {};
  for (const pair of String(raw || '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair);
    const v = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' ')) : '';
    out[k] = _templateLeaf(v, demo, params, k);
  }
  return out;
}

// Last-resort: substring-template demonstrated values out of an opaque/raw body so no typed PII banks literally. PURE.
function _templateRaw(raw, demo, params) {
  let t = String(raw || '');
  for (const d of demo) {
    if (d.length < 3 || !t.includes(d)) continue;   // ≥3 chars → avoid over-matching a stray "a"
    const name = _uniqName('field', params);
    params.push({ name, type: 'string', required: true });
    t = t.split(d).join(`{${name}}`);
  }
  return t;
}

const _isJsonType = (ct) => /json/i.test(String(ct || ''));
const _isFormType = (ct) => /x-www-form-urlencoded/i.test(String(ct || ''));

/**
 * One observed WRITE capture → a proto ride WRITE-recipe (or null if not a write). PURE.
 * @param {{method:string, url:string, body?:string, contentType?:string}} capture
 * @param {{ appHost?:string, demonstratedValues?:string[] }} [opts]
 * @returns {object|null}
 */
export function recipeFromObservedWrite(capture, { appHost = '', demonstratedValues = [] } = {}) {
  const c = capture || {};
  const method = String(c.method || '').toUpperCase();
  if (!c.url || !method || method === 'GET' || method === 'HEAD') return null;   // not a write
  const demo = _demoSet(demonstratedValues);
  const params = [];

  // URL: template id-like path segments + varying query (reuse the read core).
  const { path, query } = parseUrl(c.url);
  const tp = templatePath([path]);
  const tq = templateQuery([query]);
  const endpoint = tp.endpoint + (tq.query ? `?${tq.query}` : '');
  for (const p of [...tp.params, ...tq.params]) if (!params.some((x) => x.name === p.name)) params.push({ ...p, required: true });

  // BODY: template the payload — the demonstrate-once WIN over body-blind harvest.
  let body = null, bodyType = null;
  const raw = (c.body === undefined || c.body === null) ? '' : String(c.body);
  if (raw) {
    if (_isJsonType(c.contentType) || /^\s*[[{]/.test(raw)) {
      try { body = _templateJson(JSON.parse(raw), demo, params, 'field'); bodyType = 'json'; }
      catch { body = _templateRaw(raw, demo, params); bodyType = 'raw'; }
    } else if (_isFormType(c.contentType)) {
      body = _templateForm(raw, demo, params); bodyType = 'form';
    } else {
      // unknown/opaque content type → substring-template the typed values so no PII banks; never guess "form".
      body = _templateRaw(raw, demo, params); bodyType = 'raw';
    }
  }

  let originHost = ''; try { originHost = new URL(c.url).host; } catch { /* relative — no host */ }
  const destructive = method === 'DELETE' || /\/(merge|destroy|bulk_destroy|delete_many)/i.test(tp.endpoint);
  return {
    id: `demo_${_slug(`${method} ${tp.endpoint}`)}`,
    name: `${method} ${tp.endpoint}`,   // placeholder — the LLM polish renames + writes `does`
    does: '',
    method,
    endpoint,
    params,
    body,
    bodyType,
    origin: originHost,
    appHost: String(appHost || ''),
    contentType: String(c.contentType || (bodyType === 'json' ? 'application/json' : bodyType === 'form' ? 'application/x-www-form-urlencoded' : '')),   // the executor sets this header
    provenance: 'demonstrated',
    reviewState: 'pending',
    trust: 0.5,                          // a deliberate demo is a stronger signal than passive harvest (still HITL-gated)
    enabled: true,
    safetyClass: safetyClassForMethod(method, { destructive }),
  };
}

/**
 * A demonstration's captures → proto write-recipes (filters GET/HEAD, dedups by id). PURE.
 * @param {Array<object>} captures
 * @param {{ appHost?:string, demonstratedValues?:string[] }} [opts]
 * @returns {Array<object>}
 */
export function recipesFromObservedWrites(captures, opts = {}) {
  const out = []; const seen = new Set();
  for (const c of (Array.isArray(captures) ? captures : [])) {
    const r = recipeFromObservedWrite(c, opts);
    if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
  }
  return out;
}

// ─── Invoke side: fill the template back into a concrete request (the inverse of templating) ─────────────────
// The execution gate (CX-6) binds the ask's values to the recipe's params, then calls this to rebuild the body it
// will POST/PUT. `{name}` placeholders that are the WHOLE value become the typed param value (a JSON number stays a
// number); embedded `{name}` in a longer string are substituted as text. An unbound placeholder is left intact (so
// a missing required param is visible, not silently blanked). PURE.
const _PLACEHOLDER = /\{([a-z0-9_]+)\}/gi;
const _WHOLE = /^\{([a-z0-9_]+)\}$/i;

function _fillNode(node, vals) {
  if (Array.isArray(node)) return node.map((v) => _fillNode(v, vals));
  if (node && typeof node === 'object') { const o = {}; for (const [k, v] of Object.entries(node)) o[k] = _fillNode(v, vals); return o; }
  if (typeof node === 'string') {
    const whole = node.match(_WHOLE);
    if (whole && Object.prototype.hasOwnProperty.call(vals, whole[1])) return vals[whole[1]];   // typed value (number stays number)
    return node.replace(_PLACEHOLDER, (m, n) => (Object.prototype.hasOwnProperty.call(vals, n) ? String(vals[n]) : m));
  }
  return node;
}

/**
 * Fill an armed write-recipe's body template with bound param values → a concrete request body + content type. PURE.
 * @param {object} recipe          a recipe from recipeFromObservedWrite (body + bodyType + contentType).
 * @param {Object<string,*>} [paramValues]  { paramName: value } bound from the ask.
 * @returns {{ body: string|null, contentType: string }}
 */
export function fillWriteBody(recipe, paramValues = {}) {
  const r = recipe || {}; const vals = paramValues || {};
  const ct = r.contentType || (r.bodyType === 'json' ? 'application/json' : r.bodyType === 'form' ? 'application/x-www-form-urlencoded' : '');
  if (r.body === null || r.body === undefined) return { body: null, contentType: ct };
  if (r.bodyType === 'json') return { body: JSON.stringify(_fillNode(r.body, vals)), contentType: ct || 'application/json' };
  if (r.bodyType === 'form') {
    const filled = _fillNode(r.body, vals);
    const enc = Object.entries(filled).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    return { body: enc, contentType: ct || 'application/x-www-form-urlencoded' };
  }
  return { body: String(_fillNode(String(r.body), vals)), contentType: ct };   // raw
}
