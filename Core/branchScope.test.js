// Core/branchScope.test.js — PP-1 (v2.74.1661): the BRANCH reach adapter.
//
// Every case here pins a fact READ FROM SOURCE, not inferred — the spec already carries one falsified predicate
// list assembled by grepping identifier names (docs/DESIGN_peritem_pipeline.md §1.1, the ⛔ block).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  planBindings, precheckCondition, makeBranchEvaluator,
  RECORD_BINDING, DOC_MIN_LENGTH, ORCH_PREDICATE_OPS,
} from './branchScope.js';
import { normalizeBranchVerdict, evalBranch } from './branchClause.js';

// A scope stand-in with the same accessor shape as Services/Scope.js (get(name) → tagged value | undefined).
const scopeOf = (item, opts) => {
  const { bindings } = planBindings(item, opts);
  const m = new Map();
  for (const b of bindings) {
    m.set(b.name, b.kind === 'record'
      ? { kind: 'record', fields: b.value }
      : b.kind === 'document'
        ? { kind: 'document', content: String(b.value ?? '') }
        : { kind: 'scalar', value: String(b.value ?? ''), subtype: b.subtype || 'string' });
  }
  return { get: (n) => m.get(n), lookup: (n) => m.get(n) };
};

const LONG = 'x'.repeat(DOC_MIN_LENGTH);
const ITEM = { Id: '10834758', Status: 'open', Instructions: `${LONG} send a replacement switch` };

describe('branchScope — planBindings (§1.1c, the binding-granularity rule)', () => {
  it('binds the record whole AND every field separately', () => {
    const { bindings } = planBindings(ITEM);
    const names = bindings.map((b) => b.name);
    assert.deepEqual(names, [RECORD_BINDING, 'Id', 'Status', 'Instructions']);
    assert.equal(bindings[0].kind, 'record');
  });

  it('THE RULE: a field needing a rich predicate gets its OWN binding, because orch_predicate has no fieldName', () => {
    // Read from source: `_coerceForPredicate` (Services/DataAssertion.js:57) collapses a record to
    // Object.values(fields).join(' '), so `contains` over the RECORD binding searches every field at once.
    // Separate per-field bindings are what make a per-field predicate expressible at all.
    const { bindings } = planBindings(ITEM);
    const instr = bindings.find((b) => b.name === 'Instructions');
    assert.ok(instr, 'Instructions must be addressable on its own, not only via the record');
    assert.equal(instr.field, 'Instructions');
  });

  it('long strings bind as document (so document_contains reaches them); short ones as scalar', () => {
    const { bindings } = planBindings(ITEM);
    assert.equal(bindings.find((b) => b.name === 'Instructions').kind, 'document');
    assert.equal(bindings.find((b) => b.name === 'Status').kind, 'scalar');
  });

  it('an explicit fieldKinds declaration always beats the mechanical default (§1.3)', () => {
    const { bindings } = planBindings(ITEM, { fieldKinds: { Status: 'document', Instructions: 'scalar' } });
    assert.equal(bindings.find((b) => b.name === 'Status').kind, 'document');
    assert.equal(bindings.find((b) => b.name === 'Instructions').kind, 'scalar');
  });

  it('a field colliding with the reserved record binding is REPORTED, never silently shadowed', () => {
    const { bindings, collisions } = planBindings({ item: 'x', Other: 'y' });
    assert.deepEqual(collisions, ['item']);
    assert.equal(bindings.filter((b) => b.name === RECORD_BINDING).length, 1);
    assert.equal(bindings.find((b) => b.name === RECORD_BINDING).kind, 'record');
  });

  it('handles a non-object item without throwing', () => {
    for (const bad of [null, undefined, 'str', 7]) {
      const { bindings } = planBindings(bad);
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0].kind, 'record');
    }
  });
});

