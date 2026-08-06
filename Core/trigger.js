// Core/trigger.js — CD-0 (DESIGN_cadence.md §7): the cadence TRIGGER's PURE logic. No DOM / chrome / LLM / storage
// / clock — every function takes `now` injected. The template is Core/vitals.js (pure decision core) + the due /
// coalescing arithmetic Core/fleetSchedule.js already proved, re-homed onto a WORKFLOW-keyed field.
//
// THE RULING (§1): a cadence is not an entity. It is a FIELD on a workflow — `trigger` — that says when the workflow
// runs by itself. This module owns the field: normalize · arm · is-due · advance (with coalescing) · failure→disarm
// · orphan→disarm · the honest label (§7.3). One clock owner (the scanner, background/handlers/cadence.js) drives
// it; nothing here registers an alarm.

const MIN_MINUTES = 5;                 // be kind to the site + the LLM bill (matches fleetSchedule)
const MAX_MINUTES = 24 * 60;           // beyond a day, run it by hand
const MAX_FAILURES = 3;                // §7.2 — auto-disarm after N consecutive failures
const MS_PER_MIN = 60_000;

/** Clamp a minute count to the sane band, or null when it isn't a positive number. PURE. */
function clampMinutes(n) {
  const m = Math.round(Number(n));
  if (!Number.isFinite(m) || m <= 0) return null;
  return Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, m));
}

/**
 * Normalize a raw trigger → the closed field set, or `undefined` when there is no valid cadence. PURE.
 *
 * A trigger with no parseable `minutes` is NOT a trigger — returning undefined (not a half-record) is what lets
 * `normalizeWorkflow` carry the field verbatim: a workflow with no cadence simply has `trigger: undefined`.
 * `kind` is fixed to 'cadence' (the only value today) but PRESENT from day one so an event trigger is additive
 * (§7.1) — retrofitting the discriminator would cost the surface.
 *
 * @returns {{kind:'cadence', minutes:number, enabled:boolean, nextDue:number, lastFiredAt:number, failures:number}|undefined}
 */
export function normalizeTrigger(raw) {
  const t = (raw && typeof raw === 'object') ? raw : null;
  if (!t) return undefined;
  // §13 (v2.74.1715) — `kind` is POLYMORPHIC: only 'cadence' is specified, and an UNKNOWN kind passes through
  // UNTOUCHED (shallow copy). The pre-1715 normalizer force-rewrote every kind to 'cadence' and dropped any
  // minutes-less trigger — so a future `kind:'event'` record would have been silently coerced-or-dropped on the
  // next edit: recurring bug-class #3 (the closed whitelist) applied to a VALUE. We cannot normalize a shape
  // that isn't specified yet; preserving it verbatim is the only non-lossy move. The cadence-mechanics helpers
  // below (isDue / coalescedCount / advance / recordFailure) treat a non-cadence trigger as INERT.
  const kind = String(t.kind == null ? '' : t.kind).trim() || 'cadence';
  if (kind !== 'cadence') return { ...t, kind };
  const minutes = clampMinutes(t.minutes);
  if (minutes == null) return undefined;
  return {
    kind: 'cadence',
    minutes,
    enabled: t.enabled === true,
    nextDue: Number.isFinite(t.nextDue) && t.nextDue > 0 ? t.nextDue : 0,
    lastFiredAt: Number.isFinite(t.lastFiredAt) && t.lastFiredAt > 0 ? t.lastFiredAt : 0,
    failures: Number.isFinite(t.failures) && t.failures > 0 ? Math.floor(t.failures) : 0,
  };
}

/** Arm a fresh, ENABLED cadence every `minutes`, first due one interval from `now`. PURE. Undefined on bad minutes. */
export function armTrigger(minutes, now = 0) {
  const m = clampMinutes(minutes);
  if (m == null) return undefined;
  const base = Number.isFinite(now) ? now : 0;
  return { kind: 'cadence', minutes: m, enabled: true, nextDue: base + m * MS_PER_MIN, lastFiredAt: 0, failures: 0 };
}

/** Is a normalized trigger the cadence kind (the only kind this module's mechanics can evaluate)? PURE. */
const _isCadence = (t) => !!(t && t.kind === 'cadence');

/** Is this trigger due to fire at `now`? PURE — the scanner's check 2+3 (§2.1). Disabled / unarmed / non-cadence → never. */
export function isDue(trigger, now = 0) {
  const t = normalizeTrigger(trigger);
  return !!(_isCadence(t) && t.enabled && t.nextDue > 0 && Number.isFinite(now) && t.nextDue <= now);
}

/**
 * How many due-times have passed as of `now` (§7.2 coalescing). PURE. 0 when not due; 1 exactly at the due
 * instant; N+1 when N further whole intervals have also elapsed. The scanner fires ONCE and records "N due-times
 * collapsed" when this exceeds 1 — a backlog is currency lost, not a series to replay.
 */
export function coalescedCount(trigger, now = 0) {
  const t = normalizeTrigger(trigger);
  if (!_isCadence(t) || !t.enabled || t.nextDue <= 0 || !Number.isFinite(now) || now < t.nextDue) return 0;
  return 1 + Math.floor((now - t.nextDue) / (t.minutes * MS_PER_MIN));
}

/** The next due instant strictly after `base`, walked forward one interval at a time from the current anchor. */
function _nextDueAfter(t, base) {
  const period = t.minutes * MS_PER_MIN;
  let next = t.nextDue > 0 ? t.nextDue : base;
  while (next <= base) next += period;
  return next;
}

