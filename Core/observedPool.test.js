// Core/observedPool.test.js — PS-2 the long-tail observed pool (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { poolKey, addObservation, topObservations, serializePool, deserializePool } from './observedPool.js';

describe('observedPool — value-free catch-net of unmatched touches (pure)', () => {
  it('poolKey is case-insensitive and joins role|name|kind', () => {
    assert.equal(poolKey('BUTTON', 'Save', 'CLICK'), 'button|save|click');
    assert.equal(poolKey('', 'Save', ''), '|save|click'.replace('click', ''));   // empty kind stays empty in the key
  });

  it('addObservation appends a value-free entry; needs an accessibleName', () => {
    const p = addObservation([], { role: 'BUTTON', accessibleName: 'Save draft', kind: 'click' }, { seq: 5 });
    assert.equal(p.length, 1);
    assert.deepEqual(p[0], { key: 'button|save draft|click', role: 'button', accessibleName: 'Save draft', kind: 'click', seenCount: 1, lastSeq: 5 });
    assert.equal('value' in p[0], false);                                          // value-free
    const same = addObservation(p, { role: 'button' }, { seq: 6 });               // no accessibleName → no-op (same ref)
    assert.equal(same, p);
  });

  it('dedups by (role,name,kind): a repeat bumps seenCount + lastSeq', () => {
    let p = addObservation([], { accessibleName: 'Mute', kind: 'click' }, { seq: 1 });
    p = addObservation(p, { accessibleName: 'mute', kind: 'CLICK' }, { seq: 9 });  // same control, different case
    assert.equal(p.length, 1);
    assert.equal(p[0].seenCount, 2);
    assert.equal(p[0].lastSeq, 9);
  });

  it('caps the pool, evicting least-seen / oldest first', () => {
    let p = [];
    for (let i = 0; i < 4; i++) p = addObservation(p, { accessibleName: `ctrl ${i}` }, { seq: i });
    p = addObservation(p, { accessibleName: 'ctrl 0' }, { seq: 10 });              // bump ctrl 0 to seenCount 2
    const capped = addObservation(p, { accessibleName: 'newcomer' }, { seq: 11, max: 3 });
    assert.equal(capped.length, 3);
    assert.ok(capped.some((e) => e.accessibleName === 'ctrl 0'), 'the most-seen entry survives the cap');
  });

  it('topObservations ranks by seenCount then recency', () => {
    let p = addObservation([], { accessibleName: 'A' }, { seq: 1 });
    p = addObservation(p, { accessibleName: 'B' }, { seq: 2 });
    p = addObservation(p, { accessibleName: 'B' }, { seq: 3 });                    // B seen twice
    assert.deepEqual(topObservations(p, 2).map((e) => e.accessibleName), ['B', 'A']);
  });

  it('serialize/deserialize round-trips and drops malformed', () => {
    const p = addObservation([], { accessibleName: 'X' }, { seq: 1 });
    assert.deepEqual(deserializePool(serializePool(p)), p);
    assert.deepEqual(deserializePool(null), []);
    assert.deepEqual(deserializePool({ observations: [{ role: 'button' }] }), []);  // no key/name → dropped
  });
});
