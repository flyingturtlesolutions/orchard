/**
 * stepReceipt (v2.74.1829) — the per-step outcome receipt.
 *
 * Fixtures come from BOTH live runs deliberately: 15:36 phrased the filter with no noun ("for each without a
 * vendor explanation") and 16:08 phrased it with one ("for each TASK that has a vendor explanation"). v1828
 * passed its tests and still failed live because every fixture came from the first run — a corpus drawn from
 * one run encodes that run's accidents as the contract. Both phrasings are pinned here for that reason.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mayDeclareFilter, buildStepReceipt, renderStepReceipt, stepReceiptLine } from './stepReceipt.js';

describe('mayDeclareFilter — a COST GATE and disagreement backstop, never a decider', () => {
  it('accepts the domain noun, whatever it is (the v1828 live failure)', () => {
    assert.equal(mayDeclareFilter('for each task that has a vendor explanation, open a case with 1'), 'that has a vendor explanation');
    assert.equal(mayDeclareFilter('for each task that does not have a vendor explanation, open a case with 0'), 'that does not have a vendor explanation');
    assert.equal(mayDeclareFilter('for each ticket that is open, escalate it'), 'that is open');
    assert.equal(mayDeclareFilter('for each order without a tracking number, open a case'), 'without a tracking number');
    assert.equal(mayDeclareFilter('foreach customer whose plan is expired, send a note'), 'whose plan is expired');
  });

  it('still accepts the noun-less phrasing the FIRST run happened to use', () => {
    assert.equal(mayDeclareFilter('for each without a vendor explanation, open a case showing 0'), 'without a vendor explanation');
    assert.equal(mayDeclareFilter('for each with a vendor explanation, open a case showing 1'), 'with a vendor explanation');
  });

  it('does not fire on plain fan-outs or on an action that merely contains "with"', () => {
    assert.equal(mayDeclareFilter('for each one, read the vendor explanation'), null);
    assert.equal(mayDeclareFilter('for each, respond with a summary'), null);   // the comma guards it
    assert.equal(mayDeclareFilter('open each in a new conversation'), null);    // no marker within the filler bound
    assert.equal(mayDeclareFilter('get open warranty tasks'), null);
    assert.equal(mayDeclareFilter(''), null);
    assert.equal(mayDeclareFilter(null), null);
  });
});

describe('filterState — the model decides "declared", this file records "applied"', () => {
  it('declared by the model and NOT applied → the load-bearing warning', () => {
    const r = buildStepReceipt({ kind: 'fanout', clause: 'for each task that has a vendor explanation, open a case with 1', declared: 'has a vendor explanation', rowsIn: 2, rowsOut: 2, created: 2, skipped: 0 });
    assert.equal(r.filterState, 'declared-not-applied');
    assert.match(renderStepReceipt(r), /filter "has a vendor explanation" DECLARED-NOT-APPLIED/);
  });

  it('declared and applied → reports the narrowing, and names rows it could not judge', () => {
    const r = buildStepReceipt({ kind: 'fanout', clause: 'for each task that has a vendor explanation, open a case with 1', declared: 'has a vendor explanation', filterApplied: true, unknownRows: 1, rowsIn: 3, rowsOut: 1, created: 1 });
    assert.equal(r.filterState, 'applied');
    assert.match(renderStepReceipt(r), /rows 3→1 · filter "has a vendor explanation" applied \(1 couldn't be judged — excluded\)/);
  });

  it('applied is opt-in, never inferred from rowsOut < rowsIn (a cap would masquerade as a filter)', () => {
    const capped = buildStepReceipt({ kind: 'fanout', clause: 'for each task that has a note, open a case', declared: 'has a note', rowsIn: 20, rowsOut: 5, created: 5 });
    assert.equal(capped.filterState, 'declared-not-applied');
  });

  it('no model verdict and no lexical hint → the filter segment is absent entirely', () => {
    const r = buildStepReceipt({ kind: 'fieldread', clause: 'for each one, read the vendor explanation', rowsIn: 2, rowsOut: 2 });
    assert.equal(r.filterState, 'none');
    assert.equal(r.disagreement, '');
    assert.doesNotMatch(renderStepReceipt(r), /filter|⚠/);
  });
});

describe('the teach-and-guarantee backstop', () => {
  it('model returned NO branch but the clause reads like a filter → REPORT, never resolve', () => {
    const r = buildStepReceipt({ kind: 'fanout', clause: 'for each task that has a vendor explanation, open a case with 1', rowsIn: 2, rowsOut: 2, created: 2 });
    assert.equal(r.declared, '');
    assert.equal(r.filterState, 'none');            // we do NOT promote the hint into a verdict
    assert.equal(r.disagreement, 'that has a vendor explanation');
    assert.match(renderStepReceipt(r), /⚠ no branch from interpret, but the clause reads like a filter \("that has a vendor explanation"\)/);
  });

  it('when the model DID declare, the backstop stays quiet (no double-reporting)', () => {
    const r = buildStepReceipt({ kind: 'fanout', clause: 'for each task that has a vendor explanation, open a case', declared: 'has a vendor explanation', filterApplied: true, rowsIn: 2, rowsOut: 1, created: 1 });
    assert.equal(r.disagreement, '');
    assert.doesNotMatch(renderStepReceipt(r), /⚠/);
  });
});

describe('outcome — the states that were silent in the live runs', () => {
  it('NO-OP: work ran, nothing created or updated (the vanished step 4, caught live 16:08:30)', () => {
    const r = buildStepReceipt({ index: 4, total: 4, kind: 'fanout', clause: 'for each task that has a vendor explanation, open a case with 1', declared: 'has a vendor explanation', rowsIn: 2, rowsOut: 2, created: 0, updated: 0, skipped: 2 });
    assert.equal(r.outcome, 'no-op');
    assert.match(renderStepReceipt(r), /NO-OP \(nothing created or updated; 2 already existed\)/);
  });

  it('EMPTY-IN and stopped', () => {
    assert.equal(buildStepReceipt({ kind: 'fanout', rowsIn: 0, rowsOut: 0 }).outcome, 'empty-in');
    assert.equal(buildStepReceipt({ kind: 'fanout', rowsIn: 2, created: 0, stopped: true }).outcome, 'stopped');
  });

  it('a step with no artifact accounting is not judged on artifacts', () => {
    const r = buildStepReceipt({ kind: 'act', clause: 'get open warranty tasks', rowsOut: 2 });
    assert.equal(r.hasArtifacts, false);
    assert.equal(r.outcome, 'ok');
  });
});

describe('renderStepReceipt — the marker as it lands in the trace', () => {
  it('omits a 1/1 position — it was measuring clauses, not workflow steps (live 16:08)', () => {
    assert.match(stepReceiptLine({ index: 1, total: 1, kind: 'fanout', rowsIn: 2, rowsOut: 2, created: 2 }), /^STEP ▸ fanout · rows 2→2 · cases 2 new/);
    assert.match(stepReceiptLine({ index: 3, total: 4, kind: 'fanout', rowsIn: 2, rowsOut: 2, created: 2 }), /^STEP ▸ 3\/4 fanout /);
  });

  it('the fixed run reads correctly end to end', () => {
    const good = stepReceiptLine({ kind: 'fanout', clause: 'for each task that does not have a vendor explanation, open a case with 0', declared: 'does not have a vendor explanation', filterApplied: true, rowsIn: 2, rowsOut: 1, created: 1, skipped: 0 });
    assert.match(good, /rows 2→1 · filter "does not have a vendor explanation" applied · cases 1 new\/0 updated\/0 skipped · ok/);
    assert.doesNotMatch(good, /DECLARED-NOT-APPLIED|⚠/);
  });

  it('survives junk rather than throwing inside a log call', () => {
    assert.equal(renderStepReceipt(null), '');
    assert.equal(renderStepReceipt('nope'), '');
    assert.match(stepReceiptLine({}), /^STEP ▸ step · ok$/);
  });
});
