// Core/connectorRender.test.js — generic session-ride result rendering (CX-4c). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { primaryList, primaryObject, summarizeItem, renderConnectorLines, itemLabels, fanoutItems, fanoutSummary, dossierLines, primaryItemId, createdRecordId, itemFields, recordDetails, toWorkItem, toWorkItems } from './connectorRender.js';

describe('primaryList — find the data array', () => {
  it('prefers known data keys, falls back to any object-array, ignores scalar arrays', () => {
    assert.equal(primaryList({ results: [{ id: 1 }] }).length, 1);
    assert.equal(primaryList({ tickets: [{ id: 1 }, { id: 2 }] }).length, 2);
    assert.equal(primaryList({ comments: [{ id: 9 }] })[0].id, 9);
    assert.equal(primaryList({ things: [{ id: 3 }] }).length, 1);             // unknown key, array-of-objects → still found
    assert.equal(primaryList({ tags: ['a', 'b'], count: 0 }), null);          // a scalar array is not the data list
    assert.deepEqual(primaryList([{ id: 1 }]), [{ id: 1 }]);                  // a bare array
    assert.equal(primaryList(null), null);
  });
  it('CX-7 (v2.74.1390): recurses into a nested GraphQL envelope and unwraps edges[].node', () => {
    const gql = { data: { customers: { edges: [
      { node: { id: 'gid://shopify/Customer/12345', firstName: 'Divine', lastName: 'Monkam', email: 'dmonkam.tc@example.com', numberOfOrders: 3 }, cursor: 'x' },
    ] } } };
    const list = primaryList(gql);
    assert.equal(list.length, 1);
    assert.equal(list[0].email, 'dmonkam.tc@example.com');   // reached the node
    assert.ok(!('node' in list[0]) && !('cursor' in list[0]));   // edge unwrapped
    // a genuinely-empty search stays empty (0), not a false "found"
    assert.deepEqual(primaryList({ data: { customers: { edges: [] } } }), []);
  });
});

describe('summarizeItem — Shopify records (CX-7)', () => {
  it('names a customer from firstName+lastName (no name field), shortens the gid, reads the display status', () => {
    const cust = summarizeItem({ id: 'gid://shopify/Customer/12345', firstName: 'Divine', lastName: 'Monkam', email: 'd@example.com' });
    assert.equal(cust.title, 'Divine Monkam');
    assert.equal(cust.id, '12345');                          // gid → numeric tail
    const order = summarizeItem({ id: 'gid://shopify/Order/9', name: 'DEAKO#69872', displayFulfillmentStatus: 'FULFILLED' });
    assert.equal(order.title, 'DEAKO#69872');
    assert.equal(order.status, 'FULFILLED');                 // camelCase status key
    const emailOnly = summarizeItem({ id: 'gid://shopify/Customer/7', email: 'only@example.com' });
    assert.equal(emailOnly.title, 'only@example.com');       // email fallback when no name
  });
});

describe('primaryObject — find the single record', () => {
  it('unwraps {ticket:{…}}/{user:{…}}; takes the value itself when id/name-shaped; else null', () => {
    assert.equal(primaryObject({ ticket: { id: 7 } }).id, 7);
    assert.equal(primaryObject({ user: { id: 4, name: 'Al' } }).name, 'Al');
    assert.equal(primaryObject({ id: 5, subject: 's' }).id, 5);              // bare record
    assert.equal(primaryObject({ meta: 'x', count: 0 }), null);             // no id / name → not a record
  });
});

describe('summarizeItem — salient fields, app-agnostic', () => {
  it('a ticket: id + subject(name) + status; full adds the description body', () => {
    const t = { id: 64775, subject: 'Switches no longer working', status: 'open', description: 'They stopped.' };
    assert.deepEqual(summarizeItem(t), { id: 64775, title: 'Switches no longer working', status: 'open', body: '', url: null });
    assert.equal(summarizeItem(t, { full: true }).body, 'They stopped.');    // distinct name + content → body shown
  });
  it('a content-only item (a comment / message): the text becomes the title (no separate body)', () => {
    const c = { id: 9, body: 'Please call me back', public: false };
    const s = summarizeItem(c, { full: true });
    assert.equal(s.title, 'Please call me back');
    assert.equal(s.body, '');                                                // name absent → content IS the title, not duplicated
  });
  it('drops an /api/ url (not user-facing), keeps a real one', () => {
    assert.equal(summarizeItem({ id: 1, url: 'https://x.zendesk.com/api/v2/tickets/1.json' }).url, null);
    assert.equal(summarizeItem({ id: 1, html_url: 'https://x.com/t/1' }).url, 'https://x.com/t/1');
  });
});

