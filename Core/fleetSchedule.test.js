// Core/fleetSchedule.test.js — FL-6 (v2.74.1355): the clock trigger's interval grammar + alarm identity.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseEvery, describeEvery, sweepAlarmName, instanceFromAlarmName, buildSeedDirectivesMessages, parseSeedDirectives, rollDailyCounts, spikeVerdict, localDay, fmtCountdown, queueStateLines, priorRunVerdict, routineAlarmName, instanceFromRoutineAlarm } from './fleetSchedule.js';

describe('fleetSchedule — parseEvery (human interval → clamped minutes)', () => {
  it('parses m/h forms and bare numbers (minutes default)', () => {
    assert.equal(parseEvery('30m'), 30);
    assert.equal(parseEvery('2h'), 120);
    assert.equal(parseEvery('90'), 90);
    assert.equal(parseEvery('1 hour'), 60);
    assert.equal(parseEvery('45 min'), 45);
    assert.equal(parseEvery('1.5h'), 90);
  });
  it('clamps to the [5m, 24h] window (be kind to the site + the LLM bill)', () => {
    assert.equal(parseEvery('1m'), 5);
    assert.equal(parseEvery('48h'), 1440);
  });
  it('garbage → null (the console asks again, never guesses)', () => {
    assert.equal(parseEvery('soon'), null);
    assert.equal(parseEvery(''), null);
    assert.equal(parseEvery('0m'), null);
    assert.equal(parseEvery('-5m'), null);
  });
});

describe('fleetSchedule — describeEvery + alarm identity', () => {
  it('renders minutes back to human form', () => {
    assert.equal(describeEvery(30), '30m');
    assert.equal(describeEvery(120), '2h');
    assert.equal(describeEvery(90), '1h30m');
  });
  it('alarm names round-trip the instanceId; foreign alarms → null', () => {
    const name = sweepAlarmName('inst_abc123');
    assert.equal(name, 'fleet-sweep:inst_abc123');
    assert.equal(instanceFromAlarmName(name), 'inst_abc123');
    assert.equal(instanceFromAlarmName('orchard-sync'), null);
    assert.equal(instanceFromAlarmName('fleet-sweep:'), null);
  });
});

describe('fleetSchedule — FL-8d spike detection (code counts, the model interprets)', () => {
  it('rollDailyCounts upserts by day and keeps the last 14', () => {
    let h = [];
    for (let i = 1; i <= 16; i++) h = rollDailyCounts(h, `2026-06-${String(i).padStart(2, '0')}`, i);
    assert.equal(h.length, 14);
    assert.equal(h[0].day, '2026-06-03');
    h = rollDailyCounts(h, '2026-06-16', 99);   // same-day upsert replaces, no duplicate
    assert.equal(h.length, 14);
    assert.equal(h[h.length - 1].count, 99);
  });
  it('spikeVerdict: needs a baseline, a floor count, and the ratio', () => {
    assert.equal(spikeVerdict([], '2026-07-07', 50).spike, false);                                    // no baseline yet
    assert.equal(spikeVerdict([{ day: 'd1', count: 6 }], '2026-07-07', 50).spike, false);             // 1 day isn’t a baseline
    const base = [{ day: 'd1', count: 6 }, { day: 'd2', count: 6 }];
    assert.equal(spikeVerdict(base, '2026-07-07', 27).spike, true);                                   // 4.5× the mean
    assert.equal(spikeVerdict(base, '2026-07-07', 8).spike, false);                                   // above mean, below ratio
    assert.equal(spikeVerdict([{ day: 'd1', count: 1 }, { day: 'd2', count: 1 }], '2026-07-07', 4).spike, false);   // small-count floor
    const v = spikeVerdict(base, '2026-07-07', 27);
    assert.equal(v.baseline, 6);
    assert.equal(v.ratio, 4.5);
  });
  it('localDay renders YYYY-MM-DD', () => {
    assert.match(localDay(Date.UTC(2026, 6, 7, 12, 0, 0)), /^\d{4}-\d{2}-\d{2}$/);
  });
  it('fmtCountdown (FL-6d, v1363): a ticking timer — m:ss under an hour, h:mm:ss above', () => {
    assert.equal(fmtCountdown(42_000), '0:42');
    assert.equal(fmtCountdown(89_000), '1:29');
    assert.equal(fmtCountdown(10 * 60_000), '10:00');
    assert.equal(fmtCountdown(65 * 60_000), '1:05:00');
    assert.equal(fmtCountdown((3600 + 5 * 60 + 42) * 1000), '1:05:42');
    assert.equal(fmtCountdown(-5), '0:00');
  });
  it('pulse semantics thread recipe → leg.tool (v1359/v1375 — the digest keys on pulse DATA, never a recipe id)', async () => {
    const { recipeToLeg } = await import('./connectorLeg.js');
    const obj = recipeToLeg({ id: 'inbox_unread', app: 'gmail', appHost: 'mail.google.com', endpoint: '/x', pulse: { kind: 'inflow' }, params: [] }, { trusted: true });
    assert.deepEqual(obj.tool.pulse, { kind: 'inflow' });
    const legacy = recipeToLeg({ id: 'inbox_all', app: 'gmail', appHost: 'mail.google.com', endpoint: '/z', pulse: 'inventory', params: [] }, { trusted: true });
    assert.deepEqual(legacy.tool.pulse, { kind: 'inventory' });   // string form normalizes
    const noPulse = recipeToLeg({ id: 'read_one', app: 'gmail', appHost: 'mail.google.com', endpoint: '/y', params: [] }, { trusted: true });
    assert.equal(noPulse.tool.pulse, null);
  });
});

