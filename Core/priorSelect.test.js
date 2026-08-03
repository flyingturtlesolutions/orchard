// Core/priorSelect.test.js — PS-1 (v2.74.1982).
//
// The three live failures are the first three tests. Each was fixed separately downstream (SM-1, MR-1, FR-1)
// without any of them asking which rows were on the table.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectPrior, askTokens, isPerItem, describePick } from './priorSelect.js';

const tasks = { id: 't', noun: 'vendorsuite warranty tasks', label: 'Open warranty tasks', kind: 'list', rows: new Array(24).fill({}), at: 200 };
const orders = { id: 'o', noun: 'shopify orders', label: 'Shopify orders for a customer', kind: 'list', rows: new Array(6).fill({}), at: 100 };
const oneCustomer = { id: 'c', noun: 'shopify customers', label: 'A Customer', kind: 'record', fields: {}, at: 300 };

describe('selectPrior — the live failures', () => {
  it('13:45 — "each order" binds to the ORDERS, not the 24 tasks that were read more recently', () => {
    // Bound to tasks, it matched `Job Number` and reported `24 × "Job Number" → 24 found`. The orders carried
    // fulfillments[].trackingInfo.number the whole time.
    const r = selectPrior('read the tracking number on each order on shopify', [tasks, orders]);
    assert.equal(r.pick.id, 'o');
    assert.match(r.why, /^noun:order/);
  });

  it('12:20 — "get their last order" prefers the 6-row LIST over a more recent single record', () => {
    // It took a record "27s old" and died: `MAP ▸ no field — "" absent from 1 row(s)`.
    const r = selectPrior('get their last order', [oneCustomer, orders]);
    assert.equal(r.pick.id, 'o');
    assert.equal(r.pick.kind, 'list');
  });

  it('04:04 — "their last order" does not settle for the CUSTOMER record when orders are on the table', () => {
    // Bound to the customer, it matched `numberOfOrders` — a count, for an ask about an order.
    const r = selectPrior('get their last order', [oneCustomer, orders, tasks]);
    assert.equal(r.pick.id, 'o');
  });

  it('the counterpart still works — "each task" binds to the tasks', () => {
    assert.equal(selectPrior('read the job number on each task', [orders, tasks]).pick.id, 't');
  });
});

describe('selectPrior — falling back without lying about it', () => {
  it('picks the most recent when no candidate carries the ask\'s nouns, and SAYS so', () => {
    const r = selectPrior('what are the full details', [tasks, orders]);
    assert.equal(r.pick.id, 't', 'recency, exactly as before this module existed');
    assert.match(r.why, /most-recent/, 'the why must expose the guess');
    assert.deepEqual(r.matched, []);
  });

  it('returns null only when there is nothing to choose from', () => {
    assert.equal(selectPrior('anything', []).pick, null);
    assert.equal(selectPrior('anything', null).pick, null);
    assert.equal(selectPrior('anything', [{ kind: 'nonsense' }]).pick, null);
  });

  it('flags genuine ambiguity — two DIFFERENT nouns matching equally well', () => {
    const r = selectPrior('the orders and the tasks', [tasks, orders]);
    assert.ok(r.ambiguous.length > 1, 'both sets are live candidates and the caller may ask');
  });

  it('does NOT call two copies of the same noun ambiguous — that is just an older read', () => {
    const older = { ...orders, id: 'o2', at: 50 };
    assert.deepEqual(selectPrior('each order', [orders, older]).ambiguous, []);
  });
});

describe('askTokens / isPerItem', () => {
  it('keeps the nouns and drops the scaffolding', () => {
    assert.deepEqual(askTokens('read the tracking number on each order'), ['tracking', 'number', 'order']);
  });

  it('stems plurals so an ask meets a singular focus noun', () => {
    assert.deepEqual(askTokens('the orders'), ['order']);
    assert.deepEqual(askTokens('companies'), ['company']);
    assert.deepEqual(askTokens('addresses'), ['address']);
    assert.deepEqual(askTokens('status'), ['status'], 'a bare -ss word is not a plural');
  });

  it('recognises a per-item ask', () => {
    for (const a of ['each order', 'every task', 'all of them', 'their orders']) assert.equal(isPerItem(a), true);
    assert.equal(isPerItem('the last order'), false);
  });

  it('survives junk without throwing on the routing hot path', () => {
    for (const junk of [null, undefined, '', 42, {}]) {
      assert.doesNotThrow(() => askTokens(junk));
      assert.doesNotThrow(() => isPerItem(junk));
      assert.doesNotThrow(() => selectPrior(junk, [orders]));
    }
  });
});

describe('describePick — the missing word', () => {
  it('names the set, its noun, its size and the reason', () => {
    const r = selectPrior('each order', [tasks, orders]);
    const s = describePick(r.pick, r.why);
    assert.match(s, /list "Shopify orders for a customer"/);
    assert.match(s, /6 row\(s\)/);
    assert.match(s, /noun:order/);
  });

  it('says "none" rather than throwing when nothing was picked', () => {
    assert.equal(describePick(null, 'x'), 'none');
  });
});
