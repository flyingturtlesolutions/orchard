// Core/connection.test.js — the ride CONNECTION assessment core (DESIGN_connectors.md §16, CX-7). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STATUS, probedUser, isAnonUser, identityMatches, assessProbe, rideAction,
  connectionFromProbe, connectionFreshness, pickRideTab, rideTabUrlPatterns, isCsrfColdFailure, looksLikeLogin, classifyReachProbe,
} from './connection.js';

const reply = (user) => ({ success: true, value: { user } });          // a SESSION_FETCH probe reply
const ALICE = { id: 42, email: 'alice@acme.com', name: 'Alice' };

describe('probedUser / isAnonUser — §14 verify identity, not status', () => {
  it('extracts the user from a SESSION_FETCH reply, a bare user, or nothing', () => {
    assert.deepEqual(probedUser(reply(ALICE)), ALICE);
    assert.deepEqual(probedUser(ALICE), ALICE);                        // already a bare user
    assert.equal(probedUser(null), null);
    assert.equal(probedUser({ success: false }), null);
    assert.equal(probedUser({ success: true, value: {} }), null);
  });
  it('extracts Aircall Workspace current_user flat shape (no nested .user)', () => {
    const ac = { id: 'agent-99', email: 'agent@deako.com', first_name: 'Jane' };
    assert.deepEqual(probedUser({ success: true, value: ac }), ac);
  });
  it('flags the logged-out sentinels (200 + anon)', () => {
    assert.equal(isAnonUser(ALICE), false);
    assert.equal(isAnonUser(null), true);
    assert.equal(isAnonUser({ id: -1 }), true);
    assert.equal(isAnonUser({ id: null }), true);
    assert.equal(isAnonUser({ id: 7, email: 'invalid@example.com' }), true);
  });
});

describe('identityMatches — the wrong-account guard', () => {
  it('a null / empty / "me" expected accepts ANY authenticated user (today\'s behavior)', () => {
    assert.equal(identityMatches(ALICE, null), true);
    assert.equal(identityMatches(ALICE, ''), true);
    assert.equal(identityMatches(ALICE, 'me'), true);
  });
  it('a concrete expected matches by id OR email (case-insensitive), else fails', () => {
    assert.equal(identityMatches(ALICE, 42), true);                    // id (number)
    assert.equal(identityMatches(ALICE, '42'), true);                  // id (string)
    assert.equal(identityMatches(ALICE, 'Alice@Acme.com'), true);      // email, case-insensitive
    assert.equal(identityMatches(ALICE, 99), false);                   // different id
    assert.equal(identityMatches(ALICE, 'bob@acme.com'), false);       // different email
    assert.equal(identityMatches(null, 42), false);                    // no user
  });
});

describe('assessProbe — the auth verdict', () => {
  it('authenticated + (no account bound) → fresh', () => {
    const v = assessProbe(reply(ALICE));
    assert.equal(v.status, STATUS.FRESH);
    assert.equal(v.authenticated, true);
    assert.deepEqual(v.user, ALICE);
  });
  it('authenticated + matching account → fresh', () => {
    assert.equal(assessProbe(reply(ALICE), 42).status, STATUS.FRESH);
  });
  it('anon / null / failed fetch → signed-out (never act)', () => {
    assert.equal(assessProbe(reply({ id: -1 })).status, STATUS.SIGNED_OUT);
    assert.equal(assessProbe(null).status, STATUS.SIGNED_OUT);
    assert.equal(assessProbe({ success: false, error: 'http-401' }).status, STATUS.SIGNED_OUT);
  });
  it('authenticated but the WRONG principal → wrong-account (never act as the wrong user)', () => {
    const v = assessProbe(reply(ALICE), 99);
    assert.equal(v.status, STATUS.WRONG_ACCOUNT);
    assert.equal(v.authenticated, true);
    assert.match(v.reason, /expected 99/);
  });
});

describe('rideAction — verdict → handler action (§16)', () => {
  it('fresh → proceed; closeOnDone reflects whether the tab was ephemeral', () => {
    assert.deepEqual(rideAction(assessProbe(reply(ALICE)), { ephemeral: false }),
      { action: 'proceed', status: STATUS.FRESH, user: ALICE, focus: false, closeOnDone: false });
    assert.equal(rideAction(assessProbe(reply(ALICE)), { ephemeral: true }).closeOnDone, true);
  });
  it('signed-out / wrong-account → focus the tab for sign-in, NEVER close, NEVER act', () => {
    for (const v of [assessProbe(null), assessProbe(reply(ALICE), 99)]) {
      const a = rideAction(v, { ephemeral: true });
      assert.equal(a.action, 'reauth-focus');
      assert.equal(a.focus, true);
      assert.equal(a.closeOnDone, false);                              // an unauth'd ephemeral tab is kept for the human
    }
  });
});

