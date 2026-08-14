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

const { loadCreates, appendCreateEntry, clearCreates, findCreate, updateCreate, removeCreate, bankAct } = await import('./AuditCreateStore.js');
const { applyGone, applyTransition } = await import('../../Core/recordLife.js');
const { chooseAuditMutator } = await import('../../Core/audit.js');

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

  // ── v2.74.2222 (T1) — the mutation/lookup trio the §12 lifecycle rides on, tested directly. ──────────────
  it('findCreate matches by system + create id, AND by the moved pointer (a draft that became an order)', async () => {
    await appendCreateEntry({ at: 1, system: 'admin.shopify.com', kind: 'draft', id: '29685', label: '#D29685' });
    await updateCreate({ at: 1, id: '29685' }, (r) => applyTransition(r, { toKind: 'order', toId: '1234', at: 2 }));
    assert.equal((await findCreate({ system: 'admin.shopify.com', id: '29685' }))?.id, '29685', 'by the create id');
    assert.equal((await findCreate({ system: 'admin.shopify.com', id: '1234' }))?.id, '29685', 'by currentId — the order is still the draft’s row');
    assert.equal(await findCreate({ system: 'other.host', id: '29685' }), null, 'system is part of the identity');
  });

  it('updateCreate: at+id identity, changed:false on a same-object mutator, and a throwing mutator never corrupts', async () => {
    await appendCreateEntry({ at: 10, system: 's', kind: 'draft', id: 'x' });
    const same = await updateCreate({ at: 10, id: 'x' }, (r) => r);                       // confirmed, not changed
    assert.equal(same.changed, false);
    const boom = await updateCreate({ at: 10, id: 'x' }, () => { throw new Error('boom'); });
    assert.equal(boom.changed, false, 'a throwing mutator writes nothing');
    const miss = await updateCreate({ at: 99, id: 'x' }, (r) => ({ ...r }));
    assert.equal(miss.changed, false, 'wrong at → no row (identity is at+id together)');
    const hit = await updateCreate({ at: 10, id: 'x' }, (r) => applyGone(r, { why: 'deleted', at: 11 }));
    assert.equal(hit.changed, true);
    assert.equal(hit.row.watch, 'gone');
  });

  it('removeCreate removes exactly the at+id row and floors total at the retained count', async () => {
    await appendCreateEntry({ at: 1, system: 's', kind: 'record', id: 'dup' });
    await appendCreateEntry({ at: 2, system: 's', kind: 'record', id: 'dup' });           // same id, second act
    const r = await removeCreate({ at: 1, id: 'dup' });
    assert.equal(r.removed, true);
    assert.deepEqual(r.items.map((x) => x.at), [2], 'the OTHER dup survives — id alone would be ambiguous');
    assert.equal(r.total, 1);
    const miss = await removeCreate({ at: 1, id: 'dup' });
    assert.equal(miss.removed, false);
  });

  // ── v2.74.2222 (T2) — bankAct: the find and the write in ONE chained turn. ───────────────────────────────
  it('bankAct: an act on a KNOWN row becomes an event on it — never a second row (§12.0)', async () => {
    await bankAct({ at: 1, system: 'admin.shopify.com', verb: 'create', kind: 'draft', id: '29685', label: '#D29685' });
    const del = await bankAct(
      { at: 2, system: 'admin.shopify.com', verb: 'delete', kind: 'draft', id: '29685' },
      (known) => chooseAuditMutator('delete', { at: 2 }),
    );
    assert.equal(del.action, 'event');
    assert.equal(del.items.length, 1, 'same row, no double-count');
    assert.equal(del.row.watch, 'gone');
    assert.equal(del.total, 1, 'an event on an existing row is not a new create');
  });

  it('bankAct: an act on an UNKNOWN record appends a verb-headed row', async () => {
    const r = await bankAct(
      { at: 3, system: 'admin.shopify.com', verb: 'update', kind: 'draft', id: '777', who: 'human' },
      () => chooseAuditMutator('update', { who: 'human', at: 3 }),
    );
    assert.equal(r.action, 'append');
    assert.equal(r.row.verb, 'update');
    assert.deepEqual(r.row.events.map((x) => x.type), ['update'], 'born with an honest birth event (v2222)');
  });

  it('bankAct: a create NEVER mutates — the same id created twice is two acts, two rows', async () => {
    await bankAct({ at: 1, system: 's', verb: 'create', kind: 'record', id: 'r1' }, () => chooseAuditMutator('create', { at: 1 }));
    const r = await bankAct({ at: 2, system: 's', verb: 'create', kind: 'record', id: 'r1' }, () => chooseAuditMutator('create', { at: 2 }));
    assert.equal(r.action, 'append');
    assert.equal(r.items.length, 2);
    assert.equal(r.total, 2);
  });
});
