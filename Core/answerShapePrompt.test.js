// Core/answerShapePrompt.test.js — the interrogator answer-shaper's pure pieces (readShapeFacts + build + parse). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { askedMetric, superlativeAsk } from './askScope.js';
import { readShapeFacts, buildAnswerShapeMessages, parseAnswerShapeOutput, ensureScopeNamed, payloadMetrics, sumMetrics, unsupportedCountClaim, metricAnswerLine, countAnswerLine } from './answerShapePrompt.js';

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

// v2.74.1890 — the live pair that prompted this: `total open warranty tasks?` and `is there anything open right now?`
// returned BYTE-IDENTICAL three-number tables (gl 11:18), because the aggregate printed every measure and never read
// the ask. Same sums here; the two asks must now differ.
const SUMS = { newwarrantytasks: 2, openwarrantytasks: 19, fixedwarrantytasks: 9 };
const SCOPE = { scopePhrase: 'all 121 divisions', groups: 121, noun: 'division' };

describe('metricAnswerLine — shaped by the ask, not dumped (v1890)', () => {
  it('a COUNT ask leads with the number of the measure it named', () => {
    const s = metricAnswerLine({ ask: 'total open warranty tasks?', sums: SUMS, asked: askedMetric('total open warranty tasks?', SUMS), ...SCOPE });
    assert.match(s, /^\*\*19\*\* open \(openwarrantytasks\) across all 121 divisions/);
  });
  it('a YES/NO ask leads with yes and the number', () => {
    const s = metricAnswerLine({ ask: 'is there anything open right now?', sums: SUMS, asked: askedMetric('is there anything open right now?', SUMS), ...SCOPE });
    assert.match(s, /^\*\*Yes — 19\*\*/);
  });
  it('THE LIVE DEFECT: the two asks are no longer the same string', () => {
    const a = metricAnswerLine({ ask: 'total open warranty tasks?', sums: SUMS, asked: askedMetric('total open warranty tasks?', SUMS), ...SCOPE });
    const b = metricAnswerLine({ ask: 'is there anything open right now?', sums: SUMS, asked: askedMetric('is there anything open right now?', SUMS), ...SCOPE });
    assert.notEqual(a, b);
  });
  it('a zero measure answers NO rather than reporting a table', () => {
    const zero = { ...SUMS, openwarrantytasks: 0 };
    const s = metricAnswerLine({ ask: 'is there anything open right now?', sums: zero, asked: askedMetric('is there anything open right now?', zero), ...SCOPE });
    assert.match(s, /^\*\*No\*\* — 0 open/);
  });
  it('the measures NOT asked about are demoted, never dropped', () => {
    const s = metricAnswerLine({ ask: 'total open warranty tasks?', sums: SUMS, asked: askedMetric('total open warranty tasks?', SUMS), ...SCOPE });
    assert.match(s, /Also: newwarrantytasks 2 · fixedwarrantytasks 9\./);
    assert.ok(!/Also:[^\n]*openwarrantytasks/.test(s), 'the answered measure is not repeated in the secondary line');
  });
  it('the dashboard caveat survives, with the failure count when there was one', () => {
    assert.match(metricAnswerLine({ ask: 'x', sums: SUMS, ...SCOPE }), /own dashboard counts, summed over the 121 I read — not a row-by-row scan/);
    assert.match(metricAnswerLine({ ask: 'x', sums: SUMS, ...SCOPE, failed: 3 }), /summed over the 121 I read, 3 failed/);
  });
  it('no measure named by the ask → the TABLE is the honest answer', () => {
    const s = metricAnswerLine({ ask: 'what is going on?', sums: SUMS, asked: null, ...SCOPE });
    assert.match(s, /^Counts across all 121 divisions:/);
    assert.match(s, /\*\*openwarrantytasks\*\*: 19/);
  });
  it('the spread rides when it is known — 19 across 121, in 12 of them', () => {
    const s = metricAnswerLine({ ask: 'total open warranty tasks?', sums: SUMS, asked: askedMetric('total open warranty tasks?', SUMS), ...SCOPE, hits: 12 });
    assert.match(s, /in 12 of 121/);
  });
  it('empty sums produce nothing rather than an empty claim', () => {
    assert.equal(metricAnswerLine({ ask: 'x', sums: {} }), '');
    assert.equal(metricAnswerLine({ ask: 'x', sums: null }), '');
  });
});

