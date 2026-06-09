// Core/monitorConsent.test.js — C6 Track consent gate (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canTrack, withTrack, MONITOR_CONSENT_DEFAULT } from './monitorConsent.js';

describe('canTrack — DEFAULT-DENY Track gate', () => {
  it('denies by default (and on null / malformed / disabled)', () => {
    assert.equal(canTrack(MONITOR_CONSENT_DEFAULT, { host: 'x.com' }), false);
    assert.equal(canTrack(null, { host: 'x.com' }), false);
    assert.equal(canTrack({}, { host: 'x.com' }), false);
    assert.equal(canTrack({ track: { enabled: false, scope: 'all' } }, { host: 'x.com' }), false);
  });
  it('scope "all" → any host when enabled', () => {
    assert.equal(canTrack({ track: { enabled: true, scope: 'all', hosts: [] } }, { host: 'anything.com' }), true);
  });
  it('scope "hosts" → only listed hosts', () => {
    const c = { track: { enabled: true, scope: 'hosts', hosts: ['indeed.com'] } };
    assert.equal(canTrack(c, { host: 'indeed.com' }), true);
    assert.equal(canTrack(c, { host: 'evil.com' }), false);
    assert.equal(canTrack(c, {}), false);                       // no host
  });
  it('enabled but empty host list / unknown scope → deny', () => {
    assert.equal(canTrack({ track: { enabled: true, scope: 'hosts', hosts: [] } }, { host: 'x.com' }), false);
    assert.equal(canTrack({ track: { enabled: true, scope: 'weird' } }, { host: 'x.com' }), false);
  });
});

describe('withTrack — pure updater', () => {
  it('enables + sets scope; default starts denied', () => {
    const c = withTrack(MONITOR_CONSENT_DEFAULT, { enabled: true, scope: 'all' });
    assert.equal(c.track.enabled, true);
    assert.equal(c.track.scope, 'all');
    assert.equal(canTrack(c, { host: 'x.com' }), true);
    assert.equal(MONITOR_CONSENT_DEFAULT.track.enabled, false);  // default not mutated
  });
  it('adds + removes hosts (idempotent add, sorted), stamps schema', () => {
    let c = withTrack(null, { enabled: true, scope: 'hosts', addHost: 'b.com' });
    c = withTrack(c, { addHost: 'a.com' });
    c = withTrack(c, { addHost: 'a.com' });                      // idempotent
    assert.deepEqual(c.track.hosts, ['a.com', 'b.com']);
    assert.equal(c.schema, 1);
    assert.equal(canTrack(c, { host: 'a.com' }), true);
    c = withTrack(c, { removeHost: 'a.com' });
    assert.deepEqual(c.track.hosts, ['b.com']);
    assert.equal(canTrack(c, { host: 'a.com' }), false);
  });
  it('preserves unspecified fields + does not mutate the input', () => {
    const input = { track: { enabled: true, scope: 'hosts', hosts: ['x.com'] }, extra: 1 };
    const out = withTrack(input, { addHost: 'y.com' });
    assert.equal(out.extra, 1);
    assert.deepEqual(input.track.hosts, ['x.com']);             // input untouched
  });
});