describe('primaryItemId — the record a read RETURNED (CX-7e, for "show profile")', () => {
  it('the id of the single/first record, gid → numeric tail; null when none', () => {
    const gql = { data: { customers: { edges: [{ node: { id: 'gid://shopify/Customer/12345', firstName: 'A', lastName: 'B' } }] } } };
    assert.equal(primaryItemId(gql), '12345');                 // gid tail — feeds the /customers/{id} itemUrl
    assert.equal(primaryItemId({ tickets: [{ id: 64775, subject: 's' }] }), 64775);   // Zendesk numeric id
    assert.equal(primaryItemId({ ticket: { id: 7 } }), 7);     // wrapped single object
    assert.equal(primaryItemId({ data: { customers: { edges: [] } } }), null);        // empty → null
    assert.equal(primaryItemId(null), null);
  });
});

describe('createdRecordId — the record a WRITE created (CX-7f, for "show it" after a create)', () => {
  it('digs data.<op>.<entity>.id, skips userErrors, gid → numeric tail; null when none', () => {
    const create = { data: { customerCreate: { customer: { id: 'gid://shopify/Customer/778899', firstName: 'Divine' }, userErrors: [] } } };
    assert.equal(createdRecordId(create), '778899');                                   // feeds /customers/{id}
    const draft = { data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/42' }, userErrors: [] } } };
    assert.equal(createdRecordId(draft), '42');                                        // feeds /draft_orders/{id}
    assert.equal(createdRecordId({ data: { thing: { id: 5 } } }), 5);                  // op-result carries the id directly
    assert.equal(createdRecordId({ data: { customerCreate: { customer: null, userErrors: [{ message: 'x' }] } } }), null);  // no record (only userErrors) → null
    assert.equal(createdRecordId({ data: { customers: { edges: [] } } }), null);       // a READ envelope isn't a create → null
    assert.equal(createdRecordId(null), null);
  });
});

describe('renderConnectorLines — the chat lines', () => {
  it('a ticket list → header (N): + bullets; an empty list → header.', () => {
    const lines = renderConnectorLines({ results: [{ id: 1, subject: 'A', status: 'open' }, { id: 2, subject: 'B', status: 'open' }] }, { name: 'My open Zendesk tickets' });
    assert.equal(lines[0], 'My open Zendesk tickets (2):');
    assert.equal(lines[1], '• #1 A — open');
    assert.deepEqual(renderConnectorLines({ tickets: [] }, { name: 'Tickets' }), ['Tickets (0).']);
  });
  it('a SINGLE-record list renders as the full record (v2.74.1392), not a bare bullet', () => {
    const lines = renderConnectorLines({ comments: [{ id: 9, body: 'Call me back' }] }, { name: 'Conversation' });
    assert.deepEqual(lines, ['#9 Call me back']);        // content as title; no header/bullet for a lone record
  });
  it('CX-7: a single Shopify customer renders its PROFILE (email/phone/orders/tags/location), not #id name', () => {
    const gql = { data: { customers: { edges: [{ node: {
      id: 'gid://shopify/Customer/12345', firstName: 'Divine', lastName: 'Monkam', email: 'd@example.com',
      phone: '+15551234567', numberOfOrders: 3, tags: ['vip', 'wholesale'], defaultAddress: { city: 'Austin', province: 'TX', country: 'US' },
    } }] } } };
    const lines = renderConnectorLines(gql, { name: 'Find a Shopify customer by email' });
    assert.equal(lines[0], '#12345 Divine Monkam');       // name + shortened gid
    const text = lines.join('\n');
    assert.match(text, /Email: d@example\.com/);
    assert.match(text, /Phone: \+15551234567/);
    assert.match(text, /Orders: 3/);                      // aliased label (numberOfOrders → "Orders")
    assert.match(text, /Tags: vip, wholesale/);
    assert.match(text, /Location: Austin, TX, US/);       // aliased (defaultAddress → "Location")
  });
  it('CX-7e: a single Shopify ORDER surfaces payment/total/tracking (the nested CS fields), deduped vs the shown status', () => {
    const gql = { data: { orders: { edges: [{ node: {
      id: 'gid://shopify/Order/6818042937478', name: 'DEAKO#12043', createdAt: '2025-10-09T23:53:59Z',
      displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
      totalPriceSet: { shopMoney: { amount: '0.00', currencyCode: 'USD' } },
      customer: { email: 'd@example.com' },
      fulfillments: [{ status: 'success', trackingInfo: [{ company: 'UPS', number: '1Z999', url: 'https://ups.com/1Z999' }] }],
      returns: [], refunds: [], tags: ['draft', 'FOC', 'sent-to-3PL'],
    } }] } } };
    const text = renderConnectorLines(gql, { name: 'Look up a Shopify order' }).join('\n');
    assert.match(text, /#6818042937478 DEAKO#12043 — FULFILLED/);   // primary status = fulfillment
    assert.match(text, /Payment: PAID/);                            // the SECOND status now shows (was dropped)
    assert.match(text, /Total: 0\.00 USD/);                         // money nested 2 deep, formatted
    assert.match(text, /Tracking: UPS 1Z999/);                      // pulled from fulfillments[].trackingInfo
    assert.match(text, /Customer: d@example\.com/);
    assert.ok(!/Fulfillment: FULFILLED/.test(text));                // not duplicated as an extra (dedup vs shown status)
  });
  it('CX-7f: a returned/refunded order surfaces Payment + Return status + Refund amount (the live gap)', () => {
    const gql = { data: { orders: { edges: [{ node: {
      id: 'gid://shopify/Order/99', name: 'DEAKO#500', displayFinancialStatus: 'PARTIALLY_REFUNDED', displayFulfillmentStatus: 'FULFILLED',
      totalPriceSet: { shopMoney: { amount: '86.40', currencyCode: 'USD' } },
      fulfillments: [{ trackingInfo: [{ company: 'FedEx', number: '7712345' }] }],
      returns: { edges: [{ node: { status: 'IN_PROGRESS', returnLineItems: { edges: [{ node: { quantity: 4 } }] } } }] },   // a CONNECTION
      refunds: [{ createdAt: '2026-03-23', totalRefundedSet: { shopMoney: { amount: '86.40', currencyCode: 'USD' } } }],       // a plain list
      tags: [],
    } }] } } };
    const text = renderConnectorLines(gql, { name: 'Look up a Shopify order' }).join('\n');
    assert.match(text, /Payment: PARTIALLY_REFUNDED/);              // the return/refund state the coarse status hid
    assert.match(text, /Return: 1 \(in progress\)/);               // returns connection unwrapped + status
    assert.match(text, /Refunded: 86\.40 USD/);                    // refund amount (nested money in a list)
    assert.match(text, /Tracking: FedEx 7712345/);
  });
  it('caps a long list at 25 with a "+ N more" note (no silent truncation)', () => {
    const big = Array.from({ length: 30 }, (_, i) => ({ id: i, subject: `t${i}` }));
    const lines = renderConnectorLines({ results: big }, { name: 'X' });
    assert.equal(lines.length, 1 + 25 + 1);                                  // header + 25 rows + the "+5 more"
    assert.equal(lines[lines.length - 1], '… +5 more');
  });
  it('a single object → id/title/status + body + a user-facing url', () => {
    const lines = renderConnectorLines({ ticket: { id: 7, subject: 'Boom', status: 'open', description: 'It broke', html_url: 'https://x.com/t/7' } }, { name: 'Ticket' });
    assert.equal(lines[0], '#7 Boom — open');
    assert.equal(lines[1], 'It broke');
    assert.equal(lines[2], 'https://x.com/t/7');
  });
  it('nothing displayable → null (caller shows "Done.")', () => {
    assert.equal(renderConnectorLines({ ok: true }, {}), null);
    assert.equal(renderConnectorLines(null, {}), null);
  });
});

describe('itemLabels — fan-out labels from a read (CV-4-full)', () => {
  it('projects a ticket list into "#id title" labels; reports total + uncapped', () => {
    const r = itemLabels({ results: [{ id: 1, subject: 'A' }, { id: 2, subject: 'B' }] });
    assert.deepEqual(r.labels, ['#1 A', '#2 B']);
    assert.equal(r.total, 2);
    assert.equal(r.capped, false);
  });
  it('caps at the limit + flags capped (no silent truncation — the caller says "N of M")', () => {
    const big = Array.from({ length: 25 }, (_, i) => ({ id: i, subject: `t${i}` }));
    const r = itemLabels({ results: big }, 20);
    assert.equal(r.labels.length, 20);
    assert.equal(r.total, 25);
    assert.equal(r.capped, true);
  });
  it('a content-only item (no id) → just the title; a listless/empty/null result → no labels', () => {
    assert.deepEqual(itemLabels({ comments: [{ body: 'Call me back' }] }).labels, ['Call me back']);
    assert.deepEqual(itemLabels({ ticket: { id: 7 } }).labels, [], 'a single object is not a list');
    assert.deepEqual(itemLabels(null).labels, []);
  });
});

// CX-9c (v2.74.1436) — rows OUTSIDE the key vocabulary (the VendorSuite warranty shape) must not render as empty
// husks: id falls back to a …Number/…Id key, and lists carry the generic fields the single-record view already had.
describe('CX-9c — vocabulary-less rows (VendorSuite shape) render their real fields', () => {
  const ROW = (over) => ({ TaskId: 4001, TicketId: 9001, TaskNumber: '4090740', ClaimNumber: '01', Age: '263 days',
    IsPayable: true, AllowedAmount: 214, AddressLine1: '3955 Gallery Chase', CityStateZip: 'Cumming, GA 30028',
    ProjectId: 55, ProjectName: 'Brookside', JobNumber: '217710051', ...over });

  it('summarizeItem: id falls back to the HUMAN …Number key (TaskNumber beats TaskId); title stays empty (no name key)', () => {
    const it_ = summarizeItem(ROW());
    assert.equal(it_.id, '4090740');           // TaskNumber — the number the site shows, not the internal TaskId
    assert.equal(it_.title, '');
    const idOnly = summarizeItem({ TaskId: 4001, AddressLine1: 'x' });
    assert.equal(idOnly.id, 4001);             // no …Number key → …Id fallback
  });

  it('itemFields: the generic labeled projection (skips …Id noise, keeps address/claim/amount)', () => {
    const f = Object.fromEntries(itemFields(ROW(), { max: 8 }));
    const keys = Object.keys(f).join('|').toLowerCase();
    assert.ok(Object.values(f).includes('3955 Gallery Chase'), 'address value present');
    assert.ok(Object.values(f).includes('Cumming, GA 30028'), 'city/state/zip present');
    assert.equal(/task id|ticket id|project id/.test(keys), false, 'foreign-id noise skipped');
  });

  it('renderConnectorLines: a MULTI-row list shows real fields, never "(no title)"', () => {
    const lines = renderConnectorLines([ROW(), ROW({ TaskNumber: '4090741', AddressLine1: '456 Oak Ave' })], { name: 'Warranty tasks' });
    assert.equal(lines.length, 3);             // header + 2 rows
    assert.match(lines[1], /#4090740/);
    assert.match(lines[1], /3955 Gallery Chase/);
    assert.doesNotMatch(lines[1], /\(no title\)/);
  });

  it('itemLabels: fan-out labels carry the fields fallback too', () => {
    const { labels } = itemLabels([ROW()]);
    assert.match(labels[0], /#4090740/);
    assert.doesNotMatch(labels[0], /\bitem\b/);
  });
});

// CX-9g (v2.74.1440) — the DETAIL record's payload must survive the cap: the live warranty detail carried
// Priority/Instructions/VendorExplanation at the TAIL of 25+ fields, and the old walk-order cap-8 filled up on
// SearchField + booleans before reaching them — the drilled answer had "no warranty details". Rank-then-cap.
describe('CX-9g — a tail-heavy DETAIL record surfaces its instructions/priority/explanation', () => {
  const DETAIL = {
    SearchField: 'blob4090740cummingga', TaskId: 963119, TicketId: 9001, BusinessUnitId: 7, TaskNumber: '10803524',
    ClaimNumber: '01', Age: '263', IsFixed: false, IsPayable: true, IsPaid: false, AllowedAmount: 214,
    AddressLine1: '216 Indigo Bunting Court', CityStateZip: 'LEXINGTON, NC 27295', ProjectId: 55,
    ProjectCode: 'PC1', ProjectName: 'Brookside', CostCode: 'CC', VendorId: 3159950, ProjectDisplayName: 'Brookside Ph2',
    LotBlockPhase: '2A W', DateCreated: '2025-06-30T00:00:00', TaskStatus: 'Open',
    Appointments: [{ StartDate: '2026-07-10T07:00:00', EndDate: '2026-07-10T16:00:00' }],
    Priority: '1', Instructions: 'Replace the smart switch in the master bedroom and verify the 3-way circuit works',
    VendorExplanation: 'Awaiting parts from the supplier, scheduled for the next visit',
  };
  it('recordDetails: Instructions + VendorExplanation + Address make the cut (rank-then-cap, 12 budget, 200-char text)', () => {
    const d = recordDetails(DETAIL);
    const vals = Object.values(d).join(' | ');
    assert.match(vals, /Replace the smart switch in the master bedroom/);   // the INSTRUCTIONS — the answer the user asked for
    assert.match(vals, /Awaiting parts from the supplier/);                 // the vendor explanation
    assert.match(vals, /216 Indigo Bunting Court/);
    assert.equal(Object.values(d).includes('10803524'), false);             // the id never re-renders as an extra field
  });
  it('summarizeItem: Priority reaches the status slot case-insensitively; the appointment array renders generically', () => {
    const it_ = summarizeItem(DETAIL);
    assert.equal(it_.status, '1');                                          // Priority (PascalCase) ∈ STATUS_KEYS('priority') — was a silent case miss
    const d = recordDetails(DETAIL);
    assert.ok(Object.entries(d).some(([k, v]) => /appointment/i.test(k) && /2026-07-10T07:00:00/.test(String(v))), 'appointments array → first row scalars');
  });

  // CX-9h (v2.74.1441) — the LIVE bug both drilled answers hit: the generic any-object-array hunt returned the
  // detail's Appointments[1] as "the data list", so the render/shaper saw the APPOINTMENT (start/end + booleans)
  // and never the task — "there are no warranty details", twice. A record-shaped root IS the record.
  it('CX-9h: a record-shaped root with a nested child array resolves as the RECORD, never the child list', () => {
    assert.equal(primaryList(DETAIL), null);                                // Appointments is a CHILD, not the data
    assert.equal(primaryObject(DETAIL), DETAIL);                            // suffix-id shapes count as record-shaped
    const lines = renderConnectorLines(DETAIL, { name: 'Warranty task details' });
    const text = lines.join('\n');
    assert.match(text, /Replace the smart switch in the master bedroom/);   // the task's INSTRUCTIONS render
    assert.doesNotMatch(lines[0], /1744395/);                               // the head line is the task, not an appointment id
  });

  it('CX-9h: the Zendesk twin — {ticket:{…custom_fields:[{…}]}} resolves as the ticket, and explicit lists still win', () => {
    const t = { ticket: { id: 7, subject: 'Broken switch', status: 'open', custom_fields: [{ id: 1, value: 'x' }, { id: 2, value: null }] } };
    assert.equal(primaryList(t), null);                                     // custom_fields never hijacks a single-ticket read
    assert.equal(primaryObject(t).id, 7);
    assert.equal(primaryList({ results: [{ id: 1 }, { id: 2 }] }).length, 2);   // LIST_KEYS roots unchanged
    assert.equal(primaryList([{ TaskId: 1 }, { TaskId: 2 }]).length, 2);        // bare arrays unchanged
  });
});

describe('v2.74.1469 — the Aircall teammate row renders name + availability (live: "#1740968 email" with no status)', () => {
  it('fullName wins the title, availabilityStatus fills status', () => {
    const row = { __typename: 'Agent', ID: 1740968, fullName: 'D Monkam', extension: 101, avatarUrl: 'x', availabilityStatus: 'available', email: 'user@example.com', deleted: false };
    const it_ = summarizeItem(row);
    assert.equal(it_.title, 'D Monkam');            // was the email (fullName absent from NAME_KEYS)
    assert.equal(it_.status, 'available');           // was null (availabilityStatus absent from STATUS_KEYS)
    assert.equal(String(it_.id), '1740968');
  });
});

describe('DK-3 (DESIGN_desks.md §6) — WorkItem normalizer (toWorkItem / toWorkItems)', () => {
  it('a Zendesk-shaped ticket → WorkItem with source/owner/corrKeys (owner = assignee, keys = requester)', () => {
    const ticket = { id: 4090, subject: 'Dishwasher leak', status: 'open',
      assignee: { name: 'Divine Monkam', email: 'agent@deako.com' },
      requester: { name: 'Jane Doe', email: 'Jane.Doe@example.com', phone: '+1 (404) 555-1234' } };
    const w = toWorkItem(ticket, { source: 'Zendesk' });
    assert.equal(w.source, 'Zendesk');
    assert.equal(w.id, '4090');
    assert.equal(w.subject, 'Dishwasher leak');
    assert.equal(w.state, 'open');
    assert.equal(w.owner, 'Divine Monkam');
    assert.deepEqual(w.corrKeys, ['email:jane.doe@example.com', 'phone:4045551234']);
  });
  it('the OWNER own email/phone is NOT a correlation key (no agent-merge)', () => {
    const t = { id: 1, subject: 'x', assignee: { email: 'agent@deako.com', phone: '5551110000' } };
    assert.deepEqual(toWorkItem(t, { source: 'Z' }).corrKeys, []);
  });
  it('phone normalization converges +1 / formatting; order-no converges #hash and order_number', () => {
    assert.deepEqual(toWorkItem({ id: 1, phone: '+1 404-555-1234' }).corrKeys, ['phone:4045551234']);
    assert.deepEqual(toWorkItem({ id: 1, phone: '(404) 555 1234' }).corrKeys, ['phone:4045551234']);
    assert.deepEqual(toWorkItem({ id: 2, name: '#1001' }).corrKeys, ['order:1001']);
    assert.deepEqual(toWorkItem({ id: 2, order_number: '1001' }).corrKeys, ['order:1001']);
  });
  it('a call and a ticket that share a phone produce the SAME join key (the cross-site link)', () => {
    const call = toWorkItem({ id: 'c1', contact: { phoneNumber: '14045551234' } }, { source: 'Aircall' });
    const ticket = toWorkItem({ id: 't1', requester: { phone: '(404) 555-1234' } }, { source: 'Zendesk' });
    assert.ok(call.corrKeys.includes('phone:4045551234'));
    assert.ok(ticket.corrKeys.includes('phone:4045551234'));
  });
  it('free-text bodies are NOT mined for keys (the privacy lever)', () => {
    const t = { id: 1, subject: 'hi', description: 'reach me at sneaky@example.com about order #9999' };
    assert.deepEqual(toWorkItem(t).corrKeys, []);
  });
  it('toWorkItems maps a whole GraphQL list result + stamps source', () => {
    const result = { data: { conversations: { edges: [{ node: { id: 'a', subject: 'A', status: 'OPENED' } }, { node: { id: 'b', subject: 'B', status: 'OPENED' } }] } } };
    const items = toWorkItems(result, { source: 'Aircall' });
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.id), ['a', 'b']);
    assert.ok(items.every((i) => i.source === 'Aircall'));
  });
  it('safe on null / scalar rows', () => {
    assert.deepEqual(toWorkItem(null, { source: 'X' }), { source: 'X', id: '', subject: '', state: '', owner: '', url: '', corrKeys: [] });
    assert.deepEqual(toWorkItems(null), []);
  });
});

describe('DK-8e (v2.74.1496) — fanoutItems (a case is born with its record, not a label)', () => {
  const VS_ROW = { division: 'Las Vegas', TaskId: 2841790, TaskNumber: '4090740', ClaimNumber: '01', AddressLine1: '811 CALM CRYSTAL CT', CityStateZip: 'LAS VEGAS, NV 89123', Age: '004', AllowedAmount: 0, IsNew: true };
  it('label = the human title with NO leading #id (the id prefix poisoned division resolution live)', () => {
    const { items } = fanoutItems({ results: [VS_ROW] });
    assert.equal(items.length, 1);
    assert.ok(!items[0].label.startsWith('#'), items[0].label);
    assert.ok(items[0].label.includes('Las Vegas'), items[0].label);
  });
  it('detail carries the display id, the record fields, AND the internal …Id join keys (TaskId — the drill identity)', () => {
    const { items } = fanoutItems({ results: [VS_ROW] });
    const d = items[0].detail;
    assert.ok(/^Id: /m.test(d), 'display id line');
    assert.ok(/Task id: 2841790/i.test(d), 'TaskId join key rides the dossier');
    assert.ok(/811 CALM CRYSTAL CT|Address/i.test(d), 'record fields present');
  });
  it('caps + totals honest; empty/listless-safe', () => {
    const many = { results: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, subject: `T${i + 1}` })) };
    const r = fanoutItems(many, 20);
    assert.equal(r.items.length, 20);
    assert.equal(r.total, 30);
    assert.equal(r.capped, true);
    assert.deepEqual(fanoutItems(null).items, []);
  });
});

