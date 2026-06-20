// Core/ilRun.test.js — IL-2 the composed IL run (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runIl } from './ilRun.js';

const cap = (id) => ({ capabilityId: id, name: id });   // a learned capability (retrieveTools shape)
const legOf = (ctx, key) => ctx.palette.find((l) => l.key === key);

describe('runIl — palette + loop + dispatch composed (pure, injected deps)', () => {
  it('assembles a palette of learned ∪ builtins and hands it to Orchard', async () => {
    let seen = null;
    await runIl('g', { tabId: 5, groundId: 'gr' }, {
      retrieve: async () => [cap('cap_a')],
      il: async (ctx) => { seen = ctx.palette; return { kind: 'done', answer: 'x', confidence: 1, reason: 'd' }; },
      exec: async () => ({ success: true }),
    }, { maxSteps: 2 });
    assert.ok(seen.some((l) => l.key === 'cap_a'));      // learned
    assert.ok(seen.some((l) => l.key === 'OPEN_URL'));   // builtin
  });

  it('maxSteps=1 hands an act decision back un-executed (route parity)', async () => {
    let execCalled = false;
    const r = await runIl('g', { tabId: 5, groundId: 'gr' }, {
      retrieve: async () => [cap('cap_a')],
      il: async (ctx) => ({ kind: 'act', leg: legOf(ctx, 'cap_a'), params: {}, confidence: 1, reason: 'x' }),
      exec: async () => { execCalled = true; return { success: true }; },
    }, { maxSteps: 1 });
    assert.equal(r.status, 'act');
    assert.equal(execCalled, false);
  });

  it('multi-step: act → exec the REPLAY plan → observe → done; reads thread into scope', async () => {
    const plans = [];
    let calls = 0;
    const r = await runIl('search cats and open the first', { tabId: 5, groundId: 'gr' }, {
      retrieve: async () => [cap('cap_a')],
      il: async (ctx) => { calls++; return calls === 1
        ? { kind: 'act', leg: legOf(ctx, 'cap_a'), params: { q: 'cats' }, confidence: 1, reason: 'go' }
        : { kind: 'done', answer: 'done!', confidence: 1, reason: 'fin' }; },
      exec: async (plan) => { plans.push(plan); return { success: true, value: `v${plans.length}` }; },
    }, { maxSteps: 3 });
    assert.equal(r.status, 'done');
    assert.equal(r.answer, 'done!');
    assert.equal(plans.length, 1);
    assert.equal(plans[0].channel, 'REPLAY_SG_CAPABILITY');   // a page leg dispatches to the verified runner
    assert.equal(plans[0].payload.capabilityId, 'cap_a');
    assert.equal(plans[0].payload.tabId, 5);
    assert.equal(r.scope.cap_a, 'v1');                        // the read value keyed by its producing leg
  });

  it('a browser OPEN_URL leg dispatches to OPEN_URL_NEW_TAB (no ground/tab needed)', async () => {
    let plan = null, calls = 0;
    await runIl('go to x', {}, {
      retrieve: async () => [],
      il: async (ctx) => { calls++; return calls === 1
        ? { kind: 'act', leg: legOf(ctx, 'OPEN_URL'), params: { url: 'https://x.com' }, confidence: 1, reason: 'nav' }
        : { kind: 'done', answer: 'opened', confidence: 1, reason: 'd' }; },
      exec: async (p) => { plan = p; return { success: true }; },
    }, { maxSteps: 2 });
    assert.equal(plan.channel, 'OPEN_URL_NEW_TAB');
    assert.equal(plan.payload.url, 'https://x.com');
  });

  it('a non-dispatchable leg (page leg with no ground/tab) → structuredFailure, exec never called, Orchard re-engages', async () => {
    let execCalled = false, calls = 0;
    const r = await runIl('g', {}, {     // no tabId/groundId in ctx
      retrieve: async () => [cap('cap_a')],
      il: async (ctx) => { calls++; return calls === 1
        ? { kind: 'act', leg: legOf(ctx, 'cap_a'), params: {}, confidence: 1, reason: 'try' }
        : { kind: 'needs', needs: { kind: 'clarify' }, confidence: 0, reason: 'cannot' }; },
      exec: async () => { execCalled = true; return { success: true }; },
    }, { maxSteps: 3 });
    assert.equal(execCalled, false);          // planExec said not-ok → never sent
    assert.equal(r.status, 'needs');
    assert.equal(calls, 2);                   // Orchard saw the failure and gave up
  });

  it('exec throwing → structuredFailure, never throws; the run continues to a clean terminal', async () => {
    let calls = 0;
    const r = await runIl('g', { tabId: 5, groundId: 'gr' }, {
      retrieve: async () => [cap('cap_a')],
      il: async (ctx) => { calls++; return calls === 1
        ? { kind: 'act', leg: legOf(ctx, 'cap_a'), params: {}, confidence: 1, reason: 'x' }
        : { kind: 'done', answer: 'recovered', confidence: 1, reason: 'd' }; },
      exec: async () => { throw new Error('boom'); },
    }, { maxSteps: 3 });
    assert.equal(r.status, 'done');
  });

  it('anti-hallucination survives composition: a ghost leg → needs(demonstrate)', async () => {
    const r = await runIl('g', { tabId: 5, groundId: 'gr' }, {
      retrieve: async () => [cap('cap_a')],
      il: async () => ({ kind: 'act', leg: { key: 'GHOST' }, params: {}, confidence: 1, reason: 'x' }),
      exec: async () => ({ success: true }),
    }, { maxSteps: 1 });
    assert.equal(r.status, 'needs');
    assert.equal(r.decision.needs.kind, 'demonstrate');
  });
});
