// Core/rideCache.js — v2.74.1881 — the ROW CACHE: a read's response, keyed by the request that produced it.
//
// WHY. A `(division, status)` list read is the atom of every expensive operation on this surface — find, aggregate,
// rollup, digest, diff. A 484-cell scan fetches the entire warranty corpus and then throws all of it away except
// the one row it was looking for. The fetch is the cost; the filter is free.
//
// ── THE DISCIPLINE THIS CARRIES, and the reason it is not just a Map ──────────────────────────────────────────
// Every entry knows its AGE, and `get` will not return one without being told what age is acceptable. This whole
// session has been about verdicts that outran their evidence — a 200-row cap reported as exhaustive (v1874), a
// definite negative over a selection (v1877), an estimate never checked against the observation (v1878). A cache is
// the easiest place yet to reintroduce that class: serve a two-minute-old count as though it were live and the
// system is confidently wrong again, in a new layer, with no line in the trace saying so. So:
//   · `maxAgeMs` is a REQUIRED argument to get() in spirit — 0 means "nothing cached is acceptable", and that is the
//     default at every call site until a caller states otherwise.
//   · a hit returns its `ageMs`, so the consumer can put it in a receipt or a sentence.
//   · POPULATE is separate from SERVE. Everything that reads may fill the cache; only a consumer whose answer is
//     age-INSENSITIVE may read from it. "Which division holds task 4867009" is stable — a TaskId does not migrate.
//     "How many are open right now" is not, and must never be served from here without stating the age.
//
// Keyed on the REQUEST, not on the leg: origin + method + recipe + the canonical params. Over-keying costs a missed
// hit (invisible); under-keying returns another cell's rows (a wrong answer) — so the trade is deliberately lopsided.
// v2.74.1887 — WITH ONE CORRECTION: a param that CANNOT reach the wire is not part of the request, and keying on it
// is pure loss rather than a safe margin (see `wireParamNames`).

const _s = (v) => (v == null ? '' : String(v));

/**
 * v2.74.1887 — the param names that can REACH THE WIRE for this leg. PURE. `null` = can't tell → key on everything.
 *
 * WHY. `address` on `vs_warranty_tasks` is not in the endpoint, and the catalog says so in the param's own comment
 * ("NOT in the endpoint — the drill join's filter"): it names an identifier the ROW FILTER matches client-side, after
 * the read. Keying on it meant three text-search fans (gl 2026-07-30 08:50) issued 363 reads under 363 distinct keys
 * for byte-identical requests — the cache could not hit even in principle. Over-keying is the safe side of the trade
 * for a param that MIGHT alter the response; it is pure loss for one the leg knows never leaves the client.
 *
 * The wire surface is the TEMPLATE PLACEHOLDERS — what `fillEndpoint` fills in the endpoint/origin and `fillBody`
 * fills in a body template — plus `urlParam`, kept deliberately: its value is re-derived from the ride TAB, so a
 * caller-supplied one never reaches the request, but it still stands in for WHICH workspace was read.
 *
 * CONSERVATIVE BY CONSTRUCTION: no placeholder found → `null`, and the caller keys on every param exactly as before.
 * A broker/oauth leg (args are the payload, no endpoint template) therefore keeps today's behaviour untouched, and
 * the narrowing only ever applies to a leg that declares what its request is made of.
 */
export function wireParamNames(leg) {
  const t = (leg && leg.tool) || {};
  const parts = [_s(t.endpoint), _s(t.origin)];
  if (t.body && typeof t.body === 'object') { try { parts.push(JSON.stringify(t.body)); } catch { /* an unstringifiable body → the placeholders we already have */ } }
  const names = new Set();
  for (const part of parts) {
    for (const m of part.matchAll(/\{([a-zA-Z_][\w-]*)\}/g)) names.add(m[1]);
  }
  if (!names.size) return null;                       // nothing declared → we cannot tell; key on everything
  const up = t.urlParam && t.urlParam.name;
  if (up) names.add(String(up));
  return names;
}

/** The request identity for a read. PURE. */
export function rideCacheKey(leg, params) {
  const t = (leg && leg.tool) || {};
  const host = _s(t.origin || t.appHost).toLowerCase();
  const method = _s(t.method || 'GET').toUpperCase();
  const id = _s(t.recipeId || (leg && leg.key));
  const p = (params && typeof params === 'object') ? params : {};
  const wire = wireParamNames(leg);
  const canon = Object.keys(p).filter((k) => !wire || wire.has(k)).sort().map((k) => `${k}=${_s(p[k])}`).join('&');
  return `${host}|${method}|${id}|${canon}`;
}

/** The host segment of a key, for host-scoped invalidation. PURE. */
export function hostOfKey(key) {
  return _s(key).split('|')[0];
}

/**
 * A bounded, age-aware read cache. `max` bounds a long session rather than a single scan (484 cells is one sweep;
 * several sweeps plus fans is what accumulates). Eviction is oldest-first, which is right here because staleness and
 * insertion order agree — this is a TTL cache, not an LRU, so re-reading an entry does not make it fresher.
 */
export function makeRideCache({ max = 600 } = {}) {
  const m = new Map();
  return {
    /** A hit only when it is younger than `maxAgeMs`. Returns { value, ageMs } or null. 0/absent → never a hit. */
    get(key, maxAgeMs = 0, now = Date.now()) {
      if (!(maxAgeMs > 0)) return null;
      const hit = m.get(key);
      if (!hit) return null;
      const ageMs = now - hit.at;
      if (ageMs > maxAgeMs) return null;
      return { value: hit.value, ageMs };
    },
    set(key, value, now = Date.now()) {
      if (!key || value == null) return;
      if (m.has(key)) m.delete(key);        // re-insert so insertion order stays age order
      m.set(key, { at: now, value });
      while (m.size > max) { const oldest = m.keys().next().value; if (oldest === undefined) break; m.delete(oldest); }
    },
    /** Everything for one host — the invalidation a WRITE needs: a created/updated record changes lists we hold. */
    clearHost(host) {
      const h = _s(host).toLowerCase();
      let n = 0;
      for (const k of [...m.keys()]) if (hostOfKey(k) === h) { m.delete(k); n++; }
      return n;
    },
    clear() { const n = m.size; m.clear(); return n; },
    size() { return m.size; },
  };
}
