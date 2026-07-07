/**
 * @file Services/Storage/ProposalStore.js
 * @description FL-2 (v2.74.1346, DESIGN_app_fleet.md) — the PENDING-ACTION QUEUE: proposals a propose-only sweep
 * parked, awaiting the user's approve/reject. Keyed by INSTANCE id (`proposals:<instanceId>`) — per the identity
 * invariant (the 2026-07 review: new per-app keyspaces key by instanceId, never the type/appId — the
 * `canvas:sources:{appId}` lesson). Per-instance read-modify-write chain mirrors GoalMemoryStore (CR-ST2).
 * Deliberately NOT sync-registered: no cloud path until StoragePaths can carry instance-keyed records.
 */

import { PROPOSAL_STATUS } from '../../Core/proposals.js';

const PROPOSAL_CAP = 100;   // bounded queue — oldest SETTLED (non-pending) entries prune first

const _key = (instanceId) => `proposals:${instanceId}`;

const _chains = new Map();
function _chained(instanceId, fn) {
  const tail = _chains.get(instanceId) || Promise.resolve();
  const next = tail.then(() => fn());
  const settled = next.catch(() => {});
  _chains.set(instanceId, settled);
  settled.then(() => { if (_chains.get(instanceId) === settled) _chains.delete(instanceId); });
  return next;
}

/** All proposals for an instance (newest last). @returns {Promise<Array<object>>} */
export async function loadProposals(instanceId) {
  if (!instanceId) return [];
  try {
    const got = await chrome.storage.local.get(_key(instanceId));
    const rec = got?.[_key(instanceId)];
    return (rec && Array.isArray(rec.items)) ? rec.items : [];
  } catch { return []; }
}

async function _write(instanceId, items) {
  // prune settled first, pending last-resort, cap total
  let next = items;
  if (next.length > PROPOSAL_CAP) {
    const pending = next.filter((p) => p.status === 'pending');
    const settled = next.filter((p) => p.status !== 'pending');
    const keepSettled = settled.slice(-(Math.max(0, PROPOSAL_CAP - pending.length)));
    next = [...keepSettled, ...pending].sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-PROPOSAL_CAP);
  }
  await chrome.storage.local.set({ [_key(instanceId)]: { items: next, updatedAt: Date.now() } });
  return next;
}

/**
 * Park a sweep's proposals (status 'pending', ids minted here). @returns {Promise<Array<object>>} the stored records.
 */
export async function addProposals(instanceId, proposals) {
  if (!instanceId || !Array.isArray(proposals) || !proposals.length) return [];
  return _chained(instanceId, async () => {
    const items = await loadProposals(instanceId);
    const now = Date.now();
    const minted = proposals.map((p, i) => ({
      ...p,
      id: `prop_${now.toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      ts: now,
      status: 'pending',
    }));
    await _write(instanceId, [...items, ...minted]);
    return minted;
  });
}

/**
 * Move one proposal through its lifecycle (pending → approved/rejected; approved → executed/stale/failed).
 * @returns {Promise<object|null>} the updated record.
 */
export async function decideProposal(instanceId, id, { status, reason = '', result = null } = {}) {
  if (!instanceId || !id || !PROPOSAL_STATUS.includes(status)) return null;
  return _chained(instanceId, async () => {
    const items = await loadProposals(instanceId);
    let updated = null;
    const next = items.map((p) => {
      if (p.id !== id) return p;
      updated = { ...p, status, decidedAt: Date.now() };
      if (reason) updated.reason = String(reason).slice(0, 300);
      if (result != null) updated.result = result;
      return updated;
    });
    if (updated) await _write(instanceId, next);
    return updated;
  });
}

/** Clear an instance's queue (e.g. purge). */
export async function clearProposals(instanceId) {
  if (!instanceId) return;
  return _chained(instanceId, async () => { await chrome.storage.local.remove(_key(instanceId)); });
}
