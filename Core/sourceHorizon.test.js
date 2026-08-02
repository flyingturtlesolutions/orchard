// Core/sourceHorizon.test.js — HZ-1 (v2.74.1956).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sourceHorizon, emptyResultNote } from './sourceHorizon.js';

const upsLeg = { tool: { appHost: 'www.ups.com', retention: { days: 120, approximate: true, source: 'UPS published policy' } } };

describe('sourceHorizon — reading the declaration', () => {
  it('reads a horizon off a projected leg', () => {
    assert.deepEqual(sourceHorizon(upsLeg), { days: 120, approximate: true, source: 'UPS published policy' });
  });

  it('reads it off a raw recipe too (hop 1 and hop 3 shapes both work)', () => {
    assert.equal(sourceHorizon({ appHost: 'www.ups.com', retention: { days: 120 } }).days, 120);
  });

  it('defaults to APPROXIMATE — a hard bound must opt in', () => {
    // Hedging is the safe default: a published figure we have not measured must not be stated as exact.
    assert.equal(sourceHorizon({ retention: { days: 120 } }).approximate, true);
    assert.equal(sourceHorizon({ retention: { days: 120, approximate: false } }).approximate, false);
  });

  it('returns null for legs with no declaration — most legs', () => {
    assert.equal(sourceHorizon({ tool: { appHost: 'admin.shopify.com' } }), null);
    assert.equal(sourceHorizon({}), null);
    assert.equal(sourceHorizon(null), null);
  });

  it('ignores a malformed or nonsense window rather than half-trusting it', () => {
    for (const bad of [{ days: 0 }, { days: -5 }, { days: 'soon' }, { days: null }, {}]) {
      assert.equal(sourceHorizon({ retention: bad }), null);
    }
  });
});

describe('emptyResultNote — the sentence that stops a wrong absence', () => {
  it('names the source, hedges, and says what an empty result does NOT mean', () => {
    const n = emptyResultNote(upsLeg);
    assert.match(n, /ups\.com/);
    assert.match(n, /about 120 days/);
    assert.match(n, /aged out/);
    assert.match(n, /doesn't exist/);
  });

  it('drops the hedge when the bound is declared exact', () => {
    const n = emptyResultNote({ tool: { appHost: 'x.example', retention: { days: 30, approximate: false } } });
    assert.doesNotMatch(n, /about/);
    assert.match(n, /keeps these records for 30 days/);
  });

  it('converts to months only when they divide near-evenly — no invented precision', () => {
    assert.match(emptyResultNote({ retention: { days: 120 } }), /120 days \(about 4 months\)/);
    assert.match(emptyResultNote({ retention: { days: 90 } }),  /90 days \(about 3 months\)/);
    assert.doesNotMatch(emptyResultNote({ retention: { days: 47 } }), /months/);   // 1.57 — not clean
    assert.doesNotMatch(emptyResultNote({ retention: { days: 30 } }), /months/);   // 1 month reads worse than "30 days"
  });

  it('returns null when there is no horizon, so callers need no shape check', () => {
    assert.equal(emptyResultNote({ tool: { appHost: 'admin.shopify.com' } }), null);
    assert.equal(emptyResultNote(null), null);
  });

  it('falls back to a generic subject when the host is unknown', () => {
    assert.match(emptyResultNote({ retention: { days: 120 } }), /^This source /);
  });
});
