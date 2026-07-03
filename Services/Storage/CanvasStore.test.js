// Services/Storage/CanvasStore.test.js — CA-3 (v2.74.1204): per-anchor canvas persistence + cloud-path registration.
// In-memory chrome.storage.local mock (mirrors GoalMemoryStore.test.js).

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

const { readCanvas, loadCanvasSpec, writeCanvasSpec, clearCanvas } = await import('./CanvasStore.js');
const { canvasSyncRecord } = await import('./CanvasSyncRecords.js');
const { logicalPathForRecord, recordMetaFromPath } = await import('./StoragePaths.js');

const anchor = { appId: 'finance', conversationId: null };

describe('CanvasStore', () => {
  // globalThis.chrome is shared across ALL test files (each sets it at import; import order decides who's active at
  // run time). Re-point to OUR mock before every test, and save/restore around the suite so sibling storage suites
  // (e.g. GoalMemoryStore) keep theirs.
  let _saved;
  before(() => { _saved = globalThis.chrome; });
  after(() => { globalThis.chrome = _saved; });
  beforeEach(() => { globalThis.chrome = _chrome; _mem.clear(); });

  it('loadCanvasSpec on an unknown anchor → null', async () => {
    assert.equal(await loadCanvasSpec({ appId: 'nope' }), null);
  });

  it('writeCanvasSpec persists a normalized, rev-stamped spec keyed by canvasDocId', async () => {
    const next = await writeCanvasSpec(anchor, { title: 'HUD', blocks: [{ id: 'm', kind: 'metric', label: 'Net', value: 1 }] });
    assert.equal(next.rev, 1);
    const rec = await readCanvas('app-finance');                 // app-anchored docId
    assert.equal(rec.appId, 'finance');
    assert.equal(rec.schemaVersion, 1);
    assert.equal(rec.spec.title, 'HUD');
    assert.equal(rec.spec.blocks.length, 1);
  });

  it('the store OWNS rev — each write bumps it monotonically', async () => {
    await writeCanvasSpec(anchor, { blocks: [] });
    await writeCanvasSpec(anchor, { blocks: [] });
    assert.equal((await writeCanvasSpec(anchor, { blocks: [] })).rev, 3);
  });

  it("write pins the stored anchor to the key (a spec's stale anchor can't mis-key it)", async () => {
    const s = await writeCanvasSpec(anchor, { anchor: { appId: 'WRONG' }, blocks: [] });
    assert.deepEqual(s.anchor, { appId: 'finance', conversationId: null });
  });

  it('the closed vocabulary holds through the store (an html block never persists)', async () => {
    const s = await writeCanvasSpec(anchor, { blocks: [{ id: 'x', kind: 'html', text: '<script>' }, { id: 'm', kind: 'metric', label: 'l', value: 1 }] });
    assert.equal(s.blocks.length, 1);
    assert.equal(s.blocks[0].kind, 'metric');
  });

  it('per-anchor isolation: a conversation canvas and an app canvas are distinct docs', async () => {
    await writeCanvasSpec({ appId: 'support', conversationId: 'c1' }, { title: 'guide' });
    await writeCanvasSpec({ appId: 'support', conversationId: null }, { title: 'dash' });
    assert.equal((await loadCanvasSpec({ appId: 'support', conversationId: 'c1' })).title, 'guide');   // conv-c1
    assert.equal((await loadCanvasSpec({ appId: 'support' })).title, 'dash');                          // app-support
  });

  it('clearCanvas removes the doc', async () => {
    await writeCanvasSpec(anchor, { blocks: [] });
    await clearCanvas(anchor);
    assert.equal(await readCanvas('app-finance'), null);
  });

  it('concurrent writes do not clobber (RMW chain) — rev ends at the count', async () => {
    await Promise.all([writeCanvasSpec(anchor, { blocks: [] }), writeCanvasSpec(anchor, { blocks: [] }), writeCanvasSpec(anchor, { blocks: [] })]);
    assert.equal((await loadCanvasSpec(anchor)).rev, 3);
  });

  // v2.74.1341 (review P1-4) — the RMW chain is per-JS-context; cross-context writers (the canvas tab's edit save
  // vs the SW's compose) pass `ifRev` so a stale write is REFUSED instead of clobbering the other side's revision.
  it('ifRev CAS: a matching rev writes; a stale rev is refused (null) and the stored spec keeps', async () => {
    const first = await writeCanvasSpec(anchor, { title: 'v1', blocks: [] });          // rev 1
    assert.equal(first.rev, 1);
    const won = await writeCanvasSpec(anchor, { title: 'v2', blocks: [] }, { ifRev: 1 });
    assert.equal(won.rev, 2);
    const lost = await writeCanvasSpec(anchor, { title: 'STALE', blocks: [] }, { ifRev: 1 });   // derived from rev 1 — too old
    assert.equal(lost, null);
    const stored = await loadCanvasSpec(anchor);
    assert.equal(stored.rev, 2);
    assert.equal(stored.title, 'v2');                                                   // the newer write was NOT reverted
  });
});

describe('CanvasSyncRecords + StoragePaths (cloud path round-trips; sync still OFF)', () => {
  it('canvasSyncRecord wraps the spec in the cloud-ready envelope', () => {
    const r = canvasSyncRecord('conv-c1', 'support', { spec: { title: 't' } });
    assert.deepEqual([r.id, r.docId, r.appId, r.schemaVersion, r.lifecycle], ['conv-c1', 'conv-c1', 'support', 1, 'active']);
  });
  it('logicalPathForRecord places a canvas under its app memory; recordMetaFromPath reverses it', () => {
    const path = logicalPathForRecord('canvas', canvasSyncRecord('conv-c1', 'support', { spec: {} }));
    assert.equal(path, 'workspace/appMemory/support/canvas/conv-c1.json');
    assert.deepEqual(recordMetaFromPath(path), { kind: 'canvas', id: 'conv-c1', appId: 'support' });
  });
  it('a canvas with no appId is not sync-pathable (local-only)', () => {
    assert.equal(logicalPathForRecord('canvas', canvasSyncRecord('scratch', '', { spec: {} })), null);
  });
});
