// Core/answerShapePrompt.test.js — the interrogator answer-shaper's pure pieces (readShapeFacts + build + parse). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readShapeFacts, buildAnswerShapeMessages, parseAnswerShapeOutput, ensureScopeNamed, payloadMetrics, sumMetrics, unsupportedCountClaim } from './answerShapePrompt.js';

const TICKETS = { results: [
  { id: 64863, subject: 'Conversation with Carolina', status: 'open', description: 'a long private ticket body that must NOT leave' },
  { id: 64659, subject: 'Upgrade smart switch', status: 'open', description: 'another body' },
  { id: 63824, subject: 'Multiway switches', status: 'pending' },
] };

describe('answerShapePrompt — readShapeFacts (deterministic count + MINIMIZED sample)', () => {
  it('a list → exact count + a {id,title,status} sample with NO bodies (the minimization lever)', () => {
    const f = readShapeFacts(TICKETS);
    assert.equal(f.kind, 'list');
    assert.equal(f.count, 3);                       // count is exact (deterministic — the LLM never recounts)
    assert.equal(f.sampleN, 3);
    assert.deepEqual(f.sample[0], { id: 64863, title: 'Conversation with Carolina', status: 'open' });
    assert.deepEqual(Object.keys(f.sample[0]).sort(), ['id', 'status', 'title']);   // NO description/body/url leaves
    assert.ok(!('description' in f.sample[0]) && !('body' in f.sample[0]));
  });
  it('v2.74.1561 — CONTACT-CLASS scalars survive the lean sample (a contacts read\'s whole point); bodies still never leave', () => {
    // Live 202331: 3 contacts with Email + Cell phone on file → the {id,title,status} projection dropped them →
    // the shaper honestly answered "contact details are not included" over data it was never shown.
    const CONTACTS = { results: [
      { Id: 5455066, FullName: 'A Person', Email: 'a@example.com', CellPhone: '5551234567', ContactMethod: 'Cell', IsPrimary: true, Notes: 'long free text that must not leave' },
      { Id: 5456787, FullName: 'B Person', Email: 'b@example.com', CellPhone: '5559876543', ContactMethod: 'Email', IsPrimary: false },
    ] };
    const f = readShapeFacts(CONTACTS);
    assert.equal(f.kind, 'list');
    assert.ok(f.sample[0].contact, 'contact-class scalars ride the sample');
    assert.equal(f.sample[0].contact.CellPhone, '5551234567');
    assert.equal(f.sample[0].contact.Email, 'a@example.com');
    assert.equal(f.sample[0].roles, 'Primary', 'v1562 — the contact TYPE (truthy Is* flags → role words) rides too');
    assert.ok(!('roles' in f.sample[1]), 'no truthy flags → no roles key');
    assert.ok(!JSON.stringify(f.sample).includes('long free text'), 'free-text bodies still never leave (the privacy lever holds)');
  });
  it('count is the FULL length even when the sample is capped', () => {
    const big = { results: Array.from({ length: 25 }, (_, i) => ({ id: i, subject: `t${i}`, status: 'open' })) };
    const f = readShapeFacts(big, { sampleN: 5 });
    assert.equal(f.count, 25);                       // exact total
    assert.equal(f.sampleN, 5);                      // sample truncated → the prompt says "of the ones shown"
  });
  it('a single object → count 1; empty/null → kind empty, count 0', () => {
    assert.equal(readShapeFacts({ ticket: { id: 7, subject: 'x', status: 'open' } }).kind, 'object');
    assert.equal(readShapeFacts({ ticket: { id: 7 } }).count, 1);
    assert.deepEqual(readShapeFacts(null), { kind: 'empty', count: 0, sampleN: 0, sample: [] });
    assert.equal(readShapeFacts({}).kind, 'empty');
  });
  it('CX-7f: a SINGLE record carries `details` so the answer is accurate, not just the coarse status', () => {
    const order = { data: { orders: { edges: [{ node: {
      id: 'gid://shopify/Order/99', name: 'DEAKO#500', displayFinancialStatus: 'PARTIALLY_REFUNDED', displayFulfillmentStatus: 'FULFILLED',
      totalPriceSet: { shopMoney: { amount: '86.40', currencyCode: 'USD' } },
      returns: { edges: [{ node: { status: 'IN_PROGRESS', returnLineItems: { edges: [] } } }] },
      refunds: [{ totalRefundedSet: { shopMoney: { amount: '86.40', currencyCode: 'USD' } } }],
    } }] } } };
    const f = readShapeFacts(order);
    assert.equal(f.kind, 'object');
    assert.equal(f.count, 1);
    assert.equal(f.sample[0].details.Payment, 'PARTIALLY_REFUNDED');   // the shaper can now say "partially refunded"
    assert.equal(f.sample[0].details.Return, '1 (in progress)');
    assert.equal(f.sample[0].details.Refunded, '86.40 USD');
    assert.ok(!('details' in readShapeFacts(TICKETS).sample[0]));       // a MULTI list stays lean (size + privacy)
  });

  it('CX-9c (v1436): a vocabulary-less MULTI-row list (VendorSuite shape) carries generic fields, not empty husks', () => {
    const vs = [
      { TaskId: 4001, TaskNumber: '4090740', ClaimNumber: '01', AddressLine1: '3955 Gallery Chase', CityStateZip: 'Cumming, GA 30028', AllowedAmount: 214 },
      { TaskId: 4002, TaskNumber: '4090741', ClaimNumber: '02', AddressLine1: '456 Oak Ave', CityStateZip: 'Cumming, GA 30041', AllowedAmount: 80 },
    ];
    const f = readShapeFacts(vs);
    assert.equal(f.kind, 'list');
    assert.equal(f.count, 2);
    assert.equal(f.sample[0].id, '4090740');                            // …Number suffix fallback — the human number
    assert.ok(f.sample[0].fields, 'generic fields present when title+status are empty');
    assert.ok(Object.values(f.sample[0].fields).includes('3955 Gallery Chase'));   // the shaper can now answer "which address"
    assert.ok(!('fields' in readShapeFacts(TICKETS).sample[0]));        // a recognized shape (title present) stays lean — unchanged payload
  });

  it('CX-9h (v1441): a DETAIL record with a child array shapes as kind:object — the record, never the child rows', () => {
    const detail = { TaskId: 963119, TaskNumber: '10803524', Priority: '1',
      Instructions: 'Replace the smart switch and verify the circuit',
      Appointments: [{ AppointmentId: 1744395, StartDate: '2026-07-10T07:00:00', IsCanceled: false }] };
    const f = readShapeFacts(detail);
    assert.equal(f.kind, 'object');                                        // was: kind 'object' over the APPOINTMENT (the child hijack)
    assert.equal(f.sample[0].id, '10803524');                              // the TASK's number, not the appointment's
    assert.match(JSON.stringify(f.sample[0].details || {}), /Replace the smart switch/);   // the payload reaches the shaper
  });

  it('CX-9d (v1437): buildAnswerShapeMessages carries the SCOPE line (code-applied filters); absent → byte-identical', () => {
    const facts = readShapeFacts(TICKETS);
    const withScope = buildAnswerShapeMessages({ ask: 'open tasks for greensboro', facts, scope: 'divisionId=Greensboro (62), status=open' });
    assert.match(withScope.user, /SCOPE \(already applied by the app\): divisionId=Greensboro \(62\), status=open/);
    assert.match(withScope.system, /NEVER re-filter/);                  // the no-refilter rule is in the system prompt
    const without = buildAnswerShapeMessages({ ask: 'open tasks', facts });
    assert.doesNotMatch(without.user, /SCOPE/);                          // no scope → no line
  });
});