describe('DK-8i (v2.74.1501) — fanoutSummary (the desk gets the operator LEDGER line, never the record dump)', () => {
  it('the live shape: 1 found from a named read → opened it as a case, titled', () => {
    const s = fanoutSummary({ found: 1, opened: 1, capped: false, source: 'Warranty tasks by status', deskTitle: 'Warranty desk', titles: ['Magnolia Bay - 634270000'] });
    assert.ok(s.startsWith('Found 1 item from “Warranty tasks by status” → opened it as a case: “Magnolia Bay - 634270000”'), s);
    assert.ok(s.includes('nested under “Warranty desk” in the rail. Open it to work it.'), s);
    assert.ok(!/Address|City state|Claim number/i.test(s));   // the record dump NEVER rides the desk line
  });
  it('"open the first as a case" (capped 1 of 13) says so — count honesty', () => {
    const s = fanoutSummary({ found: 13, opened: 1, capped: true, source: 'Warranty tasks by status', deskTitle: 'Warranty desk', titles: ['Magnolia Bay'] });
    assert.ok(s.startsWith('Found 13 items'), s);
    assert.ok(s.includes('opened the first as a case: “Magnolia Bay”'), s);
  });
  it('plural: opened each (uncapped) / the first N (capped); >3 titles stay off the line', () => {
    const s = fanoutSummary({ found: 3, opened: 3, deskTitle: 'Warranty desk', titles: ['a', 'b', 'c'] });
    assert.ok(s.includes('opened each as cases (“a”, “b”, “c”)'), s);
    const big = fanoutSummary({ found: 13, opened: 5, capped: true, deskTitle: 'D', titles: ['a', 'b', 'c', 'd', 'e'] });
    assert.ok(big.includes('opened the first 5 as cases —'), big);
    assert.ok(!big.includes('“a”'), big);
  });
  it('zero opened → the honest failure line', () => {
    assert.equal(fanoutSummary({ found: 4, opened: 0 }), 'Couldn’t open any cases.');
    assert.equal(fanoutSummary(), 'Couldn’t open any cases.');
  });
  it('DK-8k — the ALREADY-OPEN reasoning: a re-run says its case is open, never duplicates or reads as failure', () => {
    const s = fanoutSummary({ found: 1, opened: 0, skipped: 1, source: 'Warranty tasks by status', deskTitle: 'Warranty desk' });
    assert.ok(s.includes('it’s already open as a case under “Warranty desk”'), s);
    assert.ok(s.includes('Nothing new to open.'), s);
    const all = fanoutSummary({ found: 3, opened: 0, skipped: 3, deskTitle: 'D' });
    assert.ok(all.includes('all 3 are already open as cases'), all);
    const mixed = fanoutSummary({ found: 3, opened: 2, skipped: 1, deskTitle: 'D', titles: ['a', 'b'] });
    assert.ok(mixed.includes('(1 already open, skipped)'), mixed);
  });
});

