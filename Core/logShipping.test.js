// Core/logShipping.test.js — CW-3: the pure shipper half (DESIGN_cloud_logs.md §3, rulings 2 & 9). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { filterForLevel, evictMiddleOut, gapEvent, buildBatches, backoffDelay, urgentEvent } from './logShipping.js';
import { buildDecisionRegExp } from './decisionMarkers.js';

const ev = (t, lvl, msg) => ({ t, lvl, tag: 'x', msg, v: '2.74.0' });

describe('logShipping — filterForLevel (ruling 2)', () => {
  const events = [
    ev(1, 'DEBUG', 'Message: VITALS_BADGE'),
    ev(2, 'INFO', 'HEAL ▸ suspect vendorsuite'),
    ev(3, 'INFO', 'plain line'),
    ev(4, 'ERROR', 'boom'),
  ];
  const re = buildDecisionRegExp();
  it('off ships nothing', () => assert.equal(filterForLevel(events, 'off', re).length, 0));
  it('decisions ships only manifest-matching lines', () => {
    assert.deepEqual(filterForLevel(events, 'decisions', re).map((e) => e.t), [2]);
  });
  it('full ships EVERYTHING, DEBUG included (user ruling)', () => {
    assert.equal(filterForLevel(events, 'full', re).length, 4);
  });
});

describe('logShipping — evictMiddleOut + gapEvent (ruling 9)', () => {
  it('under cap: untouched, no gap', () => {
    const r = evictMiddleOut([ev(1, 'INFO', 'a'), ev(2, 'INFO', 'b')], 10);
    assert.equal(r.events.length, 2);
    assert.equal(r.dropped, null);
  });
  it('over cap: head (onset) + tail survive; the MIDDLE drops; the gap names its bounds', () => {
    const events = Array.from({ length: 100 }, (_, i) => ev(i + 1, 'INFO', 'e' + i));
    const r = evictMiddleOut(events, 20, 5);
    assert.equal(r.events.length, 20);
    assert.deepEqual(r.events.slice(0, 5).map((e) => e.t), [1, 2, 3, 4, 5], 'the onset survives');
    assert.equal(r.events[19].t, 100, 'the newest survives');
    assert.equal(r.dropped.n, 80);
    assert.equal(r.dropped.from, 6);
    assert.equal(r.dropped.to, 85);
    const g = gapEvent(r.dropped, 'quota', 1700000000000);
    assert.match(g.msg, /^SHIPPER ▸ gap — dropped 80 events /);
    assert.equal(g.lvl, 'WARN');
  });
});

describe('logShipping — buildBatches (§3 limits)', () => {
  it('splits on event count', () => {
    const b = buildBatches(Array.from({ length: 1201 }, (_, i) => ev(i, 'INFO', 'x')), { maxEvents: 500 });
    assert.deepEqual(b.map((x) => x.length), [500, 500, 201]);
  });
  it('splits on byte budget', () => {
    const big = 'y'.repeat(10 * 1024);
    const b = buildBatches(Array.from({ length: 5 }, (_, i) => ev(i, 'INFO', big)), { maxBytes: 25 * 1024 });
    assert.ok(b.length >= 3, 'byte cap forces splits');
    assert.equal(b.flat().length, 5, 'nothing lost');
  });
});

describe('logShipping — backoff + urgency', () => {
  it('backoff doubles and caps at 15min', () => {
    assert.equal(backoffDelay(0), 30000);
    assert.equal(backoffDelay(1), 60000);
    assert.equal(backoffDelay(10), 15 * 60 * 1000);
  });
  it('WARN/ERROR are urgent; INFO/DEBUG are not', () => {
    assert.ok(urgentEvent(ev(1, 'ERROR', 'x')) && urgentEvent(ev(1, 'WARN', 'x')));
    assert.ok(!urgentEvent(ev(1, 'INFO', 'x')) && !urgentEvent(ev(1, 'DEBUG', 'x')));
  });
});