describe('connectionFromProbe — the Connection record', () => {
  it('an authenticated probe → identity + lastVerifiedAt stamped', () => {
    const c = connectionFromProbe(reply(ALICE), { app: 'zendesk', appHost: 'zendesk.com', expectedAccount: 42, now: 1000 });
    assert.equal(c.status, STATUS.FRESH);
    assert.deepEqual(c.identity, { id: 42, email: 'alice@acme.com', name: 'Alice' });
    assert.equal(c.lastVerifiedAt, 1000);
    assert.equal(c.app, 'zendesk');
  });
  it('a signed-out probe → no identity, lastVerifiedAt null', () => {
    const c = connectionFromProbe(null, { now: 1000 });
    assert.equal(c.status, STATUS.SIGNED_OUT);
    assert.equal(c.identity, null);
    assert.equal(c.lastVerifiedAt, null);
  });
});

describe('connectionFreshness — reuse without re-probing?', () => {
  const fresh = { status: STATUS.FRESH, lastVerifiedAt: 1000 };
  it('within the TTL → fresh; past it → stale', () => {
    assert.equal(connectionFreshness(fresh, 1000 + 60_000, 5 * 60_000), STATUS.FRESH);
    assert.equal(connectionFreshness(fresh, 1000 + 6 * 60_000, 5 * 60_000), STATUS.STALE);
  });
  it('never probed → unknown; null connection → unknown', () => {
    assert.equal(connectionFreshness({ status: STATUS.FRESH, lastVerifiedAt: null }, 1000), STATUS.UNKNOWN);
    assert.equal(connectionFreshness(null, 1000), STATUS.UNKNOWN);
  });
  it('signed-out / wrong-account is sticky until a fresh probe clears it', () => {
    assert.equal(connectionFreshness({ status: STATUS.SIGNED_OUT, lastVerifiedAt: 1000 }, 1000), STATUS.SIGNED_OUT);
    assert.equal(connectionFreshness({ status: STATUS.WRONG_ACCOUNT, lastVerifiedAt: 1000 }, 1000), STATUS.WRONG_ACCOUNT);
  });
});

describe('looksLikeLogin / classifyReachProbe — the generic (no-recipe) verify (AS-4)', () => {
  it('flags login paths + known IdP hosts; app pages are not login', () => {
    assert.equal(looksLikeLogin('https://support.deako.com/login'), true);
    assert.equal(looksLikeLogin('https://x.com/users/sign_in'), true);
    assert.equal(looksLikeLogin('https://acme.okta.com/app/...'), true);
    assert.equal(looksLikeLogin('https://accounts.google.com/o/oauth2'), true);
    assert.equal(looksLikeLogin('https://support.deako.com/hc/en-us/requests'), false);   // a real app page
    assert.equal(looksLikeLogin(''), false);
  });
  it('classifies the final url: connected / signed-out / unreachable', () => {
    assert.equal(classifyReachProbe({ finalUrl: 'https://support.deako.com/hc/requests' }), 'connected');
    assert.equal(classifyReachProbe({ finalUrl: 'https://support.deako.com/login?return=/x' }), 'signed-out');
    assert.equal(classifyReachProbe({ finalUrl: '' }), 'unreachable');
    assert.equal(classifyReachProbe({ finalUrl: 'not a url' }), 'unreachable');
  });
  it('review P1-6: a DNS/connection failure lands on a non-http(s) page → unreachable (the "verified garbage" trap)', () => {
    assert.equal(classifyReachProbe({ finalUrl: 'chrome-error://chromewebdata/' }), 'unreachable');
    assert.equal(classifyReachProbe({ finalUrl: 'about:blank' }), 'unreachable');
    assert.equal(classifyReachProbe({ finalUrl: 'chrome://newtab/' }), 'unreachable');
  });
  it('review P1-6: requestedHost belt — a park/redirect to a foreign host is unreachable; www + subdomain drift is fine', () => {
    assert.equal(classifyReachProbe({ finalUrl: 'https://parked.example/for-sale', requestedHost: 'support.deako.com' }), 'unreachable');
    assert.equal(classifyReachProbe({ finalUrl: 'https://www.support.deako.com/hc', requestedHost: 'support.deako.com' }), 'connected');   // www drift
    assert.equal(classifyReachProbe({ finalUrl: 'https://app.acme.com/home', requestedHost: 'acme.com' }), 'connected');                   // parent→subdomain
    assert.equal(classifyReachProbe({ finalUrl: 'https://acme.com/home', requestedHost: 'app.acme.com' }), 'connected');                   // subdomain→parent
    assert.equal(classifyReachProbe({ finalUrl: 'https://acme.okta.com/app', requestedHost: 'acme.com' }), 'signed-out');                  // login wins over host-mismatch
  });
});

