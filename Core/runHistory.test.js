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
