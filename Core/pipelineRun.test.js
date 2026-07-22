// Core/pipelineRun.test.js — the run object (v2.74.1665).
//
// The verdict cases carry the weight. A run that did 3 of 22 and stopped must not be able to report `complete`,
// and a CAPPED run must not either — silent truncation reading as "covered everything" is the §5.6 failure.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mintRunId, openRun, recordStage, recordAction, closeItem, closeRun,
  markAlreadyOpen, runVerdict, runTally, runStartLine, runEndLine, trialTag,
  ITEM_OUTCOMES, RUN_VERDICTS,
} from './pipelineRun.js';

const ITEMS = [{ id: 'a', label: 'Task A' }, { id: 'b', label: 'Task B' }, { id: 'c', label: 'Task C' }];
const open = (over = {}) => openRun({ pipeline: 'warranty', items: ITEMS, now: 1000, stages: ['read', 'branch'], ...over });
const finish = (run, per) => { per.forEach(([id, o]) => closeItem(run, id, o)); return closeRun(run, { now: 2000 }); };

describe('pipelineRun — identity', () => {
  it('mintRunId is pure and matches the existing fleet convention', () => {
    assert.equal(mintRunId({ now: 0, rand: 0 }), mintRunId({ now: 0, rand: 0 }));
    assert.match(mintRunId({ now: 1737000000000, rand: 0.5 }), /^run_[a-z0-9]+_[a-z0-9]{4}$/);
  });
  it('a supplied runId wins, so a caller can correlate with its own ledger entry', () => {
    assert.equal(open({ runId: 'run_fixed' }).runId, 'run_fixed');
  });
});

describe('pipelineRun — the declared cap (§5.6)', () => {
  it('caps the accepted set and RECORDS that it truncated', () => {
    const r = open({ cap: 2 });
    assert.equal(r.accepted, 2);
    assert.equal(r.offered, 3);
    assert.equal(r.truncated, true);
    assert.equal(r.items.length, 2);
  });
  it('no cap accepts everything and does not claim truncation', () => {
    const r = open();
    assert.equal(r.truncated, false);
    assert.equal(r.accepted, 3);
  });
  it('the tally STATES the truncation — silent truncation reads as "covered everything"', () => {
    const r = finish(open({ cap: 2 }), [['a', 'done'], ['b', 'done']]);
    assert.match(runTally(r), /capped 2\/3/);
    assert.match(runTally(r), /1 not looked at/);
  });
});

describe('pipelineRun — per-item records (§5.7)', () => {
  it('a FAILED stage and a NEVER-RUN stage are distinguishable', () => {
    const r = open();
    recordStage(r, 'a', { name: 'lookup', verdict: 'failed', error: new Error('timeout') });
    const a = r.items.find((x) => x.id === 'a');
    const b = r.items.find((x) => x.id === 'b');
    assert.equal(a.stages.length, 1);
    assert.equal(a.stages[0].error, 'timeout');
    assert.equal(b.stages.length, 0, 'a stage that never ran has NO entry — not a false success');
  });

  it('stages append, so a retry is visible rather than collapsed', () => {
    const r = open();
    recordStage(r, 'a', { name: 'lookup', verdict: 'failed' });
    recordStage(r, 'a', { name: 'lookup', verdict: 'ok' });
    assert.equal(r.items.find((x) => x.id === 'a').stages.length, 2);
  });

  it('actions carry their approval state', () => {
    const r = open();
    recordAction(r, 'a', { what: 'draft order', state: 'queued-for-approval', ref: 'p_1' });
    recordAction(r, 'a', { what: 'send email', state: 'refused' });
    const acts = r.items.find((x) => x.id === 'a').actions;
    assert.equal(acts.length, 2);
    assert.equal(acts[0].state, 'queued-for-approval');
    assert.equal(acts[1].state, 'refused');
  });

  it('an unknown itemId is ignored rather than throwing mid-run', () => {
    const r = open();
    assert.doesNotThrow(() => recordStage(r, 'zzz', { name: 'x', verdict: 'ok' }));
    assert.doesNotThrow(() => closeItem(r, 'zzz', 'done'));
  });

  it('an unrecognized outcome becomes `failed`, never silently accepted', () => {
    const r = open();
    closeItem(r, 'a', 'finished-ish');
    assert.equal(r.items.find((x) => x.id === 'a').outcome, 'failed');
  });
});