/**
 * After a CLEAN fire: stamp `lastFiredAt = now`, reset the consecutive-failure count, and anchor `nextDue`
 * strictly in the future (coalescing — never replay the backlog). PURE.
 */
export function advanceTrigger(trigger, now = 0) {
  const t = normalizeTrigger(trigger);
  if (!t) return undefined;
  if (!_isCadence(t)) return t;   // cadence mechanics don't apply to a shape we haven't specified — pass through
  const base = Number.isFinite(now) ? now : 0;
  return { ...t, nextDue: _nextDueAfter(t, base), lastFiredAt: base, failures: 0 };
}

/**
 * After a FAILED fire (§7.2): increment the consecutive-failure count and, at `max`, AUTO-DISARM. `nextDue` still
 * advances so a re-arm doesn't immediately re-fire the same backlog. PURE. The disarm is the only place a person
 * learns their automation stopped, so the caller writes a history entry when `enabled` flips false.
 */
export function recordFailure(trigger, { max = MAX_FAILURES, now = 0, transient = false } = {}) {
  const t = normalizeTrigger(trigger);
  if (!t) return undefined;
  if (!_isCadence(t)) return t;   // pass through — see advanceTrigger
  const base = Number.isFinite(now) ? now : 0;
  // v2.74.2043 — a TRANSIENT failure advances the clock but does NOT count toward auto-disarm. The disarm rule
  // exists to stop a workflow whose ROUTE has drifted ("its route may have drifted" is what the user is told), and
  // three consecutive drift failures is good evidence of that. Being signed out is not drift. Before this, the
  // headless path had no way to say so — and v2.74.2043 makes it matter, because adding `headless:true` to the
  // cadence invoke converts a signed-out ground from "focus a login tab and block" into a fast `not-logged-in`
  // failure. Every 3 ticks of a closed laptop would then silently disarm every armed trigger, and the user would
  // return to automations that are not merely behind but SWITCHED OFF, told their routes had drifted. `failures`
  // is deliberately left UNCHANGED rather than reset: a real drift interleaved with auth blips still accumulates.
  const failures = transient ? t.failures : t.failures + 1;
  const disarmed = failures >= max;
  return { ...t, failures, nextDue: _nextDueAfter(t, base), lastFiredAt: base, enabled: disarmed ? false : t.enabled };
}

/**
 * Is this failure the environment's fault rather than the workflow's? PURE. v2.74.2043 — the input is a step error
 * string from the executor (`not-logged-in`, `no-authenticated-tab`, `write-needs-confirm`, http-401/403, …).
 * Conservative BY DESIGN: only errors that name a signed-out/absent session are transient. Anything unrecognized
 * counts toward disarm, so a genuinely drifting route still stops itself. v2.74.2044 adds `lookup-failed` (a map
 * step whose lookups ALL errored with no completed verdict — rate limit/auth/network wholesale, not the route:
 * a drifted lookup route surfaces as `recipe-gone`/`not-armed` at resolve time and still disarms).
 */
export function isTransientFailure(error) {
  const e = String(error || '').toLowerCase();
  if (!e) return false;
  return /not-logged-in|no-authenticated-tab|no-content-script|reauth|unauthori[sz]ed|http-401|http-403|offline|network|failed to fetch|lookup-failed/.test(e);
}

/** Disable a trigger (manual pause / orphaned desk), preserving cadence + counters. PURE. */
export function disarm(trigger) {
  const t = normalizeTrigger(trigger);
  if (!t) return undefined;
  return { ...t, enabled: false };
}

/**
 * Flip enabled state. Re-arming (enabled:true) RESETS failures and anchors a fresh `nextDue` one interval out, so
 * a trigger disabled for a week doesn't fire a week's backlog the instant it's switched back on. PURE.
 */
export function setEnabled(trigger, enabled, now = 0) {
  const t = normalizeTrigger(trigger);
  if (!t) return undefined;
  if (!enabled) return { ...t, enabled: false };
  if (!_isCadence(t)) return { ...t, enabled: true };   // the arm bit is universal; the nextDue anchor is cadence-only
  const base = Number.isFinite(now) ? now : 0;
  return { ...t, enabled: true, failures: 0, nextDue: base + t.minutes * MS_PER_MIN };
}

/** Render minutes as a human interval ("30m", "2h", "1h30m"). PURE. */
export function describeMinutes(minutes) {
  const m = Math.round(Number(minutes) || 0);
  if (m <= 0) return '—';
  if (m % 60 === 0) return `${m / 60}h`;
  if (m > 60) return `${Math.floor(m / 60)}h${m % 60}m`;
  return `${m}m`;
}

/**
 * The honest label (§7.3): the surface must not claim more than the executor delivers. A tier-`'sw'` workflow
 * genuinely runs on the clock → "runs every 4h"; a tier-`'panel'` one only fires on next desk-open → "due every
 * 4h". A disabled trigger says "paused". PURE — the tier oracle (Core/workflowTier.js) supplies `tier`.
 */
export function describeTrigger(trigger, { tier = 'panel' } = {}) {
  const t = normalizeTrigger(trigger);
  if (!t || !_isCadence(t)) return '';   // an unspecified kind has no honest label yet
  const every = describeMinutes(t.minutes);
  if (!t.enabled) return `paused (every ${every})`;
  return tier === 'sw' ? `runs every ${every}` : `due every ${every}`;
}

export const TRIGGER_LIMITS = { MIN_MINUTES, MAX_MINUTES, MAX_FAILURES };
