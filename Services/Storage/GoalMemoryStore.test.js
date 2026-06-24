// Services/Storage/GoalMemoryStore.test.js — AL-3 (v2.74.1192): the per-app goal-memory store (chrome.storage I/O).
// Uses an in-memory chrome.storage.local mock — GoalMemoryStore touches chrome only INSIDE its functions, so the
// import is clean and the mock just needs to be in place before the calls.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const _mem = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) { const ks = Array.isArray(key) ? key : [key]; const out = {}; for (const k of ks) if (_mem.has(k)) out[k] = _mem.get(k); return out; },
      async set(obj) { for (const [k, v] of Object.entries(obj)) _mem.set(k, v); },
      async remove(key) { const ks = Array.isArray(key) ? key : [key]; for (const k of ks) _mem.delete(k); },
    },
  },
};

const { readGoalMemory, loadGoalItems, recordGoalItem, promoteGoalItem, clearGoalMemory } = await import('./GoalMemoryStore.js');

describe('GoalMemoryStore', () => {
  beforeEach(() => { _mem.clear(); });

  it('loadGoalItems on an unknown app → []', async () => {
    assert.deepEqual(await loadGoalItems('nope'), []);
  });

  it('recordGoalItem persists a sync-shaped record + assigns an id', async () => {
    await recordGoalItem('inbox', { kind: 'belief', body: 'Acme is enterprise', confidence: 0.6 });
    const rec = await readGoalMemory('inbox');
    assert.equal(rec.appId, 'inbox');
    assert.equal(rec.schemaVersion, 1);
    assert.equal(rec.items.length, 1);
    assert.ok(rec.items[0].id);
    assert.equal(rec.items[0].evidence, 1);
  });

  it('re-recording the same content MERGES (corroboration), not duplicates', async () => {
    await recordGoalItem('inbox', { kind: 'belief', body: 'Acme is enterprise', confidence: 0.6 });
    const items = await recordGoalItem('inbox', { kind: 'belief', body: 'ACME is enterprise', confidence: 0.9 });
    assert.equal(items.length, 1);
    assert.equal(items[0].evidence, 2);
    assert.equal(items[0].confidence, 0.9);
  });

  it('promoteGoalItem advances a corroborated hypothesis to confirmed (persisted)', async () => {
    await recordGoalItem('inbox', { kind: 'belief', body: 'churning', confidence: 0.8, tier: 'hypothesis' });
    let items = await recordGoalItem('inbox', { kind: 'belief', body: 'churning', confidence: 0.8 });   // evidence → 2
    items = await promoteGoalItem('inbox', items[0].id);                                                 // uses evidence (2)
    assert.equal(items[0].tier, 'confirmed');
    assert.equal((await loadGoalItems('inbox'))[0].tier, 'confirmed');   // persisted
  });

  it('concurrent recordGoalItem calls do not clobber (RMW chain)', async () => {
    await Promise.all([
      recordGoalItem('inbox', { kind: 'belief', body: 'one' }),
      recordGoalItem('inbox', { kind: 'belief', body: 'two' }),
      recordGoalItem('inbox', { kind: 'delta', body: 'three' }),
    ]);
    assert.equal((await loadGoalItems('inbox')).length, 3);   // all three survived the serialized chain
  });

  it('clearGoalMemory removes the app record', async () => {
    await recordGoalItem('inbox', { kind: 'belief', body: 'x' });
    await clearGoalMemory('inbox');
    assert.equal(await readGoalMemory('inbox'), null);
  });

  it('per-app isolation: one app’s memory does not bleed into another', async () => {
    await recordGoalItem('inbox', { kind: 'belief', body: 'a' });
    await recordGoalItem('support', { kind: 'belief', body: 'b' });
    assert.equal((await loadGoalItems('inbox')).length, 1);
    assert.equal((await loadGoalItems('support')).length, 1);
  });
});
