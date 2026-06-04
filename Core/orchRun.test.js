// Core/orchRun.test.js — ORCH-L pure plan-interpreter tests (node --test). PURE (mock exec, no DOM).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { walkPlan, gatePasses } from './orchRun.js';
import { planStep } from './orchPlan.js';

// A mock executor that records calls and returns canned results keyed by step id (or a per-scope function).
function mockExec({ fragment, observe, analyze } = {}) {
  const calls = [];
  return {
    calls,
    fragment: async (s, sc) => { calls.push({ kind: 'fragment', id: s.id, index: sc.index }); return fragment ? fragment(s, sc) : { ok: true }; },
    observe: async (s, sc) => { calls.push({ kind: 'observe', id: s.id, index: sc.index }); return observe ? observe(s, sc) : { ok: true, value: null }; },
    ...(analyze ? { analyze: async (s, over, sc) => { calls.push({ kind: 'analyze', id: s.id }); return analyze(s, over, sc); } } : {}),
  };
}

describe('orchRun — the pure control-flow interpreter (ORCH-L)', () => {
  it('gatePasses: booleans / affirmatives / numbers / arrays', () => {
    assert.equal(gatePasses(true), true);
    assert.equal(gatePasses('yes'), true);
    assert.equal(gatePasses('in stock'), true);
    assert.equal(gatePasses('no'), false);
    assert.equal(gatePasses(''), false);
    assert.equal(gatePasses(null), false);
    assert.equal(gatePasses(0), false);
    assert.equal(gatePasses(3), true);
    assert.equal(gatePasses([]), false);
    assert.equal(gatePasses(['x']), true);
  });

  it('the canonical FOREACH collects a value per item — "the salaries of each job"', async () => {
    const plan = { steps: [
      planStep.fragment('search', 'cap-search'),
      planStep.observe('jobs', { outputType: 'list' }),
      planStep.foreach('each', 'jobs', [
        planStep.fragment('open', 'cap-open'),
        planStep.observe('salary', { outputType: 'scalar' }),
      ], { collect: 'SALARIES' }),
    ] };
    const exec = mockExec({
      observe: (s, sc) => s.id === 'jobs' ? { ok: true, items: ['j0', 'j1', 'j2'] } : { ok: true, value: `$${sc.index}0k` },
    });
    const r = await walkPlan(plan, exec);
    assert.equal(r.ok, true);
    assert.deepEqual(r.outputs.SALARIES, ['$00k', '$10k', '$20k']);
    // body ran once per item: open + salary × 3
    assert.equal(exec.calls.filter((c) => c.id === 'open').length, 3);
    assert.equal(exec.calls.filter((c) => c.id === 'salary').length, 3);
  });

  it('FOREACH is LENIENT — one item failing is skipped, the rest still collect', async () => {
    const plan = { steps: [
      planStep.observe('jobs', { outputType: 'list' }),
      planStep.foreach('each', 'jobs', [planStep.observe('salary', { outputType: 'scalar' })], { collect: 'SALARIES' }),
    ] };
    const exec = mockExec({
      observe: (s, sc) => s.id === 'jobs' ? { ok: true, items: ['a', 'b', 'c'] }
        : (sc.index === 1 ? { ok: false, error: 'no salary on this one' } : { ok: true, value: `S${sc.index}` }),
    });
    const r = await walkPlan(plan, exec);
    assert.equal(r.ok, true, 'a missing item does not abort the loop');
    assert.deepEqual(r.outputs.SALARIES, ['S0', 'S2']);
    const fe = r.trace.find((t) => t.kind === 'foreach');
    assert.equal(fe.done, 2); assert.equal(fe.skipped, 1);
  });

  it('GATE runs its body only when the predicate is truthy (a closed gate is a skip, not a failure)', async () => {
    const mk = (condValue) => ({ steps: [
      planStep.observe('cond', { outputType: 'predicate' }),
      planStep.gate('g', 'cond', [planStep.fragment('f', 'c')]),
    ] });
    const open = mockExec({ observe: () => ({ ok: true, value: true }) });
    const ro = await walkPlan(mk(true), open);
    assert.equal(ro.ok, true);
    assert.equal(open.calls.some((c) => c.id === 'f'), true, 'open gate → body runs');

    const closed = mockExec({ observe: () => ({ ok: true, value: false }) });
    const rc = await walkPlan(mk(false), closed);
    assert.equal(rc.ok, true, 'closed gate is not a failure');
    assert.equal(closed.calls.some((c) => c.id === 'f'), false, 'closed gate → body skipped');
  });

  it('LOOP runs its body `count` times', async () => {
    const plan = { steps: [
      planStep.observe('n', { outputType: 'count' }),
      planStep.loop('l', 'n', [planStep.fragment('tick', 'c')]),
    ] };
    const exec = mockExec({ observe: () => ({ ok: true, value: 3 }) });
    const r = await walkPlan(plan, exec);
    assert.equal(r.ok, true);
    assert.equal(exec.calls.filter((c) => c.id === 'tick').length, 3);
  });

  it('a SEQUENCE aborts on the first failure (later steps do not run)', async () => {
    const plan = { steps: [planStep.fragment('a', 'c'), planStep.fragment('b', 'c'), planStep.fragment('c2', 'c')] };
    const exec = mockExec({ fragment: (s) => s.id === 'b' ? { ok: false, error: 'boom' } : { ok: true } });
    const r = await walkPlan(plan, exec);
    assert.equal(r.ok, false);
    assert.match(r.error, /b/);
    assert.equal(exec.calls.some((c) => c.id === 'c2'), false, 'the step after the failure never runs');
  });
});
