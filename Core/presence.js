// Core/presence.js — PR-1..PR-6 (v2.74.1838), DESIGN_presence.md. PURE: no chrome / DOM / LLM / clock
// (the caller passes `now`, same injection style as evalBranch taking its evaluator).
//
// ONE BELIEF PER GROUND. The dashboard renders it and the gate consults it — that is the whole point.
// Live 07-27 09:44:47 the app resolved a signed-IN presence case, and 9s later the work refused with
// `cause=no-bound-connection`, four times over a minute. Two beliefs about one subject. Freshness was never
// the problem; better detection would have changed nothing. This file exists so there is only one.
//
// THREE ROLES (§2). Only ONE of them decides:
//   • INVALIDATE — a cookie change marks the belief `stale`. It NEVER decides and NEVER reads a cookie's
//     value (§5: reading values grants no new capability but creates PORTABILITY — a copyable, loggable,
//     serializable credential. httpOnly does not protect us; it restricts the DOM API, not the extension API).
//   • ESTABLISH  — the existing scheduled probe. This is the truth, and it keeps feeding incidents/cases.
//   • CONFIRM    — a point-of-use probe, run ONLY when the belief is stale-or-negative.

export const PRESENCE_STATES = Object.freeze(['fresh', 'stale', 'signed-out', 'unknown']);

const _s = (v) => (v == null ? '' : String(v).trim());
// NOTE: Number(null) === 0, which IS finite — a naive isFinite check silently turns a null expiry into
// epoch zero, i.e. "lapsed in 1970". That made every belief look expired. Absent must stay absent.
const _n = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** A belief. `checkedAt`/`expiresAt` are epoch ms supplied by the caller — this file never reads a clock. */
export function makeBelief({ state = 'unknown', checkedAt = null, expiresAt = null, why = '' } = {}) {
  return {
    state: PRESENCE_STATES.includes(state) ? state : 'unknown',
    checkedAt: _n(checkedAt),
    expiresAt: _n(expiresAt),
    why: _s(why).slice(0, 160),
  };
}

/**
 * PR-1 — a cookie moved on this host. Marks the belief STALE; decides nothing.
 * A signed-out belief STAYS signed-out (a cookie change is not evidence of sign-in — only a probe is), which
 * keeps this from manufacturing optimism. `unknown` also stays put: there is nothing to invalidate.
 */
export function invalidate(belief, { why = 'cookie changed' } = {}) {
  const b = makeBelief(belief || {});
  if (b.state !== 'fresh') return b;
  return makeBelief({ ...b, state: 'stale', why: _s(why) });
}

/** ESTABLISH / CONFIRM — record a probe result. This is the only thing that produces `fresh`/`signed-out`. */
export function observe(belief, { signedIn, at, expiresAt = null, why = '' } = {}) {
  const b = makeBelief(belief || {});
  if (signedIn !== true && signedIn !== false) return b;   // an inconclusive probe changes NOTHING (§2.1)
  return makeBelief({
    state: signedIn ? 'fresh' : 'signed-out',
    checkedAt: _n(at) ?? b.checkedAt,
    expiresAt: signedIn ? (_n(expiresAt) ?? b.expiresAt) : null,
    why: _s(why),
  });
}

/**
 * PR-2 — should we spend a probe before acting? Only when the belief is stale-or-negative.
 * A fresh+positive belief adds ZERO latency (§2.1); that is what keeps this off the common path.
 * PR-4: a belief whose expiry has passed is treated as stale even if nothing invalidated it.
 */
export function shouldConfirm(belief, { now = null } = {}) {
  const b = makeBelief(belief || {});
  if (b.state === 'stale' || b.state === 'signed-out' || b.state === 'unknown') return true;
  const n = _n(now);
  if (n != null && b.expiresAt != null && b.expiresAt <= n) return true;   // lapsed while we weren't looking
  return false;
}

/**
 * THE GATE (§2.1). Returns {proceed, reason}. Two asymmetries are deliberate and load-bearing:
 *
 *  • A FAILED probe does NOT block. Timeout/error is evidence about the network, not the session — a
 *    `csrf prewarm` took 10s live on 07-27 00:11, and that must never become dead air then a refusal.
 *    We proceed and let the real request arbitrate.
 *  • A stale NEGATIVE does not block on its own either. A stale positive costs one failed request that
 *    self-corrects; a stale negative refuses work that would have SUCCEEDED — which is exactly the 09:44
 *    failure this file exists to prevent. Only a CONFIRMED signed-out stops the run.
 *
 * v2.74.1859 — 'no-tab' is a THIRD confirm outcome, split out of 'failed' (user report, gl 132049: "why would
 * a logged-out site run at all?"). The caller used to report "there was no tab to probe" with the same token as
 * "the probe timed out", and since `failed` is checked FIRST, a ground with a CONFIRMED signed-out belief
 * proceeded anyway — three traces in a row spent ~11s and a 17k-token interpret call to reach a guaranteed
 * `NO-APP-TAB`. The two are not alike: a timeout is evidence about the network, while no-tab is DETERMINISTIC
 * evidence that a session-ride cannot work, because the ride needs the very tab that was not found. So a
 * failed probe still proceeds (the asymmetry is intact, and it is what that rule was written for), but a
 * no-tab probe defers to the standing belief — which is the docstring's own rule: a CONFIRMED signed-out stops.
 */
export function gate(belief, { confirmed = null } = {}) {
  const b = makeBelief(belief || {});
  if (confirmed === false) return { proceed: false, reason: 'confirmed-signed-out' };
  if (confirmed === true) return { proceed: true, reason: 'confirmed-fresh' };
  if (confirmed === 'no-tab') {
    return b.state === 'signed-out'
      ? { proceed: false, reason: 'signed-out-no-tab' }        // known dead + nothing to ride → refuse in 14ms
      : { proceed: true, reason: 'no-tab-proceeding' };        // unknown/stale → unchanged: the request arbitrates
  }
  if (confirmed === 'failed') return { proceed: true, reason: 'probe-failed-proceeding' };
  if (b.state === 'fresh') return { proceed: true, reason: 'cached-fresh' };
  if (b.state === 'signed-out') return { proceed: false, reason: 'believed-signed-out' };
  return { proceed: true, reason: 'unconfirmed-proceeding' };   // stale/unknown → let the request arbitrate
}

/** PR-4 — minutes until this session lapses, or null. Envelope only; no cookie VALUE is ever involved. */
export function minutesLeft(belief, { now = null } = {}) {
  const b = makeBelief(belief || {});
  const n = _n(now);
  if (n == null || b.expiresAt == null) return null;
  return Math.max(0, Math.round((b.expiresAt - n) / 60000));
}

/** PR-6 — the `PRESENCE ▸` marker. Registered in studio.js `_DECISION_RE` (invariant #1). PURE. */
export function renderPresence(host, belief, { reason = '', now = null } = {}) {
  const h = _s(host);
  if (!h) return '';
  const b = makeBelief(belief || {});
  const bits = [h, b.state];
  if (reason) bits.push(reason);
  const m = minutesLeft(b, { now });
  if (m != null) bits.push(m === 0 ? 'lapsed' : `lapses in ${m}m`);
  if (b.why) bits.push(b.why);
  return `PRESENCE ▸ ${bits.join(' · ')}`;
}
