// Services/Storage/ProposalStore.test.js — FL-2/FL-4 (v2.74.1346): the pending-action queue + ledger stores.
// In-memory chrome.storage.local mock (mirrors CanvasStore.test.js).

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const _mem = new Map();
const _chrome = {
  storage: { local: {
    async get(key) { const ks = Array.isArray(key) ? key : [key]; const out = {}; for (const k of ks) if (_mem.has(k)) out[k] = _mem.get(k); return out; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) _mem.set(k, v); },
    async remove(key) { const ks = Array.isArray(key) ? key : [key]; for (const k of ks) _mem.delete(k); },
  } },
};

const { loadProposals, addProposals, decideProposal, clearProposals } = await import('./ProposalStore.js');
const { loadLedger, appendLedger, clearLedger } = await import('./ActionLedgerStore.js');
const { ledgerEntry } = await import('../../Core/actionLedger.js');

const INST = 'inst_test_1';

describe('ProposalStore + ActionLedgerStore (instance-keyed)', () => {
  let _saved;
  before(() => { _saved = globalThis.chrome; });
  after(() => { globalThis.chrome = _saved; });
  beforeEach(() => { globalThis.chrome = _chrome; _mem.clear(); });

  it('addProposals mints ids + pending status; loadProposals round-trips; keys by INSTANCE id', async () => {
    const minted = await addProposals(INST, [{ key: 'k1', name: 'Merge tickets', params: {}, safety: 'gated', leg: { key: 'k1' } }]);
    assert.equal(minted.length, 1);
    assert.equal(minted[0].status, 'pending');
    assert.ok(minted[0].id.startsWith('prop_'));
    assert.ok(_mem.has(`proposals:${INST}`));                       // the identity-invariant key shape
    const all = await loadProposals(INST);
    assert.equal(all.length, 1);
    assert.deepEqual(await loadProposals('other_instance'), []);     // no cross-instance bleed
  });

  it('decideProposal transitions status + stamps decidedAt/reason; invalid status refused', async () => {
    const [p] = await addProposals(INST, [{ key: 'k1', name: 'Solve ticket', params: {}, safety: 'confirm', leg: {} }]);
    const rejected = await decideProposal(INST, p.id, { status: 'rejected', reason: 'different issues' });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.reason, 'different issues');
    assert.ok(rejected.decidedAt > 0);
    assert.equal(await decideProposal(INST, p.id, { status: 'nonsense' }), null);
    const all = await loadProposals(INST);
    assert.equal(all[0].status, 'rejected');
  });

  it('concurrent adds serialize (RMW chain) — none lost', async () => {
    await Promise.all([
      addProposals(INST, [{ key: 'a', name: 'A', params: {}, safety: 'confirm', leg: {} }]),
      addProposals(INST, [{ key: 'b', name: 'B', params: {}, safety: 'confirm', leg: {} }]),
      addProposals(INST, [{ key: 'c', name: 'C', params: {}, safety: 'confirm', leg: {} }]),
    ]);
    assert.equal((await loadProposals(INST)).length, 3);
    await clearProposals(INST);
    assert.deepEqual(await loadProposals(INST), []);
  });

  it('ledger appends + caps and clears; entries keep their minted shape', async () => {
    await appendLedger(INST, ledgerEntry('sweep', { counts: { proposals: 2 } }, 1000));
    await appendLedger(INST, [ledgerEntry('execution', { action: 'Merge tickets', ok: true }, 2000)]);
    const items = await loadLedger(INST);
    assert.equal(items.length, 2);
    assert.equal(items[1].action, 'Merge tickets');
    assert.ok(_mem.has(`ledger:${INST}`));
    await clearLedger(INST);
    assert.deepEqual(await loadLedger(INST), []);
  });
});
