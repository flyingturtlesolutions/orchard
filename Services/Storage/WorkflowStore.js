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

// WW-1 (v2.74.1610, §10.A) — a STABLE SURROGATE id minted once at creation. Routines bind it, so it must NOT be
// recomputed from content (which changes on edit). Distinct from `contentId` (the dedup hash).
function _wfUid() { return `wf-u${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`; }

/** Bank a workflow (normalize + dedup by CONTENT id; a re-bank of the same ask+steps is a no-op). Capped. */
export async function saveWorkflow(appId, raw) {
  if (!appId) return [];
  return _chained(appId, async () => {
    const items = await loadWorkflows(appId);
    // WW-1 — mint a surrogate id for a NEW workflow (caller may pass one to re-key a migration); normalize honors it.
    const wf = normalizeWorkflow({ ...raw, appId, id: raw && raw.id ? raw.id : _wfUid() });
    if (!wf) return items;
    if (items.some((x) => x && x.contentId === wf.contentId)) return items;   // dedup by CONTENT (§10.A) — a re-bank of the same chain is a no-op
    const now = Date.now();
    const next = [...items, { ...wf, createdAt: wf.createdAt || now, updatedAt: now }].slice(-CAP);
    await _write(appId, next);
    return next;
  });
}

/** WW-1 (§10.A) — edit a saved workflow IN PLACE: preserve the surrogate `id` (so a bound routine survives), replace
 *  subAsks/steps/name/status; contentId + updatedAt recompute. No-op if the id isn't found. */
export async function updateWorkflow(appId, id, patch) {
  if (!appId || !id) return [];
  return _chained(appId, async () => {
    const items = await loadWorkflows(appId);
    const idx = items.findIndex((x) => x && x.id === id);
    if (idx < 0) return items;
    const merged = normalizeWorkflow({ ...items[idx], ...(patch || {}), id, appId });   // id preserved — the routine binding is stable
    if (!merged) return items;
    const next = items.slice();
    next[idx] = { ...merged, updatedAt: Date.now() };
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

// ── WF-3 (v2.74.1640) — SURVIVAL ───────────────────────────────────────────────────────────────────────────
// Workflows already outlived desk deletion; they were just UNREACHABLE. ConversationStore.delete removes only
// conversation records, so `il:workflows:<instanceId>` persisted — but every reader keys off the LIVE
// conversation's instance id, and that id dies with the desk. Data intact, permanently invisible: the same felt
// outcome as deletion, plus a storage leak that nothing could ever collect.
//
// The fix is a reader that does not need a live desk to find them. That single primitive answers both halves —
// it is what makes a deleted desk's workflows recoverable AND what lets Studio list every workflow at once.

const _PREFIX = 'il:workflows:';

/**
 * Every saved workflow across every instance, live or deleted. @returns {Promise<Array<{appId,items,updatedAt,orphaned}>>}
 * Sorted newest-touched first. Reads the whole local area once — the only way to reach a record whose owning
 * desk no longer exists to name it.
 */
export async function listAllWorkflows() {
  let all = null;
  try { all = await chrome.storage.local.get(null); } catch { return []; }
  const out = [];
  for (const [k, rec] of Object.entries(all || {})) {
    if (!k.startsWith(_PREFIX)) continue;
    const items = (rec && Array.isArray(rec.items)) ? rec.items.filter(Boolean) : [];
    if (!items.length) continue;
    out.push({
      appId: k.slice(_PREFIX.length),
      items,
      updatedAt: (rec && rec.updatedAt) || 0,
      // A record is orphaned once its desk is gone. The stamp is written AT deletion (markWorkflowsOrphaned)
      // because that is the only moment the desk's NAME still exists to record — afterwards there is nothing
      // left to look it up from, and an unnamed orphan is barely more useful than an invisible one.
      orphaned: items.some((x) => x && x.orphanedFrom),
    });
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Stamp an instance's workflows with the desk that owned them, immediately BEFORE that desk is deleted.
 * Deliberately not a delete: the user asked for these to survive, and a workflow is a taught capability whose
 * cost was the teaching, not the record. Writes directly (no normalize) so a stamp cannot fail a record's
 * schema check and silently drop the provenance it exists to preserve.
 */
export async function markWorkflowsOrphaned(appId, deskName) {
  if (!appId) return 0;
  return _chained(appId, async () => {
    const items = await loadWorkflows(appId);
    if (!items.length) return 0;
    const from = { deskName: String(deskName || 'a deleted desk').slice(0, 120), at: Date.now() };
    await _write(appId, items.map((x) => (x && !x.orphanedFrom) ? { ...x, orphanedFrom: from } : x));
    return items.length;
  });
}
