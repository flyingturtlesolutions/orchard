/**
 * @file Services/Storage/GoalMemorySyncRecords.js
 * @description Sync envelope + storage key for per-app GOAL MEMORY (AL-3, DESIGN_apps_learning.md §9). No storage /
 * partition deps — PURE, so the hybrid sync engine can build a record without importing the store (mirrors
 * GroundAssetSyncRecords). The envelope is cloud-ready (AWS_INTEGRATION §17): id + schemaVersion + updatedAt +
 * lifecycle, so goal memory can flow through the SAME hybrid pipeline once it's registered for sync. Local until
 * then — see GoalMemoryStore for the "view towards cloud" activation steps.
 */

export const GOAL_MEMORY_SCHEMA = 1;

/** The per-app chrome.storage key. @param {string} appId */
export const goalMemoryStorageKey = (appId) => `goalMemory:${appId}`;

/**
 * Build the synced goal-memory record — the whole per-app store as ONE record (the belief/delta list). PURE.
 * @param {string} appId
 * @param {{ items?: Array, updatedAt?: number, lifecycle?: string }} [gm]
 * @returns {{ id:string, appId:string, schemaVersion:number, items:Array, updatedAt:number, lifecycle:string }}
 */
export function goalMemorySyncRecord(appId, gm) {
  const m = (gm && typeof gm === 'object') ? gm : {};
  const items = Array.isArray(m.items) ? m.items : [];
  return {
    id: String(appId || ''),
    appId: String(appId || ''),
    schemaVersion: GOAL_MEMORY_SCHEMA,
    items,
    updatedAt: Number(m.updatedAt || Date.now()),
    lifecycle: m.lifecycle || 'active',
  };
}
