// Core/sessionGovernor.test.js — SGV-0: the planner's soak FAIL arms as unit tests (DESIGN_session_governor.md
// v1.14 §10 O4 — a plan the soak would grade FAIL must be UNPLANNABLE by construction). node --test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planSessionGovernorTick, incidentIdFor, SGV_LIMITS } from './sessionGovernor.js';

const NOW = 1754500000000;
const demandVia = (origins) => ({ activeAsks: [{ id: 'a1', origins }] });

describe('sessionGovernor — the O4 soak arms (each a FAIL if ever violated)', () => {
  it('ARM: focus is NEVER planned while the user is active — even determinate signed-out with demand', () => {
    const plan = planSessionGovernorTick({
      now: NOW, userActiveOn: true, ...demandVia(['a.example.com']),
      origins: { 'a.example.com': { status: 'signed-out', probedThisIncident: true } },
    });
    assert.ok(plan.heals.every((h) => h.verb !== 'focus'), JSON.stringify(plan.heals));
    assert.equal(plan.heals[0] && plan.heals[0].verb, 'probe', 'the ladder falls back to the cheap rung, not to silence');
  });

  it('ARM: the per-tick heal cap holds — excess demands DEFER, never squeeze in', () => {
    const origins = {}; const asks = [];
    for (let i = 0; i < 5; i++) { origins[`o${i}.example.com`] = { status: 'signed-out' }; asks.push(`o${i}.example.com`); }
    const plan = planSessionGovernorTick({ now: NOW, origins, ...demandVia(asks) });
    assert.equal(plan.heals.length, SGV_LIMITS.HEALS);
    assert.equal(plan.deferred, 2);
    assert.equal(plan.demands, 5);
  });

  it('ARM: no work demand → no heals (a heal without demand is the attention sink freelancing)', () => {
    const plan = planSessionGovernorTick({ now: NOW, origins: { 'a.example.com': { status: 'signed-out' } } });
    assert.equal(plan.heals.length, 0);
    assert.equal(plan.demands, 0);
    assert.equal(plan.planned, 0);
  });

  it('ARM: one heal per origin — two demands on the same origin plan ONE verb', () => {
    const plan = planSessionGovernorTick({
      now: NOW,
      origins: { 'a.example.com': { status: 'signed-out' } },
      blocked: [{ runId: 'r1', workflowId: 'w1', origins: ['a.example.com'], parkedAt: 1 }],
      activeAsks: [{ id: 'a1', origins: ['a.example.com'] }],
    });
    assert.equal(plan.heals.length, 1);
    assert.equal(plan.heals[0].incidentId, 'block:r1', 'the OLDEST demand (the block) owns the incident');
  });

  it('ladder: csrf-cold → warm beats probe; stale+KA → keepalive; fresh+nothing-owed → no heal, not deferred', () => {
    const plan = planSessionGovernorTick({
      now: NOW,
      origins: {
        'w.example.com': { status: 'fresh', csrfCold: true },
        'k.example.com': { status: 'stale', kaOn: true },
        'f.example.com': { status: 'fresh' },
      },
      ...demandVia(['w.example.com', 'k.example.com', 'f.example.com']),
    });
    const byOrigin = Object.fromEntries(plan.heals.map((h) => [h.origin, h.verb]));
    assert.equal(byOrigin['w.example.com'], 'warm');
    assert.equal(byOrigin['k.example.com'], 'keepalive');
    assert.equal(byOrigin['f.example.com'], undefined);
    assert.equal(plan.deferred, 0, 'a fresh origin with nothing owed is not "deferred work"');
  });

  it('cooldown and contested-indeterminate defer; an exhausted budget names the origin instead of planning', () => {
    const plan = planSessionGovernorTick({
      now: NOW,
      origins: {
        'c.example.com': { status: 'signed-out', cooldownUntil: NOW + 1000 },
        'x.example.com': { status: 'unknown', contested: 2 },
        'b.example.com': { status: 'signed-out' },
      },
      ...demandVia(['c.example.com', 'x.example.com', 'b.example.com']),
      budgets: { probes: 0 },
    });
    assert.equal(plan.heals.length, 0);
    assert.equal(plan.deferred, 2);
    assert.deepEqual(plan.budgetExhausted, ['b.example.com']);
  });

  it('ARM: a contested origin never climbs past probe — even determinate, probed, and user-idle (§3)', () => {
    const plan = planSessionGovernorTick({
      now: NOW, userActiveOn: false, ...demandVia(['a.example.com']),
      origins: { 'a.example.com': { status: 'signed-out', probedThisIncident: true, contested: 2 } },
    });
    assert.equal(plan.heals[0] && plan.heals[0].verb, 'probe', JSON.stringify(plan.heals));
  });

  it('the incident grammar is exact (§2 — one problem, one id, everywhere)', () => {
    assert.equal(incidentIdFor('block', { runId: 'r9' }), 'block:r9');
    assert.equal(incidentIdFor('ask', { askId: 'q2' }), 'ask:q2');
    assert.equal(incidentIdFor('due', { workflowId: 'w1', origin: 'a.b' }), 'due:w1:a.b');
    assert.equal(incidentIdFor('scope', { origin: 'a.b', utcDay: '2026-08-07' }), 'scope:a.b:2026-08-07');
  });

  it('nudges: oldest parked block first, capped at 1', () => {
    const plan = planSessionGovernorTick({
      now: NOW,
      blocked: [
        { runId: 'r2', workflowId: 'w2', origins: [], parkedAt: 200 },
        { runId: 'r1', workflowId: 'w1', origins: [], parkedAt: 100 },
      ],
    });
    assert.deepEqual(plan.dueNudges, [{ blockedRunId: 'r1', workflowId: 'w1' }]);
  });
});
