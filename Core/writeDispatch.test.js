// Core/writeDispatch.test.js — CX-8 (v2.74.1397): the prefer-ride-fallback-drive cascade + its safety property.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isHashStale, isRideUnprimed, isRideRecoverable, planWrite, recoverAfterRide } from './writeDispatch.js';

const RIDE = (over) => ({ available: true, armable: true, primed: true, ...over });
const DRIVE = (over) => ({ available: true, armable: true, ...over });

describe('writeDispatch — failure classification (the drive-recoverable set)', () => {
  it('hash-stale + op-not-captured are the ONLY drive-recoverable (pre-execution) failures', () => {
    assert.equal(isHashStale({ error: 'op-hash-stale' }), true);
    assert.equal(isRideUnprimed({ error: 'op-not-captured' }), true);
    assert.equal(isRideRecoverable({ error: 'op-hash-stale' }), true);
    assert.equal(isRideRecoverable({ error: 'op-not-captured' }), true);
    // NOT recoverable by a drive — the drive would re-hit these (hash-agnostic)
    for (const e of ['graphql-error', 'not-logged-in', 'non-json', 'http-403', 'write-needs-confirm', 'no-url-param']) {
      assert.equal(isRideRecoverable({ error: e }), false, e);
    }
    assert.equal(isRideRecoverable(null), false);
    assert.equal(isRideRecoverable({ success: true }), false);
  });
});

describe('writeDispatch — planWrite (upfront lane order)', () => {
  it('prefers ride, then drive, when both are runnable interactively', () => {
    const p = planWrite({ ride: RIDE(), drive: DRIVE() }, { headless: false });
    assert.deepEqual(p.lanes, ['ride', 'drive']);
    assert.equal(p.driveFallbackAvailable, true);
  });
  it('a HEADLESS caller drops the drive lane (H-1a — never drive a tab)', () => {
    const p = planWrite({ ride: RIDE(), drive: DRIVE() }, { headless: true });
    assert.deepEqual(p.lanes, ['ride']);              // ride only; a stale ride will PARK (recoverAfterRide)
    assert.equal(p.driveFallbackAvailable, false);
  });
  it('an UNPRIMED ride (no banked hash) is not a runnable lane; drive becomes primary', () => {
    const p = planWrite({ ride: RIDE({ primed: false }), drive: DRIVE() }, { headless: false });
    assert.deepEqual(p.lanes, ['drive']);            // interactive teach: drive runs immediately, no capture wait
  });
  it('drive-only interactive; drive-blocked-headless notes the park path', () => {
    assert.deepEqual(planWrite({ ride: null, drive: DRIVE() }, { headless: false }).lanes, ['drive']);
    const blocked = planWrite({ ride: null, drive: DRIVE() }, { headless: true });
    assert.deepEqual(blocked.lanes, []);
    assert.equal(blocked.note, 'drive-blocked-headless');
  });
  it('a non-armable ride/drive is excluded (the §18 arm guard)', () => {
    assert.deepEqual(planWrite({ ride: RIDE({ armable: false }), drive: DRIVE({ armable: false }) }, {}).lanes, []);
    assert.equal(planWrite({ ride: null, drive: null }, {}).note, 'no-runnable-lane');
  });
});

describe('writeDispatch — recoverAfterRide (the reactive fallback/park/stop decision)', () => {
  it('interactive hash-stale with a drive → fall back to the drive (re-primes the hash, §20.8)', () => {
    assert.deepEqual(recoverAfterRide({ error: 'op-hash-stale' }, { drive: DRIVE(), headless: false }),
      { action: 'drive', reason: 'hash-stale' });
    assert.deepEqual(recoverAfterRide({ error: 'op-not-captured' }, { drive: DRIVE(), headless: false }),
      { action: 'drive', reason: 'op-unprimed' });
  });
  it('HEADLESS (the sweep) hash-stale → PARK for the human (approve-click re-primes), never drive a tab', () => {
    assert.deepEqual(recoverAfterRide({ error: 'op-hash-stale' }, { drive: DRIVE(), headless: true }),
      { action: 'park', reason: 'headless-cannot-drive' });
  });
  it('no drive artifact to fall back to → STOP (a ride-only bank dead-ends — teach the write for CX-8 dual-capture)', () => {
    assert.deepEqual(recoverAfterRide({ error: 'op-hash-stale' }, { drive: null, headless: false }),
      { action: 'stop', reason: 'no-drive-to-fall-back' });
    assert.deepEqual(recoverAfterRide({ error: 'op-hash-stale' }, { drive: DRIVE({ armable: false }), headless: false }),
      { action: 'stop', reason: 'no-drive-to-fall-back' });
  });
  it('a NON-hash ride failure → STOP (the drive would re-hit it — never fall back, never risk a double-write)', () => {
    for (const e of ['graphql-error', 'not-logged-in', 'non-json']) {
      assert.equal(recoverAfterRide({ error: e }, { drive: DRIVE(), headless: false }).action, 'stop', e);
    }
  });
});