describe('fleetSchedule — H-1b priorRunVerdict (dead-run marker)', () => {
  const NOW = 1_800_000_000_000;
  it('no marker → neither in-flight nor died', () => {
    assert.deepEqual(priorRunVerdict(null, NOW), { inFlight: false, died: false });
    assert.deepEqual(priorRunVerdict({}, NOW), { inFlight: false, died: false });
  });
  it('fresh marker (<5m) → a run is in flight (skip the fire; no concurrent double-runs)', () => {
    assert.deepEqual(priorRunVerdict({ runId: 'r', startedAt: NOW - 2 * 60_000 }, NOW), { inFlight: true, died: false });
  });
  it('stale marker (≥5m) → the previous run DIED mid-flight (report + proceed)', () => {
    assert.deepEqual(priorRunVerdict({ runId: 'r', startedAt: NOW - 12 * 60_000 }, NOW), { inFlight: false, died: true });
  });
});

describe('fleetSchedule — v1375 queueStateLines (the "You: 4 open · 3 pending" breakdown)', () => {
  const _read = (pulse, count) => ({ leg: { tool: { pulse } }, value: { count } });
  it('groups reads by scope, in read order, from their API counts', () => {
    const lines = queueStateLines([
      _read({ scope: 'mine', status: 'open' }, 4),
      _read({ scope: 'mine', status: 'pending' }, 3),
      _read({ kind: 'inventory', scope: 'team', status: 'open' }, 32),
      _read({ kind: 'backlog', scope: 'team', status: 'unassigned' }, 3),
    ]);
    assert.deepEqual(lines, ['You: 4 open · 3 pending', 'Team: 32 open · 3 unassigned']);
  });
  it('skips reads without scope/status or without a count; dedupes a re-run cell; empty → []', () => {
    const lines = queueStateLines([
      _read({ kind: 'inflow' }, 98),                                  // no scope/status → not in the breakdown
      _read({ scope: 'mine', status: 'open' }, 4),
      _read({ scope: 'mine', status: 'open' }, 9),                    // duplicate cell — first read wins
      { leg: { tool: { pulse: { scope: 'team', status: 'open' } } }, value: { items: [] } },   // no count → skipped
    ]);
    assert.deepEqual(lines, ['You: 4 open']);
    assert.deepEqual(queueStateLines([]), []);
  });
});

