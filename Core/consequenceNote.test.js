// Core/consequenceNote.test.js — v2.74.2229: the §14 write-back's pure half (CW-VS).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { composeNoteLine, appendNote, dueWriteBacks, markWriteBack, NOTE_CREATOR_DEFAULT, TRACKING_RE,
  composeCustomerEmail, dueNotify, stagePendingNotify, clearPendingNotify } from './consequenceNote.js';

const ROW = (over = {}) => ({
  at: 1, system: 'admin.shopify.com', kind: 'draft', id: '29741', label: '#D29741',
  incitedBy: { system: 'vendorsuite.drhorton.com', kind: 'task', id: '10920483', label: '#4916328' },
  ...over,
});

describe('composeNoteLine — the three ruling formats (date — description — reference — creator)', () => {
  it('confirmed carries the order ref and the default creator', () => {
    assert.equal(composeNoteLine('confirmed', { date: '8/14/2026', ref: 'DEAKO#72046' }),
      '8/14/2026 — Replacement order confirmed — DEAKO#72046 — Divine @ Deako');
  });
  it('tracking carries the number (+carrier when known)', () => {
    assert.equal(composeNoteLine('tracking', { date: '8/14/2026', tracking: '1Z27691W0315107239', carrier: 'UPS' }),
      '8/14/2026 — Replacement shipped — tracking 1Z27691W0315107239 (UPS) — Divine @ Deako');
  });
  it('delivered, with and without a number; unknown kind → empty; creator overridable', () => {
    assert.equal(composeNoteLine('delivered', { date: '8/15/2026', tracking: '1Z9' }), '8/15/2026 — Replacement delivered — 1Z9 — Divine @ Deako');
    assert.equal(composeNoteLine('delivered', { date: '8/15/2026', creator: 'CS Bot' }), '8/15/2026 — Replacement delivered — CS Bot');
    assert.equal(composeNoteLine('wormhole', { date: 'x' }), '');
    assert.equal(NOTE_CREATOR_DEFAULT, 'Divine @ Deako');
  });
});

describe('appendNote — the prior text ALWAYS survives; idempotent', () => {
  it('appends on a new line; first line stands alone', () => {
    assert.equal(appendNote('', 'line one'), 'line one');
    assert.equal(appendNote('homeowner said 2 switches', 'line one'), 'homeowner said 2 switches\nline one');
  });
  it('a line already present is not added twice (the re-fire belt)', () => {
    const once = appendNote('prior', 'the line');
    assert.equal(appendNote(once, 'the line'), once);
  });
});

describe('dueWriteBacks — state-derived, marker-gated, provenance-required', () => {
  it('a hand-off owes confirmed, once', () => {
    const r = ROW({ currentKind: 'order', currentId: '7742160535686', currentLabel: 'DEAKO#72046' });
    assert.deepEqual(dueWriteBacks(r), [{ key: 'confirmed', ref: 'DEAKO#72046' }]);
    assert.deepEqual(dueWriteBacks(markWriteBack(r, 'confirmed', 5)), [], 'marked → no longer owed');
  });
  it('a tracking token in the flattened observed bag owes tracking (the v1 parse)', () => {
    const r = ROW({ observed: { parcels: '+1 new (1Z27691W0315107239)' } });
    assert.deepEqual(dueWriteBacks(r), [{ key: 'tracking', tracking: '1Z27691W0315107239' }]);
    assert.match('1Z27691W0315107239', TRACKING_RE);
  });
  it('DELIVERED in progress/shipStatus owes delivered (tracking rides along when present)', () => {
    const r = ROW({ observed: { parcels: '+1 new (1Z27691W0315107239)', progress: '1Z27691W0315107239→DELIVERED' }, writeBack: { tracking: 3 } });
    assert.deepEqual(dueWriteBacks(r), [{ key: 'delivered', tracking: '1Z27691W0315107239' }]);
  });
  it('no incitedBy → owes NOTHING (a write-back with no destination is never invented)', () => {
    assert.deepEqual(dueWriteBacks(ROW({ incitedBy: null, currentKind: 'order', currentId: '1' })), []);
    assert.deepEqual(dueWriteBacks(null), []);
  });
  it('a retry after a lost write: state unchanged + no marker → still owed (the §12.5 posture)', () => {
    const r = ROW({ currentKind: 'order', currentId: '1', currentLabel: 'DEAKO#1' });
    assert.equal(dueWriteBacks(r).length, 1);
    assert.equal(dueWriteBacks(r).length, 1, 'derives identically until markWriteBack lands');
  });
});

// ── v2.74.2230 — the customer notify: stage-only, allow-listed upstream, sent by a human. ────────────────────
describe('composeCustomerEmail + dueNotify + stage/clear (v2230)', () => {
  it('the email reads as a letter: first name, order ref, tracking promise, creator signature', () => {
    const m = composeCustomerEmail({ name: 'Vielka Wyatt', ref: 'DEAKO#72046', date: '8/14/2026' });
    assert.equal(m.subject, 'Your warranty replacement has been ordered');
    assert.match(m.body, /^Hi Vielka,/);
    assert.match(m.body, /ordered on 8\/14\/2026 \(order DEAKO#72046\)/);
    assert.match(m.body, /tracking as soon as it ships/);
    assert.match(m.body, /— Divine @ Deako$/);
    assert.match(composeCustomerEmail({}).body, /^Hi there,/, 'no name → a graceful salutation, never blank');
  });
  it('dueNotify: handed-off + provenance + neither sent nor staged', () => {
    const r = ROW({ currentKind: 'order', currentId: '1', currentLabel: 'DEAKO#1' });
    assert.deepEqual(dueNotify(r), { ref: 'DEAKO#1' });
    assert.equal(dueNotify(markWriteBack(r, 'notify', 5)), null, 'sent → not due');
    assert.equal(dueNotify(stagePendingNotify(r, { to: 'x@y.com' })), null, 'staged → the drill owns it');
    assert.equal(dueNotify(stagePendingNotify(r, { withheld: 'phone-only' })), null, 'withheld is staged too — no re-compose loop');
    assert.equal(dueNotify(ROW({ currentKind: 'order', currentId: '1', incitedBy: null })), null, 'no provenance → no destination');
    assert.equal(dueNotify(ROW()), null, 'not handed off → nothing to announce');
  });
  it('stagePendingNotify never overwrites; clearPendingNotify removes and is idempotent', () => {
    const r = stagePendingNotify(ROW(), { to: 'a@b.com', subject: 's' });
    assert.equal(stagePendingNotify(r, { to: 'other@x.com' }), r, 'first stage wins');
    const c = clearPendingNotify(r);
    assert.equal('pendingNotify' in c, false);
    assert.equal(clearPendingNotify(c), c, 'same object back when nothing to clear');
  });
});

describe('markWriteBack — same-object on a repeat (the changed:false contract)', () => {
  it('marks once, returns the same object when already marked', () => {
    const r = ROW();
    const m = markWriteBack(r, 'confirmed', 9);
    assert.equal(m.writeBack.confirmed, 9);
    assert.equal(markWriteBack(m, 'confirmed', 99), m);
    assert.equal(markWriteBack(r, ''), r);
  });
});
