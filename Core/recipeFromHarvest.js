// Core/recipeFromHarvest.js — §17 (DESIGN_connectors.md): the CRAWL-AS-GENERALIZER. Turn captured network requests
// (observed during an Explore crawl over an app's own pages) into proto RIDE-RECIPES. The unique win: an Explore crawl
// visits MANY instances of a page type (ticket #1, #2, #3), so DIFFING those same-endpoint captures collapses the
// varying segment (`/tickets/64863.json`, `/tickets/64659.json`) to a `{param}` deterministically — no LLM guess for the
// common id case. The LLM polish (a later slice) only names + writes `does`. PURE: no chrome / DOM / LLM / clock.
//
// Output records are CONNECTOR_RECIPES-shaped + harvest metadata (provenance:'harvested', reviewState:'pending', low
// trust) so they bank into the per-Ground collection (Core/rideRecipe.js) and surface in Studio's Ride section for the
// human to review before they're armable. Safety is method-derived (§9) via rideRecipe.safetyClassForMethod.

import { safetyClassForMethod } from './rideRecipe.js';

// An id RUN inside a path segment: a uuid, or a 2+-digit numeric (ticket ids, order ids). Used to template `/tickets/64863`.
const _ID_RUN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{2,}/i;
const _NUM = /^\d+$/;

const _uniq = (arr) => [...new Set(arr)];
const _slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

/** Split a URL (relative or absolute) into { path, query }. PURE. query is an ordered {key:value} object. */
export function parseUrl(url) {
  const s = String(url || '');
  const noScheme = s.replace(/^[a-z]+:\/\/[^/]+/i, '');   // strip origin if absolute
  const qIdx = noScheme.indexOf('?');
  const path = (qIdx >= 0 ? noScheme.slice(0, qIdx) : noScheme) || '/';
  const query = {};
  if (qIdx >= 0) {
    for (const pair of noScheme.slice(qIdx + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      query[decodeURIComponent(k)] = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1)) : '';
    }
  }
  return { path, query };
}

/** Is a path segment id-like (contains an id run)? PURE. `v2` (one digit) is NOT — it's a static API version. */
function _idLike(seg) { return _ID_RUN.test(String(seg || '')); }

/** The grouping KEY for a capture: METHOD + the path with id-like segments normalized to `#`. PURE. Same key ⇒ same endpoint. */
export function pathKey(method, path) {
  const segs = String(path || '').split('/').map((s) => (_idLike(s) ? '#' : s));
  return `${String(method || 'GET').toUpperCase()} ${segs.join('/')}`;
}

const _lastStatic = (segs) => { for (let i = segs.length - 1; i >= 0; i--) if (segs[i] && !segs[i].includes('{')) return segs[i]; return ''; };
function _uniqName(base, params) {
  const used = new Set(params.map((p) => p.name));
  let n = _slug(base) || 'id'; if (!used.has(n)) return n;
  for (let i = 2; ; i++) if (!used.has(`${n}${i}`)) return `${n}${i}`;
}

/**
 * Template one set of same-position segment VALUES into a `{param}` segment + its param spec, or null if not a param.
 * PURE. Two modes: an id-RUN with consistent surrounding text across all values (`64863.json`/`64659.json` →
 * `{id}.json`, integer) — works for a single capture too; else a whole varying segment → a string `{param}`.
 */
function _templateSeg(vals, prevSeg, params) {
  const ms = vals.map((v) => String(v).match(_ID_RUN));
  if (ms.every(Boolean)) {
    const pres = vals.map((v, k) => String(v).slice(0, ms[k].index));
    const posts = vals.map((v, k) => String(v).slice(ms[k].index + ms[k][0].length));
    if (_uniq(pres).length === 1 && _uniq(posts).length === 1) {
      const numeric = ms.every((m) => _NUM.test(m[0]));
      const name = _uniqName(numeric ? 'id' : (prevSeg || 'id'), params);
      return { seg: `${pres[0]}{${name}}${posts[0]}`, param: { name, type: numeric ? 'integer' : 'string' } };
    }
  }
  const name = _uniqName(prevSeg || 'value', params);   // a varying non-id segment (a slug) → a string param
  return { seg: `{${name}}`, param: { name, type: 'string' } };
}

/**
 * Template a set of same-endpoint PATHS → { endpoint, params }. PURE. The crawl-as-generalizer core: a segment that
 * VARIES across captures (or, for a single capture, is id-like) becomes a `{param}`; constant segments stay literal.
 * Mismatched segment counts → fall back to the first path literal (can't safely diff).
 */
