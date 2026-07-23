// Core/connectionPresence.js — CP-1 (v2.74.1506): the CONNECTIONS REGISTRY math — proactive auth presence for every
// connected site (DESIGN_connectors.md §16b). One registry, many signals, single writer:
//
//   - EVENT-DRIVEN freshness, never blind polling: every signal that already proves/disproves identity updates the
//     registry — pre-flight IDENTITY_PROBE verdicts, connect-time checks, and RIDE OUTCOMES (a successful ride is a
//     free "fresh"; a 401 — or a 403 on a csrf-less ride — is a free "signed-out"). The live gap this closes: a
//     VendorSuite session expired overnight and the desk's first sign was a raw http-403 mid-chain.
//   - A slow HEARTBEAT probes ONLY origins with an already-open tab (probes ride the session THROUGH a tab; opening
//     tabs on a timer is churn + scraping-shaped traffic). Origins without a tab DECAY to stale by TTL — honest,
//     refreshed the moment a tab or ride touches them.
//   - Two probe kinds: 'identity' (assessProbe — the §14 anon-sentinel rule) and 'json' (liveness: a parseable JSON
//     2xx proves auth on apps whose endpoints 403 when signed out but carry no user shape — VendorSuite).
//
// PURE: no chrome / DOM / clock / fetch. The store + broadcast live in background/handlers/connections.js.

import { STATUS, connectionFreshness } from './connection.js';

const _str = (v) => (v == null ? '' : String(v).trim());
const _now = (v) => (Number.isFinite(v) ? v : 0);

export const REG_KEY = 'conn:registry';
export const SIGNAL_SOURCES = Object.freeze(['probe', 'ride', 'connect', 'reauth', 'heartbeat']);

/** Normalize an auth signal. PURE. Null when it can't update anything (no origin / unknown status). */
export function authSignal({ origin, status, cause = null, source = 'ride', identityName = null, probePath = null, probeHeaders = null, probeAccept = null, at = 0 } = {}) {
  const o = _str(origin).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  const s = _str(status);
  if (!o || !s || ![STATUS.FRESH, STATUS.SIGNED_OUT, STATUS.WRONG_ACCOUNT].includes(s)) return null;
  return {
    origin: o, status: s,
    cause: _str(cause) || null,
    source: SIGNAL_SOURCES.includes(source) ? source : 'ride',
    identityName: _str(identityName).slice(0, 80) || null,   // display-only (the Overview card); never logged, never to the LLM
    probePath: _str(probePath) || null,                       // the registry LEARNS how to re-probe from the first signal that knows
    probeHeaders: (probeHeaders && typeof probeHeaders === 'object') ? probeHeaders : null,
    probeAccept: probeAccept === 'json' ? 'json' : (probeAccept === 'identity' ? 'identity' : null),
    at: _now(at),
  };
}

/**
 * Apply a signal to the registry. PURE. Returns { registry, transition } — transition is non-null only when the
 * effective status CHANGED to/from an attention state (→ signed-out / wrong-account, or back to fresh from one),
 * so the Overview narrates real events, never heartbeat ticks.
 */
export function applySignal(registry, signal) {
  const reg = (registry && typeof registry === 'object') ? registry : {};
  const sig = signal && signal.origin ? signal : null;
  if (!sig) return { registry: reg, transition: null };
  const prev = reg[sig.origin] || null;
  const entry = {
    origin: sig.origin,
    status: sig.status,
    cause: sig.cause,
    identityName: sig.identityName || (prev && sig.status === STATUS.FRESH ? prev.identityName : null) || (prev && prev.status === sig.status ? prev.identityName : null),
    lastVerifiedAt: sig.at,
    lastSource: sig.source,
    probePath: sig.probePath || (prev && prev.probePath) || null,
    probeHeaders: sig.probeHeaders || (prev && prev.probeHeaders) || null,
    probeAccept: sig.probeAccept || (prev && prev.probeAccept) || null,
    firstSeenAt: (prev && prev.firstSeenAt) || sig.at,
  };
  const from = (prev && prev.status) || STATUS.UNKNOWN;
  const attention = (s) => s === STATUS.SIGNED_OUT || s === STATUS.WRONG_ACCOUNT;
  const transition = (from !== sig.status && (attention(sig.status) || attention(from)))
    ? { origin: sig.origin, from, to: sig.status, cause: sig.cause, source: sig.source,
        prevVerifiedAt: (prev && prev.lastVerifiedAt) || 0 }   // KA-0 (v2.74.1599) — the death GAP (last fresh evidence → observed signed-out) teaches the origin's idle window
    : null;
  return { registry: { ...reg, [sig.origin]: entry }, transition };
}

