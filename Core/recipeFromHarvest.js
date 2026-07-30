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

// ── Recipe-worthiness filter (v2.74.1300) — forage on a complex internal-RPC app (Gmail/Calendar) captures a FLOOD of
// non-data calls: static ASSET loads (JS bundles, fonts, images) and telemetry BEACONS (gen_204, jserror, csi…). Banking
// those as "recipes" is pure noise — the user saw ~40 Gmail recipes, the majority boot scripts + pings. Drop them BEFORE
// templating: a recipe is a DATA operation, not an asset fetch or a log beacon. Dropping the asset GETs also collapses
// their cache-busting-hash duplicates (the "Load Gmail JavaScript ×4" problem). PURE; conservative — only UNAMBIGUOUS noise.
const _ASSET_EXT = /\.(?:js|mjs|css|map|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|webp|avif|bmp|wasm|mp4|webm)(?:$|\?)/i;
const _BEACON_PATH = /\/(?:gen_204|generate_204|jserror|jslog|csi|client_?streamz|streamz)(?:[/?]|$)/i;

/** Is this capture NOISE — a static-asset load (GET) or a telemetry beacon — rather than a data operation? PURE. */
export function isNoiseCapture(capture) {
  if (!capture || !capture.url) return true;
  const method = String(capture.method || 'GET').toUpperCase();
  const { path } = parseUrl(capture.url);
  if (method === 'GET' && _ASSET_EXT.test(path)) return true;   // static asset → never a data op (also collapses hash dups)
  if (_BEACON_PATH.test(path)) return true;                     // telemetry / instrumentation beacon (any method)
  return false;
}

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

// ── RH-0b (v2.74.1565, DESIGN_route_heal.md §2) — bank the captured request-header SHAPE. The tee already strips
// the credential class at capture; this layer strips AGAIN (defense in depth — the pure bank can't assume every
// capture came from our tee) and then keeps only what is REPLAYABLE: a header that is present with an IDENTICAL
// value on every capture of the endpoint group. A varying value is a nonce/trace — replaying one is wrong, and it
// is NOT a param (unlike a path id, a per-request header has no user-facing meaning to bind). The dynamic-NAME
// class (request ids, trace/correlation headers) is dropped even when a single capture makes it look static.
const _CRED_HDR = /^(cookie|set-cookie|authorization|proxy-authorization)$|csrf|xsrf|token|secret|session|api[-_]?key|password|bearer|(^|[-_])auth([-_]|$)/;
const _MECH_HDR = new Set(['content-length', 'host', 'content-type']);
const _DYN_HDR = /request[-_]?id|trace|correlation|nonce|idempotency|timestamp|^x-b3|x-amz-date|datadog|sentry|newrelic/;

/** Strip credential + mechanical headers; lowercase names; bound size (12 names, 160-char values). PURE. */
export function sanitizeCaptureHeaders(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(h)) {
    const lk = String(k).toLowerCase();
    if (_CRED_HDR.test(lk) || _MECH_HDR.has(lk) || v == null) continue;
    out[lk] = String(v).slice(0, 160);
    if (++n >= 12) break;
  }
  return out;
}

/**
 * The header twin of templateQuery: same-endpoint captures' header sets → the STATIC shape worth banking. PURE.
 * A header banks only when present with one identical value across EVERY capture of the group (a capture with no
 * headers at all vetoes — if the app sometimes doesn't send it, it isn't part of the route). Dynamic-name class
 * always drops. First-seen order; capped at 8 (a routing shape is small — Shopify's is 2).
 */
export function templateHeaders(headerSets) {
  const sets = (Array.isArray(headerSets) ? headerSets : []).map(sanitizeCaptureHeaders);
  if (!sets.length || sets.some((s) => !s || !Object.keys(s).length)) return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(sets[0])) {
    if (_DYN_HDR.test(k)) continue;
    if (!sets.every((s) => s[k] === v)) continue;
    out[k] = v;
    if (++n >= 8) break;
  }
  return out;
}

// ── RH-1c (v2.74.1567, DESIGN_route_heal.md §3.4-5) — MATCH a fresh capture to a DRIFT-SUSPECT recipe by what did
// NOT drift, and derive the five-second-readable heal proposal. The tee is body-blind, so matching is URL-shaped:
// path statics (the resource nouns survive a version-prefix or framing change), templated param count, query keys,
// and — the gql-over-URL case (Shopify `?operation=`) — the operation identity read from the RECIPE's own body
// (`operationName`) against the capture's URL. Ambiguous → NO proposal (spec hard line: never guess). READ recipes
// only ever get proposals; a drifted WRITE goes through full §18 re-review (the §4 hard line) — and a healed
// gql-read still replays OUR unchanged read document through the isReadOnlyGql belts, so a heal can never turn a
// read into a write.

