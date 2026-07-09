// Core/ticketEvidence.test.js — FL-10a (v2.74.1383): the drill's evidence extractor, rubrics, clustering, triage.
// Fixtures mirror logs/run/zendesk-queue-workflow-spec.md §3 (the observed aircall/SAS comment grammar).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  listRows, extractTicketEvidence, solveVerdict, stubCloseVerdict, clusterTickets, mergeAdvice,
  pickDrillCandidates, updateSeen, deriveMe, renderTicketEvidence, toBankEntry, bankEvidence,
} from './ticketEvidence.js';

const NOW = Date.parse('2026-07-08T18:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

// ── fixtures: a populated answered call (65782-shaped), a bare stub (65797-shaped), an action-item call ─────────
const T_SOLVED = {
  id: 65782, subject: 'Inbound answered call on nonpro support', status: 'open',
  requester_id: 41691182443415, assignee_id: 35467254975639,
  tags: ['aircall', 'answered_call', 'inbound', 'ci-alarm.com-integration', 'ci-wi-fi-credential-sync'],
  created_at: iso(120), updated_at: iso(50), description: 'Call Initiated',
};
const C_SOLVED = [
  { body: 'Call Initiated', public: false },
  { body: 'Inbound answered call on nonpro support\n\nSummary\n\nPost call\nVoicemail: No', public: false },
  { body: 'Call transcription\nAgentName: let me re-sync the WiFi credentials\n+17725305288 Aircall new contact: okay checking now\n+17725305288 Aircall new contact: now it works from the alarm.com app thank you', public: false },
  { body: 'Call Sentiment:  POSITIVE', public: false },   // double space — observed
];
const T_STUB = {
  id: 65797, subject: 'Inbound answered call on nonpro support', status: 'open',
  requester_id: 1521251994301, assignee_id: 35467254975639,
  tags: ['aircall', 'inbound'], created_at: iso(20), updated_at: iso(20), description: 'Call Initiated',
};
const C_STUB = [{ body: 'Call Initiated', public: false }];
const C_COMMIT = [
  { body: 'Call transcription\nAgentName: I will check with the carrier\n+15559990000 Aircall new contact: alright thanks', public: false },
  { body: 'Call Sentiment:  NEUTRAL', public: false },
  { body: 'Action Item: Advise the customer to contact AT&T about the SIM', public: false },
];

describe('ticketEvidence — listRows', () => {
  it('finds the primary object array in list / wrapped / comment shapes', () => {
    assert.equal(listRows([{ id: 1 }]).length, 1);
    assert.equal(listRows({ count: 2, results: [{ id: 1 }, { id: 2 }] }).length, 2);
    assert.equal(listRows({ comments: [{ body: 'x' }] }).length, 1);
    assert.deepEqual(listRows('nope'), []);
    assert.deepEqual(listRows(null), []);
  });
});

describe('ticketEvidence — extractTicketEvidence (spec §3 field map)', () => {
  it('parses sentiment / transcript / voicemail / customer confirm quotes from comment bodies', () => {
    const ev = extractTicketEvidence(T_SOLVED, C_SOLVED, { now: NOW });
    assert.equal(ev.klass, 'aircall');
    assert.equal(ev.answered, true);
    assert.equal(ev.sentiment, 'POSITIVE');
    assert.equal(ev.transcript, true);
    assert.equal(ev.voicemail, false);
    assert.equal(ev.stub, false);                          // ci-* tags present → populated, not a stub
    assert.equal(ev.populated, true);
    assert.equal(ev.actionItem, null);
    assert.ok(ev.confirmLines.some((q) => q.includes('now it works from the alarm.com app')));
    assert.ok(ev.identity.phones.includes('7725305288'));  // caller phone lives in the transcript body
  });
  it('bare "Call Initiated" with no ci-* tags = stub; Action Item = open commitment', () => {
    const st = extractTicketEvidence(T_STUB, C_STUB, { now: NOW });
    assert.equal(st.stub, true);
    assert.equal(st.populated, false);
    const cm = extractTicketEvidence({ ...T_SOLVED, tags: ['aircall', 'answered_call'] }, C_COMMIT, { now: NOW });
    assert.match(cm.actionItem, /contact AT&T/);
    assert.equal(cm.sentiment, 'NEUTRAL');
  });
  it('SAS pipe-table description yields name/email/phone/#ref identity', () => {
    const sas = extractTicketEvidence({
      id: 65774, subject: 'You have a new call from SAS Flex', status: 'open',
      requester_id: 31667792483351, assignee_id: null, tags: ['sas_flex'], created_at: iso(300), updated_at: iso(300),
      description: '| Name | Latonya Vincent |\n| Email | lvincent@example.com |\n| Cell Phone | (772) 530-5288 |\nCalling re ticket # 65639',
    }, [], { now: NOW });
    assert.equal(sas.klass, 'sas');
    assert.deepEqual(sas.identity.emails, ['lvincent@example.com']);
    assert.ok(sas.identity.phones.includes('7725305288'));
    assert.ok(sas.identity.refs.includes('65639'));
    assert.ok(sas.identity.names[0].includes('Latonya'));
  });
});

describe('ticketEvidence — solveVerdict (spec §4.1) + stubCloseVerdict (§9.2)', () => {
  const me = '35467254975639';
  it('full pass + POSITIVE = eligible AND auto-grade; NEUTRAL = eligible, NOT auto', () => {
    const ev = extractTicketEvidence(T_SOLVED, C_SOLVED, { now: NOW });
    const v = solveVerdict(ev, { me });
    assert.equal(v.eligible, true);
    assert.equal(v.autoEligible, true);
    const vn = solveVerdict({ ...ev, sentiment: 'NEUTRAL' }, { me });
    assert.equal(vn.eligible, true);
    assert.equal(vn.autoEligible, false);
  });
  it('open commitment / not-mine / unknown-me all fail closed', () => {
    const ev = extractTicketEvidence({ ...T_SOLVED, tags: ['aircall', 'answered_call'] }, C_COMMIT, { now: NOW });
    const v = solveVerdict(ev, { me });
    assert.equal(v.eligible, false);
    assert.ok(v.missing.includes('open commitment'));
    assert.ok(v.holds.some((h) => h.startsWith('open commitment')));
    const notMine = solveVerdict(extractTicketEvidence({ ...T_SOLVED, assignee_id: 999 }, C_SOLVED, { now: NOW }), { me });
    assert.ok(notMine.missing.includes('not assigned to me'));
    const noMe = solveVerdict(extractTicketEvidence(T_SOLVED, C_SOLVED, { now: NOW }), { me: null });
    assert.equal(noMe.eligible, false);
  });
  it('stub: young = HOLD (tooNew), aged past the window = close-eligible', () => {
    const young = extractTicketEvidence(T_STUB, C_STUB, { now: NOW });
    assert.deepEqual(stubCloseVerdict(young), { eligible: false, autoEligible: false, tooNew: true });
    const aged = extractTicketEvidence({ ...T_STUB, created_at: iso(6 * 60) }, C_STUB, { now: NOW });
    const v = stubCloseVerdict(aged);
    assert.equal(v.eligible, true);
    assert.equal(v.tooNew, false);
  });
});

describe('ticketEvidence — clusterTickets + mergeAdvice (spec §4.2, requester-id exception)', () => {
  const me = '35467254975639';
  const evs = [
    extractTicketEvidence({
      id: 65774, subject: 'You have a new call from SAS Flex', tags: ['sas_flex'], requester_id: 31667792483351,
      assignee_id: Number(me), created_at: iso(300), updated_at: iso(300),
      description: '| Name | Latonya Vincent |\n| Email | lvincent@example.com |\n| Cell Phone | (772) 530-5288 |\nCalling re ticket # 65639',
    }, [], { now: NOW }),
    extractTicketEvidence({
      id: 65639, subject: 'Alarm.com control not working', tags: [], requester_id: 555001,
      assignee_id: 777, created_at: iso(3000), updated_at: iso(100),
      description: 'Customer lvincent@example.com reports the switch is offline.',
    }, [{ body: 'thread reply', public: true }], { now: NOW }),
  ];
  it('clusters on email + explicit #ref; two SAS tickets sharing the intake requester do NOT cluster', () => {
    const clusters = clusterTickets(evs);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].ids, ['65639', '65774']);
    assert.ok(clusters[0].matchedBy.includes('ticket-ref'));
    assert.ok(clusters[0].matchedBy.includes('email'));
    const sasTwins = clusterTickets([
      extractTicketEvidence({ id: 1, tags: ['sas_flex'], requester_id: 31667792483351, description: '| Name | Alice Smith |', created_at: iso(9), updated_at: iso(9) }, [], { now: NOW }),
      extractTicketEvidence({ id: 2, tags: ['sas_flex'], requester_id: 31667792483351, description: '| Name | Bob Jones |', created_at: iso(8), updated_at: iso(8) }, [], { now: NOW }),
    ]);
    assert.equal(sasTwins.length, 0);   // shared intake user is NOT an identity key
  });
  it('survivor = richer plain thread; another agent’s survivor → solve-own (never merge)', () => {
    const clusters = clusterTickets(evs);
    const byId = new Map(evs.map((e) => [e.id, e]));
    const adv = mergeAdvice(clusters[0], byId, { me });
    assert.equal(adv.survivorId, '65639');          // plain thread beats the SAS stub even though the stub is mine
    assert.equal(adv.crossAgent, true);             // 65639 is agent 777's
    assert.equal(adv.advice, 'solve-own');
    const advMine = mergeAdvice(clusters[0], new Map([...byId].map(([k, e]) => [k, e.id === '65639' ? { ...e, assigneeId: Number(me) } : e])), { me });
    assert.equal(advMine.advice, 'merge');
    assert.deepEqual(advMine.sourceIds, ['65774']);
  });
});

