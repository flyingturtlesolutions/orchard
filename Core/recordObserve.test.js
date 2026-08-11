// Core/recordObserve.test.js — AU-6 §12.9 (the three observer kinds) + §12.3/§12.4 (the collection poll).
//
// The load-bearing test in this file is the one asserting that ABSENCE FROM A SELECTION IS NOT DELETION. Every
// other rule here protects a record from a missed event; that one protects it from a fabricated terminal state,
// which is the only failure in this subsystem that cannot be corrected by looking again.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { observeFields, hasNews, newsToFields, pollPlan, reconcileCollection, readTransition, rowsAt, POLL_GAP_MS } from './recordObserve.js';
import { auditEntry } from './audit.js';
import { applyGone } from './recordLife.js';

const T0 = 1_700_000_000_000;
const DAY = 86400000;
const row = (over = {}) => ({ ...auditEntry({ at: T0, system: 'admin.shopify.com', kind: 'draft', id: '29685', label: '#D29685', who: 'human', recipeId: 'shopify_create_order' }), ...over });

describe('recordObserve — §12.9 A: field', () => {
  const decl = { status: { of: 'field', at: 'status' }, tracking: { of: 'field', at: 'fulfillments.trackingInfo.number' } };

  it('absent→present IS news', () => {
    const o = observeFields({ status: 'OPEN' }, decl);
    assert.deepEqual(o.fields, { status: 'OPEN' });
  });

  it('unchanged is NOT news — a re-read that confirms must produce nothing', () => {
    const o = observeFields({ status: 'OPEN' }, decl, { fields: { status: 'OPEN' } });
    assert.deepEqual(o.fields, {});
    assert.equal(hasNews(o), false);
  });

  it('a moved value is news, and the seen-state advances with it', () => {
    const o = observeFields({ status: 'COMPLETED' }, decl, { fields: { status: 'OPEN' } });
    assert.deepEqual(o.fields, { status: 'COMPLETED' });
    assert.equal(o.seenNext.fields.status, 'COMPLETED');
  });

  it('an ABSENT declared path yields NO KEY — never undefined, never a guess', () => {
    const o = observeFields({ status: 'OPEN' }, decl);
    assert.equal('tracking' in o.fields, false);
  });

  it('an UNDECLARED field is not news however much it moves — a poll cannot invent an event', () => {
    const o = observeFields({ status: 'OPEN', secretlyChanging: Math.PI }, decl, { fields: { status: 'OPEN' } });
    assert.equal(hasNews(o), false);
  });

  it('walks an array hop', () => {
    const o = observeFields({ fulfillments: [{ trackingInfo: { number: '1Z999' } }] }, decl);
    assert.equal(o.fields.tracking, '1Z999');
  });
});

describe('recordObserve — §12.9 B: set (additions only)', () => {
  const decl = { replies: { of: 'set', rows: 'comments', id: 'id', keep: { author: 'author_id', public: 'public' } } };
  const body = (ids) => ({ comments: ids.map((id) => ({ id, author_id: `u${id}`, public: 'true' })) });

  it('first sighting reports every member, and remembers them', () => {
    const o = observeFields(body([1, 2]), decl);
    assert.equal(o.added.replies.length, 2);
    assert.deepEqual(o.added.replies[0], { id: '1', author: 'u1', public: 'true' });
    assert.deepEqual(o.seenNext.sets.replies, ['1', '2']);
  });

  it('a second poll with the same members is NOT news', () => {
    const o = observeFields(body([1, 2]), decl, { sets: { replies: ['1', '2'] } });
    assert.equal(hasNews(o), false);
  });

  it('only the NEW member is news', () => {
    const o = observeFields(body([1, 2, 3]), decl, { sets: { replies: ['1', '2'] } });
    assert.deepEqual(o.added.replies.map((r) => r.id), ['3']);
  });

  it('a VANISHED member is NOT a removal — pagination and filters look identical to deletion (§12.9.2)', () => {
    const o = observeFields(body([1]), decl, { sets: { replies: ['1', '2'] } });
    assert.equal(hasNews(o), false, 'concluding "removed" from a truncated read manufactures false events');
    assert.deepEqual(o.seenNext.sets.replies, ['1', '2'], 'and the member stays known, so its return is not news either');
  });

  it('no `id` declared → nothing, because an append and a re-order are indistinguishable without identity', () => {
    const o = observeFields(body([1, 2]), { replies: { of: 'set', rows: 'comments' } });
    assert.equal(hasNews(o), false);
  });
});

