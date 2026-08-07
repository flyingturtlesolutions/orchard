// Core/lookupRun.js — the LOOKUP run-engine (RC-1): drive a `lookup` spec against live search legs. PURE + injected.
//
// RC-0 (Core/lookupResolve.js) landed the pure RANKER. This is the orchestration around it — still pure/testable,
// because the actual leg invoke is INJECTED (`invokeSearch`), exactly like invokeRideRecipe injects `invoke`. The
// chat.js resolve seam supplies a real invokeSearch (find the viaLeg among the ground's legs, dispatch it); a test
// supplies a mock returning fixture responses. No DOM, no fetch, no clock here.
//
// Contract (DESIGN_resolve.md §2/§3): a `lookup` spec is keyed by DESTINATION param; it names `from` (which bound
// human param carries the phrase — default: the destination itself), `viaLeg`/`valueParam` (the search leg + its
// query param; arrays = try-in-order, exact-key leg first), `rows` (dotted path to the candidate rows in the
// response), and the ranker fields (match/pick/id/label/require). resolveOneLookup returns the RC-0 verdict.
//
// v2.74.2067 — RC-1.

import { getPath } from './rideParamResolve.js';
import { rankLookupCandidates } from './lookupResolve.js';

const _asArray = (v) => (v === undefined || v === null) ? [] : (Array.isArray(v) ? v : [v]);
const _str = (x) => (typeof x === 'string' && x.trim() !== '') ? x : '';

/**
 * The human phrase this lookup resolves from. `spec.from` names the bound param that carries it; when absent the
 * destination param itself carries it (the in-place case — the user typed an email into `customer_gid`). PURE.
 */
export function lookupPhrase(spec, params, destParam) {
  const src = _str(spec && spec.from) || _str(destParam);
  if (!src || !params || typeof params !== 'object') return '';
  const v = params[src];
  return (v === undefined || v === null) ? '' : String(v);
}

/** The ordered (viaLeg, valueParam) attempts. Both may be arrays — paired by index, exact-key leg first. PURE. */
export function lookupAttempts(spec) {
  if (!spec || typeof spec !== 'object') return [];
  const legs = _asArray(spec.viaLeg).filter(_str);
  const vps = _asArray(spec.valueParam).filter(_str);
  return legs.map((viaLeg, i) => ({ viaLeg, valueParam: vps[i] || vps[0] || 'query' }));
}

/** Rank a search response's rows for this spec + phrase (getPath the `rows` path, then RC-0's ranker). PURE. */
export function verdictFromResponse(spec, phrase, response) {
  const rows = _asArray(getPath(response, spec && spec.rows));
  return rankLookupCandidates(rows, spec, phrase);
}

/**
 * Drive ONE lookup destination to a verdict. Tries each (viaLeg, valueParam) in order; the first `resolved` wins
 * (exact-key leg first is the auto path). A leg that errors/returns null is `unreachable` for that attempt — try
 * the next; only if EVERY attempt is unreachable does it surface `unreachable` (headlessMap's lookup-failed-≠-miss
 * rule). A decisive-but-not-resolved verdict (ambiguous / require-failed / no-exact) is remembered and returned if
 * no later attempt resolves — never silently pick. PURE except the injected async `invokeSearch`.
 *
 * @param {(viaLegId:string, params:object)=>Promise<object|null>} invokeSearch — dispatch a search leg, return its value
 * @returns {Promise<{verdict:string, id?, label?, candidates?, clause?, viaLeg?, unreachable?:boolean}>}
 */