describe('ticketEvidence — pickDrillCandidates (FL-10e lanes) + seen state + deriveMe', () => {
  const rows = [
    { id: 60001, subject: 'plain email question', tags: [], created_at: iso(500), updated_at: iso(50) },
    { id: 60002, subject: 'Inbound answered call on nonpro support', tags: ['aircall', 'answered_call', 'ci-smart-switch'], created_at: iso(400), updated_at: iso(40) },
    { id: 60003, subject: 'You have a new call from SAS Flex', tags: ['sas_flex'], description: 'Calling re ticket # 60001', created_at: iso(30), updated_at: iso(30) },
    { id: 60004, subject: 'aged stub', tags: ['aircall'], description: 'Call Initiated', created_at: iso(200), updated_at: iso(200) },
    { id: 60005, subject: 'You have a new call from SAS Flex', tags: ['sas_flex'], created_at: iso(5), updated_at: iso(5) },
    { id: 60006, subject: 'young stub', tags: ['aircall'], description: 'Call Initiated', created_at: iso(15), updated_at: iso(15) },
  ];
  it('MY tickets get the protected share — fresh unassigned inflow can no longer crowd them out (the 14:06 live miss)', () => {
    const picks = pickDrillCandidates(rows, { cap: 3, seen: {}, mineIds: new Set(['60002']), now: NOW });
    const lane = Object.fromEntries(picks.map((p) => [p.id, p.lane]));
    assert.equal(lane['60002'], 'mine');             // older than every SAS row, still drilled
  });
  it('lanes: merge = #ref carrier + pulled counterpart + SAS; stub = AGED only (young stubs are not judgeable)', () => {
    const picks = pickDrillCandidates(rows, { cap: 8, seen: {}, mineIds: new Set(['60002']), now: NOW });
    const lane = Object.fromEntries(picks.map((p) => [p.id, p.lane]));
    assert.equal(lane['60003'], 'merge');            // explicit #ref → first merge seed
    assert.equal(lane['60001'], 'merge');            // pulled in by #60003's ticket-ref
    assert.equal(lane['60004'], 'stub');             // 200m old ≥ 2h window
    assert.equal(lane['60006'], undefined);          // 15m-old bare stub → not drilled (holds happen via seen)
    assert.equal(pickDrillCandidates(rows, { cap: 2, seen: {}, mineIds: new Set(['60002']), now: NOW }).length, 2);
  });
  it('seen skips unchanged judged rows; HELD entries re-drill first (lane held); updateSeen stores the bank + caps', () => {
    const seen = { 60002: { u: rows[1].updated_at, s: 'done', at: NOW - 1000 }, 60006: { u: rows[5].updated_at, s: 'held', at: NOW - 1000 } };
    const picks = pickDrillCandidates(rows, { cap: 8, seen, mineIds: new Set(['60002']), now: NOW });
    const lane = Object.fromEntries(picks.map((p) => [p.id, p.lane]));
    assert.equal(lane['60002'], undefined);          // judged + unchanged → skipped
    assert.equal(lane['60006'], 'held');             // held stub → always re-drills, first
    const next = updateSeen(seen, [{ id: '60006', updatedAt: rows[5].updated_at, held: false, bank: { k: 'aircall', sen: 'POSITIVE' } }], { now: NOW, cap: 2 });
    assert.equal(next['60006'].s, 'done');
    assert.equal(next['60006'].b.sen, 'POSITIVE');
    assert.ok(Object.keys(next).length <= 2);
  });
  it('deriveMe: one distinct assignee on mine rows → me; mixed/empty → null (fail closed)', () => {
    assert.equal(deriveMe([{ assignee_id: 9 }, { assignee_id: 9 }]), '9');
    assert.equal(deriveMe([{ assignee_id: 9 }, { assignee_id: 8 }]), null);
    assert.equal(deriveMe([]), null);
  });
});