describe('answerShapePrompt — buildAnswerShapeMessages', () => {
  it('renders the question + the minimized facts; the contract names count + showList', () => {
    const { system, user } = buildAnswerShapeMessages({ ask: 'how many tickets do I have?', facts: readShapeFacts(TICKETS) });
    assert.match(system, /showList/);
    assert.match(system, /use the provided "count" VERBATIM/i);
    assert.match(user, /QUESTION: how many tickets do I have\?/);
    assert.match(user, /"count":3/);
    assert.ok(!/private ticket body/.test(user));    // the body never reaches the payload
  });
});

describe('answerShapePrompt — parseAnswerShapeOutput', () => {
  it('a shaped answer', () => {
    assert.deepEqual(parseAnswerShapeOutput('{"answer":"You have 3 open tickets."}'), { answer: 'You have 3 open tickets.', showList: false });
  });
  it('showList sentinel → defer to the deterministic render', () => {
    assert.deepEqual(parseAnswerShapeOutput('{"showList":true}'), { answer: null, showList: true });
  });
  it('unparseable / empty → fall back to the render', () => {
    assert.deepEqual(parseAnswerShapeOutput('not json'), { answer: null, showList: false });
    assert.deepEqual(parseAnswerShapeOutput('{}'), { answer: null, showList: false });
    assert.deepEqual(parseAnswerShapeOutput('{"answer":""}'), { answer: null, showList: false });
  });
});

