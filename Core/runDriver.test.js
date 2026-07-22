// Core/runDriver.test.js — CD-1a: the extracted chain loop (DESIGN_cadence.md §2.2/§11.2). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runWorkflow, normalizeReporter, makeAccumulatorReporter, makeResumeReporter, DRIVER_VERDICTS } from './runDriver.js';

// A recording reporter — proves the loop calls the contract in order.
function recorder() {
  const calls = [];
  return {
    calls,
    step: (i, total, text) => calls.push(['step', i, total, text]),
    progress: (t) => calls.push(['progress', t]),
    result: (p) => calls.push(['result', p]),
    gate: async (preview) => { calls.push(['gate', preview]); return 'park'; },
    done: (v) => calls.push(['done', v]),
  };
}

const okStep = async (clause) => ({ ok: true, value: `did:${clause.text}` });

describe('runDriver — the happy path', () => {
  it('walks every clause, reports step + result, and finishes complete', async () => {
    const rep = recorder();
    const out = await runWorkflow({ clauses: [{ text: 'a' }, { text: 'b' }], reporter: rep, runStep: okStep });
    assert.equal(out.verdict, 'complete');
    assert.equal(out.ranSteps, 2);
    assert.deepEqual(rep.calls[0], ['step', 0, 2, 'a']);
    assert.deepEqual(rep.calls.at(-1), ['done', 'complete']);
    assert.ok(rep.calls.some((c) => c[0] === 'result' && c[1] === 'did:a'));
  });
  it('empty clauses → empty; no runStep → failed', async () => {
    assert.equal((await runWorkflow({ clauses: [], reporter: recorder(), runStep: okStep })).verdict, 'empty');
    assert.equal((await runWorkflow({ clauses: [{ text: 'a' }], reporter: recorder() })).verdict, 'failed');
  });
});

describe('runDriver — failure handling', () => {
  it('a soft-failed step continues the chain (partial when others ran)', async () => {
    const runStep = async (c) => (c.text === 'b' ? { ok: false, error: 'flaky' } : { ok: true, value: c.text });
    const out = await runWorkflow({ clauses: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], reporter: recorder(), runStep });
    assert.equal(out.verdict, 'partial');
    assert.equal(out.ranSteps, 2);
    assert.equal(out.failedSteps, 1);
  });
  it('a hard stop ends the run immediately', async () => {
    const runStep = async (c) => (c.text === 'b' ? { ok: false, stop: true, error: 'auth' } : { ok: true, value: c.text });
    const out = await runWorkflow({ clauses: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], reporter: recorder(), runStep });
    assert.equal(out.verdict, 'partial');   // a ran, then hard-stopped
    assert.equal(out.ranSteps, 1);
  });
  it('a runStep that throws is caught as a failed step, never crashes the loop', async () => {
    const runStep = async (c) => { if (c.text === 'b') throw new Error('boom'); return { ok: true, value: c.text }; };
    const out = await runWorkflow({ clauses: [{ text: 'a' }, { text: 'b' }], reporter: recorder(), runStep });
    assert.equal(out.verdict, 'partial');
    assert.equal(out.failedSteps, 1);
  });
});

describe('runDriver — park / resume (§8)', () => {
  it('a step that parks stops the run at that index, resumable', async () => {
    const rep = recorder();
    const runStep = async (c, ctx) => {
      if (c.text === 'write') { await ctx.reporter.gate({ preview: 'about to write' }); return { park: true, parkedRunId: 'run_p' }; }
      return { ok: true, value: c.text };
    };
    const out = await runWorkflow({ clauses: [{ text: 'read' }, { text: 'write' }, { text: 'after' }], reporter: rep, runStep });
    assert.equal(out.verdict, 'parked');
    assert.equal(out.parkedAt, 1);
    assert.equal(out.parkedRunId, 'run_p');
    assert.deepEqual(rep.calls.at(-1), ['done', 'parked']);
    assert.ok(rep.calls.some((c) => c[0] === 'gate'));
    assert.ok(!rep.calls.some((c) => c[0] === 'step' && c[3] === 'after'), 'never reached the step after the park');
  });
  it('resumes from startIndex with carried state', async () => {
    const seen = [];
    const runStep = async (c, ctx) => { seen.push([c.text, ctx.state.token]); return { ok: true, state: { token: 'kept' } }; };
    const out = await runWorkflow({ clauses: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], reporter: recorder(), runStep, startIndex: 1, state: { token: 'kept' } });
    assert.deepEqual(seen.map((s) => s[0]), ['b', 'c']);   // skipped 'a'
    assert.equal(out.verdict, 'complete');
    assert.equal(out.state.token, 'kept');
  });
});