/**
 * Classify a RIDE outcome into a signal status, or null (no auth information). PURE.
 * ok → fresh. 401 / 'session-expired' / 'not-logged-in' / 'non-json' (login HTML) → signed-out.
 * 403 → signed-out ONLY when no csrf/gql transport is involved (the v1389 Shopify lesson: a 403 without a token is
 * CSRF-not-ready, not a login problem; VendorSuite's cookie-ride GETs have no token → its 403 IS signed-out).
 */
export function rideOutcomeSignal({ ok = false, httpStatus = null, errorCode = null, csrfInvolved = false } = {}) {
  if (ok) return STATUS.FRESH;
  const err = _str(errorCode);
  if (err === 'session-expired' || err === 'not-logged-in' || err === 'non-json') return STATUS.SIGNED_OUT;
  const st = Number(httpStatus ?? (err.startsWith('http-') ? err.slice(5) : NaN));
  if (st === 401) return STATUS.SIGNED_OUT;
  if (st === 403 && !csrfInvolved) return STATUS.SIGNED_OUT;
  return null;
}

/** JSON-LIVENESS probe verdict (probeAccept:'json'). PURE. A parseable JSON body on 2xx proves auth (no identity). */
export function assessLiveness(reply) {
  const ok = !!(reply && reply.success && reply.value != null && typeof reply.value === 'object');
  return ok
    ? { authenticated: true, user: null, status: STATUS.FRESH, reason: null }
    : { authenticated: false, user: null, status: STATUS.SIGNED_OUT, reason: 'no-json-liveness' };
}

/** Effective display freshness of an entry ('fresh'|'stale'|'signed-out'|'wrong-account'|'unknown'). PURE. */
export function presenceOf(entry, now = 0, ttlMs = 30 * 60 * 1000) {
  return connectionFreshness(entry, now, ttlMs);
}

/**
 * The heartbeat's probe list. PURE. Only origins that (a) know HOW to be probed, (b) have an OPEN tab (openOrigins),
 * and (c) haven't been verified within minAgeMs. Oldest-verified first, capped — a slow sweep, never a burst.
 */
export function heartbeatTargets(registry, openOrigins, { now = 0, minAgeMs = 10 * 60 * 1000, cap = 4 } = {}) {
  const open = new Set((Array.isArray(openOrigins) ? openOrigins : []).map((o) => _str(o).toLowerCase()).filter(Boolean));
  return Object.values(registry || {})
    .filter((e) => e && e.probePath && open.has(e.origin))
    .filter((e) => (now - (e.lastVerifiedAt || 0)) >= minAgeMs)
    .sort((a, b) => (a.lastVerifiedAt || 0) - (b.lastVerifiedAt || 0))
    .slice(0, Math.max(0, cap))
    .map((e) => ({ origin: e.origin, probePath: e.probePath, probeHeaders: e.probeHeaders || null, probeAccept: e.probeAccept || 'identity' }));
}

const _AGO = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

/**
 * The Overview card body. PURE. One line per origin — status glyph, identity (display-only), verified-age; a
 * signed-out line says what to do (the Sign in button renders beside the card). Empty registry → ''.
 */