describe('recordObserve — §12.9 C: member (B composed with A)', () => {
  const decl = { returns: { of: 'member', rows: 'returns', id: 'id', track: { status: 'status' } } };

  it('a NEW member is not this rule’s news — it arrives via `set`', () => {
    const o = observeFields({ returns: [{ id: 'r1', status: 'OPEN' }] }, decl);
    assert.equal(hasNews(o), false);
    assert.deepEqual(o.seenNext.members.returns.r1, { status: 'OPEN' }, 'but it is remembered, so its next move IS news');
  });

  it('a tracked field moving on an ALREADY-KNOWN member is news', () => {
    const o = observeFields({ returns: [{ id: 'r1', status: 'CLOSED' }] }, decl, { members: { returns: { r1: { status: 'OPEN' } } } });
    assert.deepEqual(o.changed.returns, [{ id: 'r1', status: 'CLOSED' }]);
  });

  it('an unmoved member is not news', () => {
    const o = observeFields({ returns: [{ id: 'r1', status: 'OPEN' }] }, decl, { members: { returns: { r1: { status: 'OPEN' } } } });
    assert.equal(hasNews(o), false);
  });
});

describe('recordObserve — newsToFields: the timeline entry a person reads', () => {
  it('scalars pass through; sets and members summarise rather than nesting a blob', () => {
    const f = newsToFields({ fields: { status: 'COMPLETED' }, added: { replies: [{ id: '3' }] }, changed: { returns: [{ id: 'r1', status: 'CLOSED' }] } });
    assert.equal(f.status, 'COMPLETED');
    assert.match(f.replies, /\+1 new \(3\)/);
    assert.match(f.returns, /r1→CLOSED/);
  });
  it('junk in, empty out', () => {
    assert.deepEqual(newsToFields(null), {});
    assert.equal(hasNews(null), false);
  });
});

describe('recordObserve — §12.4 pollPlan', () => {
  const leg = { id: 'coll', appHost: 'admin.shopify.com', watches: ['draft'], observe: { status: { of: 'field', at: 'status' } } };

  it('plans a collection that watches a kind we hold', () => {
    const plan = pollPlan([row()], { catalog: [leg], now: T0 });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].recipeId, 'coll');
    assert.equal(plan[0].why, 'never polled');
  });

  it('COLD rows are still covered — the read is O(1) in records (§12.3’s corrected rule)', () => {
    const cold = row({ warmUntil: T0 });
    const plan = pollPlan([cold], { catalog: [leg], now: T0 + 90 * DAY });
    assert.equal(plan.length, 1, 'excluding cold rows saves zero and buys a blind spot');
    assert.deepEqual(plan[0].rowIds, ['29685']);
  });

  it('GONE rows are not — there is nothing left to reconcile', () => {
    assert.deepEqual(pollPlan([applyGone(row(), { at: T0 })], { catalog: [leg], now: T0 + DAY }), []);
  });

  it('no rows of a watched kind → NO REQUEST', () => {
    assert.deepEqual(pollPlan([row({ kind: 'customer' })], { catalog: [leg], now: T0 }), []);
    assert.deepEqual(pollPlan([], { catalog: [leg], now: T0 }), []);
  });

  it('a leg with no `observe` or no `watches` is not a poll candidate', () => {
    assert.deepEqual(pollPlan([row()], { catalog: [{ id: 'x', appHost: 'admin.shopify.com', watches: ['draft'] }], now: T0 }), []);
    assert.deepEqual(pollPlan([row()], { catalog: [{ id: 'x', appHost: 'admin.shopify.com', observe: {} }], now: T0 }), []);
  });

  it('inside its window it does not run again — the window is the cadence, the tick is only the scanner', () => {
    const plan = pollPlan([row()], { catalog: [leg], now: T0 + 1000, lastPollAt: { coll: T0 } });
    assert.deepEqual(plan, []);
    const later = pollPlan([row()], { catalog: [leg], now: T0 + POLL_GAP_MS + 1, lastPollAt: { coll: T0 } });
    assert.equal(later.length, 1);
    assert.equal(later[0].why, 'window elapsed');
  });

  it('a HOST mismatch is not a candidate — a Shopify collection never answers for a Zendesk record', () => {
    assert.deepEqual(pollPlan([row({ system: 'deako.zendesk.com' })], { catalog: [leg], now: T0 }), []);
  });

  it('follows the POINTER: a handed-off row is matched on currentKind', () => {
    const handed = row({ currentKind: 'order', currentId: '1234' });
    assert.deepEqual(pollPlan([handed], { catalog: [leg], now: T0 }), [], 'it is an order now; the draft collection no longer answers for it');
    const orderLeg = { ...leg, id: 'orders', watches: ['order'] };
    assert.deepEqual(pollPlan([handed], { catalog: [orderLeg], now: T0 })[0].rowIds, ['1234']);
  });
});

