// Core/recordHandoff.test.js — AU-6 §12.5 (the hand-off) + the SHIPPING WATCH it exists to reach.
//
// Split from recordObserve.test.js because it covers one story end to end rather than one function: a draft is
// completed into an order, the record's pointer follows it, and the tracking number that lands on the ORDER —
// days after the DRAFT was created — arrives in that record's timeline. That sequence is §12.2's motivating case
// and the reason the whole lifecycle is not just a status flag.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { observeFields, reconcileCollection, readTransition, rowsAt } from './recordObserve.js';
import { auditEntry } from './audit.js';
import { applyTransition, applyUpdate, currentRef, handOff, describeEvent } from './recordLife.js';
import { CONNECTOR_RECIPES } from './connectorRecipes.js';

const T0 = 1_700_000_000_000;
const DAY = 86400000;
const row = (over = {}) => ({ ...auditEntry({ at: T0, system: 'admin.shopify.com', kind: 'draft', id: '29685', label: '#D29685', who: 'human', recipeId: 'shopify_create_order' }), ...over });

// v2.74.2208 — A BUG WITH NO SYMPTOM, found by reasoning about a declaration rather than by a failing test. The
// rows walker borrowed `extractValue`'s array hop, which takes element [0] because it resolves ONE scalar. Here
// that meant a `data.draftOrders.edges[].node` path returned exactly ONE row — so a poll over fifty drafts would
// reconcile the newest and silently ignore the other forty-nine. Every existing test passed, because every one of
// them declared a flat path.
describe('rowsAt — walks to EVERY match, not the first', () => {
  const reply = { data: { draftOrders: { edges: [{ node: { id: '1' } }, { node: { id: '2' } }, { node: { id: '3' } }] } } };

  it('a GraphQL edges[].node path yields ALL the nodes', () => {
    assert.deepEqual(rowsAt(reply, 'data.draftOrders.edges[].node').map((r) => r.id), ['1', '2', '3']);
  });

  it('the [] marker is optional — the edges array unwraps its nodes either way', () => {
    assert.deepEqual(rowsAt(reply, 'data.draftOrders.edges').map((r) => r.id), ['1', '2', '3']);
  });

  it('a plain array field works, and so does a single object', () => {
    assert.equal(rowsAt({ fulfillments: [{ a: 1 }, { a: 2 }] }, 'fulfillments').length, 2);
    assert.deepEqual(rowsAt({ one: { a: 1 } }, 'one'), [{ a: 1 }]);
  });

  it('a missing path is empty, never a throw', () => {
    assert.deepEqual(rowsAt(reply, 'data.nope.edges'), []);
    assert.deepEqual(rowsAt(null, 'a.b'), []);
    assert.deepEqual(rowsAt(reply, ''), []);
  });

  it('THE REGRESSION, end to end: three rows in, three rows reconciled', () => {
    const leg = { id: 'c', coverage: 'selection', rowId: 'id', rows: 'data.draftOrders.edges[].node', observe: { s: { of: 'field', at: 'status' } } };
    const rows = ['1', '2', '3'].map((id) => ({ ...row(), at: Number(id), id }));
    const got = rowsAt({ data: { draftOrders: { edges: rows.map((r) => ({ node: { id: r.id, status: 'COMPLETED' } })) } } }, leg.rows);
    assert.equal(reconcileCollection(rows, got, { leg, now: T0 }).length, 3, 'all three, not just the newest');
  });
});

// §12.5 — the transition adapter, as a DECLARATION rather than the per-platform function the spec assumed. The
// unknown fails toward NOTHING: name a path, act only if a value is actually there. That is what lets this ship
// without a live completed order to learn the reply shape from (§10.3's rule against coding a shape blind).
describe('readTransition — a hand-off is observed, never inferred (§12.5)', () => {
  const decl = { at: 'order.id', toKind: 'order' };

  it('reads WHAT IT BECAME, taking the gid tail so it matches what a create banks', () => {
    assert.deepEqual(readTransition({ order: { id: 'gid://shopify/Order/1234' } }, decl), { toKind: 'order', toId: '1234' });
    assert.deepEqual(readTransition({ order: { id: '1234' } }, decl), { toKind: 'order', toId: '1234' });
  });

  it('A STATUS IS NOT A HAND-OFF — it says something happened, not what it became', () => {
    assert.equal(readTransition({ status: 'COMPLETED' }, decl), null);
  });

  it('nothing there → null, so a reply that omits the field leaves the record exactly as it was', () => {
    assert.equal(readTransition({ order: null }, decl), null);
    assert.equal(readTransition({ order: { id: '' } }, decl), null);
    assert.equal(readTransition({}, decl), null);
  });

  it('no declaration, junk, or a half-declaration → null. Never a guess.', () => {
    assert.equal(readTransition({ order: { id: '1' } }, null), null);
    assert.equal(readTransition(null, decl), null);
    assert.equal(readTransition({ order: { id: '1' } }, { at: 'order.id' }), null, 'a toKind is required — "it became something" is not an answer');
  });
});

describe('reconcileCollection — the hand-off outranks a field change', () => {
  const leg = { id: 'c', coverage: 'selection', rowId: 'id', handOff: { at: 'order.id', toKind: 'order' }, observe: { status: { of: 'field', at: 'status' } } };

  it('emits a transition, and only that — the record is at a new address now', () => {
    const acts = reconcileCollection([row()], [{ id: '29685', status: 'COMPLETED', order: { id: 'gid://shopify/Order/1234' } }], { leg, now: T0 });
    assert.equal(acts.length, 1);
    assert.deepEqual(acts[0], { key: `${T0}|29685`, at: T0, kind: 'transition', toKind: 'order', toId: '1234' });
  });

  it('a record ALREADY at that pointer is not handed off twice', () => {
    const handed = row({ currentKind: 'order', currentId: '1234' });
    assert.deepEqual(reconcileCollection([handed], [{ id: '1234', order: { id: '1234' } }], { leg, now: T0 }), []);
  });

  it('a leg with NO handOff reports field news exactly as before — this is additive', () => {
    const plain = { id: 'c', coverage: 'selection', rowId: 'id', observe: { status: { of: 'field', at: 'status' } } };
    assert.equal(reconcileCollection([row()], [{ id: '29685', status: 'COMPLETED', order: { id: '1234' } }], { leg: plain, now: T0 })[0].kind, 'update');
  });
});

