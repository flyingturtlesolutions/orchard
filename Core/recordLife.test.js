// Core/recordLife.test.js — AU-6 (DESIGN_audit.md §12). §12.7 names the per-rung test list explicitly and this
// file is that list, in its order, plus the shape rules the state machine's rulings imply.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextWatch, reWarm, applyTransition, applyUpdate, applyGone, appendEvent,
  currentRef, handOff, asOfLine, mayRead, warmWindowMs,
  WATCH_STATES, EVENT_CAP, DEFAULT_WARM_MS,
} from './recordLife.js';
import { auditEntry, describeCreate, recordOpenUrl } from './audit.js';

const DAY = 86400000;
const T0 = 1_700_000_000_000;
// A real create, through the real constructor — a fixture that drifts from `auditEntry` would test nothing.
const draft = (over = {}) => ({ ...auditEntry({ at: T0, system: 'admin.shopify.com', kind: 'draft', id: '29685', label: '#D29685', who: 'human', recipeId: 'shopify_create_order' }), warmUntil: T0 + 14 * DAY, ...over });

describe('recordLife — the state machine (§12.2)', () => {
  it('a create is born WARM, with a one-entry timeline', () => {
    const r = draft();
    assert.equal(r.watch, 'warm');
    assert.equal(r.lastSeenAt, T0);
    assert.deepEqual(r.events.map((e) => e.type), ['create']);
    assert.equal(r.events[0].kind, 'draft');
  });

  it('warm → cold when the window elapses; the state is DERIVED, so nothing has to remember to write it', () => {
    const r = draft();
    assert.equal(nextWatch(r, T0 + DAY), 'warm');
    assert.equal(nextWatch(r, T0 + 14 * DAY + 1), 'cold');
  });

  it('any observed change RE-WARMS a cold row', () => {
    const cold = { ...draft(), warmUntil: T0 };
    assert.equal(nextWatch(cold, T0 + DAY), 'cold');
    const back = reWarm(cold, { at: T0 + DAY, windowMs: 14 * DAY });
    assert.equal(nextWatch(back, T0 + DAY), 'warm');
  });

  it('GONE is terminal and ABSORBING — nothing re-warms it, nothing transitions it', () => {
    const g = applyGone(draft(), { why: '404', at: T0 + DAY });
    assert.equal(g.watch, 'gone');
    assert.equal(nextWatch(g, T0 + 100 * DAY), 'gone');
    assert.equal(reWarm(g, { at: T0 + 2 * DAY }), g, 'unchanged, same object');
    assert.equal(applyTransition(g, { toKind: 'order', toId: '1', at: T0 + 2 * DAY }), g);
    assert.equal(applyUpdate(g, { fields: { tracking: 'X' }, at: T0 + 2 * DAY }), g);
  });

  it('gone drops warmUntil — §12.1 says it is absent when cold or gone', () => {
    assert.equal('warmUntil' in applyGone(draft(), { at: T0 }), false);
  });

  it('gone is IDEMPOTENT — a second observation of the same non-existence is not a second event', () => {
    const g = applyGone(draft(), { why: 'deleted', at: T0 + DAY });
    assert.equal(applyGone(g, { why: 'deleted', at: T0 + 2 * DAY }), g);
  });

  it('there is no `settled` state — an order can be returned after it ships (ruled 2026-08-10)', () => {
    assert.deepEqual([...WATCH_STATES], ['warm', 'cold', 'gone']);
  });
});