describe('runDriver — reporter contract', () => {
  it('normalizeReporter fills missing methods and gate defaults to park (nobody watching)', async () => {
    const rep = normalizeReporter(null);
    assert.equal(typeof rep.step, 'function');
    assert.equal(await rep.gate({}), 'park');
    assert.doesNotThrow(() => rep.step(0, 1, 'x'));
  });
  it('a throwing reporter method never changes the verdict', async () => {
    const rep = { step() { throw new Error('render died'); }, done() {} };
    const out = await runWorkflow({ clauses: [{ text: 'a' }], reporter: rep, runStep: okStep });
    assert.equal(out.verdict, 'complete');
  });
  it('a throwing gate defaults to park (fail safe)', async () => {
    const runStep = async (c, ctx) => { const d = await ctx.reporter.gate({}); return d === 'park' ? { park: true } : { ok: true }; };
    const rep = { gate() { throw new Error('gate died'); }, done() {} };
    const out = await runWorkflow({ clauses: [{ text: 'write' }], reporter: rep, runStep });
    assert.equal(out.verdict, 'parked');
  });
  it('makeAccumulatorReporter (SW side) records results, parks on gate, keeps the write preview', async () => {
    const rep = makeAccumulatorReporter();
    const runStep = async (c, ctx) => {
      if (c.text === 'write') { const d = await ctx.reporter.gate({ recipe: 'send email' }); return d === true ? { ok: true } : { park: true }; }
      return { ok: true, value: c.text };
    };
    await runWorkflow({ clauses: [{ text: 'read' }, { text: 'write' }], reporter: rep, runStep });
    const snap = rep.snapshot();
    assert.deepEqual(snap.results, ['read']);
    assert.equal(snap.parked, true);
    assert.equal(snap.verdict, 'parked');
    assert.deepEqual(snap.preview, { recipe: 'send email' });   // §8 — the case shows what it would have written
  });
});

describe('runDriver — makeResumeReporter (§8 / CD-7)', () => {
  // a workflow with a read, then TWO writes; resuming approves the FIRST write and re-parks at the second.
  const runStep = async (c, ctx) => {
    if (/^write/.test(c.text)) { const d = await ctx.reporter.gate({ recipe: c.text }); return d === true ? { ok: true, value: `sent:${c.text}` } : { park: true }; }
    return { ok: true, value: c.text };
  };
  it('approves the first write (the one the human OK’d), re-parks at the next', async () => {
    const rep = makeResumeReporter();
    const out = await runWorkflow({ clauses: [{ text: 'read' }, { text: 'write1' }, { text: 'write2' }], reporter: rep, runStep, startIndex: 1 });
    assert.equal(out.verdict, 'parked');       // stopped again at write2
    assert.equal(out.parkedAt, 2);
    const snap = rep.snapshot();
    assert.equal(snap.approvedWrite, true);
    assert.ok(snap.results.includes('sent:write1'), 'the approved write executed');
    assert.deepEqual(snap.preview, { recipe: 'write2' }, 'the NEXT write needs its own approval');
  });
  it('with a single write, resume runs to completion', async () => {
    const rep = makeResumeReporter();
    const out = await runWorkflow({ clauses: [{ text: 'read' }, { text: 'write1' }], reporter: rep, runStep, startIndex: 1 });
    assert.equal(out.verdict, 'complete');
    assert.equal(rep.snapshot().approvedWrite, true);
  });
});

describe('runDriver — verdict enum', () => {
  it('every verdict the loop returns is in DRIVER_VERDICTS', () => {
    for (const v of ['complete', 'partial', 'failed', 'empty', 'parked']) assert.ok(DRIVER_VERDICTS.includes(v));
  });
});
