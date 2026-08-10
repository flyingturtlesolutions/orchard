// Core/pipelineCase.test.js — the per-item case sidecar (v2.74.1665).
//
// Two properties carry the weight: a re-run must GROW one case rather than mint a second (the vitals
// open-or-append shape), and "failed" must stay distinguishable from "never ran" — the distinction the existing
// `_runChildTask` path collapses and then discards.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  caseId, caseItemKey, upsertCase, setBranch, addStage, addAction, closeCase,
  openCases, openItemIds, casePeek, caseActionLine, caseTally, CASE_CAP, CASE_STATES,
} from './pipelineCase.js';
import { openRun, markAlreadyOpen } from './pipelineRun.js';

const mk = (over = {}) => upsertCase([], { pipeline: 'warranty', itemId: '10834758', label: 'Task 10834758', runId: 'run_1', now: 100, ...over });

describe('pipelineCase — identity', () => {
  it('the id is DETERMINISTIC per (pipeline, item) — that is what makes the re-run rule checkable', () => {
    assert.equal(caseId('warranty', '10834758'), caseId('warranty', '10834758'));
    assert.notEqual(caseId('warranty', 'a'), caseId('warranty', 'b'));
    assert.notEqual(caseId('warranty', 'a'), caseId('outreach', 'a'));
  });
  // v2.74.2172 — the live defect this rule exists to stop. The caller keyed cases by ARRAY POSITION, so index 3
  // of today's list and index 3 of yesterday's resolved to the SAME case id — one task's run appended onto
  // another task's case. Live 13:09:21: `case division lookup MISS … matched=y div="" of 200 case(s); labels:
  // "03" · "01" · "01" · "01"` — the store full of chimeras, and a case matching the wanted label while the
  // division sat on a different one.
  it('the item key is the RECORD, so the same task keeps one case across runs whatever its position', () => {
    const task = { TaskId: 4903279, AddressLine1: '1565 Fairlie Way' };
    assert.equal(caseItemKey(task, 0), '4903279');
    assert.equal(caseItemKey(task, 7), '4903279', 'position must not enter the key');
    assert.equal(caseId('warranty', caseItemKey(task, 0)), caseId('warranty', caseItemKey(task, 7)));
  });

  it('two different tasks at the same position get DIFFERENT cases (the chimera this prevents)', () => {
    const a = caseId('warranty', caseItemKey({ TaskId: 111 }, 3));
    const b = caseId('warranty', caseItemKey({ TaskId: 222 }, 3));
    assert.notEqual(a, b);
  });

  it('falls back to a MARKED positional key when the row carries no id at all', () => {
    assert.equal(caseItemKey({ Address: 'somewhere' }, 4), 'idx:4');
    assert.equal(caseItemKey(null, 0), 'idx:0', 'never throws — a case must still open');
    // The marker matters: a reader must be able to tell a record key from a position, so a future migration can
    // find the ones that were never really identified.
    assert.match(caseItemKey({}, 2), /^idx:/);
  });

  it('prefers TaskId, then TicketId, then TaskNumber — the ref the drive joins on', () => {
    assert.equal(caseItemKey({ TaskId: 1, TicketId: 2, TaskNumber: '3' }), '1');
    assert.equal(caseItemKey({ TicketId: 2, TaskNumber: '3' }), '2');
    assert.equal(caseItemKey({ TaskNumber: '3' }), '3');
  });

  it('sanitizes ids without collapsing distinct items together', () => {
    assert.match(caseId('war ranty!', '108/347'), /^pc_[a-zA-Z0-9_-]+_[a-zA-Z0-9_-]+$/);
    assert.notEqual(caseId('p', 'a/b'), caseId('p', 'a_c'));
  });
});

