// Core/bindingResolve.test.js — CR-D4 (v2.74.943): the one paramBinding resolver, each adopter's policy pinned.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBinding, resolveBindings, scopeLookup, coerceTagged } from './bindingResolve.js';

const scopeOf = (entries) => ({ get: (n) => entries[n] });
const FRAGMENT = { onMissing: 'unset', list: 'join', record: 'string' };
const SIEVE    = { onMissing: 'empty', list: 'empty', record: 'json', plainStringIsLiteral: true };
const NAVIGATE = { onMissing: 'error', list: 'error' };

describe('bindingResolve — fragment policy (missing→unset, list→join)', () => {
  const scope = scopeOf({
    Q: { kind: 'scalar', value: 'plumber' },
    ROWS: { kind: 'list', items: [{ value: 'a' }, { value: 'b' }] },
    EL: { kind: 'element', selector: '#row1' },
  });
  it('literal / scalar / element / list-join', () => {
    const { values } = resolveBindings({
      A: { kind: 'literal', value: 'x' },
      B: { kind: 'strategy_param', name: 'Q' },
      C: { kind: 'iteration_variable', name: 'EL' },
      D: { kind: 'strategy_param', name: 'ROWS' },
    }, scopeLookup(scope), FRAGMENT);
    assert.deepEqual(values, { A: 'x', B: 'plumber', C: '#row1', D: 'a, b' });
  });
  it('missing name leaves the slot UNSET (the {{TOKEN}} contract)', () => {
    const { values, errors } = resolveBindings({ X: { kind: 'strategy_param', name: 'NOPE' } }, scopeLookup(scope), FRAGMENT);
    assert.deepEqual(values, {});
    assert.equal(errors.length, 0);
  });
  it('v2.50 field path reads the iteration record', () => {
    const s2 = scopeOf({ JOB: { kind: 'element', selector: '#j', record: { jobKey: 'k-42' } } });
    const r = resolveBinding({ kind: 'iteration_variable', name: 'JOB', field: 'jobKey' }, scopeLookup(s2), FRAGMENT);
    assert.deepEqual(r, { ok: true, value: 'k-42' });
    const miss = resolveBinding({ kind: 'iteration_variable', name: 'JOB', field: 'nope' }, scopeLookup(s2), FRAGMENT);
    assert.deepEqual(miss, { ok: true, value: undefined }, 'absent field follows onMissing (unset)');
  });
  it('non-object bindings are skipped (fragment legacy)', () => {
    const { values } = resolveBindings({ A: 'bare' }, scopeLookup(scope), FRAGMENT);
    assert.deepEqual(values, {});
  });
});

describe('bindingResolve — sieve policy (missing→empty, record→json, bare string = literal)', () => {
  const scope = scopeOf({ R: { kind: 'record', fields: { a: 1 } }, L: { kind: 'list', items: [{ value: 'x' }] } });
  it('record → JSON, list → empty, missing → empty, bare string → literal', () => {
    const { values } = resolveBindings({
      A: { kind: 'strategy_param', name: 'R' },
      B: { kind: 'strategy_param', name: 'L' },
      C: { kind: 'strategy_param', name: 'NOPE' },
      D: 'bare-literal',
      E: { kind: 'mystery_kind' },
    }, scopeLookup(scope), SIEVE);
    assert.deepEqual(values, { A: '{"a":1}', B: '', C: '', D: 'bare-literal', E: '' });
  });
});

describe('bindingResolve — navigate policy (missing→error, list→error)', () => {
  const scope = scopeOf({ U: { kind: 'scalar', value: 'https://x.com' }, L: { kind: 'list', items: [] } });
  it('scalar resolves; missing and list are errors', () => {
    assert.deepEqual(resolveBinding({ kind: 'strategy_param', name: 'U' }, scopeLookup(scope), NAVIGATE), { ok: true, value: 'https://x.com' });
    assert.equal(resolveBinding({ kind: 'strategy_param', name: 'NOPE' }, scopeLookup(scope), NAVIGATE).ok, false);
    assert.equal(resolveBinding({ kind: 'strategy_param', name: 'L' }, scopeLookup(scope), NAVIGATE).ok, false);
  });
});

describe('coerceTagged + scopeLookup', () => {
  it('plain-dict sources read by key; strings pass through', () => {
    assert.equal(scopeLookup({ A: 'v' })('A'), 'v');
    assert.deepEqual(coerceTagged('s'), { ok: true, value: 's' });
  });
});
