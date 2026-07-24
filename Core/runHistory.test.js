// Core/runHistory.test.js — CD-5: the run-history entry shape + retention (DESIGN_cadence.md §6.3/§6.4). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runHistoryEntry, appendRun, truncationNotice, describeRunCounts, describeRun, historyTally,
  HISTORY_CAP, HISTORY_VERDICTS,
} from './runHistory.js';

describe('runHistory — runHistoryEntry', () => {
  it('normalizes and defaults unknown trigger/verdict to the safe value', () => {
    const e = runHistoryEntry({ at: 1000, trigger: 'auto', verdict: 'complete', counts: { items: 22, parked: 2 } });
    assert.deepEqual(e, { at: 1000, trigger: 'auto', verdict: 'complete', counts: { items: 22, parked: 2 } });
    const bad = runHistoryEntry({ trigger: 'cron', verdict: 'exploded' });
    assert.equal(bad.trigger, 'manual');
    assert.equal(bad.verdict, 'failed');
  });
  it('carries the optional fields only when meaningful', () => {
    const e = runHistoryEntry({ at: 100, verdict: 'parked', parkedRunId: 'run_x', why: 'write step', coalesced: 3, ranAt: 200 });
    assert.equal(e.parkedRunId, 'run_x');
    assert.equal(e.why, 'write step');
    assert.equal(e.coalesced, 3);      // §7.2 — collapsed backlog
    assert.equal(e.ranAt, 200);        // §7.3 — due != ran
    const clean = runHistoryEntry({ at: 100, verdict: 'complete', coalesced: 1, ranAt: 100 });
    assert.equal('coalesced' in clean, false);  // 1 due-time is not a backlog
    assert.equal('ranAt' in clean, false);      // ran == due, no drift to show
  });
});

describe('runHistory — retention (per workflow, never silent)', () => {
  it('appendRun evicts oldest past the cap', () => {
    let list = [];
    for (let i = 0; i < HISTORY_CAP + 5; i++) list = appendRun(list, runHistoryEntry({ at: i + 1, verdict: 'complete' }), { cap: HISTORY_CAP });
    assert.equal(list.length, HISTORY_CAP);
    assert.equal(list[0].at, 6);                       // first 5 evicted
    assert.equal(list[list.length - 1].at, HISTORY_CAP + 5);
  });
  it('truncationNotice speaks only when runs were dropped', () => {
    assert.equal(truncationNotice(50, 214), 'showing the last 50 of 214');
    assert.equal(truncationNotice(50, 50), '');
    assert.equal(truncationNotice(50, 10), '');        // total can't be below shown
  });
});

describe('runHistory — rendering', () => {
  it('describeRunCounts renders known keys only', () => {
    assert.equal(describeRunCounts({ items: 22, matched: 6, parked: 2 }), '22 items · 6 matched · 2 parked');
    assert.equal(describeRunCounts({ items: 1 }), '1 item');
    assert.equal(describeRunCounts(null), '');
  });
  it('describeRun shows BOTH stamps when due ≠ ran (§7.3 — the surface must not claim more than it delivers)', () => {
    assert.match(describeRun({ trigger: 'auto', verdict: 'complete' }, '14:32', '09:00'), /^due 09:00 · ran 14:32 · auto/);
    assert.match(describeRun({ trigger: 'auto', verdict: 'complete' }, '09:00', '09:00'), /^09:00 · auto/, 'same stamp → one clock');
    assert.match(describeRun({ trigger: 'manual', verdict: 'complete' }, '09:00'), /^09:00 · manual/, 'no dueClock → unchanged');
  });
  it('describeRun leads with the clock + auto/manual and flags parked', () => {
    assert.equal(describeRun({ trigger: 'auto', counts: { items: 22, matched: 6, parked: 2 }, verdict: 'partial' }, '09:00'),
      '09:00 · auto · 22 items · 6 matched · 2 parked → partial');
    assert.match(describeRun({ trigger: 'auto', verdict: 'parked' }, '09:00'), /waiting on you$/);
    assert.match(describeRun({ trigger: 'auto', verdict: 'complete', coalesced: 3 }, '09:00'), /3 due-times collapsed/);
  });
  it('§6.5 (v1746) — the audit fields mint and render: why, ms, failedStep, resume linkage, edit marker, rows', () => {
    // finding 1 — the WHY renders (it was stored-and-hidden), with the re-arm hint on disarms
    const dis = runHistoryEntry({ at: 100, trigger: 'auto', verdict: 'disarmed', why: 'the owning view was deleted' });
    assert.equal(describeRun(dis, '10:20 PM'), '10:20 PM · auto → disarmed — the owning view was deleted (re-arm with ⏱)');
    // duration + rows + the 4-way trigger
    const ok = runHistoryEntry({ at: 100, trigger: 'headless', verdict: 'complete', ms: 24000, counts: { steps: 3, total: 3, done: 3, rows: 11 }, runId: 'run_x1', contentId: 'wf-abc' });
    assert.equal(ok.trigger, 'headless');
    assert.equal(ok.ms, 24000);
    assert.match(describeRun(ok, '9:00 AM'), /3 steps · 11 rows · 24s → complete/);
    // the failing step is the story of a failed run
    const bad = runHistoryEntry({ at: 100, trigger: 'auto', verdict: 'failed', counts: { total: 3 }, failedStep: { i: 1, text: 'read the instructions of each', error: 'field-gone' } });
    assert.match(describeRun(bad, '10:12 AM'), /failed at step 2\/3 — “read the instructions of each” \(field-gone\)/);
    // resume linkage
    const res = runHistoryEntry({ at: 100, trigger: 'resume', verdict: 'complete', resumedFrom: 'run_k3x9' });
    assert.match(describeRun(res, '10:30 AM'), /^10:30 AM · resume · continues run_k3x9/);
    // the edit marker — this run used an earlier revision than the record now holds
    assert.match(describeRun(ok, '9:00 AM', '', { currentContentId: 'wf-DIFFERENT' }), /· earlier steps$/);
    assert.ok(!/earlier steps/.test(describeRun(ok, '9:00 AM', '', { currentContentId: 'wf-abc' })), 'same revision → no marker');
    // legacy entries: unknown trigger still normalizes to manual
    assert.equal(runHistoryEntry({ trigger: 'cron' }).trigger, 'manual');
  });
  it('historyTally counts auto/manual and verdicts', () => {
    const list = [
      runHistoryEntry({ verdict: 'complete', trigger: 'auto' }),
      runHistoryEntry({ verdict: 'parked', trigger: 'auto' }),
      runHistoryEntry({ verdict: 'complete', trigger: 'manual' }),
    ];
    const t = historyTally(list);
    assert.equal(t.total, 3);
    assert.equal(t.auto, 2);
    assert.equal(t.manual, 1);
    assert.equal(t.byVerdict.complete, 2);
    assert.equal(t.byVerdict.parked, 1);
  });
  it('every verdict in the enum has a tally slot (name every class incl. zeroes)', () => {
    const t = historyTally([]);
    for (const v of HISTORY_VERDICTS) assert.equal(t.byVerdict[v], 0);
  });
});
