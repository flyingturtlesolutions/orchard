/**
 * runLedger (v2.74.1831) — OB-1. Each fixture below is one of the real silent failures from this arc
 * (logs/run/findings.md, 07-24 → 07-26): the line the run SHOULD have produced and didn't.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderSpan, createRunLedger, renderNoEffect, renderRunReceipt, runVerdict, SPAN_OUTCOMES } from './runLedger.js';

describe('renderSpan — the exit that goes missing', () => {
  it('turns the 53-second branch hole into a duration and a cause', () => {
    assert.equal(
      renderSpan({ name: 'BRANCH', ms: 53021, outcome: 'failed', cause: 'no-prior' }),
      'SPAN ▸ BRANCH · FAILED · 53021ms · cause=no-prior',
    );
  });

  it('no-effect is a first-class outcome, distinct from ok and from failed', () => {
    assert.match(renderSpan({ name: 'FANOUT', ms: 16000, outcome: 'no-effect', detail: '2 already existed' }), /FANOUT · NO-EFFECT · 16000ms · 2 already existed/);
    assert.match(renderSpan({ name: 'FANOUT', ms: 12 }), /FANOUT · ok · 12ms/);
    assert.ok(SPAN_OUTCOMES.includes('no-effect'));
  });

  it('an unknown outcome degrades to failed — never silently to ok', () => {
    assert.match(renderSpan({ name: 'X', outcome: 'banana' }), /X · FAILED/);
  });

  it('survives junk from inside a finally block rather than throwing', () => {
    assert.equal(renderSpan({}), '');
    assert.equal(renderSpan(), '');
    assert.match(renderSpan({ name: 'X', ms: -5 }), /X · ok · 0ms/);
    assert.match(renderSpan({ name: 'X', ms: 'nope' }), /^SPAN ▸ X · ok$/);
  });
});

describe('createRunLedger + renderNoEffect — the turn-level backstop', () => {
  it('FIRES for the pinned-connector step: reached a decision, touched nothing, never errored', () => {
    const l = createRunLedger().decision('WORKFLOW ▸ step 1 PINNED → me.vendorsuite.vs_warranty_tasks (connector door)');
    const line = renderNoEffect(l, { ms: 900, ask: 'run the warranty workflow' });
    assert.match(line, /^RUN ▸ no-effect — nothing was created, updated or written, and nothing failed/);
    assert.match(line, /last decision: WORKFLOW ▸ step 1 PINNED/);
    assert.match(line, /ask: "run the warranty workflow"/);
  });

  it('FIRES for the vanished step 4, and distinguishes "tried and got zero" from "never got there"', () => {
    const tried = createRunLedger().effect('case', 0).decision('RIDE_DRILL ▸ dossier × 2 (fan-out spawn)');
    assert.match(renderNoEffect(tried, { ms: 16000 }), /attempted: case 0/);
    const never = createRunLedger().decision('RIDE_DRILL ▸ dossier × 2 (fan-out spawn)');
    assert.doesNotMatch(renderNoEffect(never, { ms: 16000 }), /attempted:/);
  });

  it('STAYS QUIET when an artifact was touched — an ordinary successful run', () => {
    assert.equal(renderNoEffect(createRunLedger().effect('case', 2)), '');
  });

  it('STAYS QUIET when the turn errored — that is already diagnosable', () => {
    assert.equal(renderNoEffect(createRunLedger().error().decision('x')), '');
    // …even when it also produced nothing: an error IS the explanation, so a second line would be noise.
    assert.equal(renderNoEffect(createRunLedger().effect('case', 0).error()), '');
  });

  it('a READ is not an effect — text and lookups must not count as having done something', () => {
    // The live shape: 4 successful ride reads, a rendered sentence, zero artifacts. This MUST still fire.
    const l = createRunLedger().decision('Couldn’t read the list to fan out over.');
    assert.match(renderNoEffect(l, { ms: 53021 }), /no-effect/);
  });

  it('counts accumulate per kind', () => {
    const s = createRunLedger().effect('case', 2).effect('case').effect('write', 1).snapshot();
    assert.equal(s.effects.case, 3);
    assert.equal(s.touched, 4);
  });

  it('survives junk rather than throwing inside a log call', () => {
    assert.equal(renderNoEffect(null), '');
    assert.equal(renderNoEffect({}), '');
    assert.equal(createRunLedger().effect(null, 'x').snapshot().touched, 0);
  });
});

describe('v2.74.1834 — a read that returned data did its job (the false positive)', () => {
  it('STAYS QUIET for a pure read: rows came back and no artifact stage was attempted', () => {
    // Live 07-26 18:38 — step 1 of a workflow read 2 rows and correctly created nothing. Firing here was noise
    // on a WORKING step, and a backstop that cries wolf on success is one people stop reading.
    const l = createRunLedger().read(2).decision('get open warranty cases');
    assert.equal(renderNoEffect(l, { ms: 12342, ask: 'get open warranty cases' }), '');
  });

  it('STILL FIRES when a spawn was attempted and produced nothing, even with rows in hand', () => {
    // The 07-25 step-4 failure: 2 rows, spawn ran, 0 cases. Rows must NOT buy silence once a stage was tried.
    const l = createRunLedger().read(2).effect('case', 0);
    const line = renderNoEffect(l, { ms: 16000 });
    assert.match(line, /no-effect/);
    assert.match(line, /attempted: case 0/);
    assert.match(line, /2 row\(s\) read/);
  });

  it('STILL FIRES when nothing was read and nothing was made — the original signature', () => {
    const l = createRunLedger().decision('WORKFLOW ▸ step 1 PINNED → …');
    assert.match(renderNoEffect(l, { ms: 900 }), /no-effect/);
  });

  it('rows never count as touched — a read alone is not an effect', () => {
    const s = createRunLedger().read(5).snapshot();
    assert.equal(s.rowsRead, 5);
    assert.equal(s.touched, 0);
  });

  it('read() ignores junk and non-positive counts', () => {
    assert.equal(createRunLedger().read(-3).read('x').read().snapshot().rowsRead, 0);
  });
});

// v2.74.1859 — the run-level terminal + the outcome-derived verdict. Each fixture is a REAL shape from the
// 07-28 traces (the day the backstop's suppression finally had a producer and the run lost its receipt).
describe('renderRunReceipt (v2.74.1859) — a span that opened must close, whatever the outcome', () => {
  it('the no-effect signature keeps the backstop wording byte-identical (no double-reporting)', () => {
    const l = createRunLedger();
    assert.equal(renderRunReceipt(l, { ms: 5417 }), renderNoEffect(l, { ms: 5417 }));
    assert.match(renderRunReceipt(l, { ms: 5417 }), /^RUN ▸ no-effect — /);
  });
  it('THE 13:20 CASE: an errored turn that produced nothing now closes as failed (was: silence)', () => {
    const line = renderRunReceipt(createRunLedger().error().decision('act → vs_warranty_tasks'), { ms: 800, ask: 'get open warranty tasks' });
    assert.match(line, /^RUN ▸ failed — nothing was created, updated or written/);
    assert.match(line, /1 step\(s\) failed/);
    assert.equal(renderNoEffect(createRunLedger().error()), '', 'the backstop still stays quiet — the receipt is what speaks');
  });
  it('a plain successful READ closes as ok with its rows (the backstop deliberately says nothing)', () => {
    const l = createRunLedger().read(3);
    assert.equal(renderNoEffect(l), '');
    assert.match(renderRunReceipt(l, { ms: 120 }), /^RUN ▸ ok · 120ms · 3 row\(s\) read/);
  });
  it('effects render; an error alongside them reads partial, never ok', () => {
    assert.match(renderRunReceipt(createRunLedger().effect('case', 3)), /^RUN ▸ ok — case 3/);
    assert.match(renderRunReceipt(createRunLedger().effect('case', 3).error()), /^RUN ▸ partial — case 3 · 1 step\(s\) failed/);
  });
  it('junk in → empty string out (a receipt never throws on a missing ledger)', () => {
    assert.equal(renderRunReceipt(null), '');
    assert.equal(renderRunReceipt({}), '');
  });
});

describe('runVerdict (v2.74.1859) — outcomes, not step positions', () => {
  const snap = (l) => l.snapshot();
  it('THE FALSE SUCCESS: a 1-step workflow whose only step failed is failed, not complete', () => {
    assert.equal(runVerdict(snap(createRunLedger().error()), { done: 1, total: 1 }), 'failed');
  });
  it('THE 13:20 CASE: 2 steps, step 1 dispatched-then-blocked, nothing produced → failed (was: partial)', () => {
    assert.equal(runVerdict(snap(createRunLedger().error()), { done: 1, total: 2 }), 'failed');
  });
  it('an error WITH real work is partial — the honest middle', () => {
    assert.equal(runVerdict(snap(createRunLedger().error().effect('case', 2)), { done: 2, total: 3 }), 'partial');
    assert.equal(runVerdict(snap(createRunLedger().error().read(4)), { done: 1, total: 1 }), 'partial', 'rows count as work done');
  });
  it('all steps ran, work happened, nothing failed → complete', () => {
    assert.equal(runVerdict(snap(createRunLedger().effect('case', 3)), { done: 2, total: 2 }), 'complete');
    assert.equal(runVerdict(snap(createRunLedger().read(3)), { done: 2, total: 2 }), 'complete');
  });
  it('silent nothing (no error, no work) is failed — a run that touched nothing did not complete', () => {
    assert.equal(runVerdict(snap(createRunLedger()), { done: 2, total: 2 }), 'failed');
  });
  it('no ledger → the legacy positional read, so an unmeasured host is never made worse', () => {
    assert.equal(runVerdict(null, { done: 2, total: 2 }), 'complete');
    assert.equal(runVerdict(null, { done: 1, total: 2 }), 'partial');
    assert.equal(runVerdict(null, { done: 0, total: 2 }), 'failed');
  });
});
