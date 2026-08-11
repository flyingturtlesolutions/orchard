// Core/recordHandoff.test.js — AU-6 §12.5 (the hand-off) + the SHIPPING WATCH it exists to reach.
//
// Split from recordObserve.test.js because it covers one story end to end rather than one function: a draft is
// completed into an order, the record's pointer follows it, and the tracking number that lands on the ORDER —
// days after the DRAFT was created — arrives in that record's timeline. That sequence is §12.2's motivating case
// and the reason the whole lifecycle is not just a status flag.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { observeFields, reconcileCollection, readTransition, rowsAt, newsToFields, probeParams, probeDue, probePlan } from './recordObserve.js';
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
  // v2.74.2209 — REWRITTEN AGAINST THE HAR (admin.shopify.com.har, 2026-08-11). Both assertions below replaced
  // ones that encoded a GUESS, and the capture falsified each: the draft list does not carry `order`, and the
  // unfulfilled orders queue cannot host a shipping watch. That is the tests doing their job one step late —
  // they pinned what was believed, and the evidence moved it.
  it('the draft list raises the SIGNAL it can see, and asks one read for the answer it cannot', () => {
    const d = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_draft_orders');
    assert.equal(d.handOff, undefined, 'DraftOrderList returns id/name/poNumber/purchasingEntity/status/… and NO order');
    assert.deepEqual(d.handOffProbe, { when: { field: 'status', is: 'COMPLETED' }, via: 'shopify_draft_order' });
    assert.deepEqual(d.watches, ['draft']);
    assert.equal(d.observe.status.at, 'status', 'status is the signal the list CAN carry');
  });

  it('the single-draft read answers it, in a document of our own', () => {
    const one = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_draft_order');
    assert.equal(one.reads, 'draft');
    assert.deepEqual(one.handOff, { at: 'order.id', label: 'order.name', toKind: 'order' });
    assert.deepEqual(one.probe, { param: 'draft_gid', gid: 'DraftOrder' });
    // The transport the HAR attests: a document-in-body POST under an operation NAME the BFF routes on.
    assert.match(one.endpoint, /\?operation=DraftOrderDetails_0&type=query$/);
    assert.equal(one.body.operationName, 'DraftOrderDetails_0');
    for (const frag of ['draftOrder(id: $id)', 'order { id name }', 'completedAt', 'status']) {
      assert.ok(String(one.body.query).includes(frag), `${frag} is in the hand-off document`);
    }
  });

  it('THE SHIPPING WATCH IS NOT ON THE UNFULFILLED QUEUE — an order leaves it exactly when it ships', () => {
    const q = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_orders_queue');
    assert.equal(q.watches, undefined);
    assert.equal(q.observe, undefined);
    assert.match(String(q.body.variables.q), /fulfillment_status:unfulfilled/, 'which is WHY: the query excludes the state being watched for');
  });

  it('it is on the per-record order read, which sees an order at any fulfillment status', () => {
    const o = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_order');
    assert.equal(o.reads, 'order');
    assert.equal(o.observe.parcels.of, 'set');
    assert.equal(o.observe.progress.of, 'member');
    assert.equal(o.observe.parcels.id, 'trackingInfo.number', 'one parcel, one tracking number — that IS the member identity');
    assert.deepEqual(o.probe, { param: 'order', from: 'label', digits: true }, 'a hand-off yields a gid; this leg searches name:<digits>');
  });

  it('every observed path is one the leg’s query already returns — no new request, no new field', () => {
    const q = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_order');
    const gql = String((q.body && q.body.query) || '');
    for (const frag of ['displayFulfillmentStatus', 'trackingInfo', 'deliveredAt', 'displayStatus', 'estimatedDeliveryAt']) {
      assert.ok(gql.includes(frag), `${frag} is already in the Orders query`);
    }
  });

  it('a tracking number appearing is news, and its later delivery is news AGAIN', () => {
    const q = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_order').observe;
    const shipped = { displayFulfillmentStatus: 'IN_TRANSIT', fulfillments: [{ displayStatus: 'IN_TRANSIT', trackingInfo: { number: '1Z999', company: 'UPS' } }] };
    const first = observeFields(shipped, q);
    assert.deepEqual(first.added.parcels, [{ id: '1Z999', carrier: 'UPS' }]);

    const delivered = { displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ displayStatus: 'DELIVERED', deliveredAt: '2026-08-14', trackingInfo: { number: '1Z999', company: 'UPS' } }] };
    const second = observeFields(delivered, q, first.seenNext);
    assert.equal(second.added.parcels, undefined, 'the same parcel is not new twice');
    assert.deepEqual(second.changed.progress, [{ id: '1Z999', status: 'DELIVERED', deliveredAt: '2026-08-14' }]);
  });

  it('a SPLIT shipment reports the second box on its own — what one `field` observer would have missed', () => {
    const q = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_order').observe;
    const one = observeFields({ fulfillments: [{ trackingInfo: { number: '1Z001' } }] }, q);
    const two = observeFields({ fulfillments: [{ trackingInfo: { number: '1Z001' } }, { trackingInfo: { number: '1Z002' } }] }, q, one.seenNext);
    assert.deepEqual(two.added.parcels.map((p) => p.id), ['1Z002']);
  });
});