const _epPath = (endpoint) => String(endpoint || '').split('?')[0];
const _epQuery = (endpoint) => { const i = String(endpoint || '').indexOf('?'); return i >= 0 ? String(endpoint).slice(i + 1) : ''; };
const _pathStatics = (endpoint) => _epPath(endpoint).split('/').filter((s) => s && !s.includes('{'));
const _pathParams = (endpoint) => (_epPath(endpoint).match(/\{([^}]+)\}/g) || []).map((s) => s.slice(1, -1));
const _queryKeys = (endpoint) => _epQuery(endpoint).split('&').filter(Boolean).map((p) => p.split('=')[0]);
const _queryVal = (endpoint, key) => { for (const p of _epQuery(endpoint).split('&')) { const i = p.indexOf('='); if (i >= 0 && p.slice(0, i) === key) return p.slice(i + 1); } return null; };

/**
 * Does the RECIPE's own path template MATCH the candidate path, used AS A PATTERN? PURE. Same segment count, and
 * every static recipe segment equals the candidate's (case-insensitive) — a `{param}` slot on either side matches
 * anything. This is what makes a NON-templating literal (the Shopify `{handle}` store slug — no digits, so a
 * capture never collapses it) still align with the recipe's param slot: the recipe knows its own shape.
 */
export function pathAligns(recipeEndpoint, candEndpoint) {
  const rs = _epPath(recipeEndpoint).split('/').filter(Boolean);
  const cs = _epPath(candEndpoint).split('/').filter(Boolean);
  if (!rs.length || rs.length !== cs.length) return false;
  return rs.every((seg, i) => seg.includes('{') || cs[i].includes('{') || seg.toLowerCase() === cs[i].toLowerCase());
}
/**
 * Drop palette legs whose endpoint is a CONCRETE INSTANCE of another leg's template. PURE.
 *
 * v2.74.1879 — live 194001: `how many jobs am I sitting on` routed to
 * `harvest_get_api_vendor_dashboard_statistic_83` and answered *"You have 1 job."* Division **83 is in the leg id**:
 * that leg can only ever answer for Atlanta West, and it outranked the curated `vs_warranty_stats` at
 * `/api/Vendor/Dashboard/Statistic/{divisionId}/Warranty`, which takes the division as a parameter and could have
 * answered for any of the 121. A harvested capture froze one call and then shadowed the general form of itself.
 *
 * The templated leg strictly DOMINATES: it can do everything the frozen instance can, plus the rest of the axis. So
 * this drops rather than demotes. `pathAligns` (above, the route-heal matcher — the template IS the pattern) already
 * decides instance-of, which is why this is six lines and not a new idea.
 * Narrow by construction: same host, same method, the survivor must be templated, the dropped one must NOT be.
 */
export function dropShadowedLegs(legs) {
  const list = Array.isArray(legs) ? legs.filter(Boolean) : [];
  const ep = (l) => String((l.tool && l.tool.endpoint) || '');
  const host = (l) => String((l.tool && (l.tool.appHost || l.tool.origin)) || '').toLowerCase();
  const method = (l) => String((l.tool && l.tool.method) || 'GET').toUpperCase();
  const templated = list.filter((l) => ep(l).includes('{'));
  if (!templated.length) return list;
  return list.filter((l) => {
    const e = ep(l);
    if (!e || e.includes('{')) return true;                       // templated legs are never the shadowed one
    return !templated.some((t) => host(t) === host(l) && method(t) === method(l) && pathAligns(ep(t), e));
  });
}


/**
 * Score a TEMPLATED candidate shape ({method, endpoint}) against a recipe record. PURE, deterministic integers.
 * 0 = incompatible (method mismatch / empty paths). Components: recipe-as-pattern path alignment (+4 — the
 * header/query-drift case where the path itself held), resource noun (+2), shared statics (0..3), templated-
 * param-count parity (+2), operation identity (+3 — recipe body.operationName / ?operation= vs the candidate's
 * ?operation=), query-key overlap (+1).
 */