describe('recordLife — applyTransition: the hand-off is an EVENT, not a row (§12.0)', () => {
  const done = () => applyTransition(draft(), { toKind: 'order', toId: '1234', at: T0 + 2 * DAY, windowMs: 60 * DAY });

  it('same row: id and kind are UNCHANGED, currentKind/currentId advance', () => {
    const r = done();
    assert.equal(r.id, '29685', 'the create id is the row identity, forever');
    assert.equal(r.kind, 'draft', 'what Orchard CREATED is never rewritten');
    assert.equal(r.currentKind, 'order');
    assert.equal(r.currentId, '1234');
  });

  it('appends ONE transition event carrying both ends, so the change is auditable rather than assumed', () => {
    const r = done();
    assert.deepEqual(r.events.map((e) => e.type), ['create', 'transition']);
    const t = r.events[1];
    assert.equal(t.fromKind, 'draft'); assert.equal(t.fromId, '29685');
    assert.equal(t.toKind, 'order'); assert.equal(t.toId, '1234');
  });

  it('RE-WARMS — the thing worth seeing often arrives after the hand-off (the tracking number)', () => {
    const r = done();
    assert.equal(r.watch, 'warm');
    assert.equal(r.warmUntil, T0 + 2 * DAY + 60 * DAY, 'the window restarts from the transition');
  });

  it('a transition to WHERE IT ALREADY IS is not an event — a re-read that confirms must not grow the timeline', () => {
    const r = done();
    assert.equal(applyTransition(r, { toKind: 'order', toId: '1234', at: T0 + 9 * DAY }), r);
  });

  it('an EMPTY observation records nothing — a hand-off must be observed, never inferred (§12.5)', () => {
    const r = draft();
    assert.equal(applyTransition(r, { toKind: '', toId: '', at: T0 }), r);
    assert.equal(applyTransition(r, { toKind: 'order', toId: '', at: T0 }), r);
  });

  it('a SECOND hand-off chains from the current pointer, not from the create', () => {
    const r = applyTransition(done(), { toKind: 'refund', toId: '77', at: T0 + 30 * DAY });
    const t = r.events[2];
    assert.equal(t.fromKind, 'order'); assert.equal(t.fromId, '1234');
    assert.equal(r.kind, 'draft', 'still what was created');
  });
});

describe('recordLife — applyUpdate: only a CHANGE is an event (§12.7)', () => {
  it('a first observation appends and re-warms', () => {
    const r = applyUpdate(draft(), { fields: { tracking: '1Z999' }, at: T0 + DAY });
    assert.deepEqual(r.events.map((e) => e.type), ['create', 'update']);
    assert.deepEqual(r.observed, { tracking: '1Z999' });
  });

  it('a re-read confirming the SAME tracking number must not grow the timeline', () => {
    const r = applyUpdate(draft(), { fields: { tracking: '1Z999' }, at: T0 + DAY });
    assert.equal(applyUpdate(r, { fields: { tracking: '1Z999' }, at: T0 + 2 * DAY }), r);
  });

  it('an ABSENT path yields no key, never undefined', () => {
    const r = applyUpdate(draft(), { fields: { tracking: '', carrier: null }, at: T0 + DAY });
    assert.equal(r.events.length, 1, 'nothing observed → nothing recorded');
  });

  it('a CHANGED value appends, keeping the earlier one in the timeline', () => {
    const a = applyUpdate(draft(), { fields: { status: 'OPEN' }, at: T0 + DAY });
    const b = applyUpdate(a, { fields: { status: 'COMPLETED' }, at: T0 + 2 * DAY });
    assert.deepEqual(b.events.map((e) => e.type), ['create', 'update', 'update']);
    assert.deepEqual(b.events[1].fields, { status: 'OPEN' });
    assert.deepEqual(b.events[2].fields, { status: 'COMPLETED' });
  });
});

describe('recordLife — the ONE timeline (§12.1a)', () => {
  it('caps, and NEVER evicts the create — it is the row’s reason for existing', () => {
    let ev = [{ at: T0, type: 'create', kind: 'draft', id: '1' }];
    for (let i = 0; i < EVENT_CAP + 10; i++) ev = appendEvent(ev, { at: T0 + i, type: 'update', fields: { n: i } });
    assert.equal(ev.length, EVENT_CAP);
    assert.equal(ev[0].type, 'create');
    assert.equal(ev[ev.length - 1].fields.n, EVENT_CAP + 9, 'newest kept');
  });

  it('refuses an unknown event type rather than storing a shape nothing can read', () => {
    assert.deepEqual(appendEvent([], { at: T0, type: 'invented' }), []);
    assert.deepEqual(appendEvent([], null), []);
  });
});

