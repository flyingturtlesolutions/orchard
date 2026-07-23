// Core/connectionPresence.test.js — CP-1: the connections-registry math. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { authSignal, applySignal, rideOutcomeSignal, assessLiveness, presenceOf, heartbeatTargets, renderConnectionsCard, attentionOrigins , pickSignInTab } from './connectionPresence.js';

const T = 1_000_000_000;

describe('connectionPresence — authSignal (normalize)', () => {
  it('normalizes origin (scheme/path stripped, lowered); rejects junk', () => {
    const s = authSignal({ origin: 'https://VendorSuite.drhorton.com/api/x', status: 'signed-out', at: T });
    assert.equal(s.origin, 'vendorsuite.drhorton.com');
    assert.equal(authSignal({ origin: '', status: 'fresh' }), null);
    assert.equal(authSignal({ origin: 'a.com', status: 'weird' }), null);
  });
});

describe('connectionPresence — applySignal (single-writer merge + transitions)', () => {
  it('a signed-out signal transitions; a repeat does not; back-to-fresh transitions', () => {
    const s1 = applySignal({}, authSignal({ origin: 'vs.com', status: 'signed-out', cause: 'http-403', source: 'ride', at: T }));
    assert.equal(s1.transition.to, 'signed-out');
    assert.equal(s1.transition.from, 'unknown');
    const s2 = applySignal(s1.registry, authSignal({ origin: 'vs.com', status: 'signed-out', source: 'ride', at: T + 1 }));
    assert.equal(s2.transition, null);                                     // no re-notice on every failing ride
    const s3 = applySignal(s2.registry, authSignal({ origin: 'vs.com', status: 'fresh', source: 'reauth', at: T + 2 }));
    assert.equal(s3.transition.to, 'fresh');                               // "back in" is a real event
  });
  it('fresh→fresh updates the timestamp silently; probe spec + identity persist across signals', () => {
    const a = applySignal({}, authSignal({ origin: 'z.com', status: 'fresh', source: 'probe', identityName: 'Divine', probePath: '/me', probeAccept: 'identity', at: T }));
    assert.equal(a.transition, null);                                      // unknown→fresh is quiet (first sight, nothing wrong)
    const b = applySignal(a.registry, authSignal({ origin: 'z.com', status: 'fresh', source: 'ride', at: T + 5 }));
    assert.equal(b.registry['z.com'].lastVerifiedAt, T + 5);
    assert.equal(b.registry['z.com'].probePath, '/me');                    // the registry keeps HOW to re-probe
    assert.equal(b.registry['z.com'].identityName, 'Divine');              // identity survives a probe-less fresh signal
  });
});

describe('connectionPresence — rideOutcomeSignal (free signals from ride outcomes)', () => {
  it('ok → fresh; 401/session-expired/not-logged-in/non-json → signed-out', () => {
    assert.equal(rideOutcomeSignal({ ok: true }), 'fresh');
    assert.equal(rideOutcomeSignal({ errorCode: 'http-401' }), 'signed-out');
    assert.equal(rideOutcomeSignal({ errorCode: 'session-expired' }), 'signed-out');
    assert.equal(rideOutcomeSignal({ errorCode: 'not-logged-in' }), 'signed-out');
    assert.equal(rideOutcomeSignal({ errorCode: 'non-json' }), 'signed-out');
  });
  it('403 is signed-out ONLY without csrf/gql (the v1389 Shopify lesson; VendorSuite cookie GET = signed-out)', () => {
    assert.equal(rideOutcomeSignal({ errorCode: 'http-403', csrfInvolved: false }), 'signed-out');
    assert.equal(rideOutcomeSignal({ errorCode: 'http-403', csrfInvolved: true }), null);
    assert.equal(rideOutcomeSignal({ errorCode: 'http-500' }), null);       // a server error says nothing about auth
  });
});

describe('connectionPresence — assessLiveness (probeAccept: json) + presenceOf', () => {
  it('parseable JSON object → fresh; error / non-json → signed-out', () => {
    assert.equal(assessLiveness({ success: true, value: { access: {} } }).status, 'fresh');
    assert.equal(assessLiveness({ success: false, error: 'http-403' }).status, 'signed-out');
    assert.equal(assessLiveness({ success: true, value: null }).status, 'signed-out');
  });
  it('presence decays to stale past TTL; signed-out is sticky', () => {
    const e = { status: 'fresh', lastVerifiedAt: T };
    assert.equal(presenceOf(e, T + 60_000), 'fresh');
    assert.equal(presenceOf(e, T + 31 * 60_000), 'stale');
    assert.equal(presenceOf({ status: 'signed-out', lastVerifiedAt: T }, T + 999), 'signed-out');
  });
});

