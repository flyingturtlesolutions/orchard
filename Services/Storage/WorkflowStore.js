/**
 * @file Services/Storage/WorkflowStore.js
 * @description WF-1 — per-INSTANCE saved IL workflows (a phrase → a multi-step decomposition). Keyed by the app
 * instance id (the same key as goal memory — per-instance learning, AP-0). The record SEMANTICS (normalize, content
 * id, match) live in Core/workflowMemory.js (pure, tested); this is the I/O + the per-key read-modify-write
 * serialization (mirrors GoalMemoryStore / the sgCapabilities chain, CR-ST2). Local-only (chrome.storage.local).
 */

import { normalizeWorkflow } from '../../Core/workflowMemory.js';

const CAP = 50;                                  // bounded growth — keep the most recent N per instance
const KEY = (appId) => `il:workflows:${appId}`;

async function _read(appId) {
  try { const k = KEY(appId); const got = await chrome.storage.local.get(k); return got?.[k] ?? null; } catch { return null; }
}

/** The saved workflow records for an instance (the WF-1 list). @returns {Promise<Array>} */
export async function loadWorkflows(appId) {
  if (!appId) return [];
  const rec = await _read(appId);
  return (rec && Array.isArray(rec.items)) ? rec.items : [];
}

// Per-appId read-modify-write chain — serializes concurrent save/bump/delete (mirrors GoalMemoryStore).
const _chains = new Map();
function _chained(appId, fn) {
  const tail = _chains.get(appId) || Promise.resolve();
  const next = tail.then(() => fn());
  const settled = next.catch(() => {});
  _chains.set(appId, settled);
  settled.then(() => { if (_chains.get(appId) === settled) _chains.delete(appId); });
  return next;
}

async function _write(appId, items) {
  await chrome.storage.local.set({ [KEY(appId)]: { items, updatedAt: Date.now() } });
}

/** Bank a workflow (normalize + dedup by content id; a re-bank of the same ask+steps is a no-op). Capped. */
export async function saveWorkflow(appId, raw) {
  if (!appId) return [];
  return _chained(appId, async () => {
    const items = await loadWorkflows(appId);
    const wf = normalizeWorkflow({ ...raw, appId });
    if (!wf) return items;
    if (items.some((x) => x && x.id === wf.id)) return items;        // already saved — dedup
    const next = [...items, { ...wf, createdAt: wf.createdAt || Date.now() }].slice(-CAP);
    await _write(appId, next);
    return next;
  });
}

/** Corroboration: bump a workflow's run-count on replay (feeds the match tie-break + future suggestion confidence). */
export async function bumpWorkflowRun(appId, id) {
  if (!appId || !id) return [];
  return _chained(appId, async () => {
    const items = await loadWorkflows(appId);
    const next = items.map((x) => (x && x.id === id) ? { ...x, runs: (x.runs || 0) + 1 } : x);
    await _write(appId, next);
    return next;
  });
}

/** WF-2 — bump a workflow's dismissed-count when the user declines a suggestion; a never-run, twice-dismissed match
 *  stops suggesting (workflowMatch suppression). */
export async function bumpWorkflowDismissed(appId, id) {
  if (!appId || !id) return [];
  return _chained(appId, async () => {
    const items = await loadWorkflows(appId);
    const next = items.map((x) => (x && x.id === id) ? { ...x, dismissed: (x.dismissed || 0) + 1 } : x);
    await _write(appId, next);
    return next;
  });
}

/** Forget a saved workflow. */
export async function deleteWorkflow(appId, id) {
  if (!appId || !id) return [];
  return _chained(appId, async () => {
    const next = (await loadWorkflows(appId)).filter((x) => x && x.id !== id);
    await _write(appId, next);
    return next;
  });
}