describe('recordLife — the pointer, and the AU-2 defect it closes (§12.1a)', () => {
  it('currentRef falls back to the create until a hand-off is observed', () => {
    assert.deepEqual(currentRef(draft()), { kind: 'draft', id: '29685' });
  });

  it('after a hand-off it names the ARTIFACT, not the act', () => {
    const r = applyTransition(draft(), { toKind: 'order', toId: '1234', at: T0 + DAY });
    assert.deepEqual(currentRef(r), { kind: 'order', id: '1234' });
    assert.deepEqual(handOff(r), { fromKind: 'draft', fromId: '29685', toKind: 'order', toId: '1234' });
  });

  it('handOff is null when nothing moved — the card must not invent an arrow', () => {
    assert.equal(handOff(draft()), null);
    assert.equal(handOff({ kind: 'draft', id: '1', currentKind: 'draft', currentId: '1' }), null);
  });

  it('REGRESSION (§12.1): the draft template + an ORDER id builds a wrong-record link, so the caller must not use it', () => {
    // This is the defect in as few lines as it takes: same template, moved id, a valid-looking URL for a
    // DIFFERENT record. The panel's resolver now picks the recipe by `currentKind`; this asserts why it must.
    const r = applyTransition(draft(), { toKind: 'order', toId: '1234', at: T0 + DAY });
    const wrong = recordOpenUrl({ ...r, id: currentRef(r).id }, '/store/deako/draft_orders/{id}', (t, a) => t.replace('{id}', a.id));
    assert.equal(wrong, 'https://admin.shopify.com/store/deako/draft_orders/1234', 'valid-looking, and the wrong record');
    const right = recordOpenUrl({ ...r, id: currentRef(r).id }, '/store/deako/orders/{id}', (t, a) => t.replace('{id}', a.id));
    assert.equal(right, 'https://admin.shopify.com/store/deako/orders/1234');
  });

  it('describeCreate still reports what was CREATED after a hand-off — never “you created an order”', () => {
    const r = applyTransition(draft(), { toKind: 'order', toId: '1234', at: T0 + DAY });
    assert.match(describeCreate(r, '10:00'), /draft/);
    assert.doesNotMatch(describeCreate(r, '10:00'), /\border\b/);
  });
});

describe('recordLife — reads, decay, and what cold actually suppresses (§12.3)', () => {
  it('a COLD row still accepts an observed change', () => {
    const cold = { ...draft(), warmUntil: T0 };
    const r = applyUpdate(cold, { fields: { tracking: '1Z' }, at: T0 + 90 * DAY });
    assert.equal(nextWatch(r, T0 + 90 * DAY), 'warm', 'nothing suppresses OBSERVATION at any tier');
  });

  it('COLD suppresses PER-RECORD reads and nothing else — a collection poll still covers it', () => {
    const cold = { ...draft(), warmUntil: T0 };
    assert.equal(mayRead(cold, { scope: 'record', now: T0 + DAY }), false);
    assert.equal(mayRead(cold, { scope: 'collection', now: T0 + DAY }), true,
      'a collection read is O(1) in records — excluding cold rows saves zero and buys a blind spot');
  });

  it('verify-at-view forces a read on a cold row — a human asking is not a background cost', () => {
    const cold = { ...draft(), warmUntil: T0 };
    assert.equal(mayRead(cold, { scope: 'record', now: T0 + DAY, force: true }), true);
  });

  it('GONE reads nothing, at any scope, forced or not — there is nothing left to confirm', () => {
    const g = applyGone(draft(), { at: T0 });
    for (const scope of ['record', 'collection']) {
      assert.equal(mayRead(g, { scope, now: T0 + DAY, force: true }), false);
    }
  });
});

describe('recordLife — the warm window is recipe DATA (§12.4)', () => {
  it('parses the declared forms', () => {
    assert.equal(warmWindowMs({ warm: '60d' }), 60 * DAY);
    assert.equal(warmWindowMs({ warm: '36h' }), 36 * 3600000);
    assert.equal(warmWindowMs({ warm: '90m' }), 90 * 60000);
    assert.equal(warmWindowMs({ warm: 5000 }), 5000);
  });

  it('a missing or malformed value FALLS BACK rather than throwing — a bad catalog string must not break the ledger', () => {
    assert.equal(warmWindowMs({}), DEFAULT_WARM_MS);
    assert.equal(warmWindowMs({ warm: 'soon' }), DEFAULT_WARM_MS);
    assert.equal(warmWindowMs({ warm: '0d' }), DEFAULT_WARM_MS);
    assert.equal(warmWindowMs(null, 99), 99);
  });
});

describe('recordLife — staleness is RENDERED, never implied (§12.6)', () => {
  it('says the state and when it was last confirmed', () => {
    assert.equal(asOfLine(draft(), '10:04', T0 + DAY), 'warm — as of 10:04');
    assert.equal(asOfLine({ ...draft(), warmUntil: T0 }, '10:04', T0 + DAY), 'cold — as of 10:04');
  });

  it('a gone row says so, and a 404 says which kind of gone', () => {
    assert.match(asOfLine(applyGone(draft(), { why: '404', at: T0 }), '10:04', T0), /gone \(not found on the site\)/);
    assert.match(asOfLine(applyGone(draft(), { why: 'deleted', at: T0 }), '10:04', T0), /^gone —/);
  });

  it('NEVER confirmed → says nothing rather than inventing a freshness', () => {
    assert.equal(asOfLine({ kind: 'draft', id: '1' }, '10:04', T0), '');
  });
});