describe('pipelineRun — the re-run rule (§5.7)', () => {
  it('an item with an open case is marked already-open, not re-processed', () => {
    const r = markAlreadyOpen(open(), ['b']);
    assert.equal(r.items.find((x) => x.id === 'b').outcome, 'already-open');
    assert.equal(r.items.find((x) => x.id === 'a').outcome, 'not-run');
  });
  it('it never overwrites an item that already reached a verdict', () => {
    const r = open();
    closeItem(r, 'b', 'done');
    markAlreadyOpen(r, ['b']);
    assert.equal(r.items.find((x) => x.id === 'b').outcome, 'done');
  });
});

describe('pipelineRun — the run verdict (§9.7)', () => {
  it('every accepted item done → complete', () => {
    assert.equal(runVerdict(finish(open(), [['a', 'done'], ['b', 'done'], ['c', 'done']])), 'complete');
  });

  it('THE CASE THIS EXISTS FOR: 3 of 22 processed then stopped → partial, never complete', () => {
    const r = openRun({ items: Array.from({ length: 22 }, (_, i) => ({ id: String(i) })), now: 1 });
    ['0', '1', '2'].forEach((id) => closeItem(r, id, 'done'));
    closeRun(r, { now: 2 });
    assert.equal(runVerdict(r), 'partial');
    assert.match(runTally(r), /19 not run/);
  });

  it('a CAPPED run that did everything it accepted is still partial', () => {
    const r = finish(open({ cap: 2 }), [['a', 'done'], ['b', 'done']]);
    assert.equal(runVerdict(r), 'partial', 'a capped run reporting complete is silent truncation one layer up');
  });

  it('any failure makes it partial, not complete', () => {
    assert.equal(runVerdict(finish(open(), [['a', 'done'], ['b', 'failed'], ['c', 'done']])), 'partial');
  });

  it('everything failed → failed', () => {
    assert.equal(runVerdict(finish(open(), [['a', 'failed'], ['b', 'failed'], ['c', 'failed']])), 'failed');
  });

  it('ran but nothing reached a verdict → failed, not complete', () => {
    assert.equal(runVerdict(closeRun(open(), { now: 2 })), 'failed');
  });

  it('an aborted run is partial even when everything it touched succeeded', () => {
    const r = open();
    ['a', 'b', 'c'].forEach((id) => closeItem(r, id, 'done'));
    closeRun(r, { now: 2, aborted: true });
    assert.equal(runVerdict(r), 'partial', 'a user stop is not a clean finish');
  });

  it('no items → empty; still open → running', () => {
    assert.equal(runVerdict(openRun({ items: [], now: 1 })), 'empty');
    assert.equal(runVerdict(open()), 'running');
    assert.equal(runVerdict(null), 'failed');
  });

  it('every verdict it can return is in the declared set', () => {
    const seen = ['complete', 'partial', 'failed', 'empty', 'running'];
    for (const v of seen) assert.ok(RUN_VERDICTS.includes(v));
  });
});

describe('pipelineRun — the lines (§5.5)', () => {
  it('the tally names every class including the zeroes', () => {
    const t = runTally(finish(open(), [['a', 'done'], ['b', 'blocked'], ['c', 'done']]));
    assert.match(t, /2 done/); assert.match(t, /0 failed/);
    assert.match(t, /1 blocked/); assert.match(t, /0 already open/);
  });
  it('the start line carries the run id, count, stages and cap', () => {
    const l = runStartLine(open({ cap: 24 }));
    assert.match(l, /^PIPELINE ▸ start run=/);
    assert.match(l, /stages=read→branch/);
    assert.match(l, /cap=24/);
  });
  it('the end line carries the VERDICT, so nobody infers it from counts', () => {
    assert.match(runEndLine(finish(open(), [['a', 'done'], ['b', 'done'], ['c', 'done']])), /→ complete$/);
  });
  it('the lines never throw on a null run', () => {
    assert.doesNotThrow(() => runStartLine(null));
    assert.doesNotThrow(() => runEndLine(null));
    assert.doesNotThrow(() => runTally(null));
  });
  it('every declared item outcome is countable by the tally', () => {
    const r = openRun({ items: ITEM_OUTCOMES.map((o, i) => ({ id: String(i) })), now: 1 });
    ITEM_OUTCOMES.forEach((o, i) => closeItem(r, String(i), o));
    closeRun(r, { now: 2 });
    assert.doesNotThrow(() => runTally(r));
  });
});

describe('pipelineRun — the trial tag (§10.1)', () => {
  it('is derived from the run id, so residue is findable without a captured record id', () => {
    assert.equal(trialTag({ runId: 'run_abc' }), 'orchard-trial-run_abc');
  });
  it('degrades rather than throwing', () => {
    assert.equal(trialTag(null), 'orchard-trial-unknown');
  });
});
