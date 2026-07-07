// Core/sweepPrompt.test.js — FL-1 (v2.74.1346): the propose-only sweep's think seams. The load-bearing property is
// ANTI-HALLUCINATION: every read pick and every proposal must resolve to an OFFERED leg, or it's silently dropped.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSweepReadsMessages, buildSweepProposeMessages, parseSweepReads, parseSweepProposals } from './sweepPrompt.js';
import { normalizeProposal, canBulkApprove, getPath, pendingSummary } from './proposals.js';
import { ledgerEntry, summarizeLedger, renderLedgerLines } from './actionLedger.js';

const ASK_LEGS = [
  { key: 'me.zendesk.my_open_tickets@d.zendesk.com', name: 'My open tickets', does: 'List open tickets', mode: 'ask', safety: 'auto', domain: 'connector', paramSchema: { type: 'object', properties: {} } },
  { key: 'me.zendesk.read_ticket@d.zendesk.com', name: 'Read ticket', does: 'Read one ticket', mode: 'ask', safety: 'auto', domain: 'connector', paramSchema: { type: 'object', properties: { id: { type: 'integer' } } } },
];
const ACT_LEGS = [
  { key: 'me.zendesk.merge_tickets@d.zendesk.com', name: 'Merge tickets', does: 'Merge duplicates', mode: 'act', safety: 'gated', domain: 'connector' },
  { key: 'me.zendesk.solve_ticket@d.zendesk.com', name: 'Solve ticket', does: 'Mark solved', mode: 'act', safety: 'confirm', domain: 'connector' },
  { key: 'me.zendesk.assign_ticket@d.zendesk.com', name: 'Assign ticket', does: 'Set assignee', mode: 'act', safety: 'confirm', domain: 'connector' },
];

describe('sweepPrompt — phase A (pick reads)', () => {
  it('builds messages carrying goal/learned/objects + the offered read tools', () => {
    const { system, user } = buildSweepReadsMessages({ seed: 'Keep the queue clean', learned: 'RULE: never touch vip', objects: 'ticket: open|pending', legs: ASK_LEGS, maxReads: 3 });
    assert.ok(system.includes('PLANS THE READS'));
    assert.ok(user.includes('<GOAL>') && user.includes('Keep the queue clean'));
    assert.ok(user.includes('<LEARNED>') && user.includes('never touch vip'));
    assert.ok(user.includes('my_open_tickets'));
  });
  it('parse validates against the offered legs, dedups, and caps at maxReads', () => {
    const raw = JSON.stringify({ reads: [
      { key: 'me.zendesk.my_open_tickets@d.zendesk.com', params: {} },
      { key: 'me.zendesk.my_open_tickets@d.zendesk.com', params: {} },      // dup — dropped
      { key: 'made.up.leg', params: {} },                                    // hallucinated — dropped
      { key: 'me.zendesk.read_ticket@d.zendesk.com', params: { id: 7 } },
    ] });
    const reads = parseSweepReads(raw, { legs: ASK_LEGS, maxReads: 3 });
    assert.deepEqual(reads.map((r) => r.key), ['me.zendesk.my_open_tickets@d.zendesk.com', 'me.zendesk.read_ticket@d.zendesk.com']);
    assert.deepEqual(reads[1].params, { id: 7 });
  });
  it('garbage / empty output → no reads (a sweep can proceed to propose on nothing)', () => {
    assert.deepEqual(parseSweepReads('not json at all', { legs: ASK_LEGS }), []);
    assert.deepEqual(parseSweepReads(null, { legs: ASK_LEGS }), []);
  });
});

