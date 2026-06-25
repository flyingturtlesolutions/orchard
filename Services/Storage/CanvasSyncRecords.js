/**
 * @file Services/Storage/CanvasSyncRecords.js
 * @description Sync envelope + storage key for a per-anchor CANVAS doc (CA-3, DESIGN_canvas.md §3). No storage /
 * partition deps — PURE (mirrors GoalMemorySyncRecords), so the hybrid sync engine can build a record without
 * importing the store. The envelope is cloud-ready (id + schemaVersion + updatedAt + lifecycle) so a canvas can flow
 * through the SAME hybrid pipeline once registered for sync. Local until then — see CanvasStore for activation.
 *
 * A canvas is keyed by DOC id (Core/canvasSpec.canvasDocId — conv-<id> for a per-task deliverable, app-<id> for a
 * standing dashboard) and carries its owning appId so the cloud path can place it under the app's memory area.
 */

export const CANVAS_SCHEMA = 1;

/** The per-canvas chrome.storage key. @param {string} docId */
export const canvasStorageKey = (docId) => `canvas:${docId}`;

/**
 * Build the synced canvas record — the whole doc as ONE record (the current CanvasSpec). PURE.
 * @param {string} docId   the canvasDocId (conv-… | app-… | scratch)
 * @param {string} appId   the owning app (for the cloud path; '' for a scratch canvas → not sync-pathable)
 * @param {{ spec?: object, updatedAt?: number, lifecycle?: string }} [payload]
 * @returns {{ id:string, docId:string, appId:string, schemaVersion:number, spec:object|null, updatedAt:number, lifecycle:string }}
 */
export function canvasSyncRecord(docId, appId, payload) {
  const m = (payload && typeof payload === 'object') ? payload : {};
  return {
    id: String(docId || ''),
    docId: String(docId || ''),
    appId: String(appId || ''),
    schemaVersion: CANVAS_SCHEMA,
    spec: (m.spec && typeof m.spec === 'object') ? m.spec : null,
    updatedAt: Number(m.updatedAt || Date.now()),
    lifecycle: m.lifecycle || 'active',
  };
}
