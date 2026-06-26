// Core/connection.js — the ride CONNECTION assessment core (DESIGN_connectors.md §16, CX-7). v2.74.1238.
//
// PURE: no chrome / DOM / clock / fetch. Lifts the "is this session usable?" judgment out of the INVOKE_SESSION
// handler into a tested core — the identity verdict (anon-sentinel + wrong-account), connection freshness (TTL),
// the open-tab pick, and the verdict→action mapping (proceed / focus-for-reauth). The live tab ops stay in the
// handler; the DECISIONS live here.
//
// §14 CS Tools rule, made testable: verify the RETURNED IDENTITY, never `res.ok` — a logged-out app returns HTTP 200
// + an anonymous sentinel, so a status check is a false-positive. And the §16 invariant: opening a tab INHERITS auth,
// never CREATES it → an unauthenticated connection is a focus-for-sign-in, not a hard failure.

export const STATUS = Object.freeze({
  FRESH: 'fresh',                 // authenticated, identity matches (if an account is bound), within TTL
  STALE: 'stale',                 // was authenticated, but past the freshness TTL — re-probe before reuse
  SIGNED_OUT: 'signed-out',       // probe returned anon / the fetch couldn't prove an identity
  WRONG_ACCOUNT: 'wrong-account', // authenticated, but NOT the expected principal — never act
  UNKNOWN: 'unknown',             // never probed (e.g. an ephemeral tab just opened)
});

const _str = (x) => (x == null ? '' : String(x));
const _email = (x) => _str(x).trim().toLowerCase();

/** The probed user, or null. PURE. Accepts the raw SESSION_FETCH reply (`{success,value:{user}}`) or a bare user. */
export function probedUser(reply) {
  if (!reply || typeof reply !== 'object') return null;
  if (reply.id != null || reply.email != null) return reply;            // already a bare user object
  const u = reply.success && reply.value && reply.value.user;
  return (u && typeof u === 'object') ? u : null;
}

/** Anon-sentinel test (§14): a logged-out session returns 200 + a sentinel user. PURE. */
export function isAnonUser(user) {
  return !user || user.id === -1 || user.id == null || user.email === 'invalid@example.com';
}

/**
 * Does the probed user match the expected account? PURE. A null/empty/`'me'` expected = "any authenticated user"
 * (today's behavior — no specific principal bound). A concrete expected matches by id OR email (case-insensitive).
 */
export function identityMatches(user, expectedAccount) {
  const exp = _str(expectedAccount).trim();
  if (!exp || exp.toLowerCase() === 'me') return true;                  // no principal bound → any login is fine
  if (!user) return false;
  return _str(user.id) === exp || (!!user.email && _email(user.email) === _email(exp));
}

/**
 * Assess a JUST-TAKEN probe into an auth verdict. PURE. (No TTL — a fresh probe is current by definition.)
 * @returns {{ authenticated:boolean, user:object|null, status:string, reason:string|null }}
 */
export function assessProbe(reply, expectedAccount = null) {
  const user = probedUser(reply);
  if (isAnonUser(user)) return { authenticated: false, user: null, status: STATUS.SIGNED_OUT, reason: 'anon-or-no-identity' };
  if (!identityMatches(user, expectedAccount)) {
    return { authenticated: true, user, status: STATUS.WRONG_ACCOUNT, reason: `expected ${_str(expectedAccount)}, got ${_str(user.id)}` };
  }
  return { authenticated: true, user, status: STATUS.FRESH, reason: null };
}

/**
 * Map an auth verdict (assessProbe) to the handler's next action (§16). PURE.
 * fresh → proceed (close after if the tab was ephemeral); signed-out / wrong-account → focus the tab for the human
 * to sign in / switch — NEVER close it, NEVER act as the wrong principal.
 */
export function rideAction(verdict, { ephemeral = false } = {}) {
  const status = (verdict && verdict.status) || STATUS.SIGNED_OUT;
  if (status === STATUS.FRESH) {
    return { action: 'proceed', status, user: (verdict && verdict.user) || null, focus: false, closeOnDone: !!ephemeral };
  }
  return { action: 'reauth-focus', status, focus: true, closeOnDone: false, reason: (verdict && verdict.reason) || null };
}

/** Build a Connection record from a probe. PURE — `now` is injected (no clock). */
export function connectionFromProbe(reply, { app = null, appHost = null, origin = null, expectedAccount = null, now = 0 } = {}) {
  const v = assessProbe(reply, expectedAccount);
  return {
    app, appHost, origin,
    expectedAccount: expectedAccount ?? null,
    identity: v.user ? { id: v.user.id ?? null, email: v.user.email ?? null, name: v.user.name ?? null } : null,
    status: v.status,
    lastVerifiedAt: v.authenticated ? now : null,
    reason: v.reason,
  };
}

/**
 * Is a cached connection still fresh enough to reuse WITHOUT re-probing? PURE. A signed-out / wrong-account status is
 * sticky until a fresh probe clears it; an unverified connection is UNKNOWN; otherwise fresh within the TTL, else stale.
 */
export function connectionFreshness(connection, now = 0, ttlMs = 5 * 60 * 1000) {
  const c = (connection && typeof connection === 'object') ? connection : null;
  if (!c) return STATUS.UNKNOWN;
  if (c.status === STATUS.SIGNED_OUT || c.status === STATUS.WRONG_ACCOUNT) return c.status;
  if (c.lastVerifiedAt == null) return STATUS.UNKNOWN;
  const age = now - c.lastVerifiedAt;
  return (age >= 0 && age <= ttlMs) ? STATUS.FRESH : STATUS.STALE;
}

/**
 * Pick the best existing ride tab on the origin, or null. PURE — lifts the INVOKE_SESSION selection: live
 * (non-discarded), prefer the active tab, then the most-recently-used ("the connection the user is looking at",
 * §13/CX-7). Null → the handler opens an ephemeral managed tab (§16).
 */
export function pickRideTab(tabs) {
  const live = (Array.isArray(tabs) ? tabs : []).filter((t) => t && t.id != null && !t.discarded);
  live.sort((a, b) => (Number(b.active === true) - Number(a.active === true)) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  return live[0] || null;
}