describe('connectionPresence — heartbeatTargets (open-tab origins only, capped, oldest first)', () => {
  const REG = {
    'a.com': { origin: 'a.com', probePath: '/me', lastVerifiedAt: T - 20 * 60_000, status: 'fresh' },
    'b.com': { origin: 'b.com', probePath: '/me', lastVerifiedAt: T - 5 * 60_000, status: 'fresh' },   // too recent
    'c.com': { origin: 'c.com', probePath: null, lastVerifiedAt: 0, status: 'unknown' },                // can't probe
    'd.com': { origin: 'd.com', probePath: '/state', probeAccept: 'json', lastVerifiedAt: 0, status: 'unknown' }, // no tab open
  };
  it('picks only probe-bearing + open-tab + old-enough; never a closed-tab origin', () => {
    const t = heartbeatTargets(REG, ['a.com', 'b.com', 'c.com'], { now: T });
    assert.deepEqual(t.map((x) => x.origin), ['a.com']);
    assert.deepEqual(heartbeatTargets(REG, [], { now: T }), []);            // no open tabs → NO probing (no tab churn)
  });
  it('caps the sweep', () => {
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}.com`, { origin: `s${i}.com`, probePath: '/me', lastVerifiedAt: T - (i + 20) * 60_000 }]));
    const t = heartbeatTargets(many, Object.keys(many), { now: T, cap: 4 });
    assert.equal(t.length, 4);
    assert.equal(t[0].origin, 's8.com');                                    // oldest verified first
  });
});

describe('connectionPresence — renderConnectionsCard + attentionOrigins', () => {
  const REG = {
    'vendorsuite.drhorton.com': { origin: 'vendorsuite.drhorton.com', status: 'signed-out', cause: 'session expired', lastVerifiedAt: T - 3 * 60_000 },
    'deako.zendesk.com': { origin: 'deako.zendesk.com', status: 'fresh', identityName: 'Divine M', lastVerifiedAt: T - 60_000 },
  };
  it('one line per origin: glyph, identity (fresh only), age, signed-out note', () => {
    const card = renderConnectionsCard(REG, { now: T });
    assert.ok(card.startsWith('Connections\n'));
    assert.ok(card.includes('● deako.zendesk.com — Divine M · 1m ago'), card);
    assert.ok(card.includes('✖ vendorsuite.drhorton.com'), card);
    assert.ok(card.includes('signed out (session expired); sign in to resume rides'), card);
    assert.equal(renderConnectionsCard({}, { now: T }), '');
  });
  it('attentionOrigins scopes to a desk’s own dependencies', () => {
    const a = attentionOrigins(REG, ['vendorsuite.drhorton.com', 'deako.zendesk.com']);
    assert.deepEqual(a.map((x) => x.origin), ['vendorsuite.drhorton.com']);
    assert.deepEqual(attentionOrigins(REG, ['other.com']), []);
  });
});

describe('pickSignInTab — reuse a tab over recreating one (v2.74.1702)', () => {
  const O = 'deako.zendesk.com';
  it('a live tab STILL on the origin → reload it (keeps its deep return_to)', () => {
    const tabs = [{ id: 5, url: 'https://deako.zendesk.com/agent/filters/35274215827863' }, { id: 6, url: 'https://google.com' }];
    assert.deepEqual(pickSignInTab(tabs, O), { tabId: 5, action: 'reload' });
  });
  it('THE LIVE BUG: an expired tab REDIRECTED to the branded sign-in PAGE is reclaimed via return_to → FOCUS (not restart)', () => {
    // host is now support.deako.com, so host-matching finds nothing — but return_to still names the origin, and it
    // IS a login page, so we focus (v1707), never navigate: re-triggering would wipe a half-typed password.
    const tabs = [{ id: 9, url: 'https://support.deako.com/auth/v3/signin?notice=timeout&return_to=https%3A%2F%2Fdeako.zendesk.com%2Fagent%2Ffilters%2F35274215827863&role=agent' }];
    assert.deepEqual(pickSignInTab(tabs, O), { tabId: 9, action: 'focus' });
  });
  it('v1707 — a REMEMBERED tab already on a login page is FOCUSED, not navigated (no credential wipe)', () => {
    // VendorSuite SSO shape: /idp/…?wtrealm=… — a login page, so even our remembered tab is left alone.
    const sso = [{ id: 4, url: 'https://cplogin.drhorton.com/idp/prp.wsf?wtrealm=urn:vendorsuite:web&wa=wsignin1.0' }];
    assert.deepEqual(pickSignInTab(sso, 'vendorsuite.drhorton.com', 4), { tabId: 4, action: 'focus' });
  });
  it('the tab WE last used for this origin is reused wherever it drifted → navigate (stops the pile-up)', () => {
    const tabs = [{ id: 12, url: 'https://support.deako.com/hc/en-us' }];   // drifted to the help centre, no return_to
    assert.deepEqual(pickSignInTab(tabs, O, 12), { tabId: 12, action: 'navigate' });
    assert.equal(pickSignInTab(tabs, O, null), null, 'without the remembered id and no return_to, it is not ours to reuse');
  });
  it('on-origin wins over a remembered off-origin tab (richer return_to)', () => {
    const tabs = [{ id: 1, url: 'https://deako.zendesk.com/agent' }, { id: 2, url: 'https://support.deako.com/auth/signin' }];
    assert.deepEqual(pickSignInTab(tabs, O, 2), { tabId: 1, action: 'reload' });
  });
  it('no candidate → null (open a fresh tab)', () => {
    assert.equal(pickSignInTab([{ id: 1, url: 'https://google.com' }], O), null);
    assert.equal(pickSignInTab([], O), null);
  });
  it('does NOT hijack a random page that merely mentions the host without an auth shape', () => {
    const tabs = [{ id: 3, url: 'https://news.example.com/article-about-deako.zendesk.com-outage' }];
    assert.equal(pickSignInTab(tabs, O), null, 'mention without /auth|signin|login|return_to → not a sign-in tab');
  });
  it('degenerate input does not throw', () => {
    for (const bad of [null, undefined, 'x', [null], [{}]]) assert.doesNotThrow(() => pickSignInTab(bad, O));
    assert.equal(pickSignInTab([{ id: 1, url: 'https://deako.zendesk.com/' }], ''), null);
  });
});