describe('branchScope — precheckCondition (§2.0.1, UNKNOWN must not collapse into FALSE)', () => {
  const s = scopeOf(ITEM);

  it('an unbound binding is UNKNOWN, not false', () => {
    const r = precheckCondition({ type: 'record_has_field', binding: 'nope', fieldName: 'Id' }, s.lookup);
    assert.equal(r.verdict, 'unknown');
    assert.match(r.why, /unbound/);
  });

  it('a kind mismatch is UNKNOWN — the question was never asked', () => {
    const r = precheckCondition({ type: 'document_contains', binding: 'Status', value: 'x' }, s.lookup);
    assert.equal(r.verdict, 'unknown');
    assert.match(r.why, /needs document/);
  });

  it('record_field_non_empty on an ABSENT field is UNKNOWN — the v1637 bug one layer down', () => {
    const r = precheckCondition({ type: 'record_field_non_empty', binding: RECORD_BINDING, fieldName: 'Missing' }, s.lookup);
    assert.equal(r.verdict, 'unknown');
    assert.match(r.why, /no field/);
  });

  it('record_has_field on an absent field is FALSE — presence IS the question there', () => {
    const r = precheckCondition({ type: 'record_has_field', binding: RECORD_BINDING, fieldName: 'Missing' }, s.lookup);
    assert.equal(r.verdict, 'false');
  });

  it('a binding_is_<kind> test answers itself: mismatch is FALSE, not undecidable', () => {
    assert.equal(precheckCondition({ type: 'binding_is_record', binding: RECORD_BINDING }, s.lookup).verdict, 'pass');
    assert.equal(precheckCondition({ type: 'binding_is_record', binding: 'Status' }, s.lookup).verdict, 'false');
    assert.equal(precheckCondition({ type: 'binding_is_document', binding: 'Instructions' }, s.lookup).verdict, 'pass');
  });

  it('a well-formed condition over a correctly-kinded binding PASSES through to the real evaluator', () => {
    assert.equal(precheckCondition({ type: 'document_contains', binding: 'Instructions', value: 'replacement' }, s.lookup).verdict, 'pass');
    assert.equal(precheckCondition({ type: 'record_field_non_empty', binding: RECORD_BINDING, fieldName: 'Status' }, s.lookup).verdict, 'pass');
  });

  it('an unknown condition TYPE is UNKNOWN (the evaluator would return ok:false — a merged answer)', () => {
    const r = precheckCondition({ type: 'field_contains', binding: 'Instructions', value: 'x' }, s.lookup);
    assert.equal(r.verdict, 'unknown');
    assert.match(r.why, /unknown condition type/);
  });

  it('malformed conditions degrade to UNKNOWN rather than throwing', () => {
    for (const bad of [null, undefined, {}, { type: 'record_has_field' }, { binding: 'x' }]) {
      assert.equal(precheckCondition(bad, s.lookup).verdict, 'unknown');
    }
  });
});

describe('branchScope — orch_predicate validation (closes the evaluator fail-OPEN)', () => {
  const s = scopeOf(ITEM);
  const oc = (spec) => ({ type: 'orch_predicate', binding: 'Instructions', specJson: JSON.stringify(spec) });

  it('every documented op is accepted', () => {
    for (const op of ORCH_PREDICATE_OPS) {
      assert.equal(precheckCondition(oc({ op, term: 'x', value: 1 }), s.lookup).verdict, 'pass', `op ${op}`);
    }
  });

  it('AN UNKNOWN OP + negate:true would return TRUE from evaluatePredicate — pre-check refuses it', () => {
    // Core/orchAnalyze.js: `default: r = false` then `return spec.negate ? !r : r` — the flip is unconditional,
    // so a typo'd op in a NEGATED arm matches every item. This is the fail-open §4's defaults rule forbids.
    const r = precheckCondition(oc({ op: 'containz', term: 'replacement', negate: true }), s.lookup);
    assert.equal(r.verdict, 'unknown');
    assert.match(r.why, /not implemented/);
  });

  it('unknown op WITHOUT negate is refused too — consistency, not just hole-plugging', () => {
    assert.equal(precheckCondition(oc({ op: 'bogus' }), s.lookup).verdict, 'unknown');
  });

  it('unparseable or op-less specJson is UNKNOWN', () => {
    assert.equal(precheckCondition({ type: 'orch_predicate', binding: 'Instructions', specJson: '{oops' }, s.lookup).verdict, 'unknown');
    assert.equal(precheckCondition(oc({ term: 'x' }), s.lookup).verdict, 'unknown');
  });
});

