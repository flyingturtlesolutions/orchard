// Core/orchAnalyze.test.js — ORCH-A predicate-analysis unit tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parsePredicate, evaluatePredicate, isConditionalAsk, conditionIsUnless, predicateLabel, PREDICATE_OPS } from './orchAnalyze.js';

describe('orchAnalyze — the pure predicate floor (ORCH-A, predicate → gate)', () => {
  it('parsePredicate: existence is the default conditional subject ("if there ARE jobs")', () => {
    assert.deepEqual(parsePredicate('there are any remote jobs'), { op: 'exists', raw: 'there are any remote jobs' });
    assert.equal(parsePredicate('any results').op, 'exists');
    assert.equal(parsePredicate('jobs in japan').op, 'exists');
  });

  it('parsePredicate: "no/none/zero" → none (the empty check)', () => {
    assert.equal(parsePredicate('no results').op, 'none');
    assert.equal(parsePredicate('there are none').op, 'none');
    assert.equal(parsePredicate('zero matches').op, 'none');
  });

  it('parsePredicate: a numeric threshold → the right comparator + parsed value (money-aware)', () => {
    assert.deepEqual(parsePredicate('under $40k'), { op: 'lt', value: 40000, target: 'value', raw: 'under $40k' });
    assert.deepEqual(parsePredicate('the salary is over $50 an hour'), { op: 'gt', value: 50, target: 'value', raw: 'the salary is over $50 an hour' });
    assert.equal(parsePredicate('up to $230 an hour').op, 'lte');
    assert.equal(parsePredicate('up to $230 an hour').value, 230);
    assert.equal(parsePredicate('$125,000 a year exactly').op, 'eq');
    assert.equal(parsePredicate('$125,000 a year exactly').value, 125000);
  });

  it('parsePredicate: a COUNT threshold ("more than 10 results") targets the count, not the value', () => {
    assert.deepEqual(parsePredicate('more than 10 results'), { op: 'gt', value: 10, target: 'count', raw: 'more than 10 results' });
    assert.equal(parsePredicate('at least 3 jobs').target, 'count');
    assert.equal(parsePredicate('at least 3 jobs').op, 'gte');
    assert.equal(parsePredicate('under $40k').target, 'value', 'currency → a value threshold');
  });

  it('parsePredicate: a term match → contains', () => {
    assert.deepEqual(parsePredicate('it says remote'), { op: 'contains', term: 'remote', raw: 'it says remote' });
    assert.equal(parsePredicate('the listing mentions hybrid').term, 'hybrid');
  });

  it('isConditionalAsk / conditionIsUnless: detect the conditional + the negation form', () => {
    assert.equal(isConditionalAsk('if there are remote jobs, save the search'), true);
    assert.equal(isConditionalAsk('save the search when results load'), true);
    assert.equal(isConditionalAsk('unless it is taken, apply'), true);
    assert.equal(isConditionalAsk('search nurse jobs and read each salary'), false);
    assert.equal(conditionIsUnless('unless it is taken, apply'), true);
    assert.equal(conditionIsUnless('if it is open, apply'), false);
  });

  it('evaluatePredicate: EXISTS / NONE over items, a count, and a value', () => {
    assert.equal(evaluatePredicate({ op: 'exists' }, { items: ['a', 'b'] }), true);
    assert.equal(evaluatePredicate({ op: 'exists' }, { items: [] }), false);
    assert.equal(evaluatePredicate({ op: 'exists' }, { count: 5 }), true);
    assert.equal(evaluatePredicate({ op: 'exists' }, { value: '31 jobs' }), true, 'a count string ("31 jobs") → exists');
    assert.equal(evaluatePredicate({ op: 'none' }, { value: '0' }), true, 'the integer "0" is a zero count');
    assert.equal(evaluatePredicate({ op: 'none' }, { items: [] }), true);
    assert.equal(evaluatePredicate({ op: 'none' }, { items: ['x'] }), false);
  });

  it('evaluatePredicate: a VALUE threshold parses the observed value money-aware (target defaults to value)', () => {
    assert.equal(evaluatePredicate({ op: 'lt', value: 40000 }, { value: '$27.36 an hour' }), true, '27.36 < 40000');
    assert.equal(evaluatePredicate({ op: 'lt', value: 40 }, { value: '$46.32 - $74.81 an hour' }), false, 'first number 46.32 ≮ 40');
    assert.equal(evaluatePredicate({ op: 'gt', value: 100000 }, { value: '$125,000 a year' }), true, '125000 > 100000');
    assert.equal(evaluatePredicate({ op: 'gte', value: 50 }, { items: ['$50 an hour', '$20 an hour'] }), true, 'reads the first item');
    assert.equal(evaluatePredicate({ op: 'lt', value: 40000 }, { value: 'no salary listed' }), false, 'no number → false (not a silent pass)');
  });

  it('evaluatePredicate: a COUNT threshold compares the item count, not the first item\'s number', () => {
    assert.equal(evaluatePredicate({ op: 'gt', value: 10, target: 'count' }, { items: new Array(12).fill('$5 an hour') }), true, '12 items > 10');
    assert.equal(evaluatePredicate({ op: 'gt', value: 10, target: 'count' }, { items: new Array(3).fill('$5 an hour') }), false, '3 items ≯ 10 (value 5 is ignored)');
    assert.equal(evaluatePredicate({ op: 'gte', value: 3, target: 'count' }, { count: 3 }), true, 'reads a numeric count too');
  });

  it('evaluatePredicate: contains / not_contains over value + items', () => {
    assert.equal(evaluatePredicate({ op: 'contains', term: 'remote' }, { value: 'Remote — $50/hr' }), true, 'case-insensitive');
    assert.equal(evaluatePredicate({ op: 'contains', term: 'remote' }, { items: ['On-site', 'Hybrid'] }), false);
    assert.equal(evaluatePredicate({ op: 'not_contains', term: 'remote' }, { items: ['On-site'] }), true);
  });

  it('evaluatePredicate: negate flips the result; unknown op → false (a closed gate is the safe default)', () => {
    assert.equal(evaluatePredicate({ op: 'exists', negate: true }, { items: ['a'] }), false);
    assert.equal(evaluatePredicate({ op: 'none', negate: true }, { items: [] }), false);
    assert.equal(evaluatePredicate({ op: 'mystery' }, { items: ['a'] }), false);
    assert.ok(PREDICATE_OPS.includes('exists') && PREDICATE_OPS.includes('lt') && PREDICATE_OPS.includes('contains'));
  });

  it('predicateLabel: a readable rendering for the gate confirm', () => {
    assert.equal(predicateLabel({ op: 'exists' }), 'there are any');
    assert.equal(predicateLabel({ op: 'lt', value: 40000 }), "it's under 40,000");
    assert.equal(predicateLabel({ op: 'contains', term: 'remote' }), 'it mentions "remote"');
    assert.match(predicateLabel({ op: 'exists', negate: true }), /^NOT \(/);
  });
});
