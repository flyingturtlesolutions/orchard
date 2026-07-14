// Core/sweepPrompt.test.js — FL-1 (v2.74.1346): the propose-only sweep's think seams. The load-bearing property is
// ANTI-HALLUCINATION: every read pick and every proposal must resolve to an OFFERED leg, or it's silently dropped.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSweepReadsMessages, buildSweepProposeMessages, parseSweepReads, parseSweepProposals, minimizeReadValue } from './sweepPrompt.js';
import { normalizeProposal, canBulkApprove, getPath, pendingSummary, targetUrls, autonomyFor, executedTodayByRecipe, filterRejectedRepeats, rejectionContext, supersedePlan, cleanEvidence, isJudgment, renderProposalCards } from './proposals.js';
import { ledgerEntry, summarizeLedger, renderLedgerLines, renderWorkTrace } from './actionLedger.js';

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

describe('sweepPrompt — FL-2b minimizeReadValue (coverage + privacy)', () => {
  it('a list read slims to whitelisted per-item facts with FULL coverage counts (no raw bodies)', () => {
    const tickets = Array.from({ length: 25 }, (_, i) => ({
      id: 65700 + i, subject: `Ticket ${i}`, status: 'open', requester_id: 900 + i, updated_at: `2026-07-0${(i % 7) + 1}`,
      description: 'x'.repeat(5000), url: 'https://api...', via: { channel: 'email', source: { from: { address: 'pii@example.com' } } },
    }));
    const m = minimizeReadValue({ results: tickets, next_page: null });
    assert.equal(m.count, 25);
    assert.equal(m.shown, 25);                                        // full coverage (the old 6k truncation showed ~4)
    assert.equal(m.items[0].id, 65700);
    assert.equal(m.items[0].requester_id, 900);
    assert.equal(m.items[0].excerpt.length, 120);                     // list body → slim excerpt, never 5000 raw chars
    assert.equal(m.items[0].via, undefined);                          // nested objects (email PII) dropped
    assert.ok(JSON.stringify(m).length < 6000);                       // 25 tickets FIT the prompt belt (the old path truncated to ~4)
  });
  it('comments keep the LAST N (recency = the resolution signal)', () => {
    const comments = Array.from({ length: 20 }, (_, i) => ({ id: i, author_id: 1, public: true, body: `comment ${i}`, created_at: `t${i}` }));
    const m = minimizeReadValue({ comments }, { maxComments: 8 });
    assert.equal(m.count, 20);
    assert.equal(m.shown, 8);
    assert.equal(m.kept, 'last');
    assert.equal(m.items[0].excerpt, 'comment 12');                   // the last 8, oldest-of-kept first
  });
  it('non-list values pass through untouched', () => {
    assert.deepEqual(minimizeReadValue({ ok: true, n: 3 }), { ok: true, n: 3 });
    assert.equal(minimizeReadValue('plain'), 'plain');
  });
  it('needs cap is 8 (v1353 — 3 starved an 11-ticket queue)', () => {
    const raw = JSON.stringify({ proposals: [], needs: Array.from({ length: 12 }, (_, i) => ({ key: 'me.zendesk.read_ticket@d.zendesk.com', params: { id: i } })) });
    const { needs } = parseSweepProposals(raw, { legs: ACT_LEGS, askLegs: ASK_LEGS });
    assert.equal(needs.length, 8);
  });
});

describe('sweepPrompt — FL-1b evidence round (v1347)', () => {
  it('round 1 offers READ TOOLS for needs; round 2 says FINAL and offers none', () => {
    const r1 = buildSweepProposeMessages({ seed: 's', legs: ACT_LEGS, askLegs: ASK_LEGS, results: [], round: 1 });
    assert.ok(r1.user.includes('READ TOOLS'));
    const r2 = buildSweepProposeMessages({ seed: 's', legs: ACT_LEGS, askLegs: [], results: [], round: 2 });
    assert.ok(r2.user.includes('FINAL ROUND'));
  });
  it('parse validates needs against the OFFERED read legs, dedups, caps at 3', () => {
    const raw = JSON.stringify({ proposals: [], needs: [
      { key: 'me.zendesk.read_ticket@d.zendesk.com', params: { id: 7 } },
      { key: 'me.zendesk.read_ticket@d.zendesk.com', params: { id: 7 } },     // exact dup — dropped
      { key: 'me.zendesk.read_ticket@d.zendesk.com', params: { id: 8 } },     // same leg, different params — kept
      { key: 'hallucinated.read', params: {} },                                // not offered — dropped
      { key: 'me.zendesk.merge_tickets@d.zendesk.com', params: {} },           // an ACT leg is not a valid need — dropped
    ], summary: 'need the conversations' });
    const { needs, summary } = parseSweepProposals(raw, { legs: ACT_LEGS, askLegs: ASK_LEGS });
    assert.deepEqual(needs.map((n) => n.params.id), [7, 8]);
    assert.equal(summary, 'need the conversations');
  });
});

