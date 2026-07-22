/**
 * @file Services/Storage/WorkflowRunStore.js
 * @description CD-5 (DESIGN_cadence.md §6.3/§6.4) — the RUN-HISTORY store: one row per workflow fire, keyed by
 * WORKFLOW id (`wfruns:<workflowId>`), NOT the desk. History cannot be conversation messages (the desk thread is
 * deletable and would interleave triggered output with a live conversation, §6.1); it is its own store, the vitals
 * sidecar shape minus the conversation shell. Written by BOTH the SW reporter's done() and the panel's manual runs.
 *
 * The cap is PER WORKFLOW, never global — the action ledger's shared cap-500 (which starts evicting a per-item run's
 * OWN earliest entries near N≈150) is the disqualified cautionary tale. When the cap bites, the record keeps a
 * lifetime `total` so the surface can say "showing the last 50 of 214" rather than presenting a truncated list as
 * complete (§6.4). The record semantics live in Core/runHistory.js (pure, tested); this is the I/O + the per-key
 * serialized read-modify-write (mirrors ActionLedgerStore / WorkflowStore).
 */

import { runHistoryEntry, appendRun, truncationNotice, HISTORY_CAP } from '../../Core/runHistory.js';

const KEY = (workflowId) => `wfruns:${workflowId}`;

const _chains = new Map();
function _chained(workflowId, fn) {
  const tail = _chains.get(workflowId) || Promise.resolve();
  const next = tail.then(() => fn());
  const settled = next.catch(() => {});
  _chains.set(workflowId, settled);
  settled.then(() => { if (_chains.get(workflowId) === settled) _chains.delete(workflowId); });
  return next;
}

async function _read(workflowId) {
  try { const k = KEY(workflowId); const got = await chrome.storage.local.get(k); return got?.[k] ?? null; } catch { return null; }
}

/**
 * A workflow's retained run history (oldest first) + the truncation notice.
 * @returns {Promise<{items:Array, total:number, notice:string}>}
 */
export async function loadRuns(workflowId) {
  if (!workflowId) return { items: [], total: 0, notice: '' };
  const rec = await _read(workflowId);
  const items = (rec && Array.isArray(rec.items)) ? rec.items : [];
  const total = (rec && Number.isFinite(rec.total)) ? rec.total : items.length;
  return { items, total, notice: truncationNotice(items.length, total) };
}

/**
 * Append one run entry. Normalizes through Core/runHistory, evicts past the per-workflow cap, and bumps the
 * lifetime `total` (so eviction stays visible). @returns {Promise<{items:Array, total:number, notice:string}>}
 */
export async function appendRunEntry(workflowId, fields, { cap = HISTORY_CAP } = {}) {
  if (!workflowId) return { items: [], total: 0, notice: '' };
  return _chained(workflowId, async () => {
    const rec = await _read(workflowId);
    const prev = (rec && Array.isArray(rec.items)) ? rec.items : [];
    const prevTotal = (rec && Number.isFinite(rec.total)) ? rec.total : prev.length;
    const entry = runHistoryEntry(fields);
    const items = appendRun(prev, entry, { cap });
    const total = prevTotal + 1;
    await chrome.storage.local.set({ [KEY(workflowId)]: { items, total, updatedAt: Date.now() } });
    return { items, total, notice: truncationNotice(items.length, total) };
  });
}

/** Forget a workflow's run history (cascade on workflow delete). */
export async function clearRuns(workflowId) {
  if (!workflowId) return;
  return _chained(workflowId, async () => { await chrome.storage.local.remove(KEY(workflowId)); });
}
