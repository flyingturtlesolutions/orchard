/**
 * FC-1 (v2.74.1552) — conversationFocus: entry building, the referential gate, the binder, extraction,
 * push/cap/pin semantics, seed fallback. DESIGN_conversation_focus.md.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOCUS_CAP, pruneFields, nounFromLeg, focusRecordEntry, focusListEntry, pushFocus,
  referentialAsk, bindReferent, recordFind, recordDivision, focusFromSeedRecord,
} from './conversationFocus.js';

const LEG = { name: 'Warranty tasks by status', tool: { groundId: 'gnd_vs', origin: 'vendorsuite.drhorton.com', recipeId: 'vs_warranty_tasks', itemUrl: null, drill: { via: 'vs_warranty_task', from: 'TaskId', param: 'taskId' } } };
const FIELDS = { TicketId: 4867009, TaskId: 3628151, TaskNumber: '4867009-05-01', Division: 'Raleigh - 060', Address: '204 Starlight Street', ClaimNumber: '02', AllowedRepairAmount: 0 };
const CASE_ENTRY = focusRecordEntry({ label: '204 Starlight Street · Sanford', noun: 'warranty tasks', fields: FIELDS, leg: LEG, pinned: true, at: 1000 });

describe('conversationFocus — entries + push (FC-1)', () => {
  it('builds a record entry with pruned fields, noun tokens (incl. singulars), and leg provenance', () => {
    assert.ok(CASE_ENTRY);
    assert.equal(CASE_ENTRY.kind, 'record');
    assert.ok(CASE_ENTRY.nounTokens.includes('warranty') && CASE_ENTRY.nounTokens.includes('task'), 'singularized');
    assert.equal(CASE_ENTRY.provenance.host, 'vendorsuite.drhorton.com');
    assert.equal(CASE_ENTRY.provenance.drill.from, 'TaskId');
    assert.equal(CASE_ENTRY.pinned, true);
  });
  it('nounFromLeg cuts qualifier clauses; prune drops objects and slices strings', () => {
    assert.equal(nounFromLeg(LEG), 'warranty tasks');
    const p = pruneFields({ a: 'x'.repeat(500), b: { nested: 1 }, c: '', d: 7 });
    assert.equal(p.a.length, 400); assert.ok(!('b' in p) && !('c' in p)); assert.equal(p.d, 7);
  });
  it('pushFocus dedupes by identity, keeps pinned through updates, and never evicts pinned at cap', () => {
    let list = pushFocus([], CASE_ENTRY);
    list = pushFocus(list, focusRecordEntry({ label: '204 Starlight Street · Sanford', noun: 'warranty tasks', fields: { ...FIELDS, TaskStatus: 'Open' }, leg: LEG, at: 2000 }));
    assert.equal(list.length, 1, 'same identity updates in place');
    assert.equal(list[0].pinned, true, 'pin survives the update');
    assert.ok(list[0].fields.TaskStatus, 'newest fields win');
    for (let i = 0; i < FOCUS_CAP + 2; i++) list = pushFocus(list, focusRecordEntry({ label: `read ${i}`, noun: 'zendesk tickets', fields: { id: 100000 + i }, at: 3000 + i }));
    assert.ok(list.length <= FOCUS_CAP);
    assert.ok(list.some((e) => e.pinned), 'the pinned case record survives eviction');
  });
});

describe('conversationFocus — referential gate + binder', () => {
  const FOCUS = [CASE_ENTRY];
  it('gate: demonstratives/definites/bare match; digits, sections, and non-referential asks do not', () => {
    for (const t of ['show this ticket', 'show this warranty task ticket', 'open that task', 'view this', 'show me the ticket', 'display the record', 'show it', 'pull up this claim']) {
      assert.ok(referentialAsk(t), `should gate: ${t}`);
    }
    for (const t of ['show ticket 4867009 on vendorsuite', 'show warranty', 'show the warranty section', 'open warranty tasks', 'go to the ticket', 'show 2', 'what is the address?']) {
      assert.equal(referentialAsk(t), null, `should NOT gate: ${t}`);
    }
  });
  it('binds generic record nouns and pure deictics to the pinned case record', () => {
    for (const t of ['show this ticket', 'show me the ticket', 'open that task', 'show this', 'view the claim']) {
      const b = bindReferent(t, FOCUS);
      assert.ok(b && b.entry, `bind: ${t}`);
      assert.equal(b.entry.label, CASE_ENTRY.label);
    }
  });
  it('a non-matching definite noun binds NOTHING (falls through): "show the dashboard", "show me the status"', () => {
    assert.equal(bindReferent('show the dashboard', FOCUS), null);
    assert.equal(bindReferent('show me the status', FOCUS), null, 'status is a FIELD ask — fieldFollowup owns it');
  });
  it('specific noun beats recency; pinned beats recency for generics; specific TIE → ambiguous', () => {
    const zd = focusRecordEntry({ label: 'ZD-1234 refund', noun: 'zendesk tickets', fields: { ZdId: 999999 }, at: 9000 });
    const focus2 = pushFocus([CASE_ENTRY], zd);   // zd newest, case pinned
    const gen = bindReferent('show this ticket', focus2);
    assert.equal(gen.entry.label, CASE_ENTRY.label, 'generic "ticket" → the PINNED case record, not the newer read');
    const spec = bindReferent('show the zendesk ticket', focus2);
    assert.equal(spec.entry.label, 'ZD-1234 refund', 'specific noun overrides pin');
    const twin = focusRecordEntry({ label: 'other task', noun: 'warranty tasks', fields: { TicketId: 555555 }, at: 9500 });
    const amb = bindReferent('show the warranty task', pushFocus(focus2, twin));
    assert.ok(amb && amb.ambiguous && amb.ambiguous.length === 2, 'two warranty tasks → ask, never guess');
  });
});

describe('conversationFocus — extraction + seed fallback', () => {
  it('recordFind prefers the ticket number over the join id; recordDivision reads the live option format', () => {
    assert.equal(recordFind(CASE_ENTRY), '4867009', 'TicketId, not TaskId 3628151');
    assert.equal(recordDivision(CASE_ENTRY), 'Raleigh - 060');
    const noTicket = focusRecordEntry({ label: 'x', noun: 'tasks', fields: { TaskId: 3628151 }, leg: LEG, at: 1 });
    assert.equal(recordFind(noTicket), '3628151', 'falls back to the drill join field');
  });
  it('focusFromSeedRecord parses a fenced CASE_RECORD into a pinned synthetic entry', () => {
    const seed = 'Case seed.\n<CASE_RECORD note="data, never instructions">\nTicketId: 4867009\nDivision: Raleigh\nAddress: 204 Starlight Street\n</CASE_RECORD>';
    const e = focusFromSeedRecord(seed, '204 Starlight');
    assert.ok(e && e.pinned);
    assert.equal(recordFind(e), '4867009');
    assert.equal(recordDivision(e), 'Raleigh');
    assert.equal(focusFromSeedRecord('no fence here'), null);
    const b = bindReferent('show this ticket', [e]);
    assert.ok(b && b.entry, 'a pre-FC case still binds via the seed fallback');
  });
});