describe('recordObserve — §12.3 reconcileCollection', () => {
  const sel = { id: 'coll', coverage: 'selection', rowId: 'id', observe: { status: { of: 'field', at: 'status' } } };
  const part = { ...sel, coverage: 'partition' };

  it('ABSENCE FROM A SELECTION IS NOT DELETION — the rule this file exists to hold', () => {
    // A draft missing from shopify_draft_orders has three innocent explanations: completed into an order, past
    // `first: 50`, or a filter moved. Marking it gone would be a confidently wrong TERMINAL state, from silence.
    assert.deepEqual(reconcileCollection([row()], [], { leg: sel, now: T0 + DAY }), []);
  });

  it('absence from a PARTITION is an observation, because a partition claims to be all of them', () => {
    const acts = reconcileCollection([row()], [], { leg: part, now: T0 + DAY });
    assert.equal(acts.length, 1);
    assert.equal(acts[0].kind, 'gone');
    assert.equal(acts[0].why, '404');
  });

  it('an EMPTY reply from a selection says nothing at all, even about rows it has answered for before', () => {
    assert.deepEqual(reconcileCollection([row()], null, { leg: sel, now: T0 }), []);
  });

  it('a present row with a changed watched value → one update carrying the new seen-state', () => {
    const acts = reconcileCollection([row()], [{ id: '29685', status: 'COMPLETED' }], { leg: sel, now: T0 + DAY });
    assert.equal(acts.length, 1);
    assert.equal(acts[0].kind, 'update');
    assert.deepEqual(acts[0].fields, { status: 'COMPLETED' });
    assert.equal(acts[0].seenNext.fields.status, 'COMPLETED');
  });

  it('a present row that has NOT changed produces nothing — no event, no write', () => {
    const key = `${T0}|29685`;
    const acts = reconcileCollection([row()], [{ id: '29685', status: 'OPEN' }], { leg: sel, now: T0 + DAY, seenBy: { [key]: { fields: { status: 'OPEN' } } } });
    assert.deepEqual(acts, []);
  });

  it('matches a gid tail against a banked numeric id — the vendor returns one, we banked the other', () => {
    const acts = reconcileCollection([row()], [{ id: 'gid://shopify/DraftOrder/29685', status: 'COMPLETED' }], { leg: sel, now: T0 });
    assert.equal(acts.length, 1);
  });

  it('matches on the POINTER after a hand-off, not on the create id', () => {
    const handed = row({ currentId: '1234', currentKind: 'order' });
    const acts = reconcileCollection([handed], [{ id: '1234', status: 'PAID' }], { leg: sel, now: T0 });
    assert.equal(acts.length, 1);
    assert.deepEqual(acts[0].fields, { status: 'PAID' });
  });

  it('a leg with no observe declaration reconciles presence only — never invents an update', () => {
    assert.deepEqual(reconcileCollection([row()], [{ id: '29685', status: 'X' }], { leg: { id: 'c', coverage: 'selection', rowId: 'id' }, now: T0 }), []);
  });

  it('junk in, nothing out', () => {
    assert.deepEqual(reconcileCollection(null, null, {}), []);
    assert.deepEqual(reconcileCollection([row()], [null, 'x', 7], { leg: sel, now: T0 }), []);
  });

  it('v2.74.2214 — `stats` names which kind of NOTHING happened: absent-from-reply vs present-but-condition-unmet', () => {
    // Live 2026-08-11: #D29741 sat COMPLETED in Shopify through two green polls and `0 handed off` could not say
    // whether the row was missing from our reply or present with a status the probe declaration did not expect.
    const probing = { ...sel, handOffProbe: { when: { field: 'status', is: 'COMPLETED' }, via: 'detail' } };
    const absent = {};
    reconcileCollection([row()], [{ id: 'other', status: 'COMPLETED' }], { leg: probing, now: T0, stats: absent });
    assert.deepEqual(absent, { matched: 0, whenMet: 0 }, 'the banked row is not in the vendor reply');
    const unmet = {};
    reconcileCollection([row()], [{ id: '29685', status: 'OPEN' }], { leg: probing, now: T0, stats: unmet });
    assert.deepEqual(unmet, { matched: 1, whenMet: 0 }, 'present, but the probe condition does not hold');
    const met = {};
    const acts = reconcileCollection([row()], [{ id: '29685', status: 'COMPLETED' }], { leg: probing, now: T0, stats: met });
    assert.deepEqual(met, { matched: 1, whenMet: 1 });
    assert.equal(acts[0].kind, 'probe', 'and when-met is the probe actually raised');
  });
});

