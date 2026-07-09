// Core/connectorRender.test.js — generic session-ride result rendering (CX-4c). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { primaryList, primaryObject, summarizeItem, renderConnectorLines, itemLabels, primaryItemId, createdRecordId } from './connectorRender.js';

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
