// Services/Storage/AuditCreateStore.test.js — AU-1 (DESIGN_audit.md §11): the global creates book I/O.
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

const { loadCreates, appendCreateEntry, clearCreates } = await import('./AuditCreateStore.js');

describe('AuditCreateStore', () => {
  let _saved;
  before(() => { _saved = globalThis.chrome; });
  after(() => { globalThis.chrome = _saved; });
  beforeEach(() => { globalThis.chrome = _chrome; _mem.clear(); });

  it('loadCreates on an empty book → empty', async () => {
    assert.deepEqual(await loadCreates(), { items: [], total: 0, notice: '' });
  });

  it('appendCreateEntry normalizes + persists to the single global key', async () => {
    await appendCreateEntry({ at: 1000, system: 'admin.shopify.com', kind: 'draft', id: '29685', label: '#D29685', who: 'human', recipeId: 'shopify_create_order' });
    const { items, total } = await loadCreates();
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'draft');
    assert.equal(items[0].label, '#D29685');
    assert.equal(items[0].who, 'human');
    assert.equal(items[0].verb, 'create');       // normalized in
    assert.equal(total, 1);
    assert.ok(_mem.has('audit:creates'));
  });

  it('all systems share ONE book (not keyed per system) — the cross-system answer', async () => {
    await appendCreateEntry({ at: 1, system: 'admin.shopify.com', kind: 'draft', id: '1', who: 'human' });
    await appendCreateEntry({ at: 2, system: 'deako.zendesk.com', kind: 'ticket', id: '2', who: 'gate' });
    const { items, total } = await loadCreates();
    assert.equal(total, 2);
    assert.deepEqual(items.map((x) => x.kind), ['draft', 'ticket']);   // oldest first
  });

  it('caps globally and surfaces a truncation notice (visible eviction)', async () => {
    for (let i = 0; i < 6; i++) await appendCreateEntry({ at: i + 1, system: 's', kind: 'record', id: String(i) }, { cap: 3 });
    const { items, total, notice } = await loadCreates();
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((x) => x.id), ['3', '4', '5']);
    assert.equal(total, 6);
    assert.equal(notice, 'showing the last 3 of 6');
  });

  it('total is a lifetime counter that survives eviction', async () => {
    for (let i = 0; i < 10; i++) await appendCreateEntry({ at: i + 1, system: 's', kind: 'record', id: String(i) }, { cap: 2 });
    const { items, total } = await loadCreates();
    assert.equal(items.length, 2);
    assert.equal(total, 10);
  });

  it('clearCreates empties the book', async () => {
    await appendCreateEntry({ at: 1, system: 's', kind: 'record', id: '1' });
    await clearCreates();
    assert.deepEqual(await loadCreates(), { items: [], total: 0, notice: '' });
  });
});