export function scoreCandidateShape(cand, recipe) {
  if (!cand || !recipe) return 0;
  if (String(cand.method || 'GET').toUpperCase() !== String(recipe.method || 'GET').toUpperCase()) return 0;
  const cs = _pathStatics(cand.endpoint).map((s) => s.toLowerCase());
  const rs = _pathStatics(recipe.endpoint).map((s) => s.toLowerCase());
  if (!cs.length || !rs.length) return 0;
  let score = 0;
  if (pathAligns(recipe.endpoint, cand.endpoint)) score += 4;                    // the path held — drift is query/header-side
  if (cs[cs.length - 1] === rs[rs.length - 1]) score += 2;                       // the resource noun survives drift
  const shared = rs.filter((s) => cs.includes(s)).length;
  const denom = Math.max(cs.length, rs.length);
  score += Math.min(3, Math.round((3 * shared) / denom));
  if (_pathParams(cand.endpoint).length === _pathParams(recipe.endpoint).length) score += 2;
  const rOp = (recipe.body && typeof recipe.body === 'object' && recipe.body.operationName) || _queryVal(recipe.endpoint, 'operation');
  const cOp = _queryVal(cand.endpoint, 'operation');
  if (rOp && cOp && String(rOp) === String(cOp)) score += 3;
  const rq = _queryKeys(recipe.endpoint); const cq = _queryKeys(cand.endpoint);
  if (rq.length && cq.length && rq.filter((k) => cq.includes(k)).length >= Math.ceil(rq.length / 2)) score += 1;
  return score;
}

/** Score ONE raw capture against a recipe (solo-templated). PURE. The single-capture face of the group scorer. */
export function matchCaptureToRecipe(capture, recipe) {
  if (!capture || !capture.url || isNoiseCapture(capture)) return 0;
  const { path, query } = parseUrl(capture.url);
  const tp = templatePath([path]); const tq = templateQuery([query]);
  return scoreCandidateShape({ method: capture.method, endpoint: tp.endpoint + (tq.query ? `?${tq.query}` : '') }, recipe);
}

/**
 * Build the HEALED shape for a matched candidate — CONSERVATIVE by construction. PURE. Returns null when nothing
 * needs healing or the rebase is unsafe. Path: kept from the RECIPE when statics are identical (the query/header-
 * drift case); rebased onto the candidate with the recipe's own {param} NAMES (positional) when path-param counts
 * match (the version-prefix case); otherwise no path heal. Query: the candidate's — it IS the working shape (its
 * constant keys stay literal, varying keys are already {templated}). Headers: the candidate's static set. Params:
 * only ADDITIVE (new placeholders get minimal specs; existing curated specs — hints/required/resolve — are never
 * replaced or removed).
 */
export function healedShapeFor(cand, recipe) {
  if (!cand || !recipe) return null;
  const rNames = _pathParams(recipe.endpoint); const cNames = _pathParams(cand.endpoint);
  let path = null;
  if (pathAligns(recipe.endpoint, cand.endpoint)) path = _epPath(recipe.endpoint);   // path held — keep OUR template verbatim ({handle} et al. stay fillable exactly as before)
  else if (rNames.length === cNames.length && rNames.length > 0) {
    let i = 0;
    path = _epPath(cand.endpoint).replace(/\{[^}]+\}/g, () => `{${rNames[i++]}}`);   // rebase: the drifted skeleton, OUR param names (the /v2-prefix class)
  } else return null;                                              // param-shape mismatch — an unsafe rebase, never guess
  const q = _epQuery(cand.endpoint);
  const endpoint = path + (q ? `?${q}` : '');
  const requestHeaders = (cand.requestHeaders && typeof cand.requestHeaders === 'object' && Object.keys(cand.requestHeaders).length) ? cand.requestHeaders : null;
  const endpointChanged = endpoint !== String(recipe.endpoint || '');
  const headersChanged = !!requestHeaders && JSON.stringify(requestHeaders) !== JSON.stringify(recipe.requestHeaders || null);
  if (!endpointChanged && !headersChanged) return null;            // identical shape — the drift is elsewhere, nothing to propose
  // additive params: placeholders NEW to the healed endpoint (not in the recipe's old endpoint, not already
  // spec'd) get a minimal candidate-typed spec. Pre-existing placeholders ({handle} via urlParam, path ids) keep
  // whatever filled them before — curated specs are never replaced or removed.
  const have = new Set((Array.isArray(recipe.params) ? recipe.params : []).map((p) => p && p.name).filter(Boolean));
  const old = new Set([..._pathParams(recipe.endpoint), ..._queryKeys(recipe.endpoint).filter((k) => _queryVal(recipe.endpoint, k) === `{${k}}`)]);
  const specs = new Map((Array.isArray(cand.params) ? cand.params : []).map((p) => [p && p.name, p]));
  const addParams = [...new Set([..._pathParams(endpoint), ..._queryKeys(endpoint).filter((k) => _queryVal(endpoint, k) === `{${k}}`)])]
    .filter((n) => n && !have.has(n) && !old.has(n))
    .map((n) => specs.get(n) || { name: n, type: 'string' });
  return {
    ...(endpointChanged ? { endpoint } : {}),
    ...(headersChanged ? { requestHeaders } : {}),
    ...(addParams.length ? { addParams } : {}),
  };
}

