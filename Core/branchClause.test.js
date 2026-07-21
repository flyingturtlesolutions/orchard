// Core/branchClause.test.js — PP-1 (v2.74.1661): the per-item BRANCH clause contract.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBranchVerdict, evalBranch, branchTally, BRANCH_MODES } from './branchClause.js';

const W = (f, v) => ({ type: 'field_contains', field: f, value: v });
const V = (over = {}) => normalizeBranchVerdict({
  arms: [
    { when: W('Instructions', 'replacement'), label: 'replacements', then: ['a'] },
    { when: W('Instructions', 'call'), label: 'outreach', then: ['b'] },
  ],
  ...over,
});
// A stand-in for the real scope evaluator: contains-match, UNDEFINED when the field is absent.
const ev = (a, item) => {
  const val = item ? item[a.field] : undefined;
  if (val === undefined) return undefined;          // could-not-evaluate, NOT false
  return String(val).toLowerCase().includes(String(a.value).toLowerCase());
};

describe('branchClause — normalizeBranchVerdict (arms is the only required slot)', () => {
  it('normalizes a full verdict; mode defaults to first, collection to prior', () => {
    const v = V();
    assert.equal(v.kind, 'branch');
    assert.equal(v.mode, 'first');
    assert.equal(v.collection, 'prior');
    assert.equal(v.arms.length, 2);
    assert.equal(v.otherwise, null);
  });
  it('NO arms → null, so the caller degrades honestly instead of half-running', () => {
    for (const bad of [null, {}, { arms: [] }, { arms: [{ label: 'x' }] }, { otherwise: ['z'] }]) {
      assert.equal(normalizeBranchVerdict(bad), null);
    }
  });
  it('an arm whose `when` is PROSE is rejected — assertions only, one vocabulary', () => {
    const v = normalizeBranchVerdict({ arms: [{ when: 'if it mentions replacements', then: ['a'] }] });
    assert.equal(v, null);
  });
  it('labels default positionally so every arm is nameable in a tally', () => {
    const v = normalizeBranchVerdict({ arms: [{ when: W('f', 'x') }, { when: W('f', 'y') }] });
    assert.deepEqual(v.arms.map((a) => a.label), ['arm 1', 'arm 2']);
  });
  it('mode is honored when valid, floored when not', () => {
    assert.equal(V({ mode: 'all' }).mode, 'all');
    assert.equal(V({ mode: 'sideways' }).mode, 'first');
    assert.deepEqual(BRANCH_MODES, ['first', 'all']);
  });
  it('a self-contained collection rides; otherwise is kept only when non-empty', () => {
    const v = V({ collection: { readAsk: 'get open tasks' }, otherwise: ['z'] });
    assert.deepEqual(v.collection, { readAsk: 'get open tasks' });
    assert.deepEqual(v.otherwise, ['z']);
  });
});

describe('branchClause — evalBranch: THREE outcomes, never two', () => {
  it('a match routes to that arm', () => {
    const r = evalBranch({ Instructions: 'send a replacement switch' }, V(), ev);
    assert.equal(r.outcome, 'arm');
    assert.deepEqual(r.arms.map((a) => a.label), ['replacements']);
  });

  it('no match and everything judged → `none` (a real answer, not a failure)', () => {
    const r = evalBranch({ Instructions: 'inspect the drywall' }, V(), ev);
    assert.equal(r.outcome, 'none');
    assert.deepEqual(r.arms, []);
  });

  it('NO match with something indeterminate → `unknown`, NOT `none`', () => {
    // The field is absent, so the predicate cannot be judged. Calling that "no match" would route the item to
    // `otherwise` on missing data — the v1637 unreachable-read-as-miss bug in a new costume.
    const r = evalBranch({ SomeOtherField: 'x' }, V(), ev);
    assert.equal(r.outcome, 'unknown');
    assert.match(r.why, /indeterminate/);
  });

  it('a predicate that THROWS is unknown, not false', () => {
    const boom = () => { throw new Error('scope missing'); };
    const r = evalBranch({}, V(), boom);
    assert.equal(r.outcome, 'unknown');
    assert.match(r.why, /scope missing/);
  });

  it('a positive match WINS over an indeterminate sibling — evidence beats absence of evidence', () => {
    const v = normalizeBranchVerdict({
      arms: [{ when: W('Missing', 'x'), label: 'cannot-judge' }, { when: W('Instructions', 'call'), label: 'outreach' }],
    });
    const r = evalBranch({ Instructions: 'please call the owner' }, v, ev);
    assert.equal(r.outcome, 'arm');
    assert.deepEqual(r.arms.map((a) => a.label), ['outreach']);
  });

  it('a malformed verdict or missing evaluator is unknown, never a silent pass', () => {
    assert.equal(evalBranch({}, null, ev).outcome, 'unknown');
    assert.equal(evalBranch({}, V(), null).outcome, 'unknown');
  });
});

describe('branchClause — multi-arm (§3.1): the skipped arm is RECORDED, never dropped', () => {
  const both = { Instructions: 'send a replacement, then call the owner' };
  it("mode 'first' runs one arm and REPORTS the one it skipped", () => {
    const r = evalBranch(both, V(), ev);
    assert.deepEqual(r.arms.map((a) => a.label), ['replacements']);
    assert.deepEqual(r.skipped.map((a) => a.label), ['outreach']);   // the silent-drop this exists to prevent
  });
  it("mode 'all' runs every matching arm, in declared order, skipping nothing", () => {
    const r = evalBranch(both, V({ mode: 'all' }), ev);
    assert.deepEqual(r.arms.map((a) => a.label), ['replacements', 'outreach']);
    assert.deepEqual(r.skipped, []);
  });
});

describe('branchClause — branchTally names every class, including zeroes', () => {
  it('counts arms, no-arm, unknown, and multi-match', () => {
    const v = V();
    const rows = [
      evalBranch({ Instructions: 'send a replacement' }, v, ev),
      evalBranch({ Instructions: 'call them' }, v, ev),
      evalBranch({ Instructions: 'inspect drywall' }, v, ev),
      evalBranch({ Nope: 1 }, v, ev),
      evalBranch({ Instructions: 'replacement then call' }, v, ev),
    ];
    const s = branchTally(rows, { arms: v.arms });
    assert.match(s, /5 items/);
    assert.match(s, /replacements 2/);
    assert.match(s, /outreach 1/);
    assert.match(s, /no arm 1/);
    assert.match(s, /couldn.t tell 1/);
    assert.match(s, /1 matched >1 arm/);
  });
  it('a class with ZERO still appears — absent reads as "did not happen"', () => {
    const v = V();
    const s = branchTally([evalBranch({ Instructions: 'nothing here' }, v, ev)], { arms: v.arms });
    assert.match(s, /replacements 0/);
    assert.match(s, /couldn.t tell 0/);
  });
});