describe('countAnswerLine — an aggregate over ROWS answers with the number, not the rows (v1891)', () => {
  const GROUPS = [{ label: 'Raleigh', n: 6 }, { label: 'Dallas South', n: 1 }, { label: 'Greensboro', n: 2 }];
  it('leads with the total and lists the biggest groups first', () => {
    const s = countAnswerLine({ ask: 'total open warranty tasks?', noun: 'tasks', total: 9, groups: GROUPS, cells: 121, cellNoun: 'division' });
    assert.match(s, /^\*\*9\*\* tasks across all 121 divisions, in 3 of 121: Raleigh 6 · Greensboro 2 · Dallas South 1\./);
  });
  it('a yes/no ask still leads with yes', () => {
    assert.match(countAnswerLine({ ask: 'is there anything open?', noun: 'tasks', total: 9, groups: GROUPS, cells: 121 }), /^\*\*Yes — 9\*\*/);
  });
  it('caps the named groups and counts the rest', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `d${i}`, n: 12 - i }));
    assert.match(countAnswerLine({ ask: 'how many?', noun: 'tasks', total: 78, groups: many, cells: 121 }), /· \+6 more\./);
  });
  it('zero is an honest negative, and a failed read is never hidden', () => {
    assert.equal(countAnswerLine({ ask: 'how many?', noun: 'tasks', total: 0, cells: 121, cellNoun: 'division' }), 'No tasks across all 121 divisions.');
    assert.match(countAnswerLine({ ask: 'how many?', noun: 'tasks', total: 0, cells: 121, failed: 2 }), /2 reads failed/);
    assert.match(countAnswerLine({ ask: 'how many?', noun: 'tasks', total: 9, groups: GROUPS, cells: 121, failed: 2 }), /the total may be low/);
  });
});

describe('metricAnswerLine — a SERVED count states its age (v1893)', () => {
  const SUMS2 = { newwarrantytasks: 5, openwarrantytasks: 22 };
  it('the age clause appears only when cells came from cache', () => {
    const fresh = metricAnswerLine({ ask: 'total open?', sums: SUMS2, asked: askedMetric('total open?', SUMS2), groups: 121, noun: 'division' });
    assert.ok(!/from reads up to/.test(fresh));
    const served = metricAnswerLine({ ask: 'total open?', sums: SUMS2, asked: askedMetric('total open?', SUMS2), groups: 121, noun: 'division', fromCache: 121, oldestMs: 118000 });
    assert.match(served, /121 of them from reads up to 118s old/);
  });
  it('the age rides WITH the failure count, not instead of it', () => {
    const s = metricAnswerLine({ ask: 'total open?', sums: SUMS2, groups: 121, noun: 'division', failed: 2, fromCache: 40, oldestMs: 60000 });
    assert.match(s, /summed over the 121 I read, 2 failed, 40 of them from reads up to 60s old/);
  });
  it('the number itself is unchanged by having been served', () => {
    const a = metricAnswerLine({ ask: 'total open?', sums: SUMS2, asked: askedMetric('total open?', SUMS2), groups: 121, noun: 'division' });
    const b = metricAnswerLine({ ask: 'total open?', sums: SUMS2, asked: askedMetric('total open?', SUMS2), groups: 121, noun: 'division', fromCache: 121, oldestMs: 5000 });
    assert.equal(a.split('\n')[0], b.split('\n')[0]);
  });
});

// v2.74.1895 — the live false absence: "how old are the open warranty tasks in Raleigh?" answered "the data does not
// include age or date information" over rows that carry Age, because the lean projection keeps `fields` only when
// title AND status are both empty. The ask now selects which scalars survive.
const AGED_ROW = { TicketId: 4888465, TaskNumber: '01', AddressLine1: '1097 Misty Creek Drive', CityStateZip: 'ABERDEEN, NC 28315', Age: '003', AllowedAmount: 0, ProjectName: 'Collinswood' };

