// Core/recordWatchSweep.test.js — AU-6's sweep, EXECUTED. The first execution gate on a background handler.
//
// WHY IT EXISTS. `background/handlers/*.js` is deliberately outside the unit glob (CLAUDE.md), so those files
// have had `node --check` + `npm run undef` and nothing else. Both are blind to the two failures this sweep has
// actually had, six versions apart and each invisible until a person noticed a record not updating:
//
//   v2207 → v2213  `StorageManager.get(WATCH_KEY)` — `#get` is a PRIVATE static, so this threw a TypeError on
//                  the sweep's third line. Valid syntax; the identifier IS bound. Neither gate can see it.
//   v2207 → v2212  the poll sent no params, so `{query}` stayed in the URL and the executor refused the request
//                  before the network. Pure-function tests all passed — the defect was in the assembled request.
//
// So this file does the one thing that catches both: it RUNS the sweep against a stubbed browser and asserts on
// what came out and what went over the wire. The test FILE lives in Core/ (which the glob runs) and imports the
// handler; the policy about which files carry unit tests is about where the tests live, not what they may reach.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ── the browser, stubbed to the surface this sweep actually touches ──────────────────────────────────────────
// INSTALLED IN `before`, NOT AT MODULE LOAD: the harness imports EVERY test file before running ANY suite
// (runner.mjs), so a load-time `globalThis.chrome = …` is overwritten by whichever chrome-stubbing file imports
// after this one (all of Services/Storage/*) — by run time the sweep read an EMPTY foreign store and early-
// returned, failing only under `npm test` while passing standalone. Same save/install/restore discipline as
// AuditCreateStore.test.js.
const store = {};
const _cb = (v, cb) => (cb ? (cb(v), undefined) : Promise.resolve(v));
const _chromeStub = {
  storage: {
    local: {
      get: (k, cb) => { const keys = Array.isArray(k) ? k : [k]; const out = {}; for (const key of keys) if (key in store) out[key] = store[key]; return _cb(out, cb); },
      set: (o, cb) => { Object.assign(store, o); return _cb(undefined, cb); },
      remove: (k, cb) => { delete store[k]; return _cb(undefined, cb); },
    },
  },
  alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
  runtime: { sendMessage() {}, lastError: null },
  tabs: { query: async () => [] },
  idle: { queryState: (_s, cb) => cb('active') },
};

const AUDIT_KEY = 'audit:creates';
const T0 = 1_700_000_000_000;
// A real create, through the real constructor — the shape the seam actually banks.
const { auditEntry } = await import('./audit.js');
const draftRow = () => auditEntry({
  at: T0, system: 'admin.shopify.com', kind: 'draft', id: '1144819318918', label: '#D29741',
  who: 'human', recipeId: 'shopify_create_order',
});

// What the fake Shopify answered, per leg, and what it was ASKED — the wire is half the assertion.
let asked = [];
// v2.74.2215 — the LIVE reply shape: our poll's request (query:'' + no saved view) returned 50 drafts NOT
// including the completed one (v2214 reconcile counts, matched=0). The first suite keeps the draft present
// (the collection-raised path stays covered); the last suite drops it, which is the shape that actually ships.
let listHasDraft = true;
function answer(payload) {
  asked.push(payload);
  const u = String((payload && (payload.endpoint || payload.url)) || '');
  if (/DraftOrderList/i.test(u)) {
    // When present, the draft is COMPLETED with `status` and no `order` (the 2026-08-11 capture) — the state
    // that must raise a probe rather than a hand-off.
    return { success: true, value: { data: { draftOrders: { edges: listHasDraft ? [
      { node: { id: 'gid://shopify/DraftOrder/1144819318918', name: '#D29741', status: 'COMPLETED' } },
    ] : [
      { node: { id: 'gid://shopify/DraftOrder/999', name: '#D99999', status: 'OPEN' } },
    ] } } } };
  }
  if (/DraftOrderDetails_0/i.test(u)) {
    return { success: true, value: { data: { draftOrder: {
      id: 'gid://shopify/DraftOrder/1144819318918', name: '#D29741', status: 'COMPLETED',
      completedAt: '2026-08-11T22:13:00Z', order: { id: 'gid://shopify/Order/1234567534', name: 'DEAKO#72046' },
    } } } };
  }
  if (/operation=Orders/i.test(u)) {
    // The per-record ORDER read — the tier the shipping watch lives on, because the only orders COLLECTION that
    // returns tracking is the unfulfilled queue, which an order leaves the moment it ships (v2209).
    return { success: true, value: { data: { orders: { edges: [
      { node: { id: 'gid://shopify/Order/1234567534', name: 'DEAKO#72046', displayFulfillmentStatus: 'IN_TRANSIT',
        fulfillments: [{ displayStatus: 'IN_TRANSIT', deliveredAt: null, trackingInfo: { number: '1Z999AA', company: 'UPS' } }] } },
    ] } } } };
  }
  return { success: false, error: 'unexpected leg' };
}