describe('pipelineCase — open-or-append (the vitals shape, §9.3)', () => {
  it('a RE-RUN grows one case instead of minting a second', () => {
    const first = mk({ line: 'run 1' });
    assert.equal(first.opened, true);
    const second = upsertCase(first.list, { pipeline: 'warranty', itemId: '10834758', runId: 'run_2', line: 'run 2', now: 200 });
    assert.equal(second.opened, false, 'a second case for the same record is case-spam');
    assert.equal(second.list.length, 1);
    assert.equal(second.list[0].timeline.length, 2);
    assert.deepEqual(second.list[0].runIds, ['run_1', 'run_2']);
  });

  it('a CLOSED case does not block a new one — the item can come back later', () => {
    const first = mk();
    const closed = closeCase(first.list, first.id, { state: 'done', now: 150 });
    const again = upsertCase(closed, { pipeline: 'warranty', itemId: '10834758', now: 200 });
    assert.equal(again.opened, true);
    assert.equal(again.list.length, 2);
  });

  it('stores a record REFERENCE, never the record body', () => {
    const r = mk({ record: { ref: 'gid://1', host: 'x.com', url: 'https://x.com/1', Instructions: 'SECRET', Address: '12 Elm St' } });
    const rec = r.list[0].record;
    assert.deepEqual(Object.keys(rec).sort(), ['division', 'host', 'ref', 'url']);
    assert.equal(JSON.stringify(rec).includes('SECRET'), false, 'the body must not be duplicated into a second store');
    assert.equal(JSON.stringify(rec).includes('Elm'), false);
  });

  // v2.74.2156 — the SCOPE half of the ref. A VendorSuite task has no per-record URL; it is reachable only as
  // (division, row text), so a case that banks the id and drops the division banked half a reference.
  it('banks the record DIVISION — the scope half of a ref with no URL', () => {
    const r = mk({ record: { ref: '10834758', host: 'vendorsuite.example', url: '', division: 'Greensboro' } });
    assert.equal(r.list[0].record.division, 'Greensboro');
  });

  it('a record with no division banks an empty one, never undefined', () => {
    const r = mk({ record: { ref: '10834758', host: 'vendorsuite.example', url: '' } });
    assert.equal(r.list[0].record.division, '', 'a reader must not have to distinguish absent from unknown');
  });

  // v2.74.2170 — the live defect. Every case in the store was opened BEFORE `division` joined the whitelist, and
  // the append branch wrote only the timeline + run id — so re-running the flow could never bank one, however
  // many times it ran. `PIPELINE ▸ cases … div 2/2` (the panel's count of what it SENT) and `divsrc=none` (the
  // drive's read of what was STORED) were both honest, about two different things.
  it('an APPEND backfills a reference field the first open did not have', () => {
    const first = mk({ record: { ref: '10834758', host: 'vendorsuite.example', url: '' } });
    assert.equal(first.list[0].record.division, '');
    const again = upsertCase(first.list, {
      pipeline: 'warranty', itemId: '10834758', now: 200,
      record: { ref: '10834758', host: 'vendorsuite.example', url: '', division: 'Greensboro' },
    });
    assert.equal(again.opened, false, 'still one case — the backfill must not mint a second');
    assert.equal(again.list[0].record.division, 'Greensboro', 'a re-run is how an older case gains a new ref field');
  });

  it('an APPEND creates the whole reference when the first open had none', () => {
    const first = mk({ record: null });
    assert.equal(first.list[0].record, null);
    const again = upsertCase(first.list, {
      pipeline: 'warranty', itemId: '10834758', now: 200,
      record: { ref: '10834758', host: 'vendorsuite.example', url: '', division: 'Greensboro' },
    });
    assert.deepEqual(again.list[0].record, { ref: '10834758', host: 'vendorsuite.example', url: '', division: 'Greensboro' });
  });

  // MONOTONE: fill blanks only. A later run that has lost the division (stale context, a narrower read) must not
  // be able to erase the reading taken when the row was first read — that property is what lets the merge run
  // unconditionally on every append without a policy about which read wins.
  it('an APPEND never overwrites a banked value — not with a blank, not with a different one', () => {
    const first = mk({ record: { ref: '10834758', host: 'vendorsuite.example', url: '', division: 'Greensboro' } });
    const blanked = upsertCase(first.list, { pipeline: 'warranty', itemId: '10834758', now: 200, record: { ref: '10834758', division: '' } });
    assert.equal(blanked.list[0].record.division, 'Greensboro', 'a blank must not erase');
    assert.equal(blanked.list[0].record.host, 'vendorsuite.example', 'nor may an omitted field');
    const other = upsertCase(blanked.list, { pipeline: 'warranty', itemId: '10834758', now: 300, record: { ref: '10834758', division: 'Columbus' } });
    assert.equal(other.list[0].record.division, 'Greensboro', 'the first reading stands');
  });

  it('an APPEND with no record at all leaves the banked one untouched', () => {
    const first = mk({ record: { ref: '10834758', host: 'vendorsuite.example', url: '', division: 'Greensboro' } });
    const again = upsertCase(first.list, { pipeline: 'warranty', itemId: '10834758', now: 200, line: 'run 2' });
    assert.deepEqual(again.list[0].record, { ref: '10834758', host: 'vendorsuite.example', url: '', division: 'Greensboro' });
  });

  it('an APPEND backfills an EMPTY label — a case must not stay nameless because its first write had none', () => {
    const first = upsertCase([], { pipeline: 'warranty', itemId: '10834758', now: 100 });
    assert.equal(first.list[0].label, '');
    const again = upsertCase(first.list, { pipeline: 'warranty', itemId: '10834758', label: '#10834758 · 7356 AXEL CREEK ST', now: 200 });
    assert.equal(again.list[0].label, '#10834758 · 7356 AXEL CREEK ST');
    const third = upsertCase(again.list, { pipeline: 'warranty', itemId: '10834758', label: 'something else', now: 300 });
    assert.equal(third.list[0].label, '#10834758 · 7356 AXEL CREEK ST', 'a named case keeps its name');
  });

  // The caller reports what the STORE holds, not what it sent — the v2137 lesson one layer down.
  it('the return carries the STORED reference, on create and on append alike', () => {
    const first = mk({ record: { ref: '10834758', host: 'vendorsuite.example', url: '' } });
    assert.equal(first.record.division, '', 'create echoes the stored ref');
    const again = upsertCase(first.list, {
      pipeline: 'warranty', itemId: '10834758', now: 200,
      record: { ref: '10834758', division: 'Greensboro' },
    });
    assert.equal(again.record.division, 'Greensboro', 'append echoes the ref AFTER the backfill');
  });

  it('refuses to mint without a pipeline and item', () => {
    assert.equal(upsertCase([], { itemId: 'a' }).opened, false);
    assert.equal(upsertCase([], { pipeline: 'p' }).opened, false);
  });

  it('the cap ages out CLOSED cases first and never evicts an open one', () => {
    let list = [];
    for (let i = 0; i < CASE_CAP; i++) {
      const r = upsertCase(list, { pipeline: 'p', itemId: `i${i}`, now: i });
      list = i % 2 === 0 ? closeCase(r.list, r.id, { state: 'done', now: i }) : r.list;
    }
    const before = openCases(list, 'p').length;
    const r = upsertCase(list, { pipeline: 'p', itemId: 'newest', now: 9999 });
    assert.equal(r.list.length, CASE_CAP);
    assert.equal(openCases(r.list, 'p').length, before + 1, 'an open case is work someone still owes a decision on');
  });
});

