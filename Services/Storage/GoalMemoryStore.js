/**
 * @file Services/Storage/GoalMemoryStore.js
 * @description Per-app GOAL MEMORY persistence — AL-3 (DESIGN_apps_learning.md §9). Keyed by appId. The store
 * SEMANTICS (dedup-merge, promotion, query, cap) live in Core/goalStore.js (pure, tested); this is the I/O + the
 * per-app read-modify-write serialization (mirrors the sgCapabilities chain, CR-ST2). Records are written in the
 * cloud-ready envelope (GoalMemorySyncRecords) so the data never has to migrate to sync.
 *
 * "WITH A VIEW TOWARDS cloud/aws" — chrome.storage now; the envelope is sync-shaped and the cloud PATH is registered
 * (StoragePaths: logicalPathForRecord / recordMetaFromPath). The sync layer is fully filter-gated, so activation is
 * purely ADDITIVE registration, no store/data change:
 *   1. add 'goalMemory' to KIND_ALIASES (Services/Sync/SyncBridge.js) + its loadRecord case,
 *   2. add it to isWorkspacePartitionKind (Services/Storage/WorkspacePartitionStore.js),
 *   3. add the maybeWritePartitionPrimary/maybeReadPartition dual-layer calls here (mirror GroundAssetStore).
 * Until then a goalMemory key change is silently ignored by SyncBridge (no error) — local-only, the safe default
 * for the user's learned work-beliefs.
 */

import { goalMemoryStorageKey, goalMemorySyncRecord } from './GoalMemorySyncRecords.js';
import { addItem, promoteItemInList, capItems, settleItemInList, goalItemId } from '../../Core/goalStore.js';
import { retireActFailDeltas } from '../../Core/goalMemory.js';   // v2.74.1523 — consume the "re-teach" lesson once the re-teach happens

const GOAL_MEMORY_CAP = 200;   // bounded growth — capItems protects canonical/summary, prunes the cheap tiers

/** Read the raw per-app record { items, updatedAt, ... }, or null. @param {string} appId */
export async function readGoalMemory(appId) {
  if (!appId) return null;
  try {
    const k = goalMemoryStorageKey(appId);
    const got = await chrome.storage.local.get(k);
    return got?.[k] ?? null;
  } catch {
    return null;
  }
}

/** The belief/delta ITEMS for an app (the AL-2 list). @param {string} appId @returns {Promise<Array>} */
export async function loadGoalItems(appId) {
  const rec = await readGoalMemory(appId);
  return (rec && Array.isArray(rec.items)) ? rec.items : [];
}

/** Write the whole per-app record (sync-shaped). Internal — callers use record/promote below. */
async function _writeGoalMemory(appId, items) {
  const rec = goalMemorySyncRecord(appId, { items });
  await chrome.storage.local.set({ [goalMemoryStorageKey(appId)]: rec });
  return rec;
}

// Per-appId read-modify-write chain — serializes concurrent record/promote so two write-backs can't clobber each
// other (mirrors the sgCapabilities chain, CR-ST2). The chain entry is cleaned up once it settles.
const _chains = new Map();
function _chained(appId, fn) {
  const tail = _chains.get(appId) || Promise.resolve();
  const next = tail.then(() => fn());
  const settled = next.catch(() => {});
  _chains.set(appId, settled);
  settled.then(() => { if (_chains.get(appId) === settled) _chains.delete(appId); });
  return next;
}

/**
 * Record a belief/delta — dedup-merges via the AL-2 core (a re-record corroborates: bumps evidence, maxes
 * confidence, keeps the higher tier). Capped. @returns {Promise<Array>} the stored item list.
 */
export async function recordGoalItem(appId, raw) {
  if (!appId) return [];
  return _chained(appId, async () => {
    const items = await loadGoalItems(appId);
    const added = addItem(items, raw);
    // AL-5 — TURN THE RATCHET on write: settle the just-corroborated item up the gates it now clears (a 2nd success →
    // confirmed) instead of leaving it stuck at 'observation'. Stops before the HITL canonical step (settleItemInList).
    const id = goalItemId(raw);
    const next = capItems(id ? settleItemInList(added, id) : added, GOAL_MEMORY_CAP);
    await _writeGoalMemory(appId, next);
    return next;
  });
}

/**
 * Promote one item a tier (routes through goalMemory's gate; unsupplied evidenceCount defaults to the item's
 * accumulated evidence). @returns {Promise<Array>} the stored item list.
 */
export async function promoteGoalItem(appId, id, signals) {
  if (!appId || !id) return [];
  return _chained(appId, async () => {
    const items = await loadGoalItems(appId);
    const next = promoteItemInList(items, id, signals || {});
    await _writeGoalMemory(appId, next);
    return next;
  });
}

/**
 * v2.74.1523 — retire the act-fail lesson(s) for a goal the user just RE-TAUGHT (see Core/goalMemory.js
 * retireActFailDeltas — the write-time half of the AL-3e conflict story). @returns {Promise<number>} removed count.
 */
export async function retireActFail(appId, goal) {
  if (!appId || !String(goal || '').trim()) return 0;
  return _chained(appId, async () => {
    const items = await loadGoalItems(appId);
    const { items: next, removed } = retireActFailDeltas(items, goal);
    if (removed) await _writeGoalMemory(appId, next);
    return removed;
  });
}

/** Clear an app's goal memory (e.g. when an app is forgotten / deleted). @param {string} appId */
export async function clearGoalMemory(appId) {
  if (!appId) return;
  return _chained(appId, async () => {
    await chrome.storage.local.remove(goalMemoryStorageKey(appId));
  });
}
