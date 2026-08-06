// Core/trigger.test.js — CD-0: the cadence trigger's pure logic (DESIGN_cadence.md §7). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTrigger, armTrigger, isDue, coalescedCount, advanceTrigger,
  recordFailure, disarm, setEnabled, describeMinutes, describeTrigger, TRIGGER_LIMITS, isTransientFailure,
} from './trigger.js';

const MIN = 60_000;

describe('trigger — normalizeTrigger', () => {
  it('needs a valid minutes; a non-object or bad minutes → undefined (no half-record)', () => {
    assert.equal(normalizeTrigger(null), undefined);
    assert.equal(normalizeTrigger({}), undefined);
    assert.equal(normalizeTrigger({ minutes: 0 }), undefined);
    assert.equal(normalizeTrigger({ minutes: 'soon' }), undefined);
  });
  it('clamps minutes to [5, 1440]; a missing kind defaults to cadence', () => {
    assert.equal(normalizeTrigger({ minutes: 1 }).minutes, TRIGGER_LIMITS.MIN_MINUTES);   // floored to 5
    assert.equal(normalizeTrigger({ minutes: 99999 }).minutes, TRIGGER_LIMITS.MAX_MINUTES); // capped to 1440
    assert.equal(normalizeTrigger({ minutes: 240 }).kind, 'cadence');
  });
  // §13 (v1715) — kind is POLYMORPHIC: an UNKNOWN kind passes through UNTOUCHED (the pre-1715 normalizer coerced
  // every kind to 'cadence' and dropped minutes-less triggers — a future kind:'event' would have been silently
  // rewritten or lost on the next edit: bug-class #3, the closed whitelist, applied to a VALUE).
  it('an unknown kind passes through untouched, and the cadence mechanics treat it as inert', () => {
    const ev = { kind: 'event', condition: 'new warranty task', enabled: true };
    const t = normalizeTrigger(ev);
    assert.equal(t.kind, 'event');
    assert.equal(t.condition, 'new warranty task', 'unspecified fields survive');
    assert.equal(isDue(t, 1e15), false, 'the cadence scanner never fires an event trigger');
    assert.equal(coalescedCount(t, 1e15), 0);
    assert.deepEqual(advanceTrigger(t, 1000), t, 'cadence mechanics pass an unknown kind through');
    assert.deepEqual(recordFailure(t, { now: 1000 }), t);
    assert.equal(disarm(t).enabled, false, 'the arm bit is universal');
    assert.equal(setEnabled(t, true).enabled, true);
    assert.equal(describeTrigger(t), '', 'no honest label for an unspecified shape');
  });
  it('defaults enabled/nextDue/lastFiredAt/failures and drops negatives', () => {
    const t = normalizeTrigger({ minutes: 240 });
    assert.deepEqual(t, { kind: 'cadence', minutes: 240, enabled: false, nextDue: 0, lastFiredAt: 0, failures: 0 });
    assert.equal(normalizeTrigger({ minutes: 240, failures: -3 }).failures, 0);
    assert.equal(normalizeTrigger({ minutes: 240, nextDue: -5 }).nextDue, 0);
  });
});

describe('trigger — arm + isDue', () => {
  it('armTrigger makes an enabled cadence first due one interval out', () => {
    const t = armTrigger(240, 1000);
    assert.equal(t.enabled, true);
    assert.equal(t.nextDue, 1000 + 240 * MIN);
    assert.equal(isDue(t, t.nextDue - 1), false);   // not yet
    assert.equal(isDue(t, t.nextDue), true);         // at the instant
    assert.equal(isDue(t, t.nextDue + 999), true);   // and after
  });
  it('a disabled or unarmed trigger is never due', () => {
    assert.equal(isDue({ minutes: 240, enabled: false, nextDue: 10 }, 1e15), false);
    assert.equal(isDue({ minutes: 240, enabled: true, nextDue: 0 }, 1e15), false);   // no nextDue anchor
    assert.equal(armTrigger('nope', 0), undefined);
  });
});

