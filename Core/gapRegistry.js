// Core/gapRegistry.js — the capability-gap registry (PS-0, v2.74.1123 · DESIGN_passive_synthesis.md §2.1).
//
// The INVERSE of a Perspective. A Perspective records what Orchard CAN do here (accepted, verified); the gap
// registry records what Orchard SHOULD be able to do here — world-knowledge-declared, unfulfilled. It turns
// Orchard's reflective "how could you do better?" enumeration (today generated, then THROWN AWAY) into a
// durable, per-Ground DEMAND signal. PS-1 arms these gaps into the interaction monitor so the user's ordinary
// actions fulfill them; synthesis (PS-3/4) promotes a fulfilled gap into a real capability.
//
// PURE: no chrome / DOM / LLM / storage. The plausibility "grounding gate" (don't record gaps the page can't
// fulfill — §2.1 pushback #2) is applied UPSTREAM at enumeration time (gapPrompt.js fences the page url +
// affordances and asks only for plausible gaps); this module records, dedups, and ages what it is given. The
// affordance-cross-check ARMING gate (open -> armed) lands in PS-1, where it gates monitor demand.
//
// A gap record:
//   { key, intent, verbHint, expectedIdentity:{role,namePattern}|null,
//     status:'open'|'armed'|'harvested'|'promoted'|'dismissed', seenCount, createdAt, updatedAt }

const SCHEMA = 1;
const DEFAULT_MAX = 60;
export const GAP_STATUSES = ['open', 'armed', 'harvested', 'promoted', 'dismissed'];
// Cap-eviction priority: an earned gap (promoted/armed/harvested) outranks an open one; dismissed is dropped first.
const STATUS_RANK = { promoted: 5, armed: 4, harvested: 3, open: 2, dismissed: 1 };

const _clamp = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n) : t; };

