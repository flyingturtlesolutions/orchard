// Core/routeHeal.js — RH-1a (DESIGN_route_heal.md §3 step 1): DETECT — route-miss classification + the drift-suspect
// state machine over per-Ground ride-recipe records. PURE: no chrome / DOM / LLM / clock (`now` is injected).
//
// A ROUTE MISS is the RH-0a failure signature (the Shopify ?operation&type lesson, v1564): 404/405/410 with NO
// structured JSON error body — the server never routed the request to a handler. Distinguishable by construction
// from the other failure families: auth presents as 401/403/signed-out verdicts upstream; bad params as 400/422;
// an app's genuine "record not found" carries its own JSON error body (jsonBody true → NOT a miss); a genuine
// empty result is a 200. N consecutive misses on a PROVEN recipe → `driftSuspect` (the RH-1b arm proposal's
// trigger). The state fields (lastOkAt / missStreak / driftSuspect) are USER-STATE-class — rideRecipe._USER_FIELDS
// preserves them across a curated re-seed (v1435 merge), so a catalog refresh never erases the drift evidence.

export const ROUTE_MISS_STATUSES = Object.freeze([404, 405, 410]);
export const DRIFT_MISS_N = 2;                    // consecutive route misses → suspect (spec §3.1: start N=2; tune live)
export const OK_STAMP_MIN_MS = 6 * 3600 * 1000;   // re-stamp lastOkAt at most every 6h — freshness granularity, not a per-read storage write (fan-outs run ×20)

/**
 * Is this failure ROUTE-MISS-class? PURE. `status` (number) or an `error` string in the house 'http-404' form;
 * `jsonBody` true when the failure body parsed as structured JSON (the app answered — a real API error, not a
 * route miss). 401/403 (auth), 400/422 (params), 5xx (server fault) are all NOT misses.
 */
export function isRouteMiss({ status = null, error = '', jsonBody = false } = {}) {
  let s = Number(status) || 0;
  if (!s) { const m = String(error || '').match(/^http-(\d{3})$/); if (m) s = Number(m[1]); }
  return ROUTE_MISS_STATUSES.includes(s) && jsonBody !== true;
}

/**
 * PROVEN = this recipe's shape was right at least once: curated (catalog-authored from a working capture), or any
 * prior success stamp. RH-1 heals PROVEN shapes only — an unproven harvested recipe that 404s was simply never
 * right, and flagging it as "drifted" would propose healing a shape that never worked.
 */
export function isProven(record) {
  return !!(record && (record.provenance === 'curated' || record.lastOkAt));
}

/**
 * SUCCESS tick: stamp `lastOkAt` + clear any drift state (the spec's verify-ratchet — a working call is the
 * proof that ends suspicion). PURE. Returns the updated record, or null when nothing needs persisting (already
 * stamped within OK_STAMP_MIN_MS and no drift state to clear) — the caller skips the storage write on null.
 * @returns {null | { record: object, cleared: boolean }} cleared = a driftSuspect flag was just resolved
 */
export function tickOk(record, now) {
  if (!record || typeof record !== 'object') return null;
  const hadDrift = (Number(record.missStreak) || 0) > 0 || record.driftSuspect === true;
  const stale = !record.lastOkAt || (Number(now) - Number(record.lastOkAt)) >= OK_STAMP_MIN_MS;
  if (!hadDrift && !stale) return null;
  const out = { ...record, lastOkAt: Number(now) };
  if (hadDrift) { out.missStreak = 0; out.driftSuspect = false; }
  return { record: out, cleared: record.driftSuspect === true };
}

/**
 * ROUTE-MISS tick: count the consecutive miss; at DRIFT_MISS_N the record becomes `driftSuspect`. PURE. Only
 * PROVEN records tick (see isProven). A non-miss failure (auth/params/5xx) is neither a tick nor a clear — it is
 * no evidence about the route either way; the caller simply doesn't call this for those.
 * @returns {null | { record: object, becameSuspect: boolean, streak: number }}
 */
export function tickRouteMiss(record, now) {
  if (!isProven(record)) return null;
  const streak = (Number(record.missStreak) || 0) + 1;
  const suspect = streak >= DRIFT_MISS_N;
  const out = { ...record, missStreak: streak };
  if (suspect) { out.driftSuspect = true; if (!record.driftSuspect) out.driftAt = Number(now); }
  return { record: out, becameSuspect: suspect && record.driftSuspect !== true, streak };
}

/**
 * RH-1c APPLY (v2.74.1567, spec §3.5): accept a heal proposal onto the record. PURE. READS ONLY — the §4 hard
 * line: a GET/HEAD, or a read-only GraphQL POST (the caller validates the document via isReadOnlyGql and passes
 * `gqlReadOk`; a `write` recipe never heals — its shape change means changed semantics → full §18 re-review).
 * Applies endpoint / merged requestHeaders / ADDITIVE params (curated specs are never replaced), stamps the same
 * fields into `healOverride` — the shadow the v1435 curated-refresh merge re-asserts until the catalog itself
 * carries the fix — clears the proposal + missStreak, stamps `healedAt`. `driftSuspect` deliberately STAYS: the
 * next invoke is the trial (RH-1d) — tickOk's success clears it; failure keeps the suspicion honest.
 * @returns {null | { record: object, fields: string[] }}
 */
export function applyHeal(record, now, { gqlReadOk = false } = {}) {
  const p = record && record.healProposal;
  if (!p || typeof p !== 'object') return null;
  const m = String(record.method || 'GET').toUpperCase();
  const isRead = m === 'GET' || m === 'HEAD' || (record.gql === true && record.write !== true && gqlReadOk === true);
  if (!isRead) return null;
  const fields = {};
  if (typeof p.endpoint === 'string' && p.endpoint) fields.endpoint = p.endpoint;
  if (p.requestHeaders && typeof p.requestHeaders === 'object' && Object.keys(p.requestHeaders).length) {
    fields.requestHeaders = { ...((record.requestHeaders && typeof record.requestHeaders === 'object') ? record.requestHeaders : {}), ...p.requestHeaders };
  }
  if (!Object.keys(fields).length) return null;
  if (Array.isArray(p.addParams) && p.addParams.length) {
    const have = new Set((Array.isArray(record.params) ? record.params : []).map((x) => x && x.name));
    const add = p.addParams.filter((x) => x && x.name && !have.has(x.name));
    if (add.length) fields.params = [...(Array.isArray(record.params) ? record.params : []), ...add];
  }
  const out = { ...record, ...fields, healOverride: { ...fields }, healedAt: Number(now), missStreak: 0 };
  delete out.healProposal;
  return { record: out, fields: Object.keys(fields) };
}

/** Dismiss a heal proposal (the record is otherwise untouched — the suspect state stays honest). PURE. */
export function dismissHeal(record) {
  if (!record || !record.healProposal) return null;
  const out = { ...record };
  delete out.healProposal;
  return out;
}