describe('trigger — coalescing (§7.2)', () => {
  it('0 before due, 1 at due, N+1 after N further whole intervals', () => {
    const t = armTrigger(60, 0);                     // nextDue = 60min
    assert.equal(coalescedCount(t, t.nextDue - 1), 0);
    assert.equal(coalescedCount(t, t.nextDue), 1);
    assert.equal(coalescedCount(t, t.nextDue + 60 * MIN), 2);       // one more interval elapsed
    assert.equal(coalescedCount(t, t.nextDue + 2.5 * 60 * MIN), 3); // 2 whole further intervals + partial
  });
});

describe('trigger — advance after a clean fire', () => {
  it('anchors nextDue strictly in the future, stamps lastFiredAt, resets failures', () => {
    const t = { ...armTrigger(60, 0), failures: 2 };   // nextDue = 60min, some prior failures
    const now = t.nextDue + 2.5 * 60 * MIN;             // fired late, backlog of 2 collapsed
    const a = advanceTrigger(t, now);
    assert.equal(a.lastFiredAt, now);
    assert.equal(a.failures, 0);
    assert.ok(a.nextDue > now, 'next due is in the future');
    assert.equal(a.nextDue, t.nextDue + 3 * 60 * MIN);  // walked forward past the backlog, not to now+period
    assert.equal(coalescedCount(a, now), 0, 'no residual backlog after advancing');
  });
});

describe('trigger — failure → auto-disarm (§7.2)', () => {
  it('increments failures and advances nextDue, staying enabled below the cap', () => {
    const t = armTrigger(60, 0);
    const f1 = recordFailure(t, { now: t.nextDue });
    assert.equal(f1.failures, 1);
    assert.equal(f1.enabled, true);
    assert.ok(f1.nextDue > t.nextDue);
  });
  it('auto-disarms at the failure cap', () => {
    let t = armTrigger(60, 0);
    let now = t.nextDue;
    for (let i = 0; i < TRIGGER_LIMITS.MAX_FAILURES; i++) { t = recordFailure(t, { now }); now = t.nextDue; }
    assert.equal(t.failures, TRIGGER_LIMITS.MAX_FAILURES);
    assert.equal(t.enabled, false, 'disarmed after N consecutive failures');
  });

  // v2.74.2043 — being signed out is not route drift. Adding `headless:true` to the cadence invoke turns a
  // signed-out ground into a fast failure instead of a focused login tab; without this rule a week away from the
  // machine would auto-disarm every armed trigger and tell the user their routes had drifted.
  it('a TRANSIENT failure advances the clock without burning a disarm strike', () => {
    const t = armTrigger(60, 0);
    const f1 = recordFailure(t, { now: t.nextDue, transient: true });
    assert.equal(f1.failures, 0, 'no strike');
    assert.equal(f1.enabled, true);
    assert.ok(f1.nextDue > t.nextDue, 'but the clock still advances — no tight retry loop');
  });

  it('never auto-disarms on transient failures alone, however many', () => {
    let t = armTrigger(60, 0);
    let now = t.nextDue;
    for (let i = 0; i < TRIGGER_LIMITS.MAX_FAILURES * 5; i++) { t = recordFailure(t, { now, transient: true }); now = t.nextDue; }
    assert.equal(t.enabled, true, 'a signed-out week must not switch the automation off');
    assert.equal(t.failures, 0);
  });

  it('does not RESET a real failure count — drift interleaved with auth blips still disarms', () => {
    let t = armTrigger(60, 0);
    let now = t.nextDue;
    for (let i = 0; i < TRIGGER_LIMITS.MAX_FAILURES; i++) {
      t = recordFailure(t, { now, transient: false }); now = t.nextDue;
      t = recordFailure(t, { now, transient: true }); now = t.nextDue;
    }
    assert.equal(t.enabled, false, 'the transient failures did not launder the real ones');
  });
});