let handlers = null;
let _savedChrome;
const installChrome = () => { _savedChrome = globalThis.chrome; globalThis.chrome = _chromeStub; };
const restoreChrome = () => { globalThis.chrome = _savedChrome; };
const initOnce = async () => {
  if (handlers) return;
  const mod = await import('../background/handlers/vitals.js');
  // initVitals schedules a 5s boot tick; skip that one timer so the suite does not idle waiting for it.
  const realST = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  mod.initVitals({
    invokeSgHandler: async (type, payload) => {
      if (type === 'ENSURE_GROUND_FOR_URL') return { groundId: 'gnd_test' };
      if (type === 'INVOKE_SESSION') return answer(payload);
      return { success: true };
    },
    readRideRecipes: async () => [],
    writeRideRecipes: async () => {},
    readConnRegistry: async () => ({ 'admin.shopify.com': { status: 'fresh' } }),
    reportAuthSignal: async () => {},
  });
  globalThis.setTimeout = realST;
  handlers = mod.createVitalsHandlers();
};

const verify = () => new Promise((res) => { handlers.RECORD_VERIFY_NOW({}, null, res); });
const rows = () => (store[AUDIT_KEY] && store[AUDIT_KEY].items) || [];

describe('AU-6 sweep — it actually runs (the gate node --check and undef cannot be)', () => {
  before(async () => {
    installChrome();
    await initOnce();
    asked = [];
    store[AUDIT_KEY] = { items: [draftRow()], total: 1, updatedAt: T0 };
    delete store['audit:watch'];
  });
  after(restoreChrome);

  it('RETURNS A TALLY — a throw anywhere in it would surface as null, which is the v2213 TypeError’s signature', async () => {
    const r = await verify();
    assert.equal(r.success, true);
    assert.ok(r.tally, 'null here means the sweep died in its own fail-safe catch');
    assert.ok(r.tally.polled >= 1, `the collection must be read, got polled=${r.tally.polled}`);
  });

  it('SENT THE PARAM THE URL NEEDS — the v2212 refusal, asserted at the seam that fills it', async () => {
    const { fillEndpoint } = await import('./connectorRecipes.js');
    const list = asked.find((p) => /DraftOrderList/i.test(String(p.endpoint || p.url || '')));
    assert.ok(list, 'the draft list was invoked');
    // The payload carries the TEMPLATE plus `args`; connector.js fills one from the other and refuses anything
    // still bearing a `{…}`. So the honest assertion is the executor's own, made here — checking the template
    // alone would have "passed" while the real request was blocked, which is how this shipped in the first place.
    assert.ok(list.args && 'query' in list.args, 'a declared param must ride as an arg or the request never leaves');
    const filled = fillEndpoint(String(list.endpoint || ''), list.args || {});
    const left = (filled.match(/\{[a-zA-Z_][\w-]*\}/g) || []).filter((x) => x !== '{op_sha}' && x !== '{handle}');
    assert.deepEqual(left, [], `the executor would block this request: ${filled.slice(0, 160)}`);
  });

  it('RAISED THE PROBE and applied the HAND-OFF — the whole §12.5 path, end to end', async () => {
    const detail = asked.find((p) => /DraftOrderDetails_0/i.test(String(p.endpoint || p.url || '')));
    assert.ok(detail, 'a COMPLETED draft with no `order` in the list must trigger the targeted re-read');
    const row = rows()[0];
    assert.equal(row.currentKind, 'order', 'the pointer follows the artifact');
    assert.equal(row.currentId, '1234567534');
    assert.equal(row.currentLabel, 'DEAKO#72046');
    assert.equal(row.kind, 'draft', 'and the receipt still says what Orchard created');
    // The SAME sweep also reads the new order: the per-record tier re-loads the book AFTER the collection loop
    // (vitals.js — `const fresh = (await loadCreates()).items`), precisely because the transition restarts the
    // warm window "since the thing worth seeing usually arrives after it". So sweep 1 ends with the tracking
    // update already on the timeline — pinning ['create','transition'] here was this test's own guess about
    // sequencing, falsified by running the code it gates.
    assert.deepEqual(row.events.map((e) => e.type), ['create', 'transition', 'update']);
    // And that update must be the TRACKING observation from the per-record order read — not the collection
    // echoing 'status → COMPLETED', which is the double-report the probe's `continue` (recordObserve.js) exists
    // to suppress: the status change is the probe's trigger, not separate news.
    assert.match(JSON.stringify(row.events[2].fields || {}), /1Z999AA/, 'the update is the tracking number, not a status echo');
  });

  it('then WATCHES THE ORDER — the per-record tier, which no collection can host', async () => {
    // v2.74.2213: this is what the early `return` on an empty collection plan was silently killing. Nothing
    // collection-shaped watches `order`, so a handed-off record's plan is empty BY DESIGN — and the sweep used
    // to stop there, which meant the tracking number could never arrive.
    asked = [];
    const r = await verify();
    assert.equal(r.tally.handed, 0, 'the probe’s own condition is false once the pointer has moved');
    const ord = asked.find((p) => /operation=Orders/i.test(String(p.endpoint || p.url || '')));
    assert.ok(ord, 'the ORDER is now read per-record');
    const row = rows()[0];
    assert.match(JSON.stringify(row.observed || {}), /1Z999AA/, 'the tracking number reaches the record');
    assert.deepEqual(row.events.map((e) => e.type), ['create', 'transition', 'update']);
  });

  it('is IDEMPOTENT — a third sweep with nothing new adds nothing', async () => {
    const before = rows()[0].events.length;
    await verify();
    assert.equal(rows()[0].events.length, before, 'a re-read that confirms is not an event');
  });
});