describe('sweepPrompt — phase B (propose)', () => {
  it('fences read results as DATA and offers only act tools', () => {
    const { system, user } = buildSweepProposeMessages({ seed: 's', legs: ACT_LEGS, results: [{ key: 'r1', value: { tickets: [{ id: 1 }] } }] });
    assert.ok(system.includes('PROPOSALS'));
    assert.ok(user.includes('<SWEEP_DATA>') && user.includes('"tickets"'));
    assert.ok(user.includes('Merge tickets'));
  });
  it('parse: hallucinated keys dropped, one-proposal-per-target enforced, leg snapshot + safety attached', () => {
    const raw = JSON.stringify({ proposals: [
      { key: 'me.zendesk.merge_tickets@d.zendesk.com', params: { survivor: 1, loser: 2 }, targets: ['1', '2'], why: 'same requester, same error', evidence: ['"printer crash"'], basedOn: { readKey: 'r1', path: 'tickets[1].updated_at', value: '2026-07-07T10:00:00Z' } },
      { key: 'me.zendesk.solve_ticket@d.zendesk.com', params: { id: 2 }, targets: ['2', '1'], why: 'dup of the merge above' },   // same target set — dropped
      { key: 'not.offered', params: {}, targets: ['9'], why: 'x' },                                                             // hallucinated — dropped
      { key: 'me.zendesk.assign_ticket@d.zendesk.com', params: { id: 5, assignee: 'sara' }, targets: ['5'], why: 'billing → Sara' },
    ], summary: '2 actions' });
    const { proposals, summary } = parseSweepProposals(raw, { legs: ACT_LEGS });
    assert.equal(proposals.length, 2);
    assert.equal(summary, '2 actions');
    assert.equal(proposals[0].safety, 'gated');                                  // from the LEG, not the LLM
    assert.equal(proposals[0].leg.key, 'me.zendesk.merge_tickets@d.zendesk.com');
    assert.deepEqual(proposals[0].basedOn, { readKey: 'r1', path: 'tickets[1].updated_at', value: '2026-07-07T10:00:00Z' });
    assert.equal(proposals[1].name, 'Assign ticket');
  });
});

describe('proposals — normalize / bulk class / getPath / summary', () => {
  it('normalizeProposal rejects unofferable legs and coerces shapes', () => {
    assert.equal(normalizeProposal({ key: 'nope', params: {} }, { legs: ACT_LEGS }), null);
    const n = normalizeProposal({ key: ACT_LEGS[1].key, params: { id: 3 }, targets: [3], why: 'w', evidence: ['e'] }, { legs: ACT_LEGS });
    assert.equal(n.safety, 'confirm');
    assert.deepEqual(n.targets, ['3']);
  });
  it('canBulkApprove: auto/confirm yes; gated (destructive-class) never', () => {
    assert.equal(canBulkApprove({ safety: 'confirm' }), true);
    assert.equal(canBulkApprove({ safety: 'auto' }), true);
    assert.equal(canBulkApprove({ safety: 'gated' }), false);
    assert.equal(canBulkApprove(null), false);
  });
  it('getPath walks dots and [n]; undefined on any miss', () => {
    const o = { tickets: [{ id: 1, updated_at: 'T1' }] };
    assert.equal(getPath(o, 'tickets[0].updated_at'), 'T1');
    assert.equal(getPath(o, 'tickets[3].updated_at'), undefined);
    assert.equal(getPath(null, 'a'), undefined);
  });
  it('pendingSummary counts by name over pending only', () => {
    const s = pendingSummary([
      { status: 'pending', name: 'Merge tickets' }, { status: 'pending', name: 'Merge tickets' },
      { status: 'executed', name: 'Solve ticket' }, { status: 'pending', name: 'Assign ticket' },
    ]);
    assert.ok(s.startsWith('3 pending'));
    assert.ok(s.includes('2× Merge tickets'));
  });
});

describe('actionLedger — entries + window aggregation', () => {
  it('summarizeLedger windows by sinceMs and counts executions by action', () => {
    const now = 1_000_000_000;
    const items = [
      ledgerEntry('sweep', { counts: { proposals: 3 } }, now - 7200_000),
      ledgerEntry('execution', { action: 'Merge tickets', ok: true }, now - 1800_000),
      ledgerEntry('execution', { action: 'Merge tickets', ok: true }, now - 600_000),
      ledgerEntry('execution', { action: 'Solve ticket', ok: false, error: 'stale' }, now - 300_000),
      ledgerEntry('decision', { status: 'rejected', action: 'Assign ticket', reason: 'wrong person' }, now - 100_000),
    ];
    const hour = summarizeLedger(items, { sinceMs: 3600_000, now });
    assert.equal(hour.total, 4);                                     // the 2h-old sweep is outside the window
    assert.equal(hour.executedByAction['Merge tickets'], 2);         // "how many merges in the last hour" — THE ask
    assert.equal(hour.executedByAction['Solve ticket'], undefined);  // failed execution doesn't count as done
    const all = summarizeLedger(items, { now });
    assert.equal(all.total, 5);
  });
  it('renderLedgerLines: newest first, human-shaped', () => {
    const lines = renderLedgerLines([
      ledgerEntry('proposal', { action: 'Merge tickets', targets: ['1', '2'], why: 'same issue' }, 1000),
      ledgerEntry('execution', { action: 'Merge tickets', targets: ['1', '2'], ok: true }, 2000),
    ]);
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('✓ executed'));
    assert.ok(lines[1].includes('proposed'));
  });
});
