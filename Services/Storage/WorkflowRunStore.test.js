// Services/Storage/WorkflowRunStore.test.js — CD-5: the per-workflow run-history store (chrome.storage I/O).
// In-memory chrome.storage.local mock (the store touches chrome only inside its functions). node --test.

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

const { loadRuns, appendRunEntry, clearRuns } = await import('./WorkflowRunStore.js');

describe('WorkflowRunStore', () => {
  // globalThis.chrome is shared across ALL test files (import order decides who's active at run time). Re-point to
  // OUR mock before every test and save/restore around the suite so sibling storage suites keep theirs — the
  // robust pattern CanvasStore/ProposalStore use (GoalMemoryStore's fragile import-time assign relies on load order).
  let _saved;
  before(() => { _saved = globalThis.chrome; });
  after(() => { globalThis.chrome = _saved; });
  beforeEach(() => { globalThis.chrome = _chrome; _mem.clear(); });

  it('loadRuns on an unknown workflow → empty', async () => {
    assert.deepEqual(await loadRuns('nope'), { items: [], total: 0, notice: '' });
  });

  it('appendRunEntry normalizes + persists, keyed by workflow id', async () => {
    await appendRunEntry('wf-1', { at: 1000, trigger: 'auto', verdict: 'complete', counts: { items: 3 } });
    const { items, total } = await loadRuns('wf-1');
    assert.equal(items.length, 1);
    assert.equal(items[0].trigger, 'auto');
    assert.equal(items[0].verdict, 'complete');
    assert.equal(total, 1);
    assert.ok(_mem.has('wfruns:wf-1'));
  });

  it('two workflows keep separate histories (keyed by workflow, not desk)', async () => {
    await appendRunEntry('wf-a', { at: 1, verdict: 'complete', trigger: 'auto' });
    await appendRunEntry('wf-b', { at: 1, verdict: 'parked', trigger: 'manual' });
    assert.equal((await loadRuns('wf-a')).items[0].verdict, 'complete');
    assert.equal((await loadRuns('wf-b')).items[0].verdict, 'parked');
  });

  it('caps per workflow and surfaces a truncation notice (§6.4)', async () => {
    for (let i = 0; i < 5; i++) await appendRunEntry('wf-c', { at: i + 1, verdict: 'complete', trigger: 'auto' }, { cap: 3 });
    const { items, total, notice } = await loadRuns('wf-c');
    assert.equal(items.length, 3);          // capped
    assert.equal(total, 5);                 // lifetime total preserved
    assert.equal(items[0].at, 3);           // oldest two evicted
    assert.equal(notice, 'showing the last 3 of 5');
  });

  it('clearRuns removes the history', async () => {
    await appendRunEntry('wf-d', { at: 1, verdict: 'complete', trigger: 'auto' });
    await clearRuns('wf-d');
    assert.equal((await loadRuns('wf-d')).items.length, 0);
  });
});
