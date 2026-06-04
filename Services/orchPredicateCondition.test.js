// Services/orchPredicateCondition.test.js — the converge gate condition (node --test).
// Verifies the canonical DETECT condition `orch_predicate` computes truth IDENTICALLY to the
// ORCH chat interpreter (same evaluatePredicate), and FAILS CLOSED on every malformed input.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateDataCondition, describeDataCondition, DATA_CONDITION_TYPES, DATA_CONDITION_FIELDS } from './DataAssertion.js';
import { evaluatePredicate } from '../Core/orchAnalyze.js';

// a minimal scope: get(binding) → tagged value, mirroring the runtime Scope contract
function scopeOf(map) { return { get: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null) }; }
const exists = JSON.stringify({ op: 'exists' });
const cond = (binding, specJson) => ({ type: 'orch_predicate', binding, specJson });

describe('orch_predicate — the converge DETECT condition', () => {
  it('is registered as a scope condition with [binding, specJson] fields', () => {
    assert.ok(DATA_CONDITION_TYPES.includes('orch_predicate'), 'auto-included in the scope vocabulary');
    assert.deepEqual(DATA_CONDITION_FIELDS.orch_predicate.fields, ['binding', 'specJson']);
  });

  it('exists over a length-0 list → does NOT hold (the 0-results gate stays shut)', () => {
    const r = evaluateDataCondition(cond('THE_JOBS', exists), scopeOf({ THE_JOBS: { kind: 'list', items: [] } }));
    assert.equal(r.ok, false);
  });

  it('exists over a length-2 list → holds (the gate opens)', () => {
    const r = evaluateDataCondition(cond('THE_JOBS', exists), scopeOf({ THE_JOBS: { kind: 'list', items: ['a', 'b'] } }));
    assert.equal(r.ok, true);
  });

  it('count predicates read list length (gte 5 over 6 items → holds; over 3 → not)', () => {
    const five = JSON.stringify({ op: 'gte', target: 'count', value: 5 });  // target:'count' compares length (vs the scalar value)
    const six = scopeOf({ N: { kind: 'list', items: [1, 2, 3, 4, 5, 6] } });
    const three = scopeOf({ N: { kind: 'list', items: [1, 2, 3] } });
    assert.equal(evaluateDataCondition(cond('N', five), six).ok, true);
    assert.equal(evaluateDataCondition(cond('N', five), three).ok, false);
  });

  it('scalar "0 jobs" coerces to count 0 → exists does NOT hold (parity with _countFromValue)', () => {
    const r = evaluateDataCondition(cond('TXT', exists), scopeOf({ TXT: { kind: 'scalar', value: '0 jobs found' } }));
    assert.equal(r.ok, false);
  });

  it('contains predicate runs over a scalar value', () => {
    const c = JSON.stringify({ op: 'contains', term: 'remote' });
    assert.equal(evaluateDataCondition(cond('S', c), scopeOf({ S: { kind: 'scalar', value: 'Remote — San Francisco' } })).ok, true);
    assert.equal(evaluateDataCondition(cond('S', c), scopeOf({ S: { kind: 'scalar', value: 'On-site only' } })).ok, false);
  });

  it('FAILS CLOSED — unbound binding, bad JSON spec → ok:false (never opens a gate by accident)', () => {
    assert.equal(evaluateDataCondition(cond('MISSING', exists), scopeOf({})).ok, false);
    assert.equal(evaluateDataCondition(cond('X', '{not json'), scopeOf({ X: { kind: 'list', items: ['a'] } })).ok, false);
  });

  it('truth is IDENTICAL to evaluatePredicate directly (the gate is not re-implemented)', () => {
    const specs = [{ op: 'exists' }, { op: 'none' }, { op: 'gt', value: 3 }, { op: 'lte', value: 2 }];
    const lists = [[], ['a'], ['a', 'b', 'c', 'd']];
    for (const spec of specs) for (const items of lists) {
      const direct = !!evaluatePredicate(spec, { items, count: items.length });
      const viaCond = evaluateDataCondition(cond('B', JSON.stringify(spec)), scopeOf({ B: { kind: 'list', items } })).ok;
      assert.equal(viaCond, direct, `parity for ${spec.op} over ${items.length} items`);
    }
  });

  it('describes via the same label the chat surface shows', () => {
    const d = describeDataCondition(cond('THE_JOBS', exists));
    assert.match(d, /THE_JOBS/);
    assert.match(d, /there are any/);
  });
});
