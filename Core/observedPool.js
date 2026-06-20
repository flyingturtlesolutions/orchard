// Core/observedPool.js — the long-tail observed pool (PS-2, v2.74.1125 · DESIGN_passive_synthesis.md §2.2).
//
// The catch-net beside the gap registry. A gap is a capability Orchard ANTICIPATED (PS-0) and the harvest (PS-1)
// confirms; the pool retains the touches that matched NO gap — controls the user actually uses that Orchard never
// thought to list. Lower-precision, lower-priority: surfaced only on a later ask-miss (PS-3 reads it as extra
// vocabulary). Keeps Move-1's exhaustiveness without letting it dominate the high-precision gap path.
//
// PURE: no chrome / DOM / LLM / storage. Value-free — only the WHERE (a11y identity + interaction kind), NEVER a
// typed value (privacy invariant §5). De-duped by (role, accessibleName, kind); seenCount is the reusability
// prior, lastSeq the recency (and PS-5 adjacency) signal.

const SCHEMA = 1;
const DEFAULT_MAX = 120;

const _clamp = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n) : t; };

/** Stable dedup key for an observed control. PURE. */
export function poolKey(role, accessibleName, kind) {
  return [_clamp(role, 40).toLowerCase(), _clamp(accessibleName, 120).toLowerCase(), _clamp(kind, 24).toLowerCase()].join('|');
}

/**
 * Append (or re-count) an observation. Returns a NEW array, or the SAME ref unchanged when there's no usable
 * accessibleName (so the caller's RMW chain can skip the write). De-dups by key; bumps seenCount + lastSeq on a
 * repeat; caps by evicting the least-seen / oldest. PURE.
 * @param {Array<object>} pool
 * @param {{role?:string, accessibleName?:string, kind?:string}} obs
 * @param {{seq?:number, now?:number, max?:number}} [opts]
 */
export function addObservation(pool, obs, opts = {}) {
  const name = _clamp(obs && obs.accessibleName, 120);
  if (!name) return Array.isArray(pool) ? pool : [];          // value-free identity needs at least a name
  const role = _clamp(obs && obs.role, 40).toLowerCase() || null;
  const kind = _clamp(obs && obs.kind, 24).toLowerCase() || 'click';
  const seq = Number.isFinite(opts.seq) ? opts.seq : (Number.isFinite(opts.now) ? opts.now : 0);
  const max = Number.isFinite(opts.max) ? opts.max : DEFAULT_MAX;
  const key = poolKey(role, name, kind);
  const out = (Array.isArray(pool) ? pool : []).map((e) => ({ ...e }));
  const prev = out.find((e) => e.key === key);
  if (prev) {
    prev.seenCount = (Number.isFinite(prev.seenCount) ? prev.seenCount : 1) + 1;
    prev.lastSeq = seq;
  } else {
    out.push({ key, role, accessibleName: name, kind, seenCount: 1, lastSeq: seq });
  }
  if (out.length > max) {
    out.sort((a, b) => (b.seenCount - a.seenCount) || (b.lastSeq - a.lastSeq));
    return out.slice(0, max);
  }
  return out;
}

/** The most-reused observations first (for PS-3 vocabulary). PURE. */
export function topObservations(pool, n = 20) {
  return (Array.isArray(pool) ? pool : [])
    .slice()
    .sort((a, b) => (b.seenCount - a.seenCount) || (b.lastSeq - a.lastSeq))
    .slice(0, Math.max(0, n));
}

/** To the stored shape `{schema, observations}`. PURE. */
export function serializePool(pool) {
  return { schema: SCHEMA, observations: (Array.isArray(pool) ? pool : []) };
}

/** From the stored shape, dropping anything malformed. PURE. */
export function deserializePool(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.observations)) return [];
  return raw.observations.filter((e) => e && e.key && e.accessibleName);
}
