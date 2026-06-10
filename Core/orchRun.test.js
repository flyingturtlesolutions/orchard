// Core/orchRun.test.js — ORCH-L pure plan-interpreter tests (node --test). PURE (mock exec, no DOM).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { walkPlan, gatePasses } from './orchRun.js';
import { planStep } from './orchPlan.js';
import { evaluatePredicate } from './orchAnalyze.js';

// A mock executor that records calls and returns canned results keyed by step id (or a per-scope function).
function mockExec({ fragment, observe, analyze, wait } = {}) {
  const calls = [];
  return {
    calls,
    fragment: async (s, sc) => { calls.push({ kind: 'fragment', id: s.id, index: sc.index }); return fragment ? fragment(s, sc) : { ok: true }; },
    observe: async (s, sc) => { calls.push({ kind: 'observe', id: s.id, index: sc.index }); return observe ? observe(s, sc) : { ok: true, value: null }; },
    wait: async (s, sc) => { calls.push({ kind: 'wait', id: s.id, ms: s.ms, index: sc.index }); if (wait) return wait(s, sc); },
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

  it('a WAIT node delegates to exec.wait, paces between click and read, and never fails the plan', async () => {
    // click-in-place shape: per item → click → SETTLE → fixed re-read. The wait sits between the action and read.
    const plan = { steps: [
      planStep.observe('jobs', { outputType: 'list' }),
      planStep.foreach('each', 'jobs', [
        planStep.fragment('click', null, { clickItem: true }),
        planStep.wait('settle', { ms: 900 }),
        planStep.observe('salary', { outputType: 'scalar', fixed: true }),
      ], { collect: 'SALARIES' }),
    ] };
    // Even if exec.wait THROWS (a slow/aborted settle), the plan completes — a settle is advisory.
    const exec = mockExec({
      observe: (s, sc) => s.id === 'jobs' ? { ok: true, items: ['a', 'b'] } : { ok: true, value: `S${sc.index}` },
      wait: () => { throw new Error('settle interrupted'); },
    });
    const r = await walkPlan(plan, exec);
    assert.equal(r.ok, true, 'a thrown settle is swallowed — the plan still completes');
    assert.deepEqual(r.outputs.SALARIES, ['S0', 'S1']);
    // the wait ran once per item, IN ORDER: click → wait → salary
    const ids = exec.calls.map((c) => c.id);
    assert.equal(exec.calls.filter((c) => c.kind === 'wait').length, 2, 'settle once per item');
    assert.ok(ids.indexOf('click') < ids.indexOf('settle') && ids.indexOf('settle') < ids.indexOf('salary'), 'click → settle → read order');
    assert.ok(r.trace.some((t) => t.kind === 'wait' && t.ms === 900), 'the wait is traced with its ms');
  });

  it('PREDICATE → GATE end-to-end: the analysis opens the gate only when the condition holds (ORCH-A §6)', async () => {
    // observe(condition list) → analyze(exists) → gate{ action } — the canonical "if there are any X, do Y".
    const plan = { steps: [
      planStep.observe('cond', { outputType: 'list' }),
      planStep.analyze('pred', 'cond', 'predicate', { predicate: { op: 'exists' } }),
      planStep.gate('g', 'pred', [planStep.fragment('act', 'cap-save')]),
    ] };
    const mk = (items) => {
      const m = mockExec({ observe: () => ({ ok: true, items }) });
      m.analyze = async (s, over) => { m.calls.push({ kind: 'analyze', id: s.id }); return { ok: true, value: evaluatePredicate(s.predicate, { value: over && over.value, items: over && over.items }) }; };
      return m;
    };
    const open = mk(['j0', 'j1']);                              // condition holds → gate opens → action runs
    const ro = await walkPlan(plan, open);
    assert.equal(ro.ok, true);
    assert.equal(open.calls.some((c) => c.id === 'act'), true, 'predicate true → gate open → action runs');

    const closed = mk([]);                                      // empty → gate closed → action skipped (NOT a failure)
    const rc = await walkPlan(plan, closed);
    assert.equal(rc.ok, true, 'a closed gate is a skip, not a failure');
    assert.equal(closed.calls.some((c) => c.id === 'act'), false, 'predicate false → gate closed → action skipped');
    assert.ok(rc.trace.some((t) => t.kind === 'gate' && t.pass === false), 'the gate decision is traced');
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

describe('orchRun — foreach/loop SAFETY BUDGET (v2.74.915)', () => {
  // The 22:58 runaway: a foreach replayed a 5-tab-opening fragment body 13× with no bound and no human
  // in front of it. The interpreter now (1) hard-caps iterations and (2) asks exec.confirmLoop before a
  // body with engine actions runs more than confirmAbove times.
  const bigForeach = (n) => ({ steps: [
    planStep.observe('rows', { outputType: 'list' }),
    planStep.foreach('each', 'rows', [planStep.fragment('open', 'cap-open')]),
  ] });

  it('hard-caps a foreach at maxIterations and records the cap in the trace', async () => {
    const exec = mockExec({ observe: () => ({ ok: true, items: Array.from({ length: 30 }, (_, i) => `r${i}`) }) });
    const env = await walkPlan(bigForeach(30), exec, { maxIterations: 10, confirmAbove: 99 });
    assert.equal(env.ok, true);
    const opens = exec.calls.filter((c) => c.kind === 'fragment').length;
    assert.equal(opens, 10, 'only the capped count ran');
    const fe = env.trace.find((t) => t.kind === 'foreach');
    assert.equal(fe.capped, 20, 'trace records what was cut');
    assert.equal(fe.items, 30, 'trace still reports the full driver size');
  });

  it('asks confirmLoop before a big acting loop; DECLINE aborts with zero iterations run', async () => {
    let asked = null;
    const exec = mockExec({ observe: () => ({ ok: true, items: Array.from({ length: 13 }, (_, i) => i) }) });
    exec.confirmLoop = async (q) => { asked = q; return { ok: false }; };
    const env = await walkPlan(bigForeach(13), exec, {});
    assert.equal(env.ok, false);
    assert.match(env.error, /declined/);
    assert.equal(asked.iterations, 13, 'the confirm names the real count');
    assert.equal(exec.calls.filter((c) => c.kind === 'fragment').length, 0, 'nothing ran before the decline');
  });

  it('confirmLoop ACCEPT runs the loop; a small loop never asks; a read-only body never asks', async () => {
    let asks = 0;
    const items = (n) => ({ ok: true, items: Array.from({ length: n }, (_, i) => i) });
    // accept path
    const e1 = mockExec({ observe: () => items(12) });
    e1.confirmLoop = async () => { asks++; return { ok: true }; };
    const r1 = await walkPlan(bigForeach(12), e1, {});
    assert.equal(r1.ok, true);
    assert.equal(e1.calls.filter((c) => c.kind === 'fragment').length, 12);
    // small loop — under confirmAbove (8) → no ask
    const e2 = mockExec({ observe: () => items(5) });
    e2.confirmLoop = async () => { asks++; return { ok: true }; };
    await walkPlan(bigForeach(5), e2, {});
    // read-only body (observe, no fragment) → no ask however big
    const e3 = mockExec({ observe: (s) => s.id === 'rows' ? items(20) : { ok: true, value: 'x' } });
    e3.confirmLoop = async () => { asks++; return { ok: true }; };
    const readPlan = { steps: [
      planStep.observe('rows', { outputType: 'list' }),
      planStep.foreach('each', 'rows', [planStep.observe('val', { outputType: 'scalar' })], { collect: 'VALS' }),
    ] };
    const r3 = await walkPlan(readPlan, e3, {});
    assert.equal(r3.ok, true);
    assert.equal(asks, 1, 'only the 12× acting loop asked');
  });

  it('a missing confirmLoop hook proceeds (headless replay) — cap still applies', async () => {
    const exec = mockExec({ observe: () => ({ ok: true, items: Array.from({ length: 40 }, (_, i) => i) }) });
    const env = await walkPlan(bigForeach(40), exec, {});
    assert.equal(env.ok, true);
    assert.equal(exec.calls.filter((c) => c.kind === 'fragment').length, 25, 'default maxIterations=25');
  });

  it('LOOP (count driver) gets the same cap', async () => {
    const plan = { steps: [
      planStep.observe('n', { outputType: 'count' }),
      planStep.loop('rep', 'n', [planStep.fragment('act', 'cap-act')]),
    ] };
    const exec = mockExec({ observe: () => ({ ok: true, value: 100 }) });
    const env = await walkPlan(plan, exec, { maxIterations: 7, confirmAbove: 99 });
    assert.equal(env.ok, true);
    assert.equal(exec.calls.filter((c) => c.kind === 'fragment').length, 7);
    const lp = env.trace.find((t) => t.kind === 'loop');
    assert.equal(lp.capped, 93);
  });
});

describe('walkPlan — abort propagates OUT of loops (CR-S2, v2.74.918)', () => {
  // The live 22:58-class failure: a user STOP inside a foreach was consumed as ONE item's lenient skip and
  // the remaining N-1 iterations ran anyway. An `aborted:true` exec result must end the WHOLE plan.
  const openEachPlan = (n) => ({ steps: [
    planStep.observe('rows', { outputType: 'list' }),
    planStep.foreach('each', 'rows', [planStep.fragment('open', 'cap-open')], { collect: 'OUT' }),
  ] });

  it('an aborted fragment ends the foreach immediately, keeping partials', async () => {
    let runs = 0;
    const exec = mockExec({
      observe: () => ({ ok: true, items: Array.from({ length: 5 }, (_, i) => `r${i}`) }),
      fragment: () => { runs++; return runs >= 2 ? { ok: false, aborted: true, error: 'stopped by user' } : { ok: true }; },
    });
    const env = await walkPlan(openEachPlan(5), exec, {});
    assert.equal(env.ok, false);
    assert.equal(env.aborted, true, 'walkPlan surfaces aborted');
    assert.equal(runs, 2, 'no further iterations after the abort');
    const fe = env.trace.find((t) => t.kind === 'foreach');
    assert.equal(fe.aborted, true);
    assert.equal(fe.done, 1, 'one iteration completed before the stop');
    assert.ok(!('skipped' in fe) || fe.skipped === 0, `abort is not a lenient skip (got skipped=${fe.skipped})`);
  });

  it('a plain per-item failure still lenient-skips (regression: leniency unchanged)', async () => {
    let runs = 0;
    const exec = mockExec({
      observe: () => ({ ok: true, items: ['a', 'b', 'c'] }),
      fragment: () => { runs++; return runs === 2 ? { ok: false, error: 'flaky item' } : { ok: true }; },
    });
    const env = await walkPlan(openEachPlan(3), exec, {});
    assert.equal(env.ok, true);
    assert.equal(env.aborted, false);
    assert.equal(runs, 3, 'all iterations attempted');
    const fe = env.trace.find((t) => t.kind === 'foreach');
    assert.equal(fe.done, 2);
    assert.equal(fe.skipped, 1);
  });

  it('an aborted observe in a sequence surfaces aborted on the env', async () => {
    const exec = mockExec({ observe: () => ({ ok: false, aborted: true, error: 'stopped by user' }) });
    const env = await walkPlan({ steps: [planStep.observe('r1', { outputType: 'scalar' })] }, exec, {});
    assert.equal(env.ok, false);
    assert.equal(env.aborted, true);
  });
});
