// Core/runHistory.test.js — CD-5: the run-history entry shape + retention (DESIGN_cadence.md §6.3/§6.4). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runHistoryEntry, appendRun, truncationNotice, describeRunCounts, describeRun, historyTally,
  normalizeHistoryItems, groupHistoryItems, filterLogsForRun, explainPartialWhy,
  normalizeHistoryTrace, formatTraceLines,
  HISTORY_CAP, HISTORY_VERDICTS, HISTORY_ITEM_CAP,
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
  // WFP-4 (§12.5) — the park CAUSE is a whitelisted field, closed to 'gate'|'paused'; junk is dropped, absent
  // stays absent (readers default absent → 'gate' for legacy records).
  it('carries the park kind through the whitelist; junk and absent stay off the record', () => {
    assert.equal(runHistoryEntry({ at: 1, verdict: 'parked', kind: 'paused' }).kind, 'paused');
    assert.equal(runHistoryEntry({ at: 1, verdict: 'parked', kind: 'gate' }).kind, 'gate');
    assert.equal('kind' in runHistoryEntry({ at: 1, verdict: 'parked', kind: 'vacation' }), false);
    assert.equal('kind' in runHistoryEntry({ at: 1, verdict: 'parked' }), false);
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
  it('v2.74.2026 — map/write outcomes render (the warranty→Shopify history gap)', () => {
    // Live underspec: "3 steps · 20 rows → complete" with matched/no-match/created invisible.
    assert.equal(
      describeRunCounts({ steps: 3, items: 20, matched: 16, noMatch: 2, created: 1 }),
      '20 items · 3 steps · 16 matched · 2 no-match · 1 created',
    );
    // Prefer items over rows when both are present (rows is the lastValue fallback).
    assert.equal(describeRunCounts({ items: 20, rows: 20, matched: 16 }), '20 items · 16 matched');
    assert.equal(describeRunCounts({ rows: 20 }), '20 rows', 'rows alone still scales a read-only run');
  });
  it('describeRun shows BOTH stamps when due ≠ ran (§7.3 — the surface must not claim more than it delivers)', () => {
    assert.match(describeRun({ trigger: 'auto', verdict: 'complete' }, '14:32', '09:00'), /^due 09:00 · ran 14:32 · auto/);
    assert.match(describeRun({ trigger: 'auto', verdict: 'complete' }, '09:00', '09:00'), /^09:00 · auto/, 'same stamp → one clock');
    assert.match(describeRun({ trigger: 'manual', verdict: 'complete' }, '09:00'), /^09:00 · manual/, 'no dueClock → unchanged');
  });
  it('describeRun leads with the clock + auto/manual and flags parked', () => {
    // v2.74.2029 — bare partial is banned; derived why fills in when none was banked.
    assert.equal(describeRun({ trigger: 'auto', counts: { items: 22, matched: 6, parked: 2 }, verdict: 'partial' }, '09:00'),
      '09:00 · auto · 22 items · 6 matched · 2 parked → partial — not all steps finished');
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

describe('runHistory — v2.74.2029 partial explains itself', () => {
  it('explainPartialWhy prefers stopWhy, else finished N of M', () => {
    assert.equal(explainPartialWhy({ stopWhy: 'nothing to create — every row matched' }),
      'nothing to create — every row matched');
    assert.equal(explainPartialWhy({ done: 2, total: 3 }), 'finished 2 of 3 steps');
    assert.equal(explainPartialWhy({ errors: 1 }), '1 step had an error');
    assert.equal(explainPartialWhy({}), 'not all steps finished');
  });
  it('describeRun never leaves bare → partial', () => {
    assert.match(
      describeRun({ trigger: 'manual', verdict: 'partial', counts: { done: 2, total: 3, items: 20, matched: 20 } }, '1:15 PM'),
      /→ partial — finished 2 of 3 steps$/,
    );
    assert.match(
      describeRun({ trigger: 'manual', verdict: 'partial', why: 'nothing to create — every row matched', counts: { items: 20, matched: 20 } }, '1:15 PM'),
      /→ partial — nothing to create — every row matched$/,
    );
  });
});

describe('runHistory — v2.74.2027 drill-down items + log join', () => {
  it('normalizeHistoryItems keeps body-blind kinds, drops junk, caps with prefer', () => {
    const items = normalizeHistoryItems([
      { kind: 'no-match', label: 'Task A' },
      { kind: 'created', label: 'Task B', id: 'gid://shopify/Customer/1' },
      { kind: 'secret', label: 'nope' },
      { kind: 'blocked', label: 'Task C', note: 'already exists' },
      { kind: 'no-match', label: '' },
    ]);
    assert.equal(items.length, 3);
    assert.equal(items[0].kind, 'no-match');
    assert.equal(items[1].id, 'gid://shopify/Customer/1');
    assert.equal(items[2].note, 'already exists');
    const many = [];
    for (let i = 0; i < HISTORY_ITEM_CAP + 10; i++) {
      many.push({ kind: i % 2 ? 'queued' : 'no-match', label: `r${i}` });
    }
    const capped = normalizeHistoryItems(many);
    assert.equal(capped.length, HISTORY_ITEM_CAP);
    assert.ok(capped.every((x) => x.kind === 'no-match' || x.kind === 'queued'));
    assert.ok(capped.filter((x) => x.kind === 'no-match').length >= capped.filter((x) => x.kind === 'queued').length);
  });
  it('runHistoryEntry banks items only when non-empty', () => {
    const e = runHistoryEntry({
      at: 1, verdict: 'complete',
      items: [{ kind: 'no-match', label: 'Ada' }, { kind: 'created', label: 'Bea', id: 'c1' }],
    });
    assert.equal(e.items.length, 2);
    assert.equal(groupHistoryItems(e.items)['no-match'].length, 1);
    assert.equal('items' in runHistoryEntry({ at: 1, verdict: 'complete' }), false);
  });
  it('filterLogsForRun joins by runId and time window', () => {
    const at = Date.parse('2026-08-05T17:00:00.000Z');
    const logs = [
      { timestamp: '2026-08-05T16:59:58.000Z', message: 'WORKFLOW ▸ run=run_abc start' },
      { timestamp: '2026-08-05T17:00:05.000Z', message: 'MAP ▸ 20 × shopify → 18 matched, 2 no-match' },
      { timestamp: '2026-08-05T17:00:10.000Z', message: 'WORKFLOW ▸ run=run_abc end verdict=complete' },
      { timestamp: '2026-08-05T18:00:00.000Z', message: 'unrelated later' },
      { timestamp: '2026-08-05T12:00:00.000Z', message: 'WORKFLOW ▸ run=run_other start' },
    ];
    const hit = filterLogsForRun(logs, { at, ms: 12000, runId: 'run_abc', padMs: 3000 });
    assert.equal(hit.length, 3);
    assert.ok(hit.every((l) => !/unrelated|run_other/.test(l.message)));
    assert.equal(filterLogsForRun(logs, { runId: 'run_other' }).length, 1);
    assert.deepEqual(filterLogsForRun([], { at, runId: 'x' }), []);
  });
  it('v2.74.2030 — time window drops sidecar HTTP noise (GET /workspaces 500)', () => {
    const at = Date.parse('2026-08-05T18:15:25.000Z');
    const logs = [
      { timestamp: '2026-08-05T18:16:05.566Z', message: 'GET /workspaces → 500: Request failed' },
      { timestamp: '2026-08-05T18:16:48.114Z', message: 'MAP ▸ 20 × shopify lookup → 20 matched, 0 no-match' },
      { timestamp: '2026-08-05T18:16:54.197Z', message: 'WRITE ▸ no candidates — the lookup reported no misses' },
      { timestamp: '2026-08-05T18:16:43.600Z', message: 'Message: WORKFLOW_PARKED' },
    ];
    const hit = filterLogsForRun(logs, { at, ms: 90000, runId: 'run_gone' });
    assert.equal(hit.length, 2);
    assert.ok(hit.every((l) => /MAP|WRITE/.test(l.message)));
    assert.equal(formatTraceLines([{ t: 't', m: 'MAP ▸ x' }]), 't MAP ▸ x');
    assert.equal(normalizeHistoryTrace([{ t: 't', m: 'MAP ▸ x' }, { message: '' }]).length, 1);
  });
});
