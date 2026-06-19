// Core/agentLoop.test.js — IL-1 the inference-layer brain loop (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { agentLoop, routeDecisionToDecision, legFromTool } from './agentLoop.js';
import { route } from './route.js';

const cap  = (id, name) => ({ kind: 'capability', capabilityId: id, name });
const prim = (op, name) => ({ kind: 'primitive', op, name });

describe('legFromTool — route tool → OfferedLeg (pure)', () => {
  it('capability → learned leg keyed by capabilityId', () => {
    const l = legFromTool(cap('cap_x', 'X'));
    assert.equal(l.key, 'cap_x'); assert.equal(l.source, 'learned'); assert.equal(l.domain, 'page');
  });
  it('primitive → builtin leg keyed by op', () => {
    const l = legFromTool(prim('OPEN_URL', 'Open URL'));
    assert.equal(l.key, 'OPEN_URL'); assert.equal(l.source, 'builtin');
  });
  it('null/garbage → null', () => { assert.equal(legFromTool(null), null); assert.equal(legFromTool(42), null); });
});

describe('routeDecisionToDecision — the route↔loop parity bridge (pure)', () => {
  it('replay → act (learned leg), params/confidence carried', () => {
    const d = routeDecisionToDecision({ action: 'replay', tool: cap('cap_s', 'Search'), params: { q: 'cats' }, confidence: 0.8, reason: 'select:replay' });
    assert.equal(d.kind, 'act'); assert.equal(d.leg.key, 'cap_s'); assert.equal(d.leg.source, 'learned');
    assert.equal(d.params.q, 'cats'); assert.equal(d.confidence, 0.8); assert.equal(d.reason, 'select:replay');
  });
  it('primitive → act (builtin leg)', () => {
    const d = routeDecisionToDecision({ action: 'primitive', tool: prim('OPEN_URL', 'Open'), params: { url: 'u' }, confidence: 0.95, reason: 'select:primitive', lowConfidence: false });
    assert.equal(d.kind, 'act'); assert.equal(d.leg.key, 'OPEN_URL'); assert.equal(d.lowConfidence, false);
  });
  it('demonstrate → needs(demonstrate)', () => {
    const d = routeDecisionToDecision({ action: 'demonstrate', tool: null, confidence: 0.2, reason: 'no-tool' });
    assert.equal(d.kind, 'needs'); assert.equal(d.needs.kind, 'demonstrate'); assert.equal(d.reason, 'no-tool');
  });
  it('decompose → needs(decompose) with subAsks + lowConfidence', () => {
    const d = routeDecisionToDecision({ action: 'decompose', tool: null, subAsks: ['a', 'b'], confidence: 0.2, reason: 'compound', lowConfidence: true });
    assert.equal(d.kind, 'needs'); assert.equal(d.needs.kind, 'decompose');
    assert.deepEqual(d.needs.subAsks, ['a', 'b']); assert.equal(d.lowConfidence, true);
  });
  it('clarify → needs(clarify) carrying candidates', () => {
    const d = routeDecisionToDecision({ action: 'clarify', tool: null, candidates: [cap('c1')], confidence: 0, reason: 'no-router' });
    assert.equal(d.kind, 'needs'); assert.equal(d.needs.kind, 'clarify'); assert.equal(d.needs.candidates.length, 1);
  });
  it('null/garbage → needs(clarify) (never throws)', () => {
    assert.equal(routeDecisionToDecision(null).kind, 'needs');
    assert.equal(routeDecisionToDecision(42).needs.kind, 'clarify');
  });
});

describe('agentLoop — maxSteps=1 IS route.js (the §8 Phase-1 parity claim)', () => {
  const TOOLS = [cap('cap_search', 'Search for videos'), prim('OPEN_URL', 'Open URL')];
  const retrieveTools = async () => TOOLS;
  const callRouter = async () => ({ tool: 'OPEN_URL', params: { url: 'https://pixabay.com' }, confidence: 0.95 });

  it('loop@1 with a route-backed brain ≡ routeDecisionToDecision(route(…))', async () => {
    const rd = await route('go to pixabay', { retrieveTools, callRouter });        // the direct route decision
    const expected = routeDecisionToDecision(rd);

    const palette = async (g) => (await retrieveTools(g, 8)).map(legFromTool);
    const callBrain = async (ctx) => routeDecisionToDecision(await route(ctx.goal, { retrieveTools: async () => TOOLS, callRouter }));
    const res = await agentLoop('go to pixabay', { palette, callBrain }, { maxSteps: 1 });

    assert.equal(res.status, 'act');
    assert.deepEqual(res.decision, expected);     // no divergence from route at step 1
  });

  it('maxSteps=1 hands the act decision BACK un-executed (decide-only; the caller dispatches)', async () => {
    let toolCalls = 0;
    const res = await agentLoop('g', {
      palette: async () => [{ key: 'L1' }],
      callBrain: async () => ({ kind: 'act', leg: { key: 'L1' }, params: {}, confidence: 1, reason: 'x' }),
      runTool: async () => { toolCalls++; return { ok: true }; },
    }, { maxSteps: 1 });
    assert.equal(res.status, 'act');
    assert.equal(res.decision.leg.key, 'L1');
    assert.equal(toolCalls, 0);   // route parity: maxSteps=1 never executes
  });
});

