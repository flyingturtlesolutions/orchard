/**
 * @file Services/Storage/ActionLedgerStore.js
 * @description FL-4 (v2.74.1346, DESIGN_app_fleet.md) — the app ACTION LEDGER: append-only record of what the app
 * proposed/decided/executed, with provenance captured AT ACT TIME. Keyed by INSTANCE id (`ledger:<instanceId>`) —
 * the identity invariant (never the type/appId). The pure half (entry mint + aggregation) is Core/actionLedger.js.
 * NOT sync-registered (same instance-keying rule as ProposalStore).
 */

const LEDGER_CAP = 500;   // bounded history — oldest entries fall off

const _key = (instanceId) => `ledger:${instanceId}`;

const _chains = new Map();
function _chained(instanceId, fn) {
  const tail = _chains.get(instanceId) || Promise.resolve();
  const next = tail.then(() => fn());
  const settled = next.catch(() => {});
  _chains.set(instanceId, settled);
  settled.then(() => { if (_chains.get(instanceId) === settled) _chains.delete(instanceId); });
  return next;
}

/** The instance's ledger entries (oldest first). @returns {Promise<Array<object>>} */
export async function loadLedger(instanceId) {
  if (!instanceId) return [];
  try {
    const got = await chrome.storage.local.get(_key(instanceId));
    const rec = got?.[_key(instanceId)];
    return (rec && Array.isArray(rec.items)) ? rec.items : [];
  } catch { return []; }
}

/** Append entries (already minted via Core/actionLedger.ledgerEntry). @returns {Promise<number>} new length. */
export async function appendLedger(instanceId, entries) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : (entries ? [entries] : []);
  if (!instanceId || !list.length) return 0;
  return _chained(instanceId, async () => {
    const items = await loadLedger(instanceId);
    const next = [...items, ...list].slice(-LEDGER_CAP);
    await chrome.storage.local.set({ [_key(instanceId)]: { items: next, updatedAt: Date.now() } });
    return next.length;
  });
}

/** Clear an instance's ledger (purge). */
export async function clearLedger(instanceId) {
  if (!instanceId) return;
  return _chained(instanceId, async () => { await chrome.storage.local.remove(_key(instanceId)); });
}