describe('pickRideTab — the entry tab (live, active-then-MRU), or null → open ephemeral', () => {
  it('prefers the active tab, then most-recently-used, skipping discarded', () => {
    const tabs = [
      { id: 1, active: false, discarded: false, lastAccessed: 100 },
      { id: 2, active: true, discarded: false, lastAccessed: 50 },
      { id: 3, active: false, discarded: false, lastAccessed: 999 },
    ];
    assert.equal(pickRideTab(tabs).id, 2);                             // active wins
    assert.equal(pickRideTab(tabs.filter((t) => !t.active)).id, 3);   // then MRU
  });
  it('a discarded tab does not count; no live tab → null', () => {
    assert.equal(pickRideTab([{ id: 1, discarded: true, lastAccessed: 999 }]), null);
    assert.equal(pickRideTab([]), null);
    assert.equal(pickRideTab(null), null);
  });
  it('urlParam pattern prefers a workspace tab over an active bare-root admin tab (v2.74.1758)', () => {
    const urlParam = { name: 'handle', pattern: '\\/store\\/([^\\/]+)' };
    const tabs = [
      { id: 1, active: true, discarded: false, lastAccessed: 999, url: 'https://admin.shopify.com/' },
      { id: 2, active: false, discarded: false, lastAccessed: 50, url: 'https://admin.shopify.com/store/deako/customers' },
    ];
    assert.equal(pickRideTab(tabs, { urlParam }).id, 2, 'store tab wins even when root is active/MRU');
    assert.equal(pickRideTab(tabs).id, 1, 'without urlParam, active still wins');
  });
});

describe('rideTabUrlPatterns — Chrome match patterns for session-ride tab discovery (v2.74.1758)', () => {
  it('concrete origin → exact host only', () => {
    assert.deepEqual(rideTabUrlPatterns('admin.shopify.com', 'admin.shopify.com'), ['*://admin.shopify.com/*']);
    assert.deepEqual(rideTabUrlPatterns('deako.zendesk.com', 'zendesk.com'), ['*://deako.zendesk.com/*']);
  });
  it('appHost-only → bare host AND subdomain wildcard (Chrome *.host misses bare host)', () => {
    assert.deepEqual(rideTabUrlPatterns('', 'admin.shopify.com'),
      ['*://admin.shopify.com/*', '*://*.admin.shopify.com/*']);
    assert.deepEqual(rideTabUrlPatterns(null, 'zendesk.com'),
      ['*://zendesk.com/*', '*://*.zendesk.com/*']);
  });
  it('empty inputs → no patterns', () => {
    assert.deepEqual(rideTabUrlPatterns('', ''), []);
    assert.deepEqual(rideTabUrlPatterns(null, null), []);
  });
});

describe('isCsrfColdFailure — idle-admin CSRF warm vs real signed-out (v2.74.1759)', () => {
  it('no-csrf and sniff 403s are cold; bare 403 without sniff/hint is not', () => {
    assert.equal(isCsrfColdFailure({ error: 'no-csrf' }), true);
    assert.equal(isCsrfColdFailure({ error: 'http-403', csrf: 'sniff' }), true);
    assert.equal(isCsrfColdFailure({ error: 'http-401', csrf: 'sniff' }), true);
    assert.equal(isCsrfColdFailure({ error: 'http-403', hint: 'no CSRF token yet — click' }), true);
    assert.equal(isCsrfColdFailure({ error: 'http-403' }), false);
    assert.equal(isCsrfColdFailure({ error: 'http-500', csrf: 'sniff' }), false);
    assert.equal(isCsrfColdFailure({ error: 'session-expired', csrf: 'sniff' }), false);
  });
});
