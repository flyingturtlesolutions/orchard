// Services/Chat/mergeLock.test.js — DBR-P4-6 (DESIGN §7.2): the merge land-only lock + FIFO queue.
// PURE: imports only the reducer + the async wrapper — no chrome / no git / no port.
// Run via `npm test` (the glob includes Services/Chat/*.test.js).
//
// Acceptance (DBR-P4-6): a held lock defers a second land; release auto-promotes the FIFO head; "Nth in line"
// is 1-based; the async wrapper serializes two concurrent lands (the second runs only after the first releases).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeLockState, acquire, release, queueDepth, position, createMergeLock } from './mergeLock.js';

describe('mergeLock reducer — single holder', () => {
  it('grants the lock to the first caller when free', () => {
    const r = acquire(makeLockState(), 'a');
    assert.equal(r.granted, true);
    assert.equal(r.position, 0);
    assert.equal(r.state.holder, 'a');
    assert.equal(queueDepth(r.state), 0);
  });
  it('is immutable — acquire returns new state, leaves the input untouched', () => {
    const s0 = makeLockState();
    acquire(s0, 'a');
    assert.equal(s0.holder, null);
    assert.equal(s0.queue.length, 0);
  });
  it('re-acquiring as the current holder is idempotent (granted, pos 0, no queue)', () => {
    let s = acquire(makeLockState(), 'a').state;
    const r = acquire(s, 'a');
    assert.equal(r.granted, true);
    assert.equal(r.position, 0);
    assert.equal(queueDepth(r.state), 0);
  });
});

describe('mergeLock reducer — FIFO queue + Nth in line', () => {
  it('defers later callers and reports 1-based positions', () => {
    let s = acquire(makeLockState(), 'a').state;   // a holds
    const rb = acquire(s, 'b');
    assert.equal(rb.granted, false);
    assert.equal(rb.position, 1);                  // b: 1st in line
    s = rb.state;
    const rc = acquire(s, 'c');
    assert.equal(rc.granted, false);
    assert.equal(rc.position, 2);                  // c: 2nd in line
    s = rc.state;
    assert.equal(queueDepth(s), 2);
    assert.equal(position(s, 'a'), 0);
    assert.equal(position(s, 'b'), 1);
    assert.equal(position(s, 'c'), 2);
  });
  it('queueing the same id twice does not duplicate it', () => {
    let s = acquire(makeLockState(), 'a').state;
    s = acquire(s, 'b').state;
    const r = acquire(s, 'b');                     // b again
    assert.equal(r.granted, false);
    assert.equal(r.position, 1);
    assert.equal(queueDepth(r.state), 1);
  });
});

describe('mergeLock reducer — release auto-promotes the FIFO head', () => {
  it('promotes the head to holder on release', () => {
    let s = acquire(makeLockState(), 'a').state;
    s = acquire(s, 'b').state;
    s = acquire(s, 'c').state;
    const r = release(s, 'a');
    assert.equal(r.next, 'b');                     // b promoted
    assert.equal(r.state.holder, 'b');
    assert.equal(queueDepth(r.state), 1);          // c remains
    assert.equal(position(r.state, 'c'), 1);       // c moves up to 1st
  });
  it('release with an empty queue frees the lock (holder → null)', () => {
    const s = acquire(makeLockState(), 'a').state;
    const r = release(s, 'a');
    assert.equal(r.next, null);
    assert.equal(r.state.holder, null);
    assert.equal(queueDepth(r.state), 0);
  });
  it('releasing a queued (non-holder) id cancels its wait, holder unchanged', () => {
    let s = acquire(makeLockState(), 'a').state;
    s = acquire(s, 'b').state;
    s = acquire(s, 'c').state;
    const r = release(s, 'b');                     // b cancels before its turn
    assert.equal(r.next, null);
    assert.equal(r.state.holder, 'a');             // a still holds
    assert.equal(queueDepth(r.state), 1);
    assert.equal(position(r.state, 'c'), 1);       // c moves up
  });
  it('releasing an unknown id is a no-op', () => {
    const s = acquire(makeLockState(), 'a').state;
    const r = release(s, 'zzz');
    assert.equal(r.next, null);
    assert.equal(r.state.holder, 'a');
    assert.equal(queueDepth(r.state), 0);
  });
});

describe('mergeLock reducer — guards', () => {
  it('acquire(null) is rejected, not granted', () => {
    const r = acquire(makeLockState(), null);
    assert.equal(r.granted, false);
    assert.equal(r.position, -1);
    assert.equal(r.state.holder, null);
  });
  it('position is -1 for an absent id', () => {
    const s = acquire(makeLockState(), 'a').state;
    assert.equal(position(s, 'nope'), -1);
  });
});

describe('createMergeLock async wrapper — serializes lands', () => {
  it('grants immediately when free, defers a second acquirer until release', async () => {
    const lock = createMergeLock();
    const order = [];
    const relA = await lock.acquire('a');          // free → immediate
    order.push('a-start');

    let waited = -1;
    const pB = lock.acquire('b', (pos) => { waited = pos; }).then((relB) => {
      order.push('b-start');
      return relB;
    });

    assert.equal(waited, 1);                        // b had to queue → onWait fired with 1st-in-line
    assert.equal(lock.depth(), 1);
    assert.equal(lock.position('b'), 1);

    order.push('a-release');
    relA();                                         // releasing a promotes b
    const relB = await pB;

    assert.deepEqual(order, ['a-start', 'a-release', 'b-start']);   // strictly serial
    assert.equal(lock.depth(), 0);
    relB();
  });
});