// v2.74.1862 — the FLAT-RECORD probe. Live 172156/172205: vs_versions returned eleven real fields and the
// shaper told the user "No VendorSuite build version data is available" — the husk class (v1436, v1561) one
// probe earlier, and the only variant that licenses asserting ABSENCE.
describe('readShapeFacts — a flat record is still a record (v2.74.1862)', () => {
  const VERSIONS = { AccountManagementVersion: '1.2', WarrantyVersion: '3.4', WebVersion: '5.6', Environment: 'PROD', ServiceMachineName: 'SVC01' };
  it('THE LIVE CASE: a payload of plain scalars counts as ONE record, not empty', () => {
    const f = readShapeFacts(VERSIONS);
    assert.equal(f.kind, 'object');
    assert.equal(f.count, 1, 'count:0 is what made the shaper deny the data it was holding');
    assert.equal(f.sampleN, 1);
  });
  it('and its VALUES survive the projection — the answer must be able to state them', () => {
    const shown = JSON.stringify(readShapeFacts(VERSIONS).sample[0]);
    assert.match(shown, /PROD/);
    assert.match(shown, /3\.4/);
  });
  it('`empty` is reserved for payloads that genuinely have no content', () => {
    for (const v of [null, undefined, {}, { a: '', b: null }, []]) {
      assert.equal(readShapeFacts(v).kind, 'empty', `${JSON.stringify(v)} should read empty`);
      assert.equal(readShapeFacts(v).count, 0);
    }
  });
  it('lists and enveloped records are untouched by the fallback', () => {
    assert.equal(readShapeFacts({ rows: [{ id: 1 }, { id: 2 }] }).kind, 'list');
    assert.equal(readShapeFacts({ rows: [{ id: 1 }, { id: 2 }] }).count, 2);
    assert.equal(readShapeFacts({ ticket: { id: 7, subject: 'x' } }).count, 1);
  });
});

// v2.74.1887 — the two claims the SHAPER is now held to: the DECLARED id, and a named scope.
// The live pair (gl 2026-07-30 08:50): one record, two renders — `renderConnectorLines` said #4889637 (TicketId, the
// declaration's first choice) while the shaper said "Warranty task #01" (TaskNumber), because only the renderer was
// ever handed `displayId`.
const VS_ROW = { TaskId: 10878575, TicketId: 4889637, TaskNumber: '01', ClaimNumber: '03', AddressLine1: '804 Driftwood Ln', TaskStatus: 'open' };

describe('readShapeFacts — the declared displayId reaches the facts (v1887)', () => {
  it('a single record: the sample id is the first present key the recipe declared', () => {
    const f = readShapeFacts({ results: [VS_ROW] }, { displayId: ['TicketId', 'TaskNumber'] });
    assert.equal(f.count, 1);
    assert.equal(String(f.sample[0].id), '4889637');
  });
  it('WITHOUT the declaration the generic scan picks another id — the live disagreement, pinned', () => {
    const f = readShapeFacts({ results: [VS_ROW] });
    assert.notEqual(String(f.sample[0].id), '4889637');
  });
  it('a LIST sample carries it on every row', () => {
    const f = readShapeFacts({ results: [VS_ROW, { ...VS_ROW, TicketId: 4889638, TaskNumber: '02' }] }, { displayId: ['TicketId', 'TaskNumber'] });
    assert.deepEqual(f.sample.map((s) => String(s.id)), ['4889637', '4889638']);
  });
  it('falls back to the next declared key when the first is absent, then to the generic scan', () => {
    const noTicket = { TaskId: 10878575, TaskNumber: '01', AddressLine1: 'x' };
    assert.equal(String(readShapeFacts({ results: [noTicket] }, { displayId: ['TicketId', 'TaskNumber'] }).sample[0].id), '01');
    assert.ok(readShapeFacts({ results: [noTicket] }, { displayId: ['Nope'] }).sample[0].id != null);
  });
});

