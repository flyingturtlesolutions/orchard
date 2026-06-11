// Core/orchVisual.test.js — ORCH-CB visual observation floor (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { describeForCondition, visualToInput, buildVisualObservation, isVisualObservation, renderCriteria, withCriteria, renderPlanLines } from './orchVisual.js';
import { evaluatePredicate } from './orchAnalyze.js';

describe('orchVisual — visual observation floor (ORCH-CB)', () => {
  it('describeForCondition: strips conditional + question/declarative lead-ins, names the bare subject, asks for an integer, excludes decoys', () => {
    const d = describeForCondition('if there are any jobs');
    assert.match(d, /ACTUAL jobs\b/);
    assert.match(d, /single integer/i);
    assert.match(d, /suggested|you might like|no results/i, 'tells the model to treat decoys/empty as zero');
    // the QUESTION form ("are there any X") must strip to the bare subject — NOT "are there any jobs"
    assert.match(describeForCondition('are there any jobs'), /ACTUAL jobs\b/);
    assert.ok(!/are there/i.test(describeForCondition('are there any jobs')), 'the inverted question lead-in is stripped');
    assert.match(describeForCondition('is there a free tier'), /ACTUAL free tier\b/);
    assert.match(describeForCondition('there are any remote results'), /ACTUAL remote results\b/);
  });

  it('visualToInput: a COUNT read parses the number from items[0] — "0" → 0, NOT items.length=1 (the decoy fix)', () => {
    assert.deepEqual(visualToInput({ items: ['0'] }, 'count'), { value: '0', items: ['0'], count: 0 });
    assert.equal(visualToInput({ items: ['6'] }, 'count').count, 6);
    assert.equal(visualToInput({ items: ['No matching jobs'] }, 'predicate').count, 0);
    assert.equal(visualToInput({ items: ['1,234'] }, 'count').count, 1234);
    assert.equal(visualToInput(null, 'count').count, 0);
  });

  it('visualToInput: a LIST read keeps the items, count = their length', () => {
    const r = visualToInput({ items: ['Nurse', 'RN', 'LPN'] }, 'list');
    assert.deepEqual(r.items, ['Nurse', 'RN', 'LPN']);
    assert.equal(r.count, 3);
  });

  it('end-to-end: a visual COUNT of 0 closes an existence gate (the whole point)', () => {
    const input = visualToInput({ items: ['0'] }, 'predicate');                 // the model SAW "no matching jobs"
    assert.equal(evaluatePredicate({ op: 'exists' }, input), false, 'gate CLOSED — zero real results');
    const input2 = visualToInput({ items: ['6'] }, 'predicate');                // the model SAW 6 real results
    assert.equal(evaluatePredicate({ op: 'exists' }, input2), true);
  });

  it('renderCriteria: the upstream search PARAMS become a readable criteria string (labels cleaned, blanks skipped)', () => {
    assert.equal(renderCriteria({ SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'nurse', EDIT_LOCATION: 'minneapolis' }), 'job title keywords or company "nurse", location "minneapolis"');
    assert.equal(renderCriteria({ K: 'x', EMPTY: '' }), 'k "x"', 'blank values are skipped');
    assert.equal(renderCriteria(null), '');
  });

  it('withCriteria: injects the search criteria so the model judges MATCH, not mere presence (the params fix)', () => {
    const base = describeForCondition('there are any jobs');
    const d = withCriteria(base, renderCriteria({ SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'osidndhdnd', EDIT_LOCATION: 'minneapolis' }));
    assert.match(d, /osidndhdnd/, 'the actual search term is in the prompt');
    assert.match(d, /minneapolis/);
    assert.match(d, /does NOT match.*counts as 0/s, 'unrelated suggestions count as 0');
    assert.equal(withCriteria(base, ''), base, 'no criteria → unchanged');
  });

  it('buildVisualObservation / isVisualObservation: a matcher-compatible read record carrying the vision description', () => {
    const cap = buildVisualObservation({ id: 'v1', ask: 'if there are any jobs, sort by date', groundId: 'g', description: describeForCondition('there are any jobs'), outputType: 'count' });
    assert.equal(cap.kind, 'observation');
    assert.equal(cap.effect, 'read');
    assert.equal(cap.reversible, true);
    assert.equal(cap.outputType, 'count');
    assert.equal(cap.observe.visual.mode, 'viewport');
    assert.match(cap.observe.visual.description, /ACTUAL jobs/);
    assert.equal(isVisualObservation(cap), true);
    assert.equal(isVisualObservation({ observe: { extracts: [{ selector: '.x' }] } }), false, 'a DOM observation is not visual');
  });
});

describe('renderPlanLines — the confirm-card plan renderer (CR-D7)', () => {
  it('numbers plain steps and appends bindings', () => {
    const { lines, shown } = renderPlanLines([
      { kind: 'fragment', id: 'a', intent: 'search jobs', bindings: { keyword: 'swe' } },
      { kind: 'fragment', id: 'b', clause: 'open filters' },
    ]);
    assert.equal(shown, 2);
    assert.deepEqual(lines, ['1. search jobs (keyword=swe)', '2. open filters']);
  });

  it('folds the gate condition machinery inline — the observe + analyze are not numbered steps', () => {
    const steps = [
      { kind: 'observe', id: 'o1', intent: 'count results' },
      { kind: 'analyze', id: 'a1', over: 'o1', intent: 'there are any results' },
      { kind: 'gate', id: 'g1', over: 'a1', body: [{ kind: 'fragment', intent: 'open the first one' }] },
    ];
    const { lines, shown } = renderPlanLines(steps);
    assert.equal(shown, 1, 'three IR steps render as ONE user-visible conditional');
    assert.deepEqual(lines, ['1. if there are any results: open the first one']);
  });

  it('foreach renders its body labels, the wait affordance, and the collect suffix', () => {
    const { lines } = renderPlanLines([
      { kind: 'foreach', id: 'each', over: 'rows', collect: 'titles', body: [
        { kind: 'fragment', intent: 'open item' },
        { kind: 'wait', ms: 1500 },
        { kind: 'observe', intent: 'read the title' },
      ] },
    ]);
    assert.deepEqual(lines, ['1. for each item: open item → let it settle (1.5s) → read the title (collect titles)']);
  });

  it('degrades for comprehended steps (no bindings/collect/wait) to the bare numbered lines', () => {
    const { lines, shown } = renderPlanLines([
      { kind: 'fragment', id: 's1', intent: 'search remote jobs' },
      { kind: 'foreach', id: 'f', over: 'x', body: [{ intent: 'open each' }] },
    ]);
    assert.equal(shown, 2);
    assert.deepEqual(lines, ['1. search remote jobs', '2. for each item: open each']);
  });

  it('empty/null steps -> no lines, zero shown', () => {
    assert.deepEqual(renderPlanLines([]), { lines: [], shown: 0 });
    assert.deepEqual(renderPlanLines(null), { lines: [], shown: 0 });
  });
});