export function templatePath(paths) {
  const list = (Array.isArray(paths) ? paths : []).map((p) => String(p || ''));
  if (!list.length) return { endpoint: '', params: [] };
  const splits = list.map((p) => p.split('/'));
  const n = splits[0].length;
  if (!splits.every((s) => s.length === n)) return { endpoint: list[0], params: [] };
  const out = []; const params = [];
  for (let i = 0; i < n; i++) {
    const vals = splits.map((s) => s[i]);
    const distinct = _uniq(vals);
    const isParam = distinct.length > 1 || (list.length === 1 && _idLike(vals[0]));
    if (!isParam) { out.push(vals[0]); continue; }
    const t = _templateSeg(vals, _lastStatic(out), params);
    out.push(t.seg); if (t.param) params.push(t.param);
  }
  return { endpoint: out.join('/'), params };
}

/**
 * Template the QUERY across captures → { query, params }. PURE. A query key whose value VARIES becomes `key={key}` + a
 * param; a constant value stays literal (`per_page=25`). Keys keep first-seen order (deterministic).
 */
export function templateQuery(queries) {
  const list = (Array.isArray(queries) ? queries : []).map((q) => (q && typeof q === 'object') ? q : {});
  const keys = []; const seen = new Set();
  for (const q of list) for (const k of Object.keys(q)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const parts = []; const params = [];
  for (const key of keys) {
    const vals = list.map((q) => q[key]).filter((v) => v !== undefined);
    const distinct = _uniq(vals);
    if (distinct.length <= 1) { parts.push(`${key}=${vals[0] ?? ''}`); continue; }
    parts.push(`${key}={${key}}`);
    params.push({ name: key, type: vals.every((v) => _NUM.test(String(v))) ? 'integer' : 'string' });
  }
  return { query: parts.join('&'), params };
}

/** Is this capture the app's IDENTITY probe (the `{me}` source)? PURE. Excluded from recipes; surfaced separately. */
export function isIdentityCall(capture) {
  const path = parseUrl(capture && capture.url).path;
  return /\/(users\/me|me|whoami|account|session|profile|viewer|current[_-]?user)(\.|\/|\?|$)/i.test(path)
    && String((capture && capture.method) || 'GET').toUpperCase() === 'GET';
}

/**
 * Captures → proto ride-recipes. PURE. Groups same-endpoint captures (pathKey), templates each group's paths + query,
 * derives the method-based safety class, and emits a CONNECTOR_RECIPES-shaped record carrying harvest metadata
 * (provenance 'harvested', reviewState 'pending', low trust). Re-harvesting the same endpoint yields the SAME id
 * (deterministic slug) so rideRecipe.mergeRecipes dedups it. Returns { recipes, identityPath }.
 * @param {Array<{method:string, url:string}>} captures
 * @param {{ appHost?: string }} [opts]
 */
export function recipesFromHarvest(captures, { appHost = '' } = {}) {
  const valid = (Array.isArray(captures) ? captures : []).filter((c) => c && c.url && c.method);
  let identityPath = null;
  const groups = new Map();
  for (const c of valid) {
    if (isIdentityCall(c)) { if (!identityPath) identityPath = parseUrl(c.url).path; continue; }
    const { path } = parseUrl(c.url);
    const key = pathKey(c.method, path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const recipes = [];
  for (const [, group] of groups) {
    const method = String(group[0].method || 'GET').toUpperCase();
    const parsed = group.map((c) => parseUrl(c.url));
    const tp = templatePath(parsed.map((p) => p.path));
    const tq = templateQuery(parsed.map((p) => p.query));
    const endpoint = tp.endpoint + (tq.query ? `?${tq.query}` : '');
    const destructive = method === 'DELETE' || /\/(merge|mark_as_spam|bulk_destroy|destroy_many)/i.test(tp.endpoint);
    // §20 — the captured API HOST (the recipe's `origin`). parseUrl strips it from the endpoint (path-only), so carry it
    // here: a static SPA fetches its data CROSS-ORIGIN (page on appHost, API on `deakoapi.…`), so origin ≠ appHost and the
    // replay needs the real API host to build the URL + find the page-captured token. Same host as appHost for a same-origin app.
    let originHost = ''; try { originHost = new URL(group[0].url).host; } catch { /* relative — no host */ }
    recipes.push({
      id: `harvest_${_slug(`${method} ${tp.endpoint}`)}`,
      name: `${method} ${tp.endpoint}`,   // placeholder — the LLM polish slice renames + writes `does`
      does: '',
      method,
      endpoint,
      params: [...tp.params, ...tq.params],
      body: null,
      origin: originHost,   // §20 — the captured API host (may be cross-origin to appHost)
      appHost: String(appHost || ''),
      provenance: 'harvested',
      reviewState: 'pending',
      trust: 0.3,
      enabled: true,
      safetyClass: safetyClassForMethod(method, { destructive }),
      samples: group.length,   // how many instances the template diffed (confidence signal)
    });
  }
  return { recipes, identityPath };
}