describe('readShapeFacts — the field the QUESTION asks about survives (v1895)', () => {
  it('THE LIVE CASE: an age ask keeps Age on a row that also has a title', () => {
    const f = readShapeFacts({ results: [AGED_ROW, { ...AGED_ROW, TicketId: 4892224, Age: '012' }] }, { ask: 'how old are the open warranty tasks in Raleigh?' });
    assert.ok(f.sample[0].asked, 'the asked-for scalars ride the sample');
    assert.equal(f.sample[0].asked.Age, '003');
    assert.equal(f.sample[1].asked.Age, '012');
  });
  it('a DIFFERENT question keeps a different field, and never everything', () => {
    const f = readShapeFacts({ results: [AGED_ROW] }, { ask: 'what project is that task in?' });
    assert.equal(f.sample[0].asked.ProjectName, 'Collinswood');
    assert.ok(!('Age' in (f.sample[0].asked || {})), 'only what the ask names');
  });
  it('no ask, or an ask naming nothing on the record → unchanged payload', () => {
    assert.ok(!('asked' in readShapeFacts({ results: [AGED_ROW] }).sample[0]));
    assert.ok(!('asked' in readShapeFacts({ results: [AGED_ROW] }, { ask: 'is it urgent?' }).sample[0]));
  });
  it('a STATUS word never selects a field by itself — it names a filter the app already applied', () => {
    // "open" must not pull `OpenedDate`/`IsOpen`; carrying the entity's own status field alongside is harmless context
    const f = readShapeFacts({ results: [{ ...AGED_ROW, OpenedDate: '2026-07-01', IsOpen: true }] }, { ask: 'show me the open ones' });
    const a = f.sample[0].asked || {};
    assert.ok(!('OpenedDate' in a) && !('IsOpen' in a));
  });
  it('the English bridge crosses "how old" → Age, which no token rule can', () => {
    assert.equal(readShapeFacts({ results: [AGED_ROW] }, { ask: 'how old is it?' }).sample[0].asked.Age, '003');
    assert.equal(readShapeFacts({ results: [{ Id: 1, Title: 'x', CreatedDate: '2026-01-01' }] }, { ask: 'when was that opened?' }).sample[0].asked.CreatedDate, '2026-01-01');
  });
  it('bounded like the contact class — short scalars, capped, never an object', () => {
    const wide = { Age: '003', AgeBucket: 'week', AgeDays: 3, AgeLabel: 'three days', AgeNote: 'x', Nested: { a: 1 }, Instructions: 'y'.repeat(500) };
    const f = readShapeFacts({ results: [wide] }, { ask: 'how old with what instructions?' });
    const a = f.sample[0].asked || {};
    assert.ok(Object.keys(a).length <= 4);
    assert.ok(!('Nested' in a));
    for (const v of Object.values(a)) assert.ok(String(v).length <= 60);
  });
});

// v2.74.1897 — "which division has the most open tasks?" was answered twice with the TOTAL (gl 18:36) while the fan
// held all 121 per-division numbers. The argmax is over data already in hand.
const PERGROUP = [
  { label: 'Raleigh', m: { openwarrantytasks: 8, newwarrantytasks: 3 } },
  { label: 'Chicago', m: { openwarrantytasks: 2, newwarrantytasks: 0 } },
  { label: 'Greensboro', m: { openwarrantytasks: 5, newwarrantytasks: 1 } },
  { label: 'Las Vegas', m: { openwarrantytasks: 0, newwarrantytasks: 0 } },
];
describe('metricAnswerLine — a superlative names the GROUP (v1897)', () => {
  const ask = 'which division has the most open tasks?';
  const sums = { openwarrantytasks: 15, newwarrantytasks: 4 };
  it('THE LIVE ASK: the winner, its share of the total, and the runners-up', () => {
    const s = metricAnswerLine({ ask, sums, asked: askedMetric(ask, sums), perGroup: PERGROUP, superlative: 'max', scopePhrase: 'all 121 divisions', groups: 121, noun: 'division' });
    assert.match(s, /^\*\*Raleigh\*\* has the most open \(openwarrantytasks\) — \*\*8\*\* of 15 across all 121 divisions\./);
    assert.match(s, /Next: Greensboro 5 · Chicago 2\./);
  });
  it('min picks the other end, and may name a zero group', () => {
    const s = metricAnswerLine({ ask: 'which division has the fewest open tasks?', sums, asked: askedMetric('which division has the fewest open tasks?', sums), perGroup: PERGROUP, superlative: 'min', groups: 121, noun: 'division' });
    assert.match(s, /^\*\*Las Vegas\*\* has the fewest/);
  });
  it('a max NEVER names a zero group — "the most" of nothing is not an answer', () => {
    const s = metricAnswerLine({ ask, sums: { openwarrantytasks: 0 }, asked: askedMetric(ask, { openwarrantytasks: 0 }), perGroup: [{ label: 'A', m: { openwarrantytasks: 0 } }], superlative: 'max', groups: 121, noun: 'division' });
    assert.ok(!/has the most/.test(s), 'falls back to the total sentence');
  });
  it('no per-group data → the total sentence, unchanged', () => {
    const s = metricAnswerLine({ ask, sums, asked: askedMetric(ask, sums), superlative: 'max', scopePhrase: 'all 121 divisions', groups: 121, noun: 'division' });
    assert.match(s, /^\*\*15\*\* open/);
  });
  it('NOT a superlative → the total sentence, unchanged', () => {
    const s = metricAnswerLine({ ask: 'how many open tasks?', sums, asked: askedMetric('how many open tasks?', sums), perGroup: PERGROUP, superlative: null, groups: 121, noun: 'division' });
    assert.match(s, /^\*\*15\*\* open/);
  });
});