describe('DK-8f (v2.74.1497) — dossierLines + the raw row rides the fan-out item (the drill join source)', () => {
  it('fanoutItems carries the RAW row (the drill reads its join key from it)', () => {
    const row = { TaskId: 10833116, AddressLine1: '8317 Alexander Court', ClaimNumber: '03' };
    const { items } = fanoutItems({ results: [row] });
    assert.equal(items[0].row.TaskId, 10833116);
  });
  it('dossierLines: a drilled DETAIL record earns a bigger budget (max), null-safe', () => {
    const detail = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`Field${i}`, `v${i}`]));
    detail.TaskId = 10833116; detail.status = 'new';
    assert.ok(dossierLines(detail, { max: 24 }).length <= 24);
    assert.ok(dossierLines(detail, { max: 24 }).length > dossierLines(detail, { max: 8 }).length);
    assert.deepEqual(dossierLines(null), []);
  });
});

describe('DK-8g (v2.74.1498) — the dossier carries the record NARRATIVE (vendor explanation etc.)', () => {
  it('a content-classed field (description) lands as Notes; a named explanation field lands under its label', () => {
    const detail = { TaskId: 1, AddressLine1: '811 Calm Crystal Ct', description: 'Homeowner reports the master bath switch is dead after the storm.', VendorExplanation: 'Replaced the failed dimmer module; homeowner verified operation before departure.' };
    const lines = dossierLines(detail, { max: 24 });
    assert.ok(lines.some((l) => /^(Notes|Description): Homeowner reports/.test(l)), lines.join('|'));
    assert.ok(lines.some((l) => /^Vendor explanation: Replaced the failed dimmer/.test(l)), lines.join('|'));
  });
  it('a narrative field is never duplicated when recordDetails already listed it; the cap holds', () => {
    const long = 'Replaced the failed dimmer module; homeowner verified operation before departure.';
    const lines = dossierLines({ TaskId: 1, VendorExplanation: long }, { max: 24 });
    assert.equal(lines.filter((l) => l.includes('Replaced the failed dimmer')).length, 1, lines.join('|'));
    assert.ok(lines.length <= 24);
  });
});