describe('the shipping watch — declared on the SHIPPED catalog', () => {
  it('the draft list declares the hand-off, so a completed draft can move its pointer', () => {
    const d = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_draft_orders');
    assert.deepEqual(d.handOff, { at: 'order.id', toKind: 'order' });
    assert.deepEqual(d.watches, ['draft']);
  });

  it('the orders queue watches ORDERS and declares parcels + progress', () => {
    const q = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_orders_queue');
    assert.deepEqual(q.watches, ['order']);
    assert.equal(q.observe.parcels.of, 'set');
    assert.equal(q.observe.progress.of, 'member');
    assert.equal(q.observe.parcels.id, 'trackingInfo.number', 'one parcel, one tracking number — that IS the member identity');
  });

  it('every observed path is one the leg’s query already returns — no new request, no new field', () => {
    const q = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_orders_queue');
    const gql = String((q.body && q.body.query) || '');
    for (const frag of ['displayFulfillmentStatus', 'trackingInfo', 'deliveredAt', 'displayStatus', 'estimatedDeliveryAt']) {
      assert.ok(gql.includes(frag), `${frag} is already in the Orders query`);
    }
  });

  it('a tracking number appearing is news, and its later delivery is news AGAIN', () => {
    const q = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_orders_queue').observe;
    const shipped = { displayFulfillmentStatus: 'IN_TRANSIT', fulfillments: [{ displayStatus: 'IN_TRANSIT', trackingInfo: { number: '1Z999', company: 'UPS' } }] };
    const first = observeFields(shipped, q);
    assert.deepEqual(first.added.parcels, [{ id: '1Z999', carrier: 'UPS' }]);

    const delivered = { displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ displayStatus: 'DELIVERED', deliveredAt: '2026-08-14', trackingInfo: { number: '1Z999', company: 'UPS' } }] };
    const second = observeFields(delivered, q, first.seenNext);
    assert.equal(second.added.parcels, undefined, 'the same parcel is not new twice');
    assert.deepEqual(second.changed.progress, [{ id: '1Z999', status: 'DELIVERED', deliveredAt: '2026-08-14' }]);
  });

  it('a SPLIT shipment reports the second box on its own — what one `field` observer would have missed', () => {
    const q = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_orders_queue').observe;
    const one = observeFields({ fulfillments: [{ trackingInfo: { number: '1Z001' } }] }, q);
    const two = observeFields({ fulfillments: [{ trackingInfo: { number: '1Z001' } }, { trackingInfo: { number: '1Z002' } }] }, q, one.seenNext);
    assert.deepEqual(two.added.parcels.map((p) => p.id), ['1Z002']);
  });
});

// The whole point, in one test: a warranty draft becomes an order and its tracking number arrives, on ONE row.
describe('the story end to end — draft → order → shipped → delivered, on one record', () => {
  it('one row, one timeline, and the create is never rewritten', () => {
    let r = row();

    // 1. The draft poll sees it was completed, and names what it became.
    const handAct = reconcileCollection([r], [{ id: '29685', order: { id: 'gid://shopify/Order/1234' } }],
      { leg: { id: 'd', coverage: 'selection', rowId: 'id', handOff: { at: 'order.id', toKind: 'order' } }, now: T0 + DAY })[0];
    r = applyTransition(r, { toKind: handAct.toKind, toId: handAct.toId, at: handAct.at, windowMs: 60 * DAY });
    assert.deepEqual(currentRef(r), { kind: 'order', id: '1234' }, 'the ORDER collection answers for it now');
    assert.equal(r.kind, 'draft', 'and the receipt still says what Orchard created');

    // 2. The ORDER poll now covers it — a tracking number appears.
    const q = CONNECTOR_RECIPES.find((x) => x.id === 'shopify_orders_queue').observe;
    const ship = observeFields({ displayFulfillmentStatus: 'IN_TRANSIT', fulfillments: [{ displayStatus: 'IN_TRANSIT', trackingInfo: { number: '1Z999', company: 'UPS' } }] }, q);
    r = applyUpdate(r, { fields: { shipStatus: ship.fields.shipStatus, parcels: `+1 new (${ship.added.parcels[0].id})` }, at: T0 + 3 * DAY });

    // 3. Days later, delivered.
    const done = observeFields({ displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ displayStatus: 'DELIVERED', deliveredAt: '2026-08-14', trackingInfo: { number: '1Z999' } }] }, q, ship.seenNext);
    r = applyUpdate(r, { fields: { progress: `1Z999→${done.changed.progress[0].status}` }, at: T0 + 6 * DAY });

    assert.deepEqual(r.events.map((e) => e.type), ['create', 'transition', 'update', 'update'], 'ONE timeline, four entries, one row');
    assert.deepEqual(handOff(r), { fromKind: 'draft', fromId: '29685', toKind: 'order', toId: '1234' });
    const told = r.events.map((e) => describeEvent(e, '')).filter(Boolean);
    assert.match(told[1], /Became a order \(#1234\), from draft/);
    assert.match(told[3], /1Z999→DELIVERED/);
  });
});