describe('fleetSchedule — seed directives (FL-6b: the IL reads the seed, the harness clamps)', () => {
  it('fences the seed as data in the user message', () => {
    const { system, user } = buildSeedDirectivesMessages({ seed: 'Review the queue every hour.' });
    assert.ok(user.includes('<SEED'));
    assert.ok(user.includes('Review the queue every hour.'));
    assert.ok(/strict json/i.test(system));
  });
  it('parses a stated cadence, fence-tolerant', () => {
    assert.equal(parseSeedDirectives('{"every": "1h"}').every, '1h');
    assert.equal(parseSeedDirectives('```json\n{"every": "30m"}\n```').every, '30m');
    assert.equal(parseSeedDirectives('Sure — here it is: {"every": "2 hours"}').every, '2 hours');
  });
  it('none stated / garbage / wrong shape → {every: null}', () => {
    assert.equal(parseSeedDirectives('{"every": null}').every, null);
    assert.equal(parseSeedDirectives('no json here').every, null);
    assert.equal(parseSeedDirectives('').every, null);
    assert.equal(parseSeedDirectives('{"every": 42}').every, null);
    assert.equal(parseSeedDirectives('{"cadence": "1h"}').every, null);
  });
  it('the stated text round-trips through parseEvery (the clamp is the only authority)', () => {
    assert.equal(parseEvery(parseSeedDirectives('{"every": "1 hour"}').every), 60);
    assert.equal(parseEvery(parseSeedDirectives('{"every": "always, constantly"}').every ?? ''), null);
  });
  it('assignQuota (v1360 — "the quota should be stated in the seed"): validated int in [1,200]', () => {
    const both = parseSeedDirectives('{"every": "1h", "assignQuota": 10}');
    assert.equal(both.every, '1h');
    assert.equal(both.assignQuota, 10);
    assert.equal(parseSeedDirectives('{"assignQuota": "15"}').assignQuota, 15);   // string number tolerated
    assert.equal(parseSeedDirectives('{"assignQuota": 0}').assignQuota, null);    // floor
    assert.equal(parseSeedDirectives('{"assignQuota": 9999}').assignQuota, null); // ceiling
    assert.equal(parseSeedDirectives('{"every": "1h"}').assignQuota, null);       // stated-only
    assert.ok(/assignQuota/.test(buildSeedDirectivesMessages({ seed: 's' }).system));
  });
});

describe('DK-8 (v2.74.1491) — the routine directive + alarm identity', () => {
  it('parseSeedDirectives extracts a valid routine {every, ask}; malformed → null; absent → null', () => {
    const d = parseSeedDirectives('{"every": null, "assignQuota": null, "routine": {"every": "24h", "ask": "for each division, list new warranty tasks"}}');
    assert.deepEqual(d.routine, { every: '24h', ask: 'for each division, list new warranty tasks' });
    assert.equal(parseSeedDirectives('{"every":"1h","assignQuota":5,"routine":null}').routine, null);
    assert.equal(parseSeedDirectives('{"routine": {"every": "24h"}}').routine, null);          // ask missing
    assert.equal(parseSeedDirectives('{"routine": {"ask": "do things"}}').routine, null);      // every missing
    assert.equal(parseSeedDirectives('{"routine": "daily"}').routine, null);                   // wrong shape
    assert.equal(parseSeedDirectives('junk').routine, null);
  });
  it('a routine reply still parses the sibling directives (the greedy JSON match spans the nested object)', () => {
    const d = parseSeedDirectives('{"every": "1h", "assignQuota": 10, "routine": {"every": "24h", "ask": "x"}}');
    assert.equal(d.every, '1h');
    assert.equal(d.assignQuota, 10);
    assert.equal(d.routine.ask, 'x');
  });
  it('routine ask/every are trimmed + capped (200 / 40)', () => {
    const long = 'a'.repeat(300);
    const d = parseSeedDirectives(JSON.stringify({ routine: { every: '  24h  ', ask: `  ${long}  ` } }));
    assert.equal(d.routine.every, '24h');
    assert.equal(d.routine.ask.length, 200);
  });
  it('routineAlarmName / instanceFromRoutineAlarm round-trip; foreign + sweep alarms → null', () => {
    assert.equal(instanceFromRoutineAlarm(routineAlarmName('inst_9')), 'inst_9');
    assert.equal(instanceFromRoutineAlarm(sweepAlarmName('inst_9')), null);
    assert.equal(instanceFromRoutineAlarm('orchard-sync'), null);
    assert.equal(instanceFromRoutineAlarm(''), null);
    assert.equal(instanceFromAlarmName(routineAlarmName('inst_9')), null);   // the sweep parser ignores routine alarms too
  });
});