export function renderConnectionsCard(registry, { now = 0, ttlMs = 30 * 60 * 1000 } = {}) {
  const entries = Object.values(registry || {}).filter((e) => e && e.origin)
    .sort((a, b) => a.origin.localeCompare(b.origin));
  if (!entries.length) return '';
  const G = { fresh: '●', stale: '◐', 'signed-out': '✖', 'wrong-account': '⚠', unknown: '○' };
  const lines = entries.map((e) => {
    const p = presenceOf(e, now, ttlMs);
    const who = e.identityName && p !== STATUS.SIGNED_OUT ? ` — ${e.identityName}` : '';
    const age = e.lastVerifiedAt ? ` · ${_AGO(now - e.lastVerifiedAt)}` : '';
    const note = p === STATUS.SIGNED_OUT ? ` — signed out${e.cause ? ` (${e.cause})` : ''}; sign in to resume rides`
      : p === STATUS.WRONG_ACCOUNT ? ' — wrong account; switch to continue'
        : p === STATUS.STALE ? ' — unverified lately' : '';
    return `${G[p] || '○'} ${e.origin}${who}${age}${note}`;
  });
  return `Connections\n${lines.join('\n')}`;
}

/** Origins in the registry that are signed-out / wrong-account among `origins` (a desk's dependencies). PURE. */
export function attentionOrigins(registry, origins) {
  const want = new Set((Array.isArray(origins) ? origins : []).map((o) => _str(o).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean));
  return Object.values(registry || {})
    .filter((e) => e && want.has(e.origin) && (e.status === STATUS.SIGNED_OUT || e.status === STATUS.WRONG_ACCOUNT))
    .map((e) => ({ origin: e.origin, status: e.status, cause: e.cause || null }));
}

/**
 * Pick the tab a "Sign in" click should REUSE, or null to open a fresh one. PURE. v2.74.1702.
 *
 * The goal is REUSE over recreate. The naive "a tab whose host === origin" check misses the common case: an
 * expired Zendesk agent tab has already been REDIRECTED off the origin to the branded sign-in host
 * (`support.<x>.com/auth/v3/signin?…return_to=…deako.zendesk.com…`), so host-matching finds nothing and a
 * duplicate tab is spawned — and every repeat click spawns another. Three reuse paths, most-specific first:
 *
 *   1. a live tab STILL on the origin host — reload it (its deep URL gives Zendesk the richest `return_to`).
 *   2. the tab WE previously opened/focused for this origin (`rememberedId`), wherever it has since drifted —
 *      navigate it back to the console landing to re-trigger a clean auth redirect. This is what stops the
 *      pile-up on repeat clicks.
 *   3. a sign-in page whose URL still REFERENCES the origin (its `return_to` carries the origin host verbatim —
 *      only the slashes are percent-encoded) — the drifted ORIGINAL tab, reclaimed on the very first click.
 *      Guarded to auth-shaped URLs so a stray page merely mentioning the host is not hijacked.
 *
 * @param {Array<{id:number,url:string}>} tabs
 * @param {string} origin                        host, e.g. 'deako.zendesk.com'
 * @param {number|null} rememberedId             the tab this origin's sign-in last used, if any
 * @returns {{tabId:number, action:'reload'|'navigate'}|null}
 */
export function pickSignInTab(tabs, origin, rememberedId = null) {
  const list = (Array.isArray(tabs) ? tabs : []).filter((t) => t && typeof t.url === 'string' && t.id != null);
  const o = _str(origin).toLowerCase();
  if (!o) return null;
  const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };

  const onOrigin = list.find((t) => hostOf(t.url) === o);
  if (onOrigin) return { tabId: onOrigin.id, action: 'reload' };

  if (rememberedId != null) {
    const remembered = list.find((t) => t.id === rememberedId);
    if (remembered) return { tabId: remembered.id, action: 'navigate' };
  }

  const authRef = list.find((t) => t.url.toLowerCase().includes(o)
    && /(\/(auth|sign-?in|login|access)\b|[?&]return_to=)/i.test(t.url));
  if (authRef) return { tabId: authRef.id, action: 'navigate' };

  return null;
}
