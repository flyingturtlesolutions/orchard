/**
 * presence (v2.74.1838) — DESIGN_presence.md. The fixtures are the live 07-27 09:44 failure and the two
 * asymmetries that failure taught: a stale NEGATIVE must not block, and a failed probe must not block.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeBelief, invalidate, observe, shouldConfirm, gate, minutesLeft, renderPresence } from './presence.js';

const T = 1_700_000_000_000;

describe('invalidate — marks stale, decides nothing, never manufactures optimism', () => {
  it('fresh → stale on a cookie change', () => {
    assert.equal(invalidate(makeBelief({ state: 'fresh', checkedAt: T })).state, 'stale');
  });

  it('a cookie change can NEVER produce signed-in — only a probe can', () => {
    // The event says "something moved", not "you are back". Promoting it would invent evidence.
    assert.equal(invalidate(makeBelief({ state: 'signed-out' })).state, 'signed-out');
    assert.equal(invalidate(makeBelief({ state: 'unknown' })).state, 'unknown');
  });
});

describe('observe — the only producer of fresh / signed-out', () => {
  it('records both outcomes and clears expiry on sign-out', () => {
    assert.equal(observe(null, { signedIn: true, at: T, expiresAt: T + 60000 }).state, 'fresh');
    assert.equal(observe(null, { signedIn: false, at: T }).state, 'signed-out');
    assert.equal(observe(makeBelief({ state: 'fresh', expiresAt: T + 60000 }), { signedIn: false, at: T }).expiresAt, null);
  });

  it('an INCONCLUSIVE probe changes nothing (§2.1 — failure is evidence about the network)', () => {
    const b = makeBelief({ state: 'fresh', checkedAt: T });
    assert.deepEqual(observe(b, { signedIn: null, at: T + 5 }), b);
    assert.deepEqual(observe(b, { signedIn: undefined }), b);
  });
});

describe('shouldConfirm — off the common path, on for stale-or-negative', () => {
  it('fresh costs ZERO probes; everything else confirms', () => {
    assert.equal(shouldConfirm(makeBelief({ state: 'fresh', checkedAt: T })), false);
    for (const s of ['stale', 'signed-out', 'unknown']) assert.equal(shouldConfirm(makeBelief({ state: s })), true, s);
  });

  it('PR-4 — a lapsed expiry confirms even when nothing invalidated it', () => {
    const b = makeBelief({ state: 'fresh', checkedAt: T, expiresAt: T + 60000 });
    assert.equal(shouldConfirm(b, { now: T }), false);
    assert.equal(shouldConfirm(b, { now: T + 60001 }), true);
  });
});

describe('gate — the two asymmetries that the 09:44 failure taught', () => {
  it('a FAILED probe proceeds — a slow network must never read as signed out', () => {
    // Live 07-27 00:11: a csrf prewarm took 10s. Blocking on that = dead air then a wrong refusal.
    assert.deepEqual(gate(makeBelief({ state: 'stale' }), { confirmed: 'failed' }), { proceed: true, reason: 'probe-failed-proceeding' });
  });

  it('a STALE belief proceeds — a stale negative must not refuse work that would succeed', () => {
    // This is the 09:44 shape: the app refused four runs over a minute while actually signed in.
    assert.equal(gate(makeBelief({ state: 'stale' })).proceed, true);
    assert.equal(gate(makeBelief({ state: 'unknown' })).proceed, true);
  });

  it('only a CONFIRMED signed-out stops the run', () => {
    assert.deepEqual(gate(makeBelief({ state: 'fresh' }), { confirmed: false }), { proceed: false, reason: 'confirmed-signed-out' });
    assert.equal(gate(makeBelief({ state: 'signed-out' })).proceed, false);   // an established probe result, not a guess
  });

  it('fresh proceeds with no probe at all', () => {
    assert.deepEqual(gate(makeBelief({ state: 'fresh', checkedAt: T })), { proceed: true, reason: 'cached-fresh' });
  });
});

describe('minutesLeft / renderPresence — PR-4 + PR-6', () => {
  it('reports the envelope, never a cookie value', () => {
    assert.equal(minutesLeft(makeBelief({ expiresAt: T + 12 * 60000 }), { now: T }), 12);
    assert.equal(minutesLeft(makeBelief({ expiresAt: T - 5000 }), { now: T }), 0);
    assert.equal(minutesLeft(makeBelief({}), { now: T }), null);
  });

  it('emits the PRESENCE ▸ marker registered in _DECISION_RE', () => {
    const b = makeBelief({ state: 'fresh', checkedAt: T, expiresAt: T + 12 * 60000 });
    assert.match(renderPresence('vendorsuite.drhorton.com', b, { reason: 'cached-fresh', now: T }),
      /^PRESENCE ▸ vendorsuite\.drhorton\.com · fresh · cached-fresh · lapses in 12m$/);
    assert.match(renderPresence('x.com', makeBelief({ state: 'stale', why: 'cookie changed' }), { reason: 're-probed' }),
      /PRESENCE ▸ x\.com · stale · re-probed · cookie changed/);
  });

  it('survives junk rather than throwing inside a log call', () => {
    assert.equal(renderPresence('', null), '');
    assert.equal(renderPresence(null, null), '');
    assert.equal(makeBelief({ state: 'banana' }).state, 'unknown');
  });
});
