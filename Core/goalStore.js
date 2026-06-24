// Core/goalStore.js — AL-2 (v2.74.1191): the per-app goal-memory store — pure list-ops over goalMemory items
// (DESIGN_apps_learning.md §9 AL-2). PURE: no chrome / DOM / storage / clock.
//
// The store SEMANTICS over an array of beliefs/deltas (Core/goalMemory.js): content-addressed ids so re-recording
// the same claim MERGES (corroboration, not duplication), tiered/confidence-ranked query (the retrieval primitive
// AL-4 builds on), a small rollup, and a growth cap that protects canonical/summary while pruning the cheap tiers.
// The thin chrome.storage persistence (keyed by appId) lands with AL-3's first write-back caller — no dead code here.
//
// Stored item = a normalized goalMemory item + two STORE fields: `id` (content hash) and `evidence` (corroboration
// count — how many times this claim has been re-recorded; it FEEDS the promotion gate: 2+ corroborations is the
// hypothesis→confirmed threshold, §4).

import { normalizeMemoryItem, promote, tierRank, TIERS } from './goalMemory.js';

// djb2 → base36, the same id style as Core/outcomes.hashId / Core/locale. PURE + deterministic (no clock/random).
function _hash(s) {
  const str = String(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The dedup/content KEY for an item: kind | trigger | body, lowercased. PURE. '' for an unusable item. */
export function goalItemKey(item) {
  const i = normalizeMemoryItem(item);
  if (!i) return '';
  return `${i.kind}|${(i.trigger || '').toLowerCase()}|${i.body.toLowerCase()}`;
}

/** A stable CONTENT id (so add is idempotent — same claim → same id → merge). PURE. '' for an unusable item. */
export function goalItemId(item) {
  const k = goalItemKey(item);
  return k ? `gm-${_hash(k)}` : '';
}

/**
 * Add a belief/delta — or MERGE a duplicate (same content id). PURE, copy-on-write. A re-add is CORROBORATION: keep
 * the higher tier, the max confidence, the freshest provenance, and bump `evidence`. An unusable raw item is ignored.
 */
export function addItem(items, raw) {
  const item = normalizeMemoryItem(raw);
  const list = Array.isArray(items) ? items : [];
  if (!item) return [...list];
  const id = goalItemId(item);
  const idx = list.findIndex((x) => x && x.id === id);
  if (idx < 0) return [...list, { ...item, id, evidence: 1 }];
  const cur = list[idx];
  const merged = {
    ...cur,
    confidence: Math.max(cur.confidence ?? 0, item.confidence),
    tier: tierRank(item.tier) > tierRank(cur.tier) ? item.tier : cur.tier,
    provenance: item.provenance || cur.provenance,
    evidence: (Number.isFinite(cur.evidence) ? cur.evidence : 1) + 1,
  };
  const next = [...list]; next[idx] = merged; return next;
}

/**
 * Promote one item a tier (copy-on-write), routing through goalMemory.promote's gate. PURE. Unsupplied evidenceCount
 * defaults to the item's accumulated `evidence`, so corroboration drives the hypothesis→confirmed step. Keeps id +
 * evidence. No-op if the id is missing or the gate doesn't clear.
 */
export function promoteItemInList(items, id, signals = {}) {
  const list = Array.isArray(items) ? items : [];
  const idx = list.findIndex((x) => x && x.id === id);
  if (idx < 0) return [...list];
  const cur = list[idx];
  const ev = Number.isFinite(cur.evidence) ? cur.evidence : 1;
  const promoted = promote(cur, { evidenceCount: ev, ...signals });
  if (!promoted) return [...list];
  const next = [...list]; next[idx] = { ...promoted, id, evidence: ev }; return next;
}

/** Remove an item by id. PURE. */
export function removeItem(items, id) {
  const key = String(id || '');
  return (Array.isArray(items) ? items : []).filter((x) => x && x.id !== key);
}

/**
 * Query the store: filter by kind / tier-floor / min-confidence, ranked tier-desc then confidence-desc (the most
 * canonical, most confident first — the retrieval order AL-4 budgets a context window from). PURE.
 */
export function queryItems(items, { kind = null, minTier = null, minConfidence = 0 } = {}) {
  const minR = (minTier && TIERS.includes(minTier)) ? tierRank(minTier) : -1;
  return (Array.isArray(items) ? items : [])
    .filter((x) => x && x.id && (!kind || x.kind === kind) && tierRank(x.tier) >= minR && (x.confidence ?? 0) >= minConfidence)
    .sort((a, b) => (tierRank(b.tier) - tierRank(a.tier)) || ((b.confidence ?? 0) - (a.confidence ?? 0)));
}

/** A small rollup: total + counts by kind + counts by tier. PURE. (The artifact-level summary, like OUTCOMES rollups.) */
export function rollupGoalMemory(items) {
  const list = Array.isArray(items) ? items : [];
  const byKind = { belief: 0, delta: 0 };
  const byTier = Object.fromEntries(TIERS.map((t) => [t, 0]));
  let total = 0;
  for (const x of list) {
    if (!x || !x.id) continue;
    total++;
    if (x.kind in byKind) byKind[x.kind]++;
    if (x.tier in byTier) byTier[x.tier]++;
  }
  return { total, byKind, byTier };
}

/**
 * Bound growth: keep at most `max` items. PURE. canonical + summary are PROTECTED (never pruned — the costly,
 * human-confirmed knowledge); only the cheap lower tiers are dropped, weakest-first (tier, then confidence, then
 * evidence). Returns a new array (protected items first, then the survivors).
 */
export function capItems(items, max = 200) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && x.id);
  if (list.length <= max) return [...list];
  const isProtected = (x) => x.tier === 'canonical' || x.tier === 'summary';
  const protectedItems = list.filter(isProtected);
  const prunable = list.filter((x) => !isProtected(x))
    .sort((a, b) => (tierRank(b.tier) - tierRank(a.tier)) || ((b.confidence ?? 0) - (a.confidence ?? 0)) || ((b.evidence ?? 0) - (a.evidence ?? 0)));
  const keep = prunable.slice(0, Math.max(0, max - protectedItems.length));
  return [...protectedItems, ...keep];
}