describe('ticketEvidence — evidence bank (FL-10e): cross-fire relatedness + already-handled', () => {
  it('toBankEntry/bankEvidence round-trip clusters a FRESH ticket with a PRIOR fire’s drill', () => {
    const prior = extractTicketEvidence({
      id: 65639, subject: 'Alarm.com control not working', tags: [], requester_id: 555001, assignee_id: 777,
      created_at: iso(3000), updated_at: iso(2000), status: 'open',
      description: 'Customer lvincent@example.com reports the switch is offline.',
    }, [], { now: NOW });
    const bank = bankEvidence('65639', toBankEntry(prior, { now: NOW }), { now: NOW });
    const fresh = extractTicketEvidence({
      id: 65774, subject: 'You have a new call from SAS Flex', tags: ['sas_flex'], requester_id: 31667792483351,
      created_at: iso(30), updated_at: iso(30), status: 'new',
      description: '| Name | Latonya Vincent |\n| Email | lvincent@example.com |',
    }, [], { now: NOW });
    const clusters = clusterTickets([fresh, bank]);
    assert.equal(clusters.length, 1);
    assert.ok(clusters[0].matchedBy.includes('email'));
  });
  it('a solved bank survivor flips the advice to solve-own (issue already handled — merge impossible)', () => {
    const prior = extractTicketEvidence({
      id: 65639, subject: 'Alarm.com control not working', tags: [], assignee_id: 777, status: 'solved',
      created_at: iso(3000), updated_at: iso(2000), description: 'lvincent@example.com switch offline',
    }, [], { now: NOW });
    const bank = bankEvidence('65639', toBankEntry(prior, { now: NOW }), { now: NOW });
    const fresh = extractTicketEvidence({
      id: 65774, subject: 'SAS callback', tags: ['sas_flex'], status: 'new', created_at: iso(30), updated_at: iso(30),
      description: '| Email | lvincent@example.com |',
    }, [], { now: NOW });
    const clusters = clusterTickets([fresh, bank]);
    const adv = mergeAdvice(clusters[0], new Map([[fresh.id, fresh], [bank.id, bank]]), { me: '35467254975639' });
    assert.equal(adv.survivorId, '65639');
    assert.equal(adv.alreadyHandled, true);
    assert.equal(adv.advice, 'solve-own');
    const lines = renderTicketEvidence([], [{ ...adv, ids: clusters[0].ids }], {});
    assert.match(lines.join('\n'), /ALREADY HANDLED/);
  });
});

describe('ticketEvidence — renderTicketEvidence', () => {
  it('renders facts + verdict + cluster advice lines, fence-clean', () => {
    const ev = extractTicketEvidence(T_SOLVED, C_SOLVED, { now: NOW });
    const v = solveVerdict(ev, { me: '35467254975639' });
    const verdicts = new Map([[ev.id, { autoSolve: v.autoEligible, solveEligible: v.eligible, closeEligible: false, holds: v.holds, missing: v.missing }]]);
    const lines = renderTicketEvidence([ev], [{ survivorId: '65639', sourceIds: ['65774'], ids: ['65639', '65774'], crossAgent: true, matchedBy: ['email'] }], { verdicts, me: '35467254975639' });
    const text = lines.join('\n');
    assert.match(text, /#65782 .*assigned to me.*sentiment POSITIVE.*no open commitment/);
    assert.match(text, /customer: "now it works/);
    assert.match(text, /solve-eligible \(pre-checked, auto-grade\)/);
    assert.match(text, /SAME CUSTOMER \(matched by email\).*survivor #65639 is ANOTHER AGENT’S — do NOT merge/);
    assert.ok(!/[<>`]/.test(text));
  });
});