// v2.74.1903 — depth + the clock + the stock bridge, on the live Shopify shapes.
const SH_ORDER_T = { id: 'gid://shopify/Order/5551', name: 'DEAKO#69872', createdAt: '2026-07-20T10:00:00Z',
  displayFulfillmentStatus: 'FULFILLED', customer: { email: 'momkat820@gmail.com' },
  fulfillments: [{ deliveredAt: '2026-07-23T18:00:00Z', estimatedDeliveryAt: '2026-07-24T00:00:00Z', trackingInfo: [{ number: '1Z27691W0320913590', company: 'UPS' }] }] };
const SH_PRODUCT_T = { id: 'gid://shopify/Product/9', title: 'Smart Scene Controller Switch', status: 'ACTIVE', totalInventory: 1378,
  variants: { edges: [{ node: { title: 'White', sku: 'DK-SW-01', price: '49.00', inventoryQuantity: 620 } }] } };

describe('readShapeFacts — the asked block reaches DEPTH (v1903)', () => {
  it('THE LIVE CASE: "is it in stock?" now carries the inventory (the stock bridge + deep walk)', () => {
    const f = readShapeFacts({ results: [SH_PRODUCT_T, { ...SH_PRODUCT_T, id: 'x' }] }, { ask: 'is the smart switch in stock?' });
    assert.ok(f.sample[0].asked, 'asked block present');
    assert.match(JSON.stringify(f.sample[0].asked), /1378|620/);
  });
  it('"has it been delivered?" carries deliveredAt from inside fulfillments', () => {
    const f = readShapeFacts({ results: [SH_ORDER_T, { ...SH_ORDER_T, id: 'y' }] }, { ask: 'has it been delivered yet?' });
    assert.match(JSON.stringify(f.sample[0].asked || {}), /deliveredAt/);
  });
  it('flat rows are byte-identical to the v1895 behaviour', () => {
    const f = readShapeFacts({ results: [{ TicketId: 1, Title: 'x', Age: '003' }] }, { ask: 'how old is it?' });
    assert.equal(f.sample[0].asked.Age, '003');
  });
});

describe('buildAnswerShapeMessages — the clock (v1903)', () => {
  it('TODAY rides the user message when the transport supplies it', () => {
    const u = buildAnswerShapeMessages({ ask: 'how old are those orders?', facts: readShapeFacts({ results: [SH_ORDER_T, SH_ORDER_T] }), today: '2026-07-31' }).user;
    assert.match(u, /TODAY: 2026-07-31/);
  });
  it('the system rule forbids computing an age without TODAY', () => {
    assert.match(buildAnswerShapeMessages({ ask: 'x', facts: readShapeFacts({ results: [SH_ORDER_T, SH_ORDER_T] }) }).system, /inventing today's date is fabrication/);
  });
  it('no today → no TODAY line (byte-identical prompt otherwise)', () => {
    assert.doesNotMatch(buildAnswerShapeMessages({ ask: 'x', facts: readShapeFacts({ results: [SH_ORDER_T, SH_ORDER_T] }) }).user, /TODAY:/);
  });
});