describe('CX-9k (v2.74.1617) — recipe-declared displayId: the HUMAN row id wins over the generic scans', () => {
  // The live shape class: a VS warranty row whose FIRST …Number field is the per-home claim sequence ("01") —
  // every list bullet read "#01" (22 of 24 identical). The recipe now declares which key IS the human id.
  const ROW = { ClaimNumber: '01', TaskNumber: '4090740', TicketId: 4867009, AddressLine1: '953 Misty Creek Drive', TaskId: 'abc-123' };
  it('summarizeItem: declared keys tried in order — first PRESENT scalar wins; absent candidates skip on', () => {
    assert.equal(summarizeItem(ROW, { displayId: ['TicketId', 'TaskNumber'] }).id, 4867009);
    assert.equal(summarizeItem(ROW, { displayId: ['NopeKey', 'TaskNumber'] }).id, '4090740');
  });
  it('no declaration / none present → the CX-9c fallbacks exactly as before (exact ID_KEYS, then first …Number)', () => {
    assert.equal(summarizeItem(ROW).id, '01', 'ClaimNumber is first in record order — the very miss the declaration fixes');
    assert.equal(summarizeItem(ROW, { displayId: ['Missing'] }).id, '01', 'a declaration that matches nothing degrades to the old behavior');
    assert.equal(summarizeItem({ id: 7, TaskNumber: '9' }, { displayId: ['Missing'] }).id, 7, 'exact ID_KEYS still precede the suffix scan');
  });
  it('renderConnectorLines threads displayId into list rows AND the single-record head', () => {
    const lines = renderConnectorLines({ results: [{ ...ROW }, { ...ROW, TicketId: 555 }] }, { name: 'Tasks', displayId: ['TicketId'] });
    assert.ok(lines[1].startsWith('• #4867009 '), lines[1]);
    assert.ok(lines[2].startsWith('• #555 '), lines[2]);
    const single = renderConnectorLines({ results: [{ ...ROW }] }, { name: 'Task', displayId: ['TicketId'] });
    assert.ok(single[0].startsWith('#4867009'), single[0]);
  });
});

describe('CX-9k — displayId reaches the case surfaces (dossierLines + fanoutItems)', () => {
  const ROW = { TaskNumber: '01', TicketId: 4867009, AddressLine1: '607 Pine Dune Lane' };
  it('dossierLines "Id:" line shows the declared human id (live 194814: every case read "Id: 01")', () => {
    assert.equal(dossierLines(ROW, { displayId: ['TicketId'] })[0], 'Id: 4867009');
    assert.equal(dossierLines(ROW)[0], 'Id: 01', 'undeclared stays the old first-…Number pick');
  });
  it('fanoutItems threads displayId into each item detail', () => {
    const { items } = fanoutItems({ results: [ROW, { ...ROW, TicketId: 555 }] }, 20, { displayId: ['TicketId'] });
    assert.ok(items[0].detail.startsWith('Id: 4867009'), items[0].detail.split('\n')[0]);
    assert.ok(items[1].detail.startsWith('Id: 555'));
  });
});
