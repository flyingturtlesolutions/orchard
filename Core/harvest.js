// DORMANT (stamped 2026-08-07, dead-code audit) — §15/A2 row-correlation: NO live consumer yet by design.
// Revive trigger: a canHarvest producer / the §15 read-leg build (DESIGN_connectors.md §15, build-order rows).
// Kept tested (harvest.test.js is the consumer) per the forageFrontier park pattern; delete only as a PACKAGE
// with readLeg's network-harvest gate + the §15/A2 spec rows.
// Core/harvest.js — pure network-harvest correlation + extraction (DESIGN_connectors.md §15, A2). CX-9 slice 2 (pure core).
// v2.74.1159.
//
// PURE: no chrome / DOM / LLM / storage. The live MAIN-world fetch/XHR tee (the next, impure slice) captures every
// response the page makes during a driven step; THIS module is the algorithm that picks THE result-bearing call
// out of that noise and pulls the rows. The hard part of A2 (§15 "Correlation"): one submit fires several XHRs —
// analytics, autocomplete, the search, lazy sub-fetches. We keep only calls that match the leg (endpoint + method
// + JSON + 2xx), prefer the one whose request carried the query, tie-break by row-count then recency, then extract
// the rows via the leg's `result` JSON-path.
//
// A captured call (what the tee emits, normalized): { url, method, status, contentType, requestBody?, json?, at? }
//   json        — the PARSED response body (the tee JSON-parses 2xx responses)
//   requestBody — the request payload (string|object) used for query correlation
//   at          — a monotonic timestamp the tee stamps (kept caller-supplied so this module stays pure)

const _str = (x) => (typeof x === 'string' ? x.trim() : '');

/**
 * Read a dotted JSON path out of a parsed body: 'results' · 'data.tickets' · 'hits.hits.0' · 'hits[0].x'. PURE.
 * Empty/missing path returns the body itself (a bare-array endpoint). Returns undefined on any missing segment.
 */
export function jsonPath(obj, path) {
  const p = _str(path);
  if (!p) return obj;
  const segs = p.replace(/\[(\d+)\]/g, '.$1').split('.').map((s) => s.trim()).filter(Boolean);
  let cur = obj;
  for (const seg of segs) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Does a captured call look like the harvest leg's result-bearing endpoint? PURE. URL must contain the leg's
 * `match`; method (if the leg pins one) must agree; a known status must be 2xx; and the body must be JSON (by
 * content-type OR a parsed `json` already present). An unknown status/method is TOLERATED (the tee may omit it).
 */
export function callMatchesLeg(call, leg) {
  const c = (call && typeof call === 'object') ? call : null;
  const l = (leg && typeof leg === 'object') ? leg : null;
  if (!c || !l || !l.match) return false;
  if (!_str(c.url).includes(l.match)) return false;
  if (l.method && c.method && String(c.method).toUpperCase() !== String(l.method).toUpperCase()) return false;
  const status = Number(c.status);
  if (Number.isFinite(status) && (status < 200 || status >= 300)) return false;   // 2xx only; unknown tolerated
  if (c.json == null && !/json/i.test(_str(c.contentType))) return false;          // must be JSON
  return true;
}

const _rowsOf = (call, leg) => {
  const r = jsonPath(call && call.json, leg && leg.result);
  return (r === undefined) ? null : r;
};
const _count = (rows) => (Array.isArray(rows) ? rows.length : (rows != null ? 1 : 0));

/**
 * Pick THE result-bearing call out of the captured set and extract its rows. PURE (§15 correlation).
 *   1. keep only calls matching the leg (callMatchesLeg);
 *   2. rank: request-carried-the-query first, then most rows, then most recent;
 *   3. extract rows via the leg's `result` JSON-path.
 * `query` is an optional correlation hint (the search term the driven step typed). Returns { call, rows, reason };
 * call/rows are null when nothing matched.
 */
export function matchHarvest(calls, leg, { query } = {}) {
  const list = (Array.isArray(calls) ? calls : []).filter((c) => callMatchesLeg(c, leg));
  if (!list.length) return { call: null, rows: null, reason: 'no-match' };
  const q = _str(query).toLowerCase();
  const carriedQuery = (c) => {
    if (!q) return false;
    const body = (typeof c.requestBody === 'string') ? c.requestBody : (c.requestBody ? JSON.stringify(c.requestBody) : '');
    return `${_str(c.url)} ${body}`.toLowerCase().includes(q);
  };
  const scored = list.map((c) => {
    const rows = _rowsOf(c, leg);
    return { c, rows, n: _count(rows), qb: carriedQuery(c) ? 1 : 0, at: Number(c.at) || 0 };
  });
  scored.sort((a, b) => (b.qb - a.qb) || (b.n - a.n) || (b.at - a.at));
  const top = scored[0];
  const reason = `matched ${list.length} → chose ${top.qb ? 'query+' : ''}rows=${top.n}`;
  return { call: top.c, rows: top.rows, reason };
}