describe('pipelineCase — the record a reviewer reads (§5.7)', () => {
  it('a FAILED stage and a NEVER-RUN stage are distinguishable', () => {
    const r = mk();
    let l = addStage(r.list, r.id, { name: 'lookup', verdict: 'failed', error: new Error('timeout') });
    const c = l[0];
    assert.equal(c.stages.length, 1);
    assert.equal(c.stages[0].error, 'timeout');
    assert.ok(!c.stages.some((s) => s.name === 'upsert'), 'a stage that never ran has NO placeholder entry');
  });

  it('the branch outcome records arm / none / unknown WITH the skipped arms', () => {
    const r = mk();
    let l = setBranch(r.list, r.id, { outcome: 'arm', arm: 'replacements', why: 'ships a new unit', skipped: ['outreach'] });
    assert.equal(l[0].branch.arm, 'replacements');
    assert.deepEqual(l[0].branch.skippedArms, ['outreach']);
    l = setBranch(l, r.id, { outcome: 'unknown', why: 'contradictory' });
    assert.equal(l[0].branch.outcome, 'unknown');
    assert.equal(l[0].branch.arm, '');
  });

  it('actions carry approval state', () => {
    const r = mk();
    let l = addAction(r.list, r.id, { what: 'draft order', state: 'queued-for-approval', ref: 'p_1' });
    l = addAction(l, r.id, { what: 'send email', state: 'refused' });
    assert.equal(l[0].actions.length, 2);
    assert.equal(l[0].actions[1].state, 'refused');
  });

  it('`blocked` is a distinct terminal state from `failed`', () => {
    const r = mk();
    const l = closeCase(r.list, r.id, { state: 'blocked', verdict: 'lookup unreachable', now: 200 });
    assert.equal(l[0].state, 'blocked');
    assert.notEqual(l[0].state, 'failed');
    assert.equal(l[0].closedAt, 200);
  });

  it('an unrecognized close state becomes `failed`, and `open` cannot be a close', () => {
    const r = mk();
    assert.equal(closeCase(r.list, r.id, { state: 'finished' })[0].state, 'failed');
    assert.equal(closeCase(r.list, r.id, { state: 'open' })[0].state, 'failed');
  });

  it('mutators on an unknown id are no-ops rather than throws', () => {
    const r = mk();
    for (const fn of [() => addStage(r.list, 'nope', { name: 'x', verdict: 'ok' }), () => addAction(r.list, 'nope', { what: 'x', state: 'done' }), () => setBranch(r.list, 'nope', { outcome: 'none' }), () => closeCase(r.list, 'nope', {})]) {
      assert.doesNotThrow(fn);
      assert.equal(fn().length, 1);
    }
  });

  it('every declared state is closable (the list and the closer cannot drift)', () => {
    for (const s of CASE_STATES.filter((x) => x !== 'open')) {
      const r = mk();
      assert.equal(closeCase(r.list, r.id, { state: s })[0].state, s);
    }
  });
});

