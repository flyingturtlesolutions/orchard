// Core/groundReadiness.js — G1-3: a Ground's READINESS for unattended use, derived
// PURELY from substrate counts (no chrome / DOM / storage), mirroring the other Core
// modules. The auto-explore orchestrator gates on this: an `empty` Ground must be
// explored before anything can run; a `capable` one can replay existing capabilities.

export const READINESS_STATES = ['empty', 'preparing', 'capable', 'rich'];
export const READINESS_RANK = { empty: 0, preparing: 1, capable: 2, rich: 3 };

// "rich" thresholds — broad, multi-page coverage (not a one-page toy Ground).
const RICH_CAPS = 5;
const RICH_LOCALES = 3;

/**
 * Classify a Ground's readiness from its substrate counts. Monotonic — more substrate
 * never lowers the state:
 *   empty     — nothing explored, nothing authored (a freshly-minted Ground)
 *   preparing — territory seen (≥1 Locale modeled OR ≥1 siteMap node) but NO authored capability yet
 *   capable   — ≥1 authored capability (can actually DO something)
 *   rich      — broad coverage (≥RICH_CAPS capabilities AND ≥RICH_LOCALES locales)
 * @param {{ localeCount?:number, capabilityCount?:number, siteMapNodeCount?:number }} [counts]
 * @returns {{ state:string, rank:number, signals:{localeCount:number,capabilityCount:number,siteMapNodeCount:number} }}
 */
export function groundReadiness({ localeCount = 0, capabilityCount = 0, siteMapNodeCount = 0 } = {}) {
  const locales = Math.max(0, Math.trunc(Number(localeCount) || 0));
  const caps    = Math.max(0, Math.trunc(Number(capabilityCount) || 0));
  const nodes   = Math.max(0, Math.trunc(Number(siteMapNodeCount) || 0));
  let state;
  if (caps >= RICH_CAPS && locales >= RICH_LOCALES) state = 'rich';
  else if (caps >= 1) state = 'capable';
  else if (locales >= 1 || nodes >= 1) state = 'preparing';
  else state = 'empty';
  return { state, rank: READINESS_RANK[state], signals: { localeCount: locales, capabilityCount: caps, siteMapNodeCount: nodes } };
}

/** True when `state` is at least `min` on the readiness ladder (rank-compare). Unknown → false. */
export function isReadyAtLeast(state, min) {
  const r = READINESS_RANK[state];
  const m = READINESS_RANK[min];
  if (r == null || m == null) return false;
  return r >= m;
}
