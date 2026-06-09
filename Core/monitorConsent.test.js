// Core/monitorConsent.test.js — Track consent: GLOBAL enable + per-page exclude (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canTrack, withTrack, isHostExcluded, isMonitoringEnabled, MONITOR_CONSENT_DEFAULT } from './monitorConsent.js';

describe('canTrack — global ENABLE ∧ host not excluded (default-deny)', () => {
  it('denies by default / null / malformed / disabled', () => {
    assert.equal(canTrack(MONITOR_CONSENT_DEFAULT, { host: 'x.com' }), false);
    assert.equal(canTrack(null, { host: 'x.com' }), false);
    assert.equal(canTrack({}, { host: 'x.com' }), false);
    assert.equal(canTrack({ track: { enabled: false, excludeHosts: [] } }, { host: 'x.com' }), false);
  });
  it('enabled → captures EVERYWHERE (general intent), except excluded hosts', () => {
    const c = { track: { enabled: true, excludeHosts: ['secret.com'] } };
    assert.equal(canTrack(c, { host: 'indeed.com' }), true);     // any host
    assert.equal(canTrack(c, { host: 'whatever.io' }), true);
    assert.equal(canTrack(c, { host: 'secret.com' }), false);    // opted out
  });
});

describe('isHostExcluded / isMonitoringEnabled', () => {
  it('reflect the record', () => {
    const c = { track: { enabled: true, excludeHosts: ['a.com'] } };
    assert.equal(isMonitoringEnabled(c), true);
    assert.equal(isHostExcluded(c, 'a.com'), true);
    assert.equal(isHostExcluded(c, 'b.com'), false);
    assert.equal(isMonitoringEnabled(MONITOR_CONSENT_DEFAULT), false);
  });
});

describe('withTrack — global toggle + per-page moderation', () => {
  it('flips the global switch', () => {
    const on = withTrack(MONITOR_CONSENT_DEFAULT, { enabled: true });
    assert.equal(isMonitoringEnabled(on), true);
    assert.equal(canTrack(on, { host: 'anything.com' }), true);
    assert.equal(MONITOR_CONSENT_DEFAULT.track.enabled, false);   // default not mutated
  });
  it('excludeHost opts a page OUT; includeHost re-includes (idempotent, sorted)', () => {
    let c = withTrack({ track: { enabled: true, excludeHosts: [] } }, { excludeHost: 'b.com' });
    c = withTrack(c, { excludeHost: 'a.com' });
    c = withTrack(c, { excludeHost: 'a.com' });                    // idempotent
    assert.deepEqual(c.track.excludeHosts, ['a.com', 'b.com']);
    assert.equal(canTrack(c, { host: 'a.com' }), false);
    assert.equal(canTrack(c, { host: 'c.com' }), true);           // not excluded → still captured
    c = withTrack(c, { includeHost: 'a.com' });
    assert.deepEqual(c.track.excludeHosts, ['b.com']);
    assert.equal(canTrack(c, { host: 'a.com' }), true);
  });
  it('preserves unspecified fields + does not mutate the input; stamps schema 2', () => {
    const input = { track: { enabled: true, excludeHosts: ['x.com'] }, extra: 1 };
    const out = withTrack(input, { excludeHost: 'y.com' });
    assert.equal(out.extra, 1);
    assert.equal(out.schema, 2);
    assert.deepEqual(input.track.excludeHosts, ['x.com']);        // input untouched
  });
});
