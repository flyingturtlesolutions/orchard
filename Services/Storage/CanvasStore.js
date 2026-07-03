/**
 * @file Services/Storage/CanvasStore.js
 * @description Per-anchor CANVAS persistence — CA-3 (DESIGN_canvas.md §3). Keyed by canvasDocId (conv-… | app-…).
 * The render-spec SEMANTICS (normalize, diff, the closed safe vocabulary) live in Core/canvasSpec.js (pure, tested);
 * this is the chrome.storage I/O + the per-doc read-modify-write serialization (mirrors GoalMemoryStore / the
 * sgCapabilities chain, CR-ST2). The store OWNS `rev` — it stamps a monotonic revision on every write (the pure
 * layer never reads a clock), so a stale paint can be ordered and diffSpec can animate between revisions.
 *
 * "WITH A VIEW TOWARDS cloud/aws" — chrome.storage now; the envelope is sync-shaped and the cloud PATH is registered
 * (StoragePaths: logicalPathForRecord / recordMetaFromPath, kind 'canvas'). The sync layer is fully filter-gated, so
 * activation is purely ADDITIVE registration (KIND_ALIASES + loadRecord in SyncBridge; isWorkspacePartitionKind in
 * WorkspacePartitionStore) — until then a canvas key change is silently ignored by SyncBridge (local-only).
 */

import { canvasStorageKey, canvasSyncRecord } from './CanvasSyncRecords.js';
import { canvasDocId, normalizeCanvasSpec } from '../../Core/canvasSpec.js';

/** Read the raw per-canvas record { spec, updatedAt, ... }, or null. @param {string} docId */
export async function readCanvas(docId) {
  if (!docId) return null;
  try {
    const k = canvasStorageKey(docId);
    const got = await chrome.storage.local.get(k);
    return got?.[k] ?? null;
  } catch {
    return null;
  }
}

/** The current CanvasSpec for an anchor (normalized), or null when nothing's been rendered. @returns {Promise<object|null>} */
export async function loadCanvasSpec(anchor) {
  const rec = await readCanvas(canvasDocId(anchor));
  return (rec && rec.spec) ? normalizeCanvasSpec(rec.spec) : null;
}

// Per-doc read-modify-write chain — serializes concurrent writes so two renders can't clobber each other (mirrors
// GoalMemoryStore). The chain entry is cleaned up once it settles.
// v2.74.1341 (review P1-4): the chain is a module-level Map = PER JS CONTEXT — the canvas TAB and the SW each have
// their own, so the chain alone cannot serialize a tab edit against a compose-in-flight. Cross-context writers pass
// `ifRev` (the rev their spec was derived from): a mismatch returns null instead of clobbering, and the caller
// re-reads + rebases. The chain still serializes same-context writers (keeps the read→set window microscopic).
const _chains = new Map();
function _chained(docId, fn) {
  const tail = _chains.get(docId) || Promise.resolve();
  const next = tail.then(() => fn());
  const settled = next.catch(() => {});
  _chains.set(docId, settled);
  settled.then(() => { if (_chains.get(docId) === settled) _chains.delete(docId); });
  return next;
}

/**
 * Write a canvas render. RMW-serialized; STAMPS the next `rev` (monotonic per doc) and pins the stored spec's anchor
 * to the storage key's anchor. PURE spec normalization (closed vocabulary) happens here AND at the renderer — two
 * gates, one vocabulary (§5).
 * v2.74.1341 (review P1-4) — `opts.ifRev`: compare-and-swap for CROSS-CONTEXT writers (the canvas tab's edit save vs
 * the SW's compose). When set and the STORED rev differs, the write is refused (returns null) — the caller re-reads
 * and rebases instead of silently reverting the other context's write. Omitted → unconditional (same behavior as
 * before, for the SW render path which always derives from a fresh read inside its own chain).
 * @returns {Promise<object|null>} the stored (normalized, rev-stamped) spec, or null when the CAS lost.
 */
export async function writeCanvasSpec(anchor, spec, { ifRev } = {}) {
  const docId = canvasDocId(anchor);
  if (!docId) return null;
  const appId = (anchor && typeof anchor === 'object' && anchor.appId) ? String(anchor.appId) : '';
  return _chained(docId, async () => {
    const prev = await readCanvas(docId);
    const prevRev = (prev && prev.spec && Number.isFinite(prev.spec.rev)) ? prev.spec.rev : 0;
    if (ifRev != null && prevRev !== ifRev) return null;   // CAS lost — another context wrote since the caller's read
    const next = normalizeCanvasSpec({ ...(spec && typeof spec === 'object' ? spec : {}), anchor, rev: prevRev + 1 });
    await chrome.storage.local.set({ [canvasStorageKey(docId)]: canvasSyncRecord(docId, appId, { spec: next }) });
    return next;
  });
}

/** Clear an anchor's canvas (e.g. the conversation/app is forgotten). @param {object} anchor */
export async function clearCanvas(anchor) {
  const docId = canvasDocId(anchor);
  if (!docId) return;
  return _chained(docId, async () => { await chrome.storage.local.remove(canvasStorageKey(docId)); });
}