describe('agentLoop — loop behavior', () => {
  it('empty goal → needs(clarify), the brain is never called', async () => {
    let called = false;
    const res = await agentLoop('   ', { callBrain: async () => { called = true; return null; } });
    assert.equal(res.status, 'needs'); assert.equal(res.decision.reason, 'empty-goal'); assert.equal(called, false);
  });

  it('no brain → error', async () => {
    const res = await agentLoop('g', {});
    assert.equal(res.status, 'error'); assert.equal(res.reason, 'no-brain');
  });

  it('anti-hallucination: an act leg NOT in the palette → coerced to needs(demonstrate)', async () => {
    const res = await agentLoop('g', {
      palette: async () => [{ key: 'REAL' }],
      callBrain: async () => ({ kind: 'act', leg: { key: 'GHOST' }, params: {}, confidence: 1, reason: 'x' }),
    }, { maxSteps: 1 });
    assert.equal(res.status, 'needs');
    assert.equal(res.decision.needs.kind, 'demonstrate');
    assert.equal(res.decision.reason, 'tool-not-in-palette');
  });

  it('needs decision is terminal (handed off immediately)', async () => {
    const res = await agentLoop('g', { callBrain: async () => ({ kind: 'needs', needs: { kind: 'demonstrate' }, reason: 'gap', confidence: 0.2 }) }, { maxSteps: 5 });
    assert.equal(res.status, 'needs'); assert.equal(res.decision.needs.kind, 'demonstrate');
  });

  it('multi-step: act → observe → act → observe → done; runTool fires per intermediate act; scope threads', async () => {
    let i = 0;
    const decisions = [
      { kind: 'act', leg: { key: 'L1' }, params: {}, confidence: 1, reason: 'a' },
      { kind: 'act', leg: { key: 'L1' }, params: {}, confidence: 1, reason: 'b' },
      { kind: 'done', answer: 'final', params: {}, confidence: 1, reason: 'done' },
    ];
    let toolCalls = 0;
    const res = await agentLoop('g', {
      palette: async () => [{ key: 'L1' }],
      callBrain: async () => decisions[i++],
      runTool: async () => { toolCalls++; return { ok: true, value: `v${toolCalls}` }; },
    }, { maxSteps: 3 });
    assert.equal(res.status, 'done');
    assert.equal(res.answer, 'final');
    assert.equal(toolCalls, 2);        // steps 1,2 executed; step 3 was 'done' (terminal)
    assert.equal(res.ledger.length, 2);
    assert.equal(res.scope.L1, 'v2');  // last read value keyed by its producing leg (HS-2)
  });

  it('ledger entries carry the decision params (v2.74.1113 — the brain must see WHAT it did, not just that it acted)', async () => {
    let i = 0;
    const decisions = [
      { kind: 'act', leg: { key: 'OPEN_URL' }, params: { url: 'https://pixabay.com' }, confidence: 1, reason: 'go' },
      { kind: 'done', answer: 'there', confidence: 1, reason: 'arrived' },
    ];
    const res = await agentLoop('go to pixabay', {
      palette: async () => [{ key: 'OPEN_URL' }],
      callBrain: async () => decisions[i++],
      runTool: async () => ({ ok: true }),
    }, { maxSteps: 2 });
    assert.deepEqual(res.ledger[0].params, { url: 'https://pixabay.com' });   // the url is in the ledger now
  });

  it('done is gate-confirmed: verifyDone=false rejects it and the loop keeps going (#2)', async () => {
    let calls = 0;
    const res = await agentLoop('g', {
      callBrain: async () => { calls++; return calls === 1 ? { kind: 'done', answer: 'x', reason: 'd', confidence: 1 } : { kind: 'needs', needs: { kind: 'clarify' }, reason: 'n', confidence: 0 }; },
      verifyDone: () => false,
    }, { maxSteps: 3 });
    assert.equal(res.status, 'needs');   // the rejected done forced another iteration → needs
    assert.equal(calls, 2);
    assert.equal(res.ledger.length, 1);  // the rejected done was ledgered
  });

  it('explicit obs.scope deltas merge into scope (HS-2)', async () => {
    let i = 0;
    const decisions = [{ kind: 'act', leg: { key: 'L1' }, reason: 'a', confidence: 1 }, { kind: 'done', answer: 'ok', reason: 'd', confidence: 1 }];
    const res = await agentLoop('g', {
      palette: async () => [{ key: 'L1' }],
      callBrain: async () => decisions[i++],
      runTool: async () => ({ ok: true, scope: { foo: 'bar' } }),
    }, { maxSteps: 2 });
    assert.equal(res.scope.foo, 'bar');
  });

  it('budget exhaustion → exhausted before the first think', async () => {
    let called = false;
    const res = await agentLoop('g', { callBrain: async () => { called = true; return { kind: 'done' }; } }, { maxSteps: 3, budget: { remaining: () => 0 } });
    assert.equal(res.status, 'exhausted'); assert.equal(res.reason, 'budget'); assert.equal(called, false);
  });

  it('abort signal → aborted', async () => {
    const res = await agentLoop('g', { callBrain: async () => ({ kind: 'done' }), isAborted: () => true }, { maxSteps: 2 });
    assert.equal(res.status, 'aborted');
  });

  it('a brain that throws/returns garbage → needs(clarify, brain-failed), never throws', async () => {
    const res = await agentLoop('g', { callBrain: async () => { throw new Error('boom'); } }, { maxSteps: 2 });
    assert.equal(res.status, 'needs'); assert.equal(res.decision.reason, 'brain-failed');
  });
});