/** The five-second-readable DIFF lines for a heal proposal. PURE. Template-level only — never a user value. */
export function recipeHealDiff(recipe, healed) {
  const lines = [];
  if (!recipe || !healed) return lines;
  if (healed.endpoint) lines.push(`path: ${recipe.endpoint || '(none)'} → ${healed.endpoint}`);
  if (healed.requestHeaders) {
    const old = (recipe.requestHeaders && typeof recipe.requestHeaders === 'object') ? recipe.requestHeaders : {};
    for (const [k, v] of Object.entries(healed.requestHeaders)) if (old[k] !== v) lines.push(`+ header ${k}: ${String(v).slice(0, 40)}`);
    for (const k of Object.keys(old)) if (!(k in healed.requestHeaders)) lines.push(`− header ${k}`);
  }
  if (Array.isArray(healed.addParams) && healed.addParams.length) lines.push(`+ param ${healed.addParams.map((p) => p.name).join(', ')}`);
  return lines.slice(0, 10);
}

/**
 * The RH-1c batch: fresh captures × a Ground's records → heal proposals for its DRIFT-SUSPECT READ recipes. PURE.
 * Groups + templates the captures (GET/HEAD/POST — a POST group can heal a gql-READ recipe: the healed call still
 * replays the recipe's own read document through the isReadOnlyGql belts), scores each candidate shape per suspect,
 * and proposes ONLY an unambiguous winner (min score, strictly above the runner-up). Never proposes for writes.
 * @returns {Array<{recipeId: string, proposal: {at, endpoint?, requestHeaders?, addParams?, diff, fields, samples, score}}>}
 */
export function healProposalsFromCaptures(captures, recipes, { now = 0, minScore = 5 } = {}) {
  const suspects = (Array.isArray(recipes) ? recipes : []).filter((r) => r && r.driftSuspect === true
    && (String(r.method || 'GET').toUpperCase() === 'GET' || String(r.method || 'GET').toUpperCase() === 'HEAD' || (r.gql === true && r.write !== true)));
  if (!suspects.length) return [];
  const valid = (Array.isArray(captures) ? captures : []).filter((c) => c && c.url && c.method
    && ['GET', 'HEAD', 'POST'].includes(String(c.method).toUpperCase()) && !isNoiseCapture(c) && !isIdentityCall(c));
  const groups = new Map();
  for (const c of valid) {
    const key = pathKey(c.method, parseUrl(c.url).path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const cands = [];
  for (const [, group] of groups) {
    const parsed = group.map((c) => parseUrl(c.url));
    const tp = templatePath(parsed.map((p) => p.path));
    const tq = templateQuery(parsed.map((p) => p.query));
    cands.push({
      method: String(group[0].method).toUpperCase(),
      endpoint: tp.endpoint + (tq.query ? `?${tq.query}` : ''),
      params: [...tp.params, ...tq.params],
      requestHeaders: templateHeaders(group.map((c) => c.h)),
      samples: group.length,
    });
  }
  const out = [];
  for (const r of suspects) {
    const scored = cands.map((c) => ({ c, s: scoreCandidateShape(c, r) })).sort((a, b) => b.s - a.s);
    const best = scored[0]; const second = scored[1];
    if (!best || best.s < minScore) continue;
    if (second && second.s === best.s) continue;                   // a tie is ambiguity — never guess (spec §3.4)
    const healed = healedShapeFor(best.c, r);
    if (!healed) continue;
    const diff = recipeHealDiff(r, healed);
    if (!diff.length) continue;
    out.push({ recipeId: r.id, proposal: { at: Number(now), ...healed, diff, fields: Object.keys(healed), samples: best.c.samples, score: best.s } });
  }
  return out;
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
  const valid = (Array.isArray(captures) ? captures : []).filter((c) => c && c.url && c.method && !isNoiseCapture(c));   // v1300 — drop asset/beacon noise before banking
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
    if (method !== 'GET' && method !== 'HEAD') continue;   // v1304 — forage is BODY-BLIND, so a harvested WRITE is always a hollow stub (no payload to send). Reads only; real writes come from demonstrate-once (CX-8). This kills the "/hello" pseudo-writes.
    const parsed = group.map((c) => parseUrl(c.url));
    const tp = templatePath(parsed.map((p) => p.path));
    const tq = templateQuery(parsed.map((p) => p.query));
    const th = templateHeaders(group.map((c) => c.h));   // RH-0b — the STATIC app-set header shape rides the recipe (capture fidelity beats healing)
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
      ...(Object.keys(th).length ? { requestHeaders: th } : {}),   // RH-0b — absent when the app set none (records stay byte-identical); recipeToLeg hop 3 already reads it (CX-10)
    });
  }
  return { recipes, identityPath };
}