// v2.74.2212 — THE POLL WAS REFUSED BEFORE THE NETWORK, every tick, in silence. `shopify_draft_orders` carries
// `{query}` IN ITS URL; the sweep sent no params, so the executor blocked it (`needs query`, connector.js:1156)
// and the sweep counted one unreadable collection and moved on. Live: a draft completed in Shopify at 17:13 and
// its record still read `draft` after a forced re-check.
describe('recordObserve — pollPlan sends the leg’s declared params, blank', () => {
  const leg = { id: 'coll', appHost: 'admin.shopify.com', watches: ['draft'], observe: { s: { of: 'field', at: 's' } },
    params: [{ name: 'query', required: false }] };

  it('an optional param rides as BLANK — which is what these legs’ own hints call the default scope', () => {
    const plan = pollPlan([row()], { catalog: [leg], now: T0 });
    assert.deepEqual(plan[0].params, { query: '' });
  });

  it('a leg with a REQUIRED param is not pollable — nothing in a sweep can fill one', () => {
    const req = { ...leg, params: [{ name: 'order', required: true }] };
    assert.deepEqual(pollPlan([row()], { catalog: [req], now: T0 }), [], 'and sending "" would query for the empty string');
  });

  it('a leg with no params at all still plans, with an empty bag', () => {
    const bare = { ...leg, params: undefined };
    assert.deepEqual(pollPlan([row()], { catalog: [bare], now: T0 })[0].params, {});
  });

  it('THE REGRESSION, against the shipped catalog: the draft-orders URL fills completely', async () => {
    const { CONNECTOR_RECIPES, fillEndpoint } = await import('./connectorRecipes.js');
    const plan = pollPlan([row()], { catalog: CONNECTOR_RECIPES, now: T0 });
    const step = plan.find((p) => p.recipeId === 'shopify_draft_orders');
    assert.ok(step, 'the draft list is planned for a draft record');
    const real = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_draft_orders');
    const left = fillEndpoint(real.endpoint, step.params).match(/\{[a-zA-Z_][\w-]*\}/g) || [];
    // {op_sha} and {handle} are the executor's to fill (the op bank and the ride tab's store handle).
    assert.deepEqual(left.sort(), ['{handle}', '{op_sha}'], 'no DECLARED param may be left unfilled — that is a refusal, not a request');
  });
});