describe('ensureScopeNamed — a count claim names its scope, deterministically (v1887)', () => {
  it('appends the scope label to a bare count', () => {
    assert.equal(ensureScopeNamed('Yes, there is 1 open item: a warranty claim.', ['Atlanta West']),
      'Yes, there is 1 open item: a warranty claim (in Atlanta West).');
  });
  it('leaves an answer that already names it alone — including a different case', () => {
    const a = 'There is 1 open warranty task in Atlanta West.';
    assert.equal(ensureScopeNamed(a, ['Atlanta West']), a);
    assert.equal(ensureScopeNamed('1 open task in atlanta west', ['Atlanta West']), '1 open task in atlanta west');
  });
  it('fires on a yes/no existence claim with no digits', () => {
    assert.equal(ensureScopeNamed('No open warranty tasks right now.', ['Raleigh']), 'No open warranty tasks right now (in Raleigh).');
  });
  it('does NOT fire on a summary that makes no quantity claim — the marker must stay readable', () => {
    const a = 'The task is at 804 Driftwood Ln and is awaiting a vendor.';
    assert.equal(ensureScopeNamed(a, ['Atlanta West']), a);
  });
  it('no label, a junk label, or an each/all sweep → untouched', () => {
    assert.equal(ensureScopeNamed('There is 1 open task.', []), 'There is 1 open task.');
    assert.equal(ensureScopeNamed('There is 1 open task.', ['ea']), 'There is 1 open task.');
    assert.equal(ensureScopeNamed('There is 1 open task.', ['each']), 'There is 1 open task.');
    assert.equal(ensureScopeNamed('There are 18 across all 121 divisions.', ['all']), 'There are 18 across all 121 divisions.');
  });
  it('handles a missing terminal period and an empty answer', () => {
    assert.equal(ensureScopeNamed('1 open task', ['Raleigh']), '1 open task (in Raleigh)');
    assert.equal(ensureScopeNamed('', ['Raleigh']), '');
    assert.equal(ensureScopeNamed(null, ['Raleigh']), null);
  });
});

// v2.74.1888 — the STATS payload, verbatim from `PAYLOAD ▸ [vs_warranty_stats]` (gl 09:32). The live answer was
// "1 open warranty task in Atlanta West" while the list leg read that division EMPTY 26 seconds earlier: the counts
// live in a nested container the record projection drops, and `count:1` is the number of records read.
const STATS = { Key: 'warranty', Type: 8, DivisionStatistics: {
  newwarrantytasks: { Key: 'newwarrantytasks', StatisticType: 1, Count: 3, DivisionId: 83, ItemValue: null, ItemComment: null },
  openwarrantytasks: { Key: 'openwarrantytasks', StatisticType: 2, Count: 0, DivisionId: 83, ItemValue: null, ItemComment: null },
  fixedwarrantytasks: { Key: 'fixedwarrantytasks', StatisticType: 3, Count: 7, DivisionId: 83, ItemValue: null, ItemComment: null },
} };