/** Stable dedup key from an intent string (case/punctuation/whitespace-insensitive). PURE. */
export function gapKey(intent) {
  return String(intent ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Coerce a raw enumerated item into a fresh 'open' gap record. Returns null if there's no usable intent. PURE.
 * @param {{intent?:string, verbHint?:string, expectedIdentity?:{role?:string,namePattern?:string}}} raw
 * @param {number} [now] timestamp (injected — no Date.now here)
 */
export function normalizeGap(raw, now = 0) {
  const intent = _clamp(raw && raw.intent, 120);
  const key = gapKey(intent);
  if (!intent || !key) return null;
  const verbHint = _clamp(raw && raw.verbHint, 24).toLowerCase() || null;
  let expectedIdentity = null;
  const ei = raw && raw.expectedIdentity;
  if (ei && typeof ei === 'object') {
    const role = _clamp(ei.role, 40).toLowerCase() || null;
    const namePattern = _clamp(ei.namePattern, 80) || null;
    if (role || namePattern) { expectedIdentity = {}; if (role) expectedIdentity.role = role; if (namePattern) expectedIdentity.namePattern = namePattern; }
  }
  return { key, intent, verbHint, expectedIdentity, status: 'open', seenCount: 1, createdAt: now, updatedAt: now };
}

function _cmpForEvict(a, b) {
  const sr = (STATUS_RANK[b.status] || 0) - (STATUS_RANK[a.status] || 0);
  if (sr) return sr;
  if ((b.seenCount || 0) !== (a.seenCount || 0)) return (b.seenCount || 0) - (a.seenCount || 0);
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

/**
 * Merge freshly-enumerated candidates into the existing registry. PURE (returns a new array).
 *  - a NEW key  -> appended as a fresh 'open' gap
 *  - a SEEN key -> bump seenCount + recency, backfill missing hints, but NEVER reset status
 *                  (a 'promoted'/'armed'/'dismissed' gap must not regress to 'open' on re-enumeration)
 *  - capped at opts.max, evicting the lowest-priority gaps first (dismissed/open before earned ones)
 * @param {Array<object>} existing
 * @param {Array<object>} candidates  raw enumerated items
 * @param {{now?:number, max?:number}} [opts]
 */
export function mergeGaps(existing, candidates, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : 0;
  const max = Number.isFinite(opts.max) ? opts.max : DEFAULT_MAX;
  const out = (Array.isArray(existing) ? existing : []).map((g) => ({ ...g }));
  const byKey = new Map(out.map((g) => [g.key, g]));
  for (const raw of (Array.isArray(candidates) ? candidates : [])) {
    const g = normalizeGap(raw, now);
    if (!g) continue;
    const prev = byKey.get(g.key);
    if (prev) {
      prev.seenCount = (Number.isFinite(prev.seenCount) ? prev.seenCount : 1) + 1;
      prev.updatedAt = now;
      if (g.verbHint && !prev.verbHint) prev.verbHint = g.verbHint;
      if (g.expectedIdentity && !prev.expectedIdentity) prev.expectedIdentity = g.expectedIdentity;
    } else {
      out.push(g);
      byKey.set(g.key, g);
    }
  }
  if (out.length > max) { out.sort(_cmpForEvict); return out.slice(0, max); }
  return out;
}

/** Transition one gap to a new status (immutable). Unknown status or key is a no-op. PURE. */
export function setStatus(gaps, key, status, now = 0) {
  if (!GAP_STATUSES.includes(status)) return Array.isArray(gaps) ? gaps : [];
  return (Array.isArray(gaps) ? gaps : []).map((g) => (g && g.key === key ? { ...g, status, updatedAt: now } : g));
}

const _nameMatches = (pattern, name) => {
  const p = String(pattern ?? '').toLowerCase().trim();
  if (!p) return false;
  try { return new RegExp(p, 'i').test(name); } catch { return name.includes(p); }
};

/**
 * PS-1 — deterministically match a captured interaction target to an OPEN gap (the harvest signal): a user
 * clicked an UNKNOWN control; does its a11y identity fulfil a declared gap? Matches on the gap's
 * `expectedIdentity` — `namePattern` (required; tested as a regex, falling back to substring, against the
 * control's accessibleName) gated by `role` (when BOTH are known they must agree). Only 'open' gaps are eligible
 * (an earned gap is never re-harvested). Returns the gap key, or null. PURE.
 * @param {{role?:string, accessibleName?:string}} target  the captured interaction target descriptor
 * @param {Array<object>} gaps
 * @returns {string|null}
 */
export function matchInteractionToGap(target, gaps) {
  const name = String(target?.accessibleName ?? '').toLowerCase().trim();
  if (!name) return null;                                   // need an accessible name to match on
  const role = String(target?.role ?? '').toLowerCase().trim();
  for (const g of (Array.isArray(gaps) ? gaps : [])) {
    if (!g || g.status !== 'open' || !g.expectedIdentity || !g.expectedIdentity.namePattern) continue;
    if (g.expectedIdentity.role && role && g.expectedIdentity.role !== role) continue;   // role, when both known, must agree
    if (_nameMatches(g.expectedIdentity.namePattern, name)) return g.key;
  }
  return null;
}

/**
 * PS-1 — record a passive fulfilment: flip the matched gap to 'harvested' and attach the fulfilling control's
 * a11y IDENTITY (the WHERE — never a typed value; privacy invariant §5). PS-3 materialises a selector from this
 * via probe-or-recover. Immutable; a non-matching key is a no-op. PURE.
 * @param {Array<object>} gaps  @param {string} key  @param {{role?:string,accessibleName?:string,tagName?:string}} fulfillment  @param {number} [now]
 */
export function recordFulfillment(gaps, key, fulfillment, now = 0) {
  return (Array.isArray(gaps) ? gaps : []).map((g) => {
    if (!g || g.key !== key) return g;
    const f = {
      role: _clamp(fulfillment && fulfillment.role, 40).toLowerCase() || null,
      accessibleName: _clamp(fulfillment && fulfillment.accessibleName, 120) || null,
      tagName: _clamp(fulfillment && fulfillment.tagName, 40).toLowerCase() || null,
      seenAt: now,
    };
    return { ...g, status: 'harvested', updatedAt: now, fulfillment: f };
  });
}

const _ASK_STOP = new Set(['the', 'a', 'an', 'to', 'of', 'on', 'in', 'for', 'my', 'this', 'that', 'it', 'please', 'can', 'you', 'could', 'would', 'and', 'with', 'me', 'is']);
const _askTokens = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !_ASK_STOP.has(t));

/**
 * PS-4 — match a user ask to the best HARVESTED gap (the reactive synthesis trigger). Deterministic keyword
 * overlap over gap intents — for the param-free single-click case the ask IS basically the action word
 * ("subscribe", "pause"). Returns the gap key, or null when nothing meaningfully overlaps; the caller then falls
 * through to its existing dead-end, so this is STRICTLY ADDITIVE (sometimes synthesizes, never worse). An LLM
 * gap-judge can refine the fuzzy tail later. PURE.
 * @param {string} ask  @param {Array<object>} gaps  @param {{status?:string}} [opts]
 * @returns {string|null}
 */
export function matchAskToGap(ask, gaps, { status = 'harvested' } = {}) {
  const at = _askTokens(ask);
  if (!at.length) return null;
  let best = null, score = 0;
  for (const g of (Array.isArray(gaps) ? gaps : [])) {
    if (!g || (status && g.status !== status)) continue;
    const gt = _askTokens(g.intent);
    const overlap = at.filter((t) => gt.includes(t)).length;
    if (overlap > score) { score = overlap; best = g.key; }
  }
  return score > 0 ? best : null;
}

/** Status histogram (for logging / the PS-6 inspector). PURE. */
export function summarizeGaps(gaps) {
  const out = { total: 0, open: 0, armed: 0, harvested: 0, promoted: 0, dismissed: 0 };
  for (const g of (Array.isArray(gaps) ? gaps : [])) {
    if (g && out[g.status] != null) { out[g.status] += 1; out.total += 1; }
  }
  return out;
}

/** To the stored shape `{schema, gaps}`. PURE. */
export function serializeGaps(gaps) {
  return { schema: SCHEMA, gaps: (Array.isArray(gaps) ? gaps : []) };
}

/** From the stored shape, dropping anything malformed. PURE. */
export function deserializeGaps(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.gaps)) return [];
  return raw.gaps.filter((g) => g && g.key && g.intent && GAP_STATUSES.includes(g.status));
}
