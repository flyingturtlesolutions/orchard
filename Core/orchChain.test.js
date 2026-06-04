// Core/orchChain.test.js — ORCH-X front-end unit tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decomposeAsk, isCompoundAsk, assembleSequentialPlan, looksComplex, buildCompositeCapability, liftControlFlow, deriveCompositeSignature, deriveCompositeIntent, liftConditional } from './orchChain.js';
import { validatePlan } from './orchPlan.js';

describe('orchChain — decompose a compound ask + assemble a sequential plan (ORCH-X)', () => {
  it('decomposeAsk: a single intent stays one clause', () => {
    const c = decomposeAsk('search for music');
    assert.equal(c.length, 1);
    assert.equal(c[0].text, 'search for music');
    assert.equal(c[0].connective, null);
  });

  it('decomposeAsk: "search for x and filter by y" → two clauses (the bug)', () => {
    const c = decomposeAsk('search for music and filter by date');
    assert.deepEqual(c.map((x) => x.text), ['search for music', 'filter by date']);
    assert.equal(c[1].connective, 'and');
  });

  it('decomposeAsk: a value-joining "and" does NOT split ("cats and dogs")', () => {
    assert.deepEqual(decomposeAsk('search for cats and dogs').map((x) => x.text), ['search for cats and dogs']);
    assert.deepEqual(decomposeAsk('add milk and eggs to the cart').map((x) => x.text), ['add milk and eggs to the cart']);
  });

  it('decomposeAsk: "then" and commas are boundaries when a verb follows', () => {
    assert.deepEqual(decomposeAsk('open settings then enable dark mode').map((x) => x.text), ['open settings', 'enable dark mode']);
    assert.deepEqual(
      decomposeAsk('search for music, filter by date and sort by price').map((x) => x.text),
      ['search for music', 'filter by date', 'sort by price'],
    );
  });

  it('decomposeAsk: a connective left by a comma split is stripped from the clause text', () => {
    // "…, then sort" — the comma is the delimiter, so "then" leads the segment; the clause text must be bare.
    assert.deepEqual(decomposeAsk('find music, then sort by date').map((x) => x.text), ['find music', 'sort by date']);
  });

  it('decomposeAsk: a read clause can be chained after a do clause (observations live in chains)', () => {
    const c = decomposeAsk('search for gifs and how many results are there');
    assert.deepEqual(c.map((x) => x.text), ['search for gifs', 'how many results are there']);
  });

  it('isCompoundAsk: reflects clause count', () => {
    assert.equal(isCompoundAsk('search for music'), false);
    assert.equal(isCompoundAsk('search for music and filter by date'), true);
  });

  it('looksComplex: a long single sentence with a constraint signal → worth an LLM plan; short asks aren’t', () => {
    assert.equal(looksComplex('search for jobs'), false, 'short → single match');
    assert.equal(looksComplex('search for software engineers'), false, 'short → single match');
    assert.equal(looksComplex('search for software engineering jobs in minneapolis posted in the last 7 days'), true);
    assert.equal(looksComplex('find remote python developer roles sorted by newest'), true);
    assert.equal(looksComplex('search for remote software jobs $90000+'), true, 'short but a salary + work-type constraint');
    assert.equal(looksComplex('show me cheap flights under $200'), true, 'short but a price constraint');
  });

  it('assembleSequentialPlan: matched clauses → ordered fragment steps, validated', () => {
    const { plan, valid, gaps } = assembleSequentialPlan([
      { text: 'search for music', capabilityId: 'cap_search', bindings: { CATEGORY: 'Music' } },
      { text: 'filter by date', capabilityId: 'cap_filter', bindings: { WHEN: 'Last 3 days' } },
    ], { goal: 'search + filter' });
    assert.equal(valid, true, plan && JSON.stringify(plan));
    assert.equal(plan.steps.length, 2);
    assert.deepEqual(plan.steps.map((s) => s.kind), ['fragment', 'fragment']);
    assert.equal(plan.steps[0].capabilityId, 'cap_search');
    assert.deepEqual(plan.steps[1].bindings, { WHEN: 'Last 3 days' });
    assert.equal(gaps.length, 0);
  });

  it('assembleSequentialPlan: an unmatched clause becomes a GAP (record just that one), not a failure', () => {
    const { plan, gaps } = assembleSequentialPlan([
      { text: 'search for music', capabilityId: 'cap_search' },
      { text: 'filter by date', capabilityId: null },
    ]);
    assert.equal(plan.steps.length, 1, 'only the matched clause is a step');
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].text, 'filter by date');
    assert.equal(gaps[0].index, 1);
  });

  it('buildCompositeCapability: a verified compound → a durable T2 artifact riding the matcher rails', () => {
    const cap = buildCompositeCapability({
      id: 'cmp1', ask: 'search support jobs in minneapolis and tell me the first title', groundId: 'gnd_x',
      steps: [
        { capabilityId: 'cap_search', bindings: { KEYWORD: 'support', LOCATION: 'minneapolis' }, kind: null, clause: 'search support jobs in minneapolis', intent: 'Search jobs' },
        { capabilityId: 'obs_title', bindings: {}, kind: 'observation', clause: 'tell me the first title', intent: "what's the first title" },
      ],
    });
    assert.equal(cap.kind, 'composite');
    assert.equal(cap.effect, 'composite');
    assert.equal(cap.reversible, false, 'may contain an irreversible action → confirm-first');
    assert.equal(cap.groundId, 'gnd_x');
    assert.equal(cap.steps.length, 2);
    assert.equal(cap.steps[0].capabilityId, 'cap_search');
    assert.deepEqual(cap.steps[0].bindings, { KEYWORD: 'support', LOCATION: 'minneapolis' });
    assert.equal(cap.steps[1].kind, 'observation', 'the read step keeps its kind for the runner');
  });

  it('buildCompositeCapability: steps without a capabilityId are dropped', () => {
    const cap = buildCompositeCapability({ ask: 'x and y', groundId: 'g', steps: [{ capabilityId: 'a' }, { clause: 'gap' }, { capabilityId: 'b' }] });
    assert.deepEqual(cap.steps.map((s) => s.capabilityId), ['a', 'b']);
  });

  // ── T2 intent derivation (a control-flow composite's identity) ───────────────────────────────────────────────
  const _cfFlat = () => [
    { capabilityId: 'cap-search', intent: 'Search jobs by title and location', bindings: { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'nurse', EDIT_LOCATION: 'minneapolis' }, clause: 'search nurse jobs' },
    { capabilityId: 'obs-jobs', intent: 'the list of jobs', kind: 'observation', outputType: 'list', clause: 'each job' },
    { capabilityId: 'obs-salary', intent: 'the salary', kind: 'observation', outputType: 'scalar', clause: 'read the salary' },
  ];
  const _cfAsk = 'search nurse jobs, click each job and read the salary';

  it('deriveCompositeSignature: params = union of fragment bindings (with a sample); output = the collected list', () => {
    const { steps } = liftControlFlow(_cfFlat(), _cfAsk);
    const sig = deriveCompositeSignature(steps);
    assert.deepEqual(sig.params.map((p) => p.name), ['SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY', 'EDIT_LOCATION']);
    assert.equal(sig.params[0].sample, 'nurse', 'a sample argument rides along (it is NOT the identity)');
    assert.deepEqual(sig.output, { name: 'THE_SALARY', type: 'list' }, 'the foreach collect names the list output');
  });

  it('deriveCompositeIntent: a param-ABSTRACTED phrase (composition under the quantifier, no arguments baked in)', () => {
    const { steps } = liftControlFlow(_cfFlat(), _cfAsk);
    const intent = deriveCompositeIntent(steps, _cfAsk);
    assert.match(intent, /Search jobs by title and location/, 'the head action intent');
    assert.match(intent, /the salary/, 'the per-item read');
    assert.match(intent, /for each result/, 'the collection quantifier');
    assert.ok(!/nurse|minneapolis/i.test(intent), 'arguments are NOT in the intent — it generalizes across them');
  });

  it('buildCompositeCapability: a CONTROL-FLOW plan → a quantified T2 artifact (IR intact + derived signature/intent)', () => {
    const { steps } = liftControlFlow(_cfFlat(), _cfAsk);
    const cap = buildCompositeCapability({ id: 'cf1', ask: _cfAsk, groundId: 'g', plan: { steps } });
    assert.equal(cap.kind, 'composite');
    assert.equal(cap.controlFlow, true);
    // the IR survives the round-trip so replay runs through the interpreter
    const fe = cap.steps.find((s) => s.kind === 'foreach');
    assert.ok(fe, 'the foreach node is preserved in the stored steps');
    assert.ok(fe.body.some((b) => b.kind === 'wait'), 'the settle node survives');
    assert.ok(fe.body.some((b) => b.kind === 'observe' && b.fixed), 'the fixed re-read survives');
    // the derived, generalized identity
    assert.deepEqual(cap.params, ['SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY', 'EDIT_LOCATION']);
    assert.deepEqual(cap.output, { name: 'THE_SALARY', type: 'list' });
    assert.match(cap.intent, /for each result/);
    assert.ok(!/nurse/i.test(cap.intent), 'the intent is param-abstracted, not the raw ask');
    assert.deepEqual(validatePlan({ steps: cap.steps }).errors, [], 'the stored IR re-validates as a runnable plan');
  });

  it('buildCompositeCapability: the FLAT (legacy) path is unchanged — intent = ask, flat refs, controlFlow false', () => {
    const cap = buildCompositeCapability({ id: 'f1', ask: 'search x and the first title', groundId: 'g', steps: [
      { capabilityId: 'a', bindings: { K: 'x' }, kind: null, clause: 'search x', intent: 'Search' },
      { capabilityId: 'b', bindings: {}, kind: 'observation', clause: 'the first title', intent: 'the first title' },
    ] });
    assert.equal(cap.controlFlow, false);
    assert.equal(cap.intent, 'search x and the first title', 'a flat composite intent is the ask (legacy behavior)');
    assert.equal(cap.steps.length, 2);
    assert.deepEqual(cap.params, []);
  });

  it('liftControlFlow: "the salaries of EACH job" → a foreach over the list, body = the trailing read; it validates', () => {
    const flat = [
      { capabilityId: 'cap-search', intent: 'search jobs', kind: null, clause: 'search recent jobs in japan' },
      { capabilityId: 'obs-jobs', intent: 'the job list', kind: 'observation', outputType: 'list', clause: 'each job' },
      { capabilityId: 'obs-salary', intent: 'the salary', kind: 'observation', outputType: 'scalar', clause: 'the salaries of each' },
    ];
    const { steps, lifted, collect } = liftControlFlow(flat, 'search recent jobs in japan, the salaries of each job');
    assert.equal(lifted, true);
    assert.equal(steps.length, 3);                                  // search(fragment) · jobs(observe list) · foreach
    assert.equal(steps[0].kind, 'fragment');
    assert.equal(steps[1].kind, 'observe');
    assert.equal(steps[2].kind, 'foreach');
    assert.equal(steps[2].over, steps[1].id, 'the foreach iterates the list observe');
    assert.equal(steps[2].body.length, 1);
    assert.equal(steps[2].body[0].kind, 'observe', 'the per-item salary read is the body');
    assert.equal(collect, 'THE_SALARY');
    assert.deepEqual(validatePlan({ steps }).errors, [], 'the lifted plan is well-formed');
  });

  it('liftControlFlow: "click EACH job and read the salary" → foreach { clickItem, WAIT settle, observe(fixed) }', () => {
    const flat = [
      { capabilityId: 'cap-search', intent: 'search jobs', kind: null, clause: 'search nurse jobs' },
      { capabilityId: 'obs-jobs', intent: 'the job list', kind: 'observation', outputType: 'list', clause: 'each job' },
      { capabilityId: 'obs-salary', intent: 'the salary', kind: 'observation', outputType: 'scalar', clause: 'read the salary' },
    ];
    const { steps, lifted, clickEach } = liftControlFlow(flat, 'search nurse jobs, click each job and read the salary');
    assert.equal(lifted, true);
    assert.equal(clickEach, true);
    const fe = steps[2];
    assert.equal(fe.kind, 'foreach');
    assert.equal(fe.body.length, 3, 'click → SETTLE → read');
    assert.equal(fe.body[0].clickItem, true, 'the per-item click comes first');
    assert.equal(fe.body[1].kind, 'wait', 'a settle node paces the live page between the click and the read');
    assert.ok(fe.body[1].ms > 0, 'the settle has a non-zero floor');
    assert.equal(fe.body[2].kind, 'observe');
    assert.equal(fe.body[2].fixed, true, 'the click-then-read is a FIXED panel re-read (single selector, not the frozen archetype index)');
    assert.notEqual(fe.body[2].positional, true, 'a fixed re-read is NOT positional');
    assert.deepEqual(validatePlan({ steps }).errors, [], 'the click-each plan (with the wait node) is well-formed');
  });

  it('liftControlFlow: read-collection (no click) marks the body read POSITIONAL', () => {
    const flat = [
      { capabilityId: 'obs-jobs', kind: 'observation', outputType: 'list', clause: 'each job' },
      { capabilityId: 'obs-title', kind: 'observation', outputType: 'scalar', clause: 'the title of each' },
    ];
    const { steps } = liftControlFlow(flat, 'the title of each job');
    assert.equal(steps[1].body[0].positional, true, 'no click → the per-item read is positional (Nth item)');
  });

  it('liftControlFlow: no quantifier, or no list step → returned FLAT (unchanged)', () => {
    const flat = [
      { capabilityId: 'a', kind: null, clause: 'search' },
      { capabilityId: 'b', kind: 'observation', outputType: 'list', clause: 'the jobs' },
      { capabilityId: 'c', kind: 'observation', outputType: 'scalar', clause: 'the first salary' },
    ];
    assert.equal(liftControlFlow(flat, 'search jobs and the first salary').lifted, false, 'no quantifier → flat');
    const noList = [
      { capabilityId: 'a', kind: null, clause: 'search' },
      { capabilityId: 'b', kind: 'observation', outputType: 'scalar', clause: 'the title of each' },
    ];
    assert.equal(liftControlFlow(noList, 'search and the title of each').lifted, false, 'no list-output step → flat');
  });

  // ── ORCH-A: conditional lift (predicate → gate) ──────────────────────────────────────────────────────────────
  it('liftConditional: "if there are any remote jobs, save the search" → observe → analyze(exists) → gate{action}', () => {
    const flat = [
      { capabilityId: 'obs-remote', intent: 'remote jobs', kind: 'observation', outputType: 'list', clause: 'any remote jobs' },
      { capabilityId: 'cap-save', intent: 'save the search', kind: null, clause: 'save the search' },
    ];
    const { steps, lifted, predicate } = liftConditional(flat, 'if there are any remote jobs, save the search');
    assert.equal(lifted, true);
    assert.equal(predicate.op, 'exists');
    assert.equal(steps.length, 3);
    assert.equal(steps[0].kind, 'observe');
    assert.equal(steps[1].kind, 'analyze');
    assert.equal(steps[1].over, steps[0].id, 'the analysis reads the condition observation');
    assert.equal(steps[1].outputType, 'predicate');
    assert.deepEqual(steps[1].predicate, predicate);
    assert.equal(steps[2].kind, 'gate');
    assert.equal(steps[2].over, steps[1].id, 'the gate is driven by the predicate analysis');
    assert.equal(steps[2].body[0].intent, 'save the search', 'the consequent action is the gated body');
    assert.deepEqual(validatePlan({ steps }).errors, [], 'the conditional plan is well-formed (predicate → gate)');
  });

  it('liftConditional: "unless" negates the predicate; the observation is hoisted ahead of the action', () => {
    const flat = [
      { capabilityId: 'cap-apply', intent: 'apply to the job', kind: null, clause: 'apply' },
      { capabilityId: 'obs-taken', intent: 'taken label', kind: 'observation', outputType: 'count', clause: 'it is taken' },
    ];
    const { steps, lifted, predicate } = liftConditional(flat, 'apply unless it is taken');
    assert.equal(lifted, true);
    assert.equal(predicate.negate, true, 'unless negates the predicate');
    assert.equal(steps[0].kind, 'observe', 'the condition observe is hoisted to the front');
    assert.equal(steps[2].kind, 'gate');
    assert.equal(steps[2].body[0].intent, 'apply to the job');
    assert.deepEqual(validatePlan({ steps }).errors, []);
  });

  it('liftConditional: a threshold condition keeps the observation scalar (parses the value at runtime)', () => {
    const flat = [
      { capabilityId: 'obs-top', intent: 'the top salary', kind: 'observation', outputType: 'scalar', clause: 'the top result' },
      { capabilityId: 'cap-skip', intent: 'skip it', kind: null, clause: 'skip' },
    ];
    const { steps, predicate } = liftConditional(flat, 'if the top result is under $40k, skip it');
    assert.equal(predicate.op, 'lt');
    assert.equal(predicate.value, 40000);
    assert.equal(steps[0].outputType, 'scalar', 'a threshold reads the scalar value, not a count');
  });

  it('liftConditional: a GUARDED SEQUENCE runs the leading action UNGATED, then gates only what follows the condition', () => {
    const flat = [
      { capabilityId: 'cap-search', intent: 'Search jobs by title and location', kind: null, clause: 'search for jobs' },
      { capabilityId: 'obs-jobs', intent: 'the list of jobs', kind: 'observation', outputType: 'list', clause: 'if there are any jobs' },
      { capabilityId: 'cap-sort', intent: 'Sort by date', kind: null, clause: 'sort by date' },
    ];
    const { steps, lifted } = liftConditional(flat, 'search for jobs and if there are any jobs, sort by date');
    assert.equal(lifted, true);
    assert.equal(steps.length, 5, 'search(head) · SETTLE · observe · analyze · gate');
    assert.equal(steps[0].kind, 'fragment');
    assert.equal(steps[0].capabilityId, 'cap-search', 'the leading search runs UNCONDITIONALLY (not gated)');
    assert.equal(steps[1].kind, 'wait', 'a settle between the navigating search and the condition read');
    assert.ok(steps[1].ms > 0, 'the settle has a non-zero floor');
    assert.equal(steps[2].kind, 'observe');
    assert.equal(steps[3].kind, 'analyze');
    assert.equal(steps[4].kind, 'gate');
    assert.equal(steps[4].body.length, 1, 'ONLY the sort is gated');
    assert.equal(steps[4].body[0].capabilityId, 'cap-sort');
    assert.deepEqual(validatePlan({ steps }).errors, [], 'the guarded-sequence plan is well-formed');
  });

  it('liftConditional: no conditional keyword, or no observation/action → returned FLAT', () => {
    const noKw = [
      { capabilityId: 'a', kind: null, clause: 'search' },
      { capabilityId: 'b', kind: 'observation', outputType: 'list', clause: 'the jobs' },
    ];
    assert.equal(liftConditional(noKw, 'search jobs and list them').lifted, false, 'no if/when/unless → flat');
    const noObs = [
      { capabilityId: 'a', kind: null, clause: 'save' },
      { capabilityId: 'b', kind: null, clause: 'apply' },
    ];
    assert.equal(liftConditional(noObs, 'if it works, save and apply').lifted, false, 'no observation to test → flat');
  });
});