describe('payloadMetrics — the numbers the record projection cannot see (v1888)', () => {
  it('lifts a nested Count and names it by the bucket that holds it', () => {
    assert.deepEqual(payloadMetrics(STATS), { newwarrantytasks: 3, openwarrantytasks: 0, fixedwarrantytasks: 7 });
  });
  it('ZERO is a measurement — the live open count was 0 and must not be dropped as falsy', () => {
    assert.equal(payloadMetrics(STATS).openwarrantytasks, 0);
    assert.ok('openwarrantytasks' in payloadMetrics(STATS));
  });
  it('ignores numbers that are not measures — ids, type codes, statistic types', () => {
    const m = payloadMetrics(STATS);
    assert.ok(!('Type' in m) && !('DivisionId' in m) && !('StatisticType' in m));
  });
  it('a top-level measure names itself', () => {
    assert.deepEqual(payloadMetrics({ Total: 12, Name: 'x' }), { Total: 12 });
  });
  it('never descends an array — a list quantity is `count`, and per-row values must not leak here', () => {
    assert.deepEqual(payloadMetrics([{ Count: 5 }]), {});
    assert.deepEqual(payloadMetrics({ rows: [{ Count: 5 }, { Count: 6 }] }), {});
  });
  it('a record payload yields NO metrics — the discriminator the fan aggregate relies on', () => {
    assert.deepEqual(payloadMetrics(VS_ROW), {});
    assert.deepEqual(payloadMetrics({ ...VS_ROW, AllowedAmount: 0, Age: '001' }), {});
  });
  it('sumMetrics adds by label across a fan', () => {
    assert.deepEqual(sumMetrics([{ open: 1, new: 2 }, { open: 3 }, null, { new: 4, other: 1 }]), { open: 4, new: 6, other: 1 });
    assert.deepEqual(sumMetrics([]), {});
  });
});

describe('readShapeFacts + the shaper message carry the metrics (v1888)', () => {
  it('the stats payload is an OBJECT with metrics, not an empty husk', () => {
    const f = readShapeFacts(STATS);
    assert.equal(f.kind, 'object');
    assert.deepEqual(f.metrics, { newwarrantytasks: 3, openwarrantytasks: 0, fixedwarrantytasks: 7 });
  });
  it('THE LIVE BUG, pinned: the model now receives the counts (before, it saw only count:1)', () => {
    const user = buildAnswerShapeMessages({ ask: 'total open warranty tasks?', facts: readShapeFacts(STATS), scope: 'divisionId=Atlanta West (83)' }).user;
    assert.match(user, /"openwarrantytasks":0/);
    assert.match(user, /"metrics"/);
  });
  it('the prompt tells the model what `count` is NOT', () => {
    const sys = buildAnswerShapeMessages({ ask: 'x', facts: readShapeFacts(STATS) }).system;
    assert.match(sys, /number of RECORDS read/);
    assert.match(sys, /never substitute "count"/);
  });
  it('a plain list is untouched — no metrics key, exact count', () => {
    const f = readShapeFacts({ results: [VS_ROW, { ...VS_ROW, TicketId: 4889638 }] });
    assert.equal(f.kind, 'list');
    assert.equal(f.count, 2);
    assert.ok(!('metrics' in f));
  });
});

describe('unsupportedCountClaim — no metric, no number (v1888)', () => {
  const husk = readShapeFacts({ Key: 'warranty', Type: 8 });
  it('fires on a quantity ask over a metric-less single record that states a figure', () => {
    assert.equal(unsupportedCountClaim({ ask: 'total open warranty tasks?', facts: husk, answer: '1 open warranty task in Atlanta West.' }), true);
    assert.equal(unsupportedCountClaim({ ask: 'how many are open?', facts: husk, answer: 'There is 1 open item.' }), true);
  });
  it('does NOT fire once the metrics are there — the fixed path stays open', () => {
    assert.equal(unsupportedCountClaim({ ask: 'total open warranty tasks?', facts: readShapeFacts(STATS), answer: 'No open warranty tasks in Atlanta West.' }), false);
  });
  it('does NOT fire on a LIST — its count is exact and IS the answer', () => {
    const list = readShapeFacts({ results: [VS_ROW, { ...VS_ROW, TicketId: 2 }] });
    assert.equal(unsupportedCountClaim({ ask: 'how many open tasks?', facts: list, answer: 'There are 2 open tasks.' }), false);
  });
  it('does NOT fire when the ask wants no quantity', () => {
    assert.equal(unsupportedCountClaim({ ask: 'what is the address?', facts: husk, answer: '804 Driftwood Ln.' }), false);
  });
  it('does NOT fire on an answer that states no figure', () => {
    assert.equal(unsupportedCountClaim({ ask: 'how many are open?', facts: husk, answer: 'I could not find that number in what came back.' }), false);
  });
});