describe('branchScope — makeBranchEvaluator (the three-outcome contract end to end)', () => {
  const s = scopeOf(ITEM);
  // Stand-in for evaluateDataCondition: the real one returns {ok, reason} and merges every failure into ok:false.
  const realish = (cond, _scope) => {
    if (cond.type === 'document_contains') {
      const v = s.get(cond.binding);
      return { ok: !!v && String(v.content || '').includes(String(cond.value)), reason: '' };
    }
    if (cond.type === 'record_field_non_empty') {
      const v = s.get(cond.binding);
      const f = v && v.fields ? v.fields[cond.fieldName] : undefined;
      return { ok: !!String(f ?? '').trim(), reason: '' };
    }
    return { ok: false, reason: 'unhandled' };
  };
  const mk = (over = {}) => makeBranchEvaluator({ evaluate: realish, scope: s, lookup: s.lookup, ...over });

  it('maps {ok:true} → true and {ok:false} → false once the pre-check has passed', () => {
    const e = mk();
    assert.equal(e({ type: 'document_contains', binding: 'Instructions', value: 'replacement' }), true);
    assert.equal(e({ type: 'document_contains', binding: 'Instructions', value: 'refund' }), false);
  });

  it('a pre-check failure returns UNDEFINED and never reaches the evaluator', () => {
    let called = false;
    const e = mk({ evaluate: () => { called = true; return { ok: false }; } });
    assert.equal(e({ type: 'record_field_non_empty', binding: RECORD_BINDING, fieldName: 'Missing' }), undefined);
    assert.equal(called, false, 'the evaluator must not see a condition whose answer would be ambiguous');
  });

  it('an evaluator THROW is undefined, not false', () => {
    const e = mk({ evaluate: () => { throw new Error('transport'); } });
    assert.equal(e({ type: 'document_contains', binding: 'Instructions', value: 'x' }), undefined);
  });

  it('a non-boolean, non-{ok} return is undefined rather than coerced', () => {
    for (const r of [null, undefined, 'yes', 0, {}]) {
      const e = mk({ evaluate: () => r });
      assert.equal(e({ type: 'document_contains', binding: 'Instructions', value: 'x' }), undefined);
    }
  });

  it('unknowns reach the disposition sink (§5.5 — an unknown is logged LOUDLY, never silently)', () => {
    const seen = [];
    const e = mk({ onUnknown: (w) => seen.push(w) });
    e({ type: 'record_field_non_empty', binding: RECORD_BINDING, fieldName: 'Missing' });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /no field/);
  });

  it('a throwing sink cannot change a verdict', () => {
    const e = mk({ onUnknown: () => { throw new Error('log broke'); } });
    assert.equal(e({ type: 'record_field_non_empty', binding: RECORD_BINDING, fieldName: 'Missing' }), undefined);
  });
});

describe('branchScope × branchClause — the composed reach', () => {
  const s = scopeOf(ITEM);
  const evaluate = (cond) => {
    if (cond.type !== 'document_contains') return { ok: false, reason: 'unhandled' };
    const v = s.get(cond.binding);
    return { ok: !!v && String(v.content || '').includes(String(cond.value)), reason: '' };
  };
  const evaluator = makeBranchEvaluator({ evaluate, scope: s, lookup: s.lookup });
  const D = (b, v) => ({ type: 'document_contains', binding: b, value: v });

  it('routes an item to the matching arm through the real adapter shape', () => {
    const verdict = normalizeBranchVerdict({
      arms: [
        { when: D('Instructions', 'replacement'), label: 'replacements', then: ['a'] },
        { when: D('Instructions', 'call them'), label: 'outreach', then: ['b'] },
      ],
    });
    const r = evalBranch(ITEM, verdict, (a) => evaluator(a));
    assert.equal(r.outcome, 'arm');
    assert.equal(r.arms[0].label, 'replacements');
  });

  it('an arm reading an ABSENT binding lands the item in unknown, NOT in otherwise', () => {
    const verdict = normalizeBranchVerdict({
      arms: [{ when: D('NoSuchField', 'x'), label: 'replacements', then: ['a'] }],
      otherwise: ['fallback'],
    });
    const r = evalBranch(ITEM, verdict, (a) => evaluator(a));
    assert.equal(r.outcome, 'unknown', 'routing this to otherwise is the v1637 bug in a new costume');
    assert.equal(r.arms.length, 0);
  });

  it('a genuine non-match with all arms evaluable is `none` — distinct from unknown', () => {
    const verdict = normalizeBranchVerdict({
      arms: [{ when: D('Instructions', 'refund'), label: 'refunds', then: ['a'] }],
    });
    const r = evalBranch(ITEM, verdict, (a) => evaluator(a));
    assert.equal(r.outcome, 'none');
  });
});