// THE WHOLE POINT, in one test, and every step now uses the SHIPPED declarations against reply shapes the
// 2026-08-11 capture attests. A warranty draft is completed by a person in Shopify; Orchard is not told; and the
// tracking number that lands on the ORDER days later arrives in that same record's timeline.
describe('the story end to end — draft → order → shipped → delivered, on one record', () => {
  const draftList = CONNECTOR_RECIPES.find((x) => x.id === 'shopify_draft_orders');
  const draftOne = CONNECTOR_RECIPES.find((x) => x.id === 'shopify_draft_order');
  const orderOne = CONNECTOR_RECIPES.find((x) => x.id === 'shopify_order');

  it('one row, one timeline, and the create is never rewritten', () => {
    let r = row();

    // 1. THE COLLECTION POLL sees what the list can say. The HAR's DraftOrderList node shape exactly: no `order`,
    //    but a `status` — and a COMPLETED draft is still IN the list, which is what makes this reachable at all.
    const acts = reconcileCollection([r], [{ id: '29685', name: '#D29685', status: 'COMPLETED', updatedAt: 'x' }],
      { leg: draftList, now: T0 + DAY });
    assert.equal(acts[0].kind, 'probe', 'the list cannot answer, so it asks');
    assert.equal(acts[0].via, 'shopify_draft_order');

    // 2. THE TARGETED RE-READ answers it — the reply shape entry 122 of the capture proves.
    const reply = { data: { draftOrder: { id: 'gid://shopify/DraftOrder/29685', name: '#D29685', status: 'COMPLETED', completedAt: '2026-08-11T14:00:00Z', order: { id: 'gid://shopify/Order/1234567534', name: 'DEAKO#72044' } } } };
    const seen = rowsAt(reply, draftOne.rows)[0];
    const ho = readTransition(seen, draftOne.handOff);
    assert.deepEqual(ho, { toKind: 'order', toId: '1234567534', toLabel: 'DEAKO#72044' });
    r = applyTransition(r, { ...ho, at: T0 + DAY, windowMs: 60 * DAY });
    assert.deepEqual(currentRef(r), { kind: 'order', id: '1234567534' }, 'the per-record ORDER read answers for it now');
    assert.equal(r.kind, 'draft', 'and the receipt still says what Orchard created');

    // 3. THE PROBE for the new kind addresses it by NAME — the id-shape seam, resolved by declaration.
    assert.deepEqual(probeParams(orderOne, { id: r.currentId, label: r.currentLabel }), { order: '72044' },
      'the store prefix is stripped, per this leg’s own does-line');

    // 4. It ships. A tracking number appears, which is why the draft's life could not end at completion.
    const ship = observeFields({ displayFulfillmentStatus: 'IN_TRANSIT', fulfillments: [{ displayStatus: 'IN_TRANSIT', trackingInfo: { number: '1Z999', company: 'UPS' } }] }, orderOne.observe);
    r = applyUpdate(r, { fields: newsToFields(ship), at: T0 + 3 * DAY });

    // 5. Days later, delivered.
    const done = observeFields({ displayFulfillmentStatus: 'FULFILLED', fulfillments: [{ displayStatus: 'DELIVERED', deliveredAt: '2026-08-14', trackingInfo: { number: '1Z999' } }] }, orderOne.observe, ship.seenNext);
    r = applyUpdate(r, { fields: newsToFields(done), at: T0 + 6 * DAY });

    assert.deepEqual(r.events.map((e) => e.type), ['create', 'transition', 'update', 'update'], 'ONE timeline, four entries, one row');
    assert.deepEqual(handOff(r), { fromKind: 'draft', fromId: '29685', toKind: 'order', toId: '1234567534', toLabel: 'DEAKO#72044' });
    const told = r.events.map((e) => describeEvent(e, '')).filter(Boolean);
    assert.match(told[1], /Became an order \(DEAKO#72044\), from draft/);
    assert.match(told[2], /1Z999/);
    assert.match(told[3], /1Z999→DELIVERED/);
  });

  it('and the probe STOPS once it succeeds — the condition it fires on is the one it removes', () => {
    const handed = row({ currentKind: 'order', currentId: '1234567534' });
    assert.deepEqual(reconcileCollection([handed], [{ id: '29685', status: 'COMPLETED' }], { leg: draftList, now: T0 + 2 * DAY }), [],
      'a still-COMPLETED draft row raises nothing once its record has moved on');
  });

  it('and RETRIES until it does — state-triggered, so a lost probe is not a stranded record', () => {
    const a = reconcileCollection([row()], [{ id: '29685', status: 'COMPLETED' }], { leg: draftList, now: T0 + DAY });
    const b = reconcileCollection([row()], [{ id: '29685', status: 'COMPLETED' }], { leg: draftList, now: T0 + 9 * DAY });
    assert.equal(a[0].kind, 'probe');
    assert.equal(b[0].kind, 'probe', 'the same pending question is asked again, not asked once and forgotten');
  });
});