describe('pipelineCase — feeding the re-run rule (§5.7)', () => {
  it('openItemIds drives markAlreadyOpen, so a re-run skips items already under review', () => {
    let l = mk({ itemId: 'a' }).list;
    l = upsertCase(l, { pipeline: 'warranty', itemId: 'b', now: 2 }).list;
    const doneId = caseId('warranty', 'b');
    l = closeCase(l, doneId, { state: 'done', now: 3 });

    const ids = openItemIds(l, 'warranty');
    assert.deepEqual(ids, ['a'], 'only the OPEN case blocks a re-run');

    const run = markAlreadyOpen(openRun({ items: [{ id: 'a' }, { id: 'b' }], now: 10 }), ids);
    assert.equal(run.items.find((x) => x.id === 'a').outcome, 'already-open');
    assert.equal(run.items.find((x) => x.id === 'b').outcome, 'not-run', 'a closed case must not block re-processing');
  });

  it('scopes by pipeline — another pipeline\'s open case does not block this one', () => {
    let l = mk({ pipeline: 'warranty', itemId: 'a' }).list;
    l = upsertCase(l, { pipeline: 'outreach', itemId: 'a', now: 2 }).list;
    assert.deepEqual(openItemIds(l, 'warranty'), ['a']);
    assert.equal(openCases(l, 'warranty').length, 1);
    assert.equal(openCases(l).length, 2, 'unscoped returns both');
  });
});

describe('pipelineCase — the Rail peek', () => {
  it('leads with the STATE, because the case row has no status glyph', () => {
    const r = mk({ label: 'Task A' });
    assert.match(casePeek(r.list[0]), /^○ Task A/);
    const done = closeCase(setBranch(r.list, r.id, { outcome: 'arm', arm: 'replacements' }), r.id, { state: 'done', verdict: 'draft created' });
    assert.match(casePeek(done[0]), /^✓ Task A — replacements · draft created/);
  });
  it('degrades without throwing', () => {
    assert.equal(casePeek(null), '');
  });
  it('the tally names every class including the zeroes', () => {
    const t = caseTally(mk().list, 'warranty');
    assert.match(t, /1 open/); assert.match(t, /0 done/); assert.match(t, /0 blocked/); assert.match(t, /0 failed/);
  });
});

describe('pipelineCase — caseActionLine: what the row says is OWED (v2.74.2134)', () => {
  const withAction = (state, what) => ({ id: 'c1', label: '#4899327', state: 'open', stages: [], actions: [{ what, state, ref: '' }] });
  it('a queued action reads as awaiting the human, and names the act', () => {
    const line = caseActionLine(withAction('queued-for-approval', 'email: no-count -> dana@example.com (contact method "Any")'));
    assert.match(line, /^▸ awaiting you — email: no-count/);
  });
  it('a refusal reads as declined, WITH its reason — that is what makes it overridable', () => {
    const line = caseActionLine(withAction('refused', 'unresolved: other-trade (reads as another trade)'));
    assert.match(line, /^· declined — unresolved: other-trade \(reads as another trade\)/);
  });
  it('a done action reads as done', () => {
    assert.match(caseActionLine(withAction('done', 'email sent')), /^✓ done/);
  });
  it('the LATEST action wins — an override must not be hidden behind the original decision', () => {
    const c = { id: 'c', label: 'x', state: 'open', stages: [], actions: [
      { what: 'unresolved: other-trade', state: 'refused' },
      { what: 'email: overridden by you', state: 'queued-for-approval' },
    ] };
    assert.match(caseActionLine(c), /awaiting you — email: overridden by you/);
  });
  it('a case with no actions yields an empty line rather than a placeholder', () => {
    assert.equal(caseActionLine({ id: 'c', label: 'x', state: 'open', stages: [], actions: [] }), '');
    assert.equal(caseActionLine(null), '');
  });
  it('casePeek returns a STRING — the list must use it directly', () => {
    // The overlay read `peek.line` on this string, which is undefined, so every row showed the word "open" and
    // the arm/verdict was discarded. Pinning the type here so the caller cannot regress to property access.
    const peek = casePeek({ id: 'c', label: '#1', state: 'open', stages: [], branch: { outcome: 'arm', arm: 'contact homeowner' } });
    assert.equal(typeof peek, 'string');
    assert.match(peek, /contact homeowner/);
  });
});