describe('isTransientFailure — conservative by design (v2.74.2043)', () => {
  it('classes signed-out / unreachable errors as transient', () => {
    for (const e of ['not-logged-in', 'no-authenticated-tab', 'no-content-script', 'http-401', 'http-403',
                     'reauth-timeout', 'Failed to fetch', 'network error']) {
      assert.equal(isTransientFailure(e), true, e);
    }
  });
  it('a wholesale map lookup failure is the environment, not the route (v2.74.2044)', () => {
    assert.equal(isTransientFailure('lookup-failed'), true);
  });
  it('everything else counts toward disarm — a drifting route must still stop itself', () => {
    for (const e of ['recipe-gone', 'not-armed', 'unpinned-step', 'no-plan', 'write-needs-confirm',
                     'map-not-banked', 'http-404', 'http-500', '', null, undefined]) {
      assert.equal(isTransientFailure(e), false, String(e));
    }
  });
});

describe('trigger — disarm / setEnabled', () => {
  it('disarm disables but preserves cadence + counters', () => {
    const t = { ...armTrigger(60, 0), failures: 2 };
    const d = disarm(t);
    assert.equal(d.enabled, false);
    assert.equal(d.minutes, 60);
    assert.equal(d.failures, 2);
  });
  it('re-enabling resets failures and anchors a fresh nextDue (no backlog burst)', () => {
    const t = { ...armTrigger(60, 0), enabled: false, failures: 3 };
    const e = setEnabled(t, true, 1_000_000);
    assert.equal(e.enabled, true);
    assert.equal(e.failures, 0);
    assert.equal(e.nextDue, 1_000_000 + 60 * MIN);
    assert.equal(coalescedCount(e, 1_000_000), 0);
  });
});

describe('trigger — human labels', () => {
  it('describeMinutes renders compactly', () => {
    assert.equal(describeMinutes(30), '30m');
    assert.equal(describeMinutes(120), '2h');
    assert.equal(describeMinutes(90), '1h30m');
    assert.equal(describeMinutes(0), '—');
  });
  it('describeTrigger is HONEST about the tier (§7.3)', () => {
    const t = armTrigger(240, 0);
    assert.equal(describeTrigger(t, { tier: 'sw' }), 'runs every 4h');
    assert.equal(describeTrigger(t, { tier: 'panel' }), 'due every 4h');
    assert.equal(describeTrigger(disarm(t)), 'paused (every 4h)');
    assert.equal(describeTrigger(null), '');
  });
});

// RB-2 (rail review, iron principle) — a system disarm NAMES ITSELF on the trigger so the Automate tab can
// distinguish it from a user pause; pre-fix the reason lived only in run history and the surface was silent.
describe('disarm stamping (RB-2) — the surface can say WHY an automation stopped', () => {
  it('disarm(why, now) stamps; the stamp SURVIVES normalizeTrigger (the closed-shape trap)', () => {
    const t = disarm(armTrigger(240, 0), 'the owning view was deleted', 5 * MIN);
    assert.equal(t.enabled, false);
    assert.equal(t.disarmedWhy, 'the owning view was deleted');
    assert.equal(t.disarmedAt, 5 * MIN);
    const round = normalizeTrigger(t);
    assert.equal(round.disarmedWhy, 'the owning view was deleted', 'normalize must not strip the stamp');
    assert.equal(round.disarmedAt, 5 * MIN);
  });

  it('disarm without a why (the user-pause path) leaves NO stamp — that distinction IS the feature', () => {
    const t = disarm(armTrigger(240, 0));
    assert.equal(t.enabled, false);
    assert.ok(!('disarmedWhy' in t));
  });

  it('the strike disarm stamps itself at the threshold', () => {
    let t = armTrigger(60, 0);
    for (let i = 0; i < TRIGGER_LIMITS.MAX_FAILURES; i++) t = recordFailure(t, { now: (i + 1) * MIN });
    assert.equal(t.enabled, false);
    assert.match(t.disarmedWhy, /consecutive failures/);
    assert.ok(t.disarmedAt > 0);
  });

  it('re-arming clears the stamp (the reason described a state that no longer holds)', () => {
    const dead = disarm(armTrigger(240, 0), 'route drifted', 5 * MIN);
    const alive = setEnabled(dead, true, 10 * MIN);
    assert.equal(alive.enabled, true);
    assert.equal(alive.failures, 0);
    assert.ok(!('disarmedWhy' in alive), 're-arm must clear disarmedWhy');
    assert.ok(!('disarmedAt' in alive), 're-arm must clear disarmedAt');
  });
});