describe('AU-6 sweep — the LIVE 2026-08-11 shape: the completed draft is NOT in the collection reply', () => {
  // v2.74.2215 — the defect this suite pins: #D29741 sat COMPLETED in Shopify through green polls because our
  // DraftOrderList request (query:'' + savedViewId:null) does not return it — the §12.5 signal the collection
  // was trusted to raise CANNOT fire. The draft detail leg now declares `observe`, so probePlan plans a warm
  // draft its own one-row read, and the hand-off happens without the collection's help.
  const NOW = Date.now();
  before(async () => {
    installChrome();
    await initOnce();
    asked = [];
    listHasDraft = false;
    // A recent, warm draft — the shape the real create banks (born warm; the per-record tier is warm-gated).
    store[AUDIT_KEY] = { items: [auditEntry({
      at: NOW - 3600_000, system: 'admin.shopify.com', kind: 'draft', id: '1144819318918', label: '#D29741',
      who: 'human', recipeId: 'shopify_create_order', warmUntil: NOW + 86_400_000,
    })], total: 1, updatedAt: NOW - 3600_000 };
    delete store['audit:watch'];
  });
  after(() => { listHasDraft = true; restoreChrome(); });

  it('hands off through the PER-RECORD detail read, with the collection blind', async () => {
    const r = await verify();
    assert.equal(r.tally.handed, 1, `the hand-off must not depend on the collection: ${JSON.stringify(r.tally)}`);
    const detail = asked.find((p) => /DraftOrderDetails_0/i.test(String(p.endpoint || p.url || '')));
    assert.ok(detail, 'the draft DETAIL was read per-record');
    assert.equal(String((detail.args || {}).draft_gid || ''), 'gid://shopify/DraftOrder/1144819318918',
      'addressed by the rebuilt gid, from the numeric id the create banked');
    const row = rows()[0];
    assert.equal(row.currentKind, 'order');
    assert.equal(row.currentLabel, 'DEAKO#72046');
    assert.deepEqual(row.events.map((e) => e.type), ['create', 'transition']);
  });

  it('and the NEXT sweep watches the order it became', async () => {
    asked = [];
    await verify();
    assert.ok(asked.find((p) => /operation=Orders/i.test(String(p.endpoint || p.url || ''))), 'the order is read per-record');
    const row = rows()[0];
    assert.match(JSON.stringify(row.observed || {}), /1Z999AA/, 'the tracking number reaches the record');
    assert.deepEqual(row.events.map((e) => e.type), ['create', 'transition', 'update']);
  });
});