describe('proposals — FL-1c targetUrls (ground truth, trusted-template only)', () => {
  const LEG = { key: 'k', name: 'Solve ticket', mode: 'act', safety: 'confirm',
    tool: { origin: 'deako.zendesk.com', itemUrl: '/agent/tickets/{id}' } };
  it('builds https urls from origin + template + sanitized ids; strips leading #', () => {
    const urls = targetUrls({ leg: LEG, targets: ['#64775', '64780'] });
    assert.deepEqual(urls, [
      { id: '64775', url: 'https://deako.zendesk.com/agent/tickets/64775' },
      { id: '64780', url: 'https://deako.zendesk.com/agent/tickets/64780' },
    ]);
  });
  it('rejects non-token ids (a minted `../../evil` can never escape the path)', () => {
    assert.deepEqual(targetUrls({ leg: LEG, targets: ['../../evil', 'a b', '64775?x=1'] }), []);
  });
  it('no template / no origin → [] (graceful plain-text targets)', () => {
    assert.deepEqual(targetUrls({ leg: { tool: { origin: 'x.com' } }, targets: ['1'] }), []);
    assert.deepEqual(targetUrls({ leg: null, targets: ['1'] }), []);
  });
});

describe('actionLedger — FL-1c ground-truth urls (v1348: stored as provenance, NEVER rendered as links)', () => {
  it('entries carry validated urls; renderLedgerLines stays plain text (conversational console)', () => {
    const e = ledgerEntry('execution', { action: 'Merge tickets', targets: ['1', '2'], ok: true,
      urls: [{ id: '1', url: 'https://d.zendesk.com/agent/tickets/1' }, { id: 'bad', url: 'http://insecure' }] }, 1000);
    assert.equal(e.urls.length, 1);                                   // non-https dropped at mint; provenance persists
    const [line] = renderLedgerLines([e]);
    assert.ok(line.includes('(1, 2)'));                               // plain targets
    assert.ok(!line.includes(']('));                                  // and NO markdown links anywhere
  });
});

describe('palette — fleetOfferedLegs (v1348: NL routes through the IL, not regex)', () => {
  it('offers REVIEW_QUEUE + SHOW_ITEM_SOURCES + SHOW_WORK for a connected app, with the object-model noun woven in', async () => {
    const { fleetOfferedLegs } = await import('./palette.js');
    const legs = fleetOfferedLegs({ objectModel: { plural: 'tickets' } }, true);
    assert.deepEqual(legs.map((l) => l.key), ['REVIEW_QUEUE', 'SHOW_ITEM_SOURCES', 'SHOW_WORK']);
    assert.ok(legs.every((l) => l.domain === 'self' && l.safety === 'auto'));
    assert.ok(legs[0].does.includes('tickets'));
    assert.ok(legs[1].paramSchema.properties.proposal);
    assert.deepEqual(fleetOfferedLegs({ objectModel: { plural: 'tickets' } }, false), []);   // unconnected app → not offered
  });
});