export async function resolveOneLookup(spec, phrase, { invokeSearch } = {}) {
  if (!_str(phrase)) return { verdict: 'blank' };
  if (typeof invokeSearch !== 'function') return { verdict: 'unreachable', unreachable: true };
  const attempts = lookupAttempts(spec);
  if (!attempts.length) return { verdict: 'unreachable', unreachable: true };
  let best = null;
  let allUnreachable = true;
  for (const { viaLeg, valueParam } of attempts) {
    let response = null;
    try { response = await invokeSearch(viaLeg, { [valueParam]: phrase }); } catch { response = null; }
    if (response === null || response === undefined) continue;   // this leg unreachable — try the next
    allUnreachable = false;
    const v = verdictFromResponse(spec, phrase, response);
    if (v.verdict === 'resolved') return { ...v, viaLeg };
    // remember the most-informative non-resolved verdict, preferring one that found candidates over a bare 'none'
    if (!best || (best.verdict === 'none' && v.verdict !== 'none')) best = { ...v, viaLeg };
  }
  if (allUnreachable) return { verdict: 'unreachable', unreachable: true };
  return best || { verdict: 'none', candidates: [] };
}

// Default "already resolved" test: a value that already looks like the id we'd produce is passed through untouched
// (the user supplied a gid, or a prior pass filled it). Shopify gids are `gid://shopify/Kind/id`; a caller with a
// different id envelope injects its own `isResolved`.
const _looksResolvedGid = (v) => typeof v === 'string' && /^gid:\/\//.test(v.trim());

/**
 * Resolve EVERY destination in a leg's `lookup` map, in place. Two shapes (DESIGN_resolve.md §2):
 *   scalar — fill params[dest] from the phrase (spec.from names the bound param, else dest itself).
 *   each   — params[dest] is an ARRAY; resolve each element's `elementKey` (e.g. line_items[].variantId).
 * A value that already looks resolved is passed through (the user gave a gid). The FIRST destination/element that
 * does not cleanly resolve returns { needs } and STOPS — never partial-dispatch a write with one wrong id.
 * PURE except the injected async `invokeSearch`. Returns { params, labels, needs }.
 *
 * @param {object} lookupMap   leg.tool.lookup — { <destParam>: <spec> }
 * @param {(viaLegId:string, params:object)=>Promise<object|null>} invokeSearch — injected leg dispatcher
 * @param {(value:*)=>boolean} [isResolved] — override the default gid shape test
 */
export async function resolveLookupParams(lookupMap, params, { invokeSearch, isResolved } = {}) {
  const out = { ...(params || {}) };
  const labels = {};
  const resolved = (typeof isResolved === 'function') ? isResolved : _looksResolvedGid;
  if (!lookupMap || typeof lookupMap !== 'object') return { params: out, labels, needs: null };
  for (const [dest, spec] of Object.entries(lookupMap)) {
    if (!spec || typeof spec !== 'object') continue;
    if (spec.each === true) {
      const key = _str(spec.elementKey) || 'id';
      const arr = Array.isArray(out[dest]) ? out[dest] : [];
      const next = [];
      for (let i = 0; i < arr.length; i++) {
        const el = (arr[i] && typeof arr[i] === 'object' && !Array.isArray(arr[i])) ? { ...arr[i] } : arr[i];
        const cur = (el && typeof el === 'object') ? el[key] : el;
        if (resolved(cur)) { next.push(el); continue; }
        const phrase = (cur === undefined || cur === null) ? '' : String(cur);
        const v = await resolveOneLookup(spec, phrase, { invokeSearch });
        if (v.verdict === 'resolved') {
          if (el && typeof el === 'object') { el[key] = v.id; next.push(el); } else next.push(v.id);
          if (v.label) labels[`${dest}[${i}]`] = v.label;
        } else {
          return { params: out, labels, needs: { param: dest, index: i, noun: _str(spec.from) || dest, raw: phrase, reason: v.verdict, candidates: v.candidates || [] } };
        }
      }
      out[dest] = next;
    } else {
      const cur = out[dest];
      if (resolved(cur)) continue;
      const phrase = lookupPhrase(spec, out, dest);
      if (!phrase) continue;   // nothing bound → let the required-param gate answer honestly
      const v = await resolveOneLookup(spec, phrase, { invokeSearch });
      if (v.verdict === 'resolved') { out[dest] = v.id; if (v.label) labels[dest] = v.label; } else {
        return { params: out, labels, needs: { param: dest, noun: _str(spec.from) || dest, raw: phrase, reason: v.verdict, candidates: v.candidates || [] } };
      }
    }
  }
  return { params: out, labels, needs: null };
}