describe('AU-6 sweep — a COLD draft, completed: the forced sweep is its only way home', () => {
  // v2.74.2217 — the blind spot the AU-6 review named: a draft past its warm window that THEN completes could
  // never hand off. Cold suppresses the per-record read, the collection cannot see COMPLETED drafts (v2215),
  // and `force` bypassed only the poll windows — so not even a human opening the card could rescue it. A
  // forced sweep now re-reads cold rows ("a person asking is not background cost").
  const NOW = Date.now();
  before(async () => {
    installChrome();
    await initOnce();
    asked = [];
    listHasDraft = false;
    store[AUDIT_KEY] = { items: [auditEntry({
      at: NOW - 20 * 86_400_000, system: 'admin.shopify.com', kind: 'draft', id: '1144819318918', label: '#D29741',
      who: 'human', recipeId: 'shopify_create_order', warmUntil: NOW - 6 * 86_400_000,   // cold for six days
    })], total: 1, updatedAt: NOW - 20 * 86_400_000 };
    delete store['audit:watch'];
  });
  after(() => { listHasDraft = true; restoreChrome(); });

  it('hands off on the forced (human-is-looking) sweep, despite being cold', async () => {
    const r = await verify();   // RECORD_VERIFY_NOW → force: true
    assert.equal(r.tally.handed, 1, `a cold row must be re-read when a person asks: ${JSON.stringify(r.tally)}`);
    assert.equal(rows()[0].currentKind, 'order');
  });

  it('and re-warms on the ORDER’s declared 60d window, not the draft leg’s', () => {
    // v2.74.2217 — the destination-window fix, asserted through the SHIPPED catalog: shopify_order declares
    // `warm: '60d'`. Under the old code this was the observing leg's window instead, and an order quiet past
    // it went cold before its tracking number existed.
    const w = rows()[0].warmUntil;
    assert.ok(w > NOW + 59 * 86_400_000, `warmUntil grants the order's horizon, got +${Math.round((w - NOW) / 86_400_000)}d`);
  });
});

describe('AU-6 sweep — an empty book is a no-op, not a failure', () => {
  before(async () => {
    installChrome();
    await initOnce();
    asked = [];
    store[AUDIT_KEY] = { items: [], total: 0, updatedAt: T0 };
  });
  after(restoreChrome);

  it('says so honestly rather than reporting a check it never made', async () => {
    const r = await verify();
    assert.equal(r.success, true);
    assert.equal(asked.length, 0, 'no rows → no requests');
  });
});