describe('actionLedger — FL-1e renderWorkTrace ("show work")', () => {
  it('groups by the LATEST runId, renders steps in order, and makes an UNSERVED need visible', () => {
    const items = [
      ledgerEntry('step', { runId: 'run_old', phase: 'plan', action: 'reads', note: 'My open tickets' }, 1000),
      ledgerEntry('step', { runId: 'run_new', phase: 'plan', action: 'reads', ok: true, note: 'My open tickets · My pending tickets' }, 2000),
      ledgerEntry('step', { runId: 'run_new', phase: 'read', action: 'My open tickets', ok: true, note: '~4200 chars' }, 2001),
      ledgerEntry('step', { runId: 'run_new', phase: 'propose', action: 'round 1', ok: true, note: '0 proposal(s), 2 evidence need(s)' }, 2002),
      ledgerEntry('step', { runId: 'run_new', phase: 'need', action: 'Read a Zendesk ticket conversation', ok: true, note: '{"id":65721}' }, 2003),
      ledgerEntry('step', { runId: 'run_new', phase: 'need', action: 'made.up.read', ok: false, note: 'not among the offered reads' }, 2004),
      ledgerEntry('step', { runId: 'run_new', phase: 'propose', action: 'round 2', ok: true, note: '1 proposal(s)' }, 2005),
      ledgerEntry('sweep', { counts: { reads: 3, proposals: 1 }, runId: 'run_new' }, 2006),
    ];
    const { lines, runId } = renderWorkTrace(items);
    assert.equal(runId, 'run_new');
    assert.equal(lines.length, 7);                                     // the run_old step is NOT included
    assert.ok(lines[0].includes('planned reads'));
    assert.ok(lines[3].includes('evidence'));
    assert.ok(lines[4].includes('evidence UNSERVED'));               // the invisible failure, made visible (de-iconed v1368)
    assert.ok(lines[6].startsWith('Σ done'));
    assert.deepEqual(renderWorkTrace([]), { lines: [], runId: null }); // no traced runs → honest empty
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

// ── FL-8b/8c (v2.74.1358) — autonomy policy + quota counters + the operational-context fence ─────────────────

describe('FL-8 — autonomyFor / executedTodayByRecipe / context fence', () => {
  const AUTONOMY = { update_ticket_status: 'auto', merge_tickets: 'auto' };   // config LYING about merge
  const _p = (recipeId, safety, status = 'pending', decidedAt = 0) => ({
    name: recipeId, safety, status, decidedAt,
    leg: { safety, tool: { recipeId } },
  });
  it('autonomyFor: auto only when the map says auto AND the safety floor allows it', () => {
    assert.equal(autonomyFor({ autonomy: AUTONOMY }, _p('update_ticket_status', 'confirm')), 'auto');
    assert.equal(autonomyFor({ autonomy: AUTONOMY }, _p('merge_tickets', 'gated')), 'gated');     // destructive floor beats config
    assert.equal(autonomyFor({ autonomy: AUTONOMY }, _p('assign_ticket_to_me', 'confirm')), 'gated');   // absent → fail-closed
    assert.equal(autonomyFor({}, _p('update_ticket_status', 'confirm')), 'gated');                // no policy → nothing runs alone
  });
  it('executedTodayByRecipe: executed-today only, keyed by recipeId', () => {
    const now = Date.UTC(2026, 6, 7, 20, 0, 0);
    const today = now - 3600_000, yesterday = now - 30 * 3600_000;
    const counts = executedTodayByRecipe([
      { ..._p('update_ticket_status', 'confirm', 'executed', today) },
      { ..._p('update_ticket_status', 'confirm', 'executed', today) },
      { ..._p('assign_ticket_to_me', 'confirm', 'executed', yesterday) },   // not today
      { ..._p('assign_ticket_to_me', 'confirm', 'rejected', today) },       // not executed
    ], now);
    assert.equal(counts.update_ticket_status, 2);
    assert.ok(!('assign_ticket_to_me' in counts));
  });
  it('buildSweepProposeMessages: the operational-context fence appears only when given', () => {
    const withCtx = buildSweepProposeMessages({ seed: 's', legs: ACT_LEGS, results: [], round: 2, context: 'quota assign: 9/10 executed today — 1 remaining' });
    assert.ok(withCtx.user.includes('<SWEEP_CONTEXT'));
    assert.ok(withCtx.user.includes('9/10'));
    const without = buildSweepProposeMessages({ seed: 's', legs: ACT_LEGS, results: [], round: 2 });
    assert.ok(!without.user.includes('<SWEEP_CONTEXT'));
  });
  it('DK-4: the CROSS_SITE_ISSUES block appears only when issues are passed; empty = byte-identical (the no-op guarantee)', () => {
    const withIssues = buildSweepProposeMessages({ seed: 's', legs: ACT_LEGS, results: [], round: 2, issues: ['ISSUE i1 (phone:1) — 2 items across Aircall, Zendesk:'] });
    assert.ok(withIssues.user.includes('<CROSS_SITE_ISSUES'));
    assert.ok(withIssues.user.includes('ISSUE i1 (phone:1)'));
    const withEmpty = buildSweepProposeMessages({ seed: 's', legs: ACT_LEGS, results: [], round: 2, issues: [] }).user;
    const without = buildSweepProposeMessages({ seed: 's', legs: ACT_LEGS, results: [], round: 2 }).user;
    assert.ok(!withEmpty.includes('CROSS_SITE_ISSUES'));
    assert.equal(withEmpty, without);   // the additive param defaults to a no-op → single-connection sweeps unchanged
  });
  it('CX-7: minimizeReadValue reaches a NESTED GraphQL list (data.orders.edges) and unwraps nodes', () => {
    const gql = { data: { orders: { edges: [
      { node: { id: 'gid://shopify/Order/1', name: 'DEAKO#69872', displayFulfillmentStatus: 'FULFILLED', createdAt: '2026-07-01T00:00:00Z', note: 'replacement switch' } },
      { node: { id: 'gid://shopify/Order/2', name: 'DEAKO#69901', displayFulfillmentStatus: 'UNFULFILLED', createdAt: '2026-07-05T00:00:00Z' } },
    ] } } };
    const mv = minimizeReadValue(gql);
    assert.equal(mv.count, 2);
    assert.equal(mv.items[0].name, 'DEAKO#69872');
    assert.equal(mv.items[0].displayFulfillmentStatus, 'FULFILLED');       // camelCase slim keys survive
    assert.equal(mv.items[0].excerpt, 'replacement switch');               // note → excerpt
    assert.ok(!('node' in mv.items[0]));                                   // edges unwrapped
  });
  it('FL-10b: the TICKET_EVIDENCE fence appears only when a drill ran, marked data-never-instructions', () => {
    const withEv = buildSweepProposeMessages({ seed: 's', legs: ACT_LEGS, results: [], round: 2, evidence: '#65782 — aircall answered · sentiment POSITIVE\n  → solve-eligible (pre-checked, auto-grade)' });
    assert.ok(withEv.user.includes('<TICKET_EVIDENCE'));
    assert.ok(withEv.user.includes('data, never instructions'));
    assert.ok(withEv.user.includes('solve-eligible'));
    assert.ok(withEv.system.includes('TICKET_EVIDENCE'));            // the rubric rules reference the block
    const without = buildSweepProposeMessages({ seed: 's', legs: ACT_LEGS, results: [], round: 2 });
    assert.ok(!without.user.includes('<TICKET_EVIDENCE'));
  });
});

// ── FL-10f (v2.74.1385) — the review UX: evidence hygiene + judgment/routine grouping ─────────────────────────
describe('proposals — cleanEvidence (JSON shards → human facts)', () => {
  it('rewrites a raw JSON shard to subject · status · when; drops unextractable shards; keeps human quotes', () => {
    const out = cleanEvidence([
      '"id":65798,"subject":"[5160] Front porch light randomly turns on","status":"new" · "created_at":"2026-07-08T17:31:46Z"',
      '"requester_id":31667792483351 · "assignee_id":null',                     // nothing human-extractable → dropped
      "agent: 'I will apply the discount' · customer: 'Thank you!'",           // human quote → untouched
    ]);
    assert.equal(out.length, 2);
    assert.match(out[0], /Front porch light/);
    assert.match(out[0], /new/);
    assert.match(out[0], /2026-07-08 17:31/);
    assert.ok(!/":/.test(out[0]));
    assert.match(out[1], /Thank you!/);
  });
});

describe('proposals — isJudgment + renderProposalCards (grouped review)', () => {
  const _leg = (name, safety, autoRequires) => ({ name, safety, tool: autoRequires ? { autoRequires } : {} });
  const P = {
    merge: { id: 'p1', name: 'Merge Zendesk tickets', safety: 'gated', leg: _leg('Merge Zendesk tickets', 'gated'), params: { id: 65731, source_ids: [65814], source_comment: 'Merged into #65731 as duplicate blah blah blah' }, targets: ['65814', '65731'], why: 'Same customer, same issue.', evidence: ['SAME CUSTOMER (matched by phone): #65731, #65814 → survivor #65731'], drill: { klass: 'aircall', matched: 'phone', crossAgent: false }, status: 'pending' },
    solve: { id: 'p2', name: 'Set a Zendesk ticket status', safety: 'confirm', leg: { name: 'Set a Zendesk ticket status', safety: 'confirm', tool: { autoRequires: 'evidence' } }, params: { status: 'solved' }, targets: ['65679'], why: 'Customer confirmed the refund fix.', evidence: ["customer: 'Thank you!'"], status: 'pending' },
    a1: { id: 'p3', name: 'Assign a Zendesk ticket to me', safety: 'confirm', leg: _leg('Assign a Zendesk ticket to me', 'confirm'), params: {}, targets: ['65798'], why: 'New ticket within quota.', evidence: ['"subject":"[5160] Front porch light","status":"new"'], status: 'pending' },
    a2: { id: 'p4', name: 'Assign a Zendesk ticket to me', safety: 'confirm', leg: _leg('Assign a Zendesk ticket to me', 'confirm'), params: {}, targets: ['65796'], why: 'Support form within quota.', evidence: [], status: 'pending' },
  };
  it('judgment = gated/destructive/evidence-gated; routine = the rest', () => {
    assert.equal(isJudgment(P.merge), true);
    assert.equal(isJudgment(P.solve), true);       // autoRequires evidence → human judgment class
    assert.equal(isJudgment(P.a1), false);
  });
  it('judgment leads with full cards (direction line, no boilerplate comment params, no drill-echo quotes); routine groups as one-liners; numbering follows the display', () => {
    const { lines, order, judgmentCount } = renderProposalCards([P.a1, P.merge, P.a2, P.solve]);
    assert.equal(judgmentCount, 2);
    assert.deepEqual(order.map((p) => p.id), ['p1', 'p2', 'p3', 'p4']);   // judgment first, then routine — display order
    const text = lines.join('\n');
    assert.match(text, /Needs your judgment \(2\)/);
    assert.match(text, /#65814 → #65731/);                                // consolidation direction
    assert.ok(!text.includes('source_comment'));                          // boilerplate prose param suppressed
    assert.ok(!text.includes('SAME CUSTOMER'));                           // drill line already says matched-by → echo quote dropped
    assert.match(text, /Routine — Assign a Zendesk ticket to me \(2\)/);
    assert.match(lines.find((l) => l.startsWith('3.')), /65798/);         // routine one-liner numbered after judgment
    assert.match(lines.find((l) => l.startsWith('3.')), /Front porch light/);   // shard cleaned into the gist
  });
});

// ── FL-9 (v2.74.1370) — rejections stick: the structural repeat filter + the prompt-context lines ────────────

describe('FL-9 — filterRejectedRepeats / rejectionContext', () => {
  const NOW = Date.UTC(2026, 6, 8, 17, 0, 0);
  const _rej = (recipeId, targets, { decidedAt = NOW - 3600_000, basedOnValue = 'open', reason = 'not yet' } = {}) => ({
    name: recipeId, status: 'rejected', decidedAt, reason,
    targets, basedOn: { readKey: 'k', path: 'p', value: basedOnValue },
    leg: { tool: { recipeId } },
  });
  const _fresh = (recipeId, targets, basedOnValue = 'open') => ({
    name: recipeId, targets, basedOn: { readKey: 'k', path: 'p', value: basedOnValue },
    leg: { tool: { recipeId } },
  });
  it('suppresses a same-action same-targets repeat inside the window (the 09:02→09:08 live miss)', () => {
    const { kept, suppressed } = filterRejectedRepeats([_fresh('update_ticket_status', ['65679'])], [_rej('update_ticket_status', ['65679'])], { now: NOW });
    assert.equal(kept.length, 0);
    assert.equal(suppressed.length, 1);
    assert.equal(suppressed[0].reason, 'not yet');
  });
  it('lets it through when the SAME anchor MOVED (same readKey+path, different value)', () => {
    const { kept } = filterRejectedRepeats([_fresh('update_ticket_status', ['65679'], 'pending')], [_rej('update_ticket_status', ['65679'], { basedOnValue: 'open' })], { now: NOW });
    assert.equal(kept.length, 1);
  });
  it('a DIFFERENT grounding field is NOT "moved" — suppressed (v1374: the 65679 re-proposal slipped through cross-field comparison)', () => {
    const fresh = _fresh('update_ticket_status', ['65679'], 'whatever');
    fresh.basedOn = { readKey: 'other_read', path: 'results[3].updated_at', value: '2026-07-08T09:40:00Z' };
    const { kept, suppressed } = filterRejectedRepeats([fresh], [_rej('update_ticket_status', ['65679'], { basedOnValue: 'open' })], { now: NOW });
    assert.equal(kept.length, 0);
    assert.equal(suppressed.length, 1);
  });
  it('window + identity: an old rejection or different targets never suppress', () => {
    const old = _rej('update_ticket_status', ['65679'], { decidedAt: NOW - 30 * 3600_000 });
    assert.equal(filterRejectedRepeats([_fresh('update_ticket_status', ['65679'])], [old], { now: NOW }).kept.length, 1);
    assert.equal(filterRejectedRepeats([_fresh('update_ticket_status', ['99999'])], [_rej('update_ticket_status', ['65679'])], { now: NOW }).kept.length, 1);
    assert.equal(filterRejectedRepeats([_fresh('assign_ticket_to_me', ['65679'])], [_rej('update_ticket_status', ['65679'])], { now: NOW }).kept.length, 1);
  });
  it('rejectionContext renders name @ targets — "reason" lines under a PER-ITEM scoping header (v1374)', () => {
    const ctx = rejectionContext([_rej('update_ticket_status', ['65679'], { reason: "agent hasn't actioned it" })], { now: NOW });
    assert.ok(ctx.includes('update_ticket_status @ 65679'));
    assert.ok(ctx.includes("agent hasn't actioned it"));
    assert.ok(/do NOT invent new task types/.test(ctx));   // the live sweep pivoted to bulk status-to-pending
    assert.equal(rejectionContext([], { now: NOW }), '');
  });
  it('PROPOSE_SYSTEM carries the seed-fidelity rule (v1374: only the GOAL’s enumerated tasks)', () => {
    const { system } = buildSweepProposeMessages({ seed: 's', legs: ACT_LEGS, results: [], round: 2 });
    assert.ok(/SEED FIDELITY/.test(system));
  });
});

// ── v1381 — pendings SURVIVE sweeps: supersedePlan (replace same-pair · expire 24h · keep the rest) ──────────

describe('v1381 — supersedePlan', () => {
  const NOW = Date.UTC(2026, 6, 8, 18, 0, 0);
  const _pend = (recipeId, targets, ts) => ({ id: `p_${recipeId}_${targets.join('_')}`, status: 'pending', ts, targets, leg: { tool: { recipeId } } });
  it('a fresh mint of the SAME (action, targets) pair replaces the prior pending', () => {
    const prior = [_pend('update_ticket_status', ['65679'], NOW - 10 * 60_000)];
    const fresh = [{ targets: ['65679'], leg: { tool: { recipeId: 'update_ticket_status' } } }];
    const plan = supersedePlan(prior, fresh, { now: NOW });
    assert.equal(plan.stale.length, 1);
    assert.match(plan.stale[0].reason, /replaced/);
    assert.equal(plan.kept.length, 0);
  });
  it('an un-replaced young pending SURVIVES (the 5-minute-clock live miss: "1 pending" → "Nothing pending")', () => {
    const prior = [_pend('update_ticket_status', ['65679'], NOW - 10 * 60_000)];
    const plan = supersedePlan(prior, [], { now: NOW });
    assert.equal(plan.stale.length, 0);
    assert.equal(plan.kept.length, 1);
  });
  it('a pending unreviewed past 24h expires; non-pending entries are ignored', () => {
    const prior = [
      _pend('assign_ticket_to_me', ['1'], NOW - 25 * 3600_000),
      { id: 'x', status: 'rejected', ts: NOW - 30 * 3600_000, targets: ['2'], leg: { tool: { recipeId: 'assign_ticket_to_me' } } },
    ];
    const plan = supersedePlan(prior, [], { now: NOW });
    assert.equal(plan.stale.length, 1);
    assert.match(plan.stale[0].reason, /expired/);
    assert.equal(plan.kept.length, 0);
  });
});
