// Core/fieldRead.test.js — PM-9 (v2.74.1649): per-item field read, term-matched not format-parsed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readFieldSection, splitSentences, normalizeFieldReadVerdict, fieldReadTally, fieldPhraseCandidates, resolveFieldKey, termFieldKey, deepFieldPaths } from './fieldRead.js';
import { extractValue } from './peritemMap.js';   // v1903 — discovery and extraction must agree

// Shaped after the real VendorSuite `Instructions` (HAR-verified): a date header, a numbered item with a
// label ending in a colon, a lettered sub-item. Tabs are real in the source.
const OUTLINE = [
  '1 unit 2 story / 4 bed / 2500 sf / lot 12 THs blk 03 / WEDNESDAY, JULY 22nd 8AM-12PM',
  '4.\tDeako switches:',
  'a.\thomeowner reports two switches not pairing in the main hall.',
  '',
].join('\n');

const PROSE = 'Vendor to inspect drywall crack in garage. Deako rep should verify the switch firmware before the visit. Confirm access with homeowner.';

describe('fieldRead — readFieldSection: the term finds its unit, whatever the shape', () => {
  it('numbered item: returns the item AND its lettered sub-item (the detail lives there)', () => {
    const r = readFieldSection(OUTLINE, 'deako');
    assert.equal(r.found, true);
    assert.equal(r.mode, 'item');
    assert.match(r.text, /Deako switches:/);
    assert.match(r.text, /not pairing in the main hall/);
    assert.equal(r.text.includes('lot 12 THs'), false);   // the unrelated header stays out
  });

  it('mid-sentence: the same term in flowing prose returns just that sentence', () => {
    // The user was explicit: "sometimes a number item and sometimes appears in a sentence". One predicate, both.
    const r = readFieldSection(PROSE, 'deako');
    assert.equal(r.found, true);
    assert.equal(r.mode, 'sentence');
    assert.match(r.text, /verify the switch firmware/);
    assert.equal(r.text.includes('drywall crack'), false);
  });

  it('case-insensitive', () => {
    assert.equal(readFieldSection(OUTLINE, 'DEAKO').found, true);
    assert.equal(readFieldSection(PROSE, 'Deako').found, true);
  });

  it('a MISS returns the whole field and says so — never an empty targeted answer', () => {
    const r = readFieldSection(OUTLINE, 'plumbing');
    assert.equal(r.found, false);
    assert.equal(r.mode, 'whole');
    assert.equal(r.text.includes('Deako switches'), true);   // everything, so the user can still read it
  });

  it('no term at all → the whole field, found', () => {
    const r = readFieldSection(PROSE, '');
    assert.equal(r.mode, 'whole');
    assert.equal(r.found, true);
    assert.equal(r.text, PROSE);
  });

  it('empty/blank field is reported as empty, not as a whole-field answer', () => {
    for (const v of ['', '   ', null, undefined]) {
      const r = readFieldSection(v, 'deako');
      assert.equal(r.mode, 'empty');
      assert.equal(r.found, false);
    }
  });

  it('a numbered item stops at the NEXT numbered item', () => {
    const t = ['1.\tDeako:', 'a.\tfirst detail', '2.\tPaint:', 'b.\tunrelated'].join('\n');
    const r = readFieldSection(t, 'deako');
    assert.match(r.text, /first detail/);
    assert.equal(r.text.includes('Paint'), false);
    assert.equal(r.text.includes('unrelated'), false);
  });

  it('multiple hits all come back, counted', () => {
    const t = ['1.\tDeako switch A', '2.\tOther', '3.\tDeako switch B'].join('\n');
    const r = readFieldSection(t, 'deako');
    assert.equal(r.hits, 2);
    assert.match(r.text, /switch A/);
    assert.match(r.text, /switch B/);
    assert.equal(r.text.includes('Other'), false);
  });

  it('CRLF is normalized (the field arrives from a web API)', () => {
    const r = readFieldSection('1.\tDeako:\r\na.\tdetail here', 'deako');
    assert.match(r.text, /detail here/);
  });

  it('term inside ONE long line with no newlines falls through to sentence mode', () => {
    const r = readFieldSection('Do the thing. The Deako rep needs access. Then leave.', 'deako');
    assert.equal(r.mode, 'sentence');
    assert.match(r.text, /needs access/);
  });
});

describe('fieldRead — splitSentences', () => {
  it('splits on terminal punctuation followed by a capital', () => {
    assert.equal(splitSentences('One thing. Two things! Three?').length, 3);
  });
  it('empty in, empty out', () => {
    assert.deepEqual(splitSentences(''), []);
  });
});

describe('fieldRead — normalizeFieldReadVerdict (the shape that needed no target)', () => {
  it('field is the only required slot; term is optional', () => {
    assert.deepEqual(normalizeFieldReadVerdict({ field: 'Task instructions' }),
      { kind: 'fieldRead', collection: 'prior', field: 'Task instructions', term: '' });
  });
  it('carries a term and a cap', () => {
    const v = normalizeFieldReadVerdict({ field: 'Instructions', term: 'DEAKO', cap: 10 });
    assert.equal(v.term, 'DEAKO');
    assert.equal(v.cap, 10);
  });
  it('a self-contained collection rides', () => {
    const v = normalizeFieldReadVerdict({ collection: { readAsk: 'get open warranty tasks' }, field: 'Instructions' });
    assert.deepEqual(v.collection, { readAsk: 'get open warranty tasks' });
  });
  it('NO field → not this shape (null, so the caller can try another)', () => {
    for (const v of [null, {}, { field: '  ' }, { term: 'DEAKO' }]) assert.equal(normalizeFieldReadVerdict(v), null);
  });
});

describe('fieldRead — fieldReadTally', () => {
  it('names the whole-field fallbacks separately from the real hits', () => {
    const s = fieldReadTally({ rows: 22, found: 18, whole: 3, missing: 1, field: 'Instructions', term: 'DEAKO' });
    assert.match(s, /22 rows/);
    assert.match(s, /18 with a .DEAKO. part/);
    assert.match(s, /3 showing the whole Instructions \(no match\)/);
    assert.match(s, /1 with no Instructions/);
  });
});

describe('fieldRead — fieldPhraseCandidates (v2.74.1652: spoken phrase → real key)', () => {
  it('full phrase FIRST, then leading words dropped — the live "tasks instructions" → Instructions case', () => {
    const c = fieldPhraseCandidates('tasks instructions');
    assert.equal(c[0], 'tasks instructions');       // most specific wins when it resolves
    assert.equal(c.includes('instructions'), true); // the fallback that would have saved the live run
    assert.ok(c.indexOf('tasks instructions') < c.indexOf('instructions'));
  });
  it('handles the article-y phrasings people actually type', () => {
    assert.equal(fieldPhraseCandidates('the task instructions').includes('instructions'), true);
    assert.equal(fieldPhraseCandidates('vendor explanation')[0], 'vendor explanation');
  });
  it('drops tokens under 4 chars — a wrong field read beats no field read only in the demo', () => {
    const c = fieldPhraseCandidates('id of the note');
    assert.equal(c.includes('id'), false);
    assert.equal(c.includes('the'), false);
    assert.equal(c.includes('note'), true);
  });
  it('empty in, empty out', () => { assert.deepEqual(fieldPhraseCandidates('  '), []); });
});

// v2.74.1690 — resolveFieldKey. The live disagreement: fieldRead read "VendorExplanation" successfully on 16 of
// 22 rows while the BRANCH declared the same field absent on all 22, because it matched the phrase verbatim.
describe('fieldRead — resolveFieldKey: one answer to "what is this field called"', () => {
  const REC = ['TaskId', 'VendorExplanation', 'Instructions', 'Status'];

  it('THE LIVE BUG: a spaced phrase resolves to the record’s concatenated key', () => {
    assert.equal(resolveFieldKey(REC, 'Vendor Explanation').key, 'VendorExplanation');
    assert.equal(resolveFieldKey(REC, 'vendor explanation').key, 'VendorExplanation');
  });

  it('matches across the separator conventions a record might use', () => {
    for (const keys of [['vendor_explanation'], ['Vendor-Explanation'], ['vendor explanation'], ['VENDOREXPLANATION']]) {
      assert.equal(resolveFieldKey(keys, 'Vendor Explanation').key, keys[0], keys[0]);
    }
  });

  it('takes a verbatim key without going near the ladder', () => {
    assert.equal(resolveFieldKey(['Vendor Explanation', 'VendorExplanationNote'], 'Vendor Explanation').key, 'Vendor Explanation');
  });

  it('AMBIGUITY IS A VERDICT — never a silent pick', () => {
    // "ask, never guess" (§1626). A confidently-wrong field read is the failure this area keeps producing.
    const r = resolveFieldKey(['VendorExplanation', 'VendorName'], 'vendor');
    assert.equal(r.key, '');
    assert.equal(r.ambiguous, true);
    assert.deepEqual(r.candidates.sort(), ['VendorExplanation', 'VendorName']);
  });

  it('a genuine miss is a miss, not a loose match', () => {
    const r = resolveFieldKey(REC, 'shipping address');
    assert.equal(r.key, '');
    assert.equal(r.ambiguous, false);
  });

  it('drops sub-4-char tokens rather than matching half the record', () => {
    assert.equal(resolveFieldKey(['TaskId', 'Instructions'], 'the id of it').key, '');
  });

  it('accepts a record object as well as a key list', () => {
    assert.equal(resolveFieldKey({ VendorExplanation: '', Status: 'open' }, 'Vendor Explanation').key, 'VendorExplanation',
      'an EMPTY value must still resolve — "which have none" is a question about the empty ones');
  });

  it('degenerate input does not throw', () => {
    for (const k of [null, undefined, [], {}, 'nope', 7]) assert.doesNotThrow(() => resolveFieldKey(k, 'x'));
    for (const p of [null, undefined, '', 7, {}]) assert.doesNotThrow(() => resolveFieldKey(REC, p));
    assert.equal(resolveFieldKey(REC, '').key, '');
  });
});

describe('fieldRead — v1882: termFieldKey, for when the DOOR invented the {field, term} pair', () => {
  // Live 210342: interpret is shipped no record-field vocabulary, so its only source of field names is the
  // transcript. At 21:01 the only names it had seen were Instructions and VendorExplanation — IsPaid had not
  // rendered yet — so "is it paid yet?" became {field:'VendorExplanation', term:'paid'} and the reply hunted the
  // word "paid" through a paragraph while IsPaid:true sat unread.
  const REC = { SearchField: 'x', TaskId: 1, IsPaid: true, Priority: 'Normal', TaskStatus: 'Open', Instructions: 'Deako to call h/owner', VendorExplanation: 'reached out 42966' };
  it('THE LIVE CASE: term "paid" IS a field, and not a part of VendorExplanation', () => {
    assert.equal(termFieldKey(REC, 'paid', 'VendorExplanation'), 'IsPaid');
  });
  it('declines when the term names no field — a synonym gap is not a field ("emergency" ≠ Priority)', () => {
    assert.equal(termFieldKey(REC, 'emergency', 'Instructions'), '');
  });
  it('LEAVES THE LEGITIMATE CASE ALONE: a real section of a note is not a field', () => {
    assert.equal(termFieldKey(REC, 'deako', 'Instructions'), '');
  });
  it('never re-enters on the field it already chose', () => {
    assert.equal(termFieldKey(REC, 'instructions', 'Instructions'), '');
    assert.equal(termFieldKey(REC, 'Instructions', 'Instructions'), '');
  });
  it('declines on an AMBIGUOUS term rather than picking — the caller keeps its own tie handling', () => {
    assert.equal(termFieldKey({ TaskNumber: '01', ClaimNumber: '01' }, 'number', 'Instructions'), '');
  });
  it('degenerate input is safe', () => {
    assert.equal(termFieldKey(REC, '', 'Instructions'), '');
    assert.equal(termFieldKey(REC, null, 'Instructions'), '');
    assert.equal(termFieldKey(null, 'paid', 'X'), '');
  });
});

// v2.74.1903 — DEPTH. The live Shopify order shape (gl 2026-07-31 08:06): tracking, price and delivery all present,
// all invisible to the one-hop/top-level scans. Structure verbatim from _GQL_ORDERS/_GQL_PRODUCTS; values fabricated.
const SH_ORDER = {
  id: 'gid://shopify/Order/5551', name: 'DEAKO#69872', createdAt: '2026-07-20T10:00:00Z',
  displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
  totalPriceSet: { shopMoney: { amount: '50.34', currencyCode: 'USD' } },
  customer: { email: 'momkat820@gmail.com' },
  lineItems: { edges: [{ node: { title: 'Universal Connector', quantity: 1 } }] },
  fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED', estimatedDeliveryAt: '2026-07-24T00:00:00Z', deliveredAt: '2026-07-23T18:00:00Z', trackingInfo: [{ number: '1Z27691W0320913590', company: 'UPS', url: 'https://ups.example/track' }] }],
  refunds: [{ createdAt: '2026-07-25T00:00:00Z', totalRefundedSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } } }],
};
const SH_PRODUCT = { id: 'gid://shopify/Product/9', title: 'Smart Scene Controller Switch', status: 'ACTIVE', totalInventory: 1378,
  variants: { edges: [{ node: { id: 'gid://v/1', title: 'White', sku: 'DK-SW-01', price: '49.00', inventoryQuantity: 620 } }] } };

describe('deepFieldPaths — discovery learns depth (v1903)', () => {
  it('enumerates the nested leaves with GQL plumbing dropped from matchText and kept in path', () => {
    const ps = deepFieldPaths(SH_ORDER);
    const track = ps.find((p) => p.path === 'fulfillments.trackingInfo.number');
    assert.ok(track, 'tracking number path found');
    assert.equal(track.matchText, 'fulfillments trackingInfo number');
    const price = deepFieldPaths(SH_PRODUCT).find((p) => p.path === 'variants.edges.node.price');
    assert.ok(price, 'variant price path found');
    assert.equal(price.matchText, 'variants price');
  });
  it('a flat record yields exactly its keys', () => {
    assert.deepEqual(deepFieldPaths({ TicketId: 1, Age: '003' }).map((p) => p.path).sort(), ['Age', 'TicketId']);
  });
});

describe('resolveFieldKey — record mode resolves DEEP (v1903)', () => {
  it('THE LIVE FOUR: tracking · price · delivered · refund', () => {
    assert.equal(resolveFieldKey(SH_ORDER, 'tracking number').key, 'fulfillments.trackingInfo.number');
    assert.equal(resolveFieldKey(SH_PRODUCT, 'price').key, 'variants.edges.node.price');
    assert.equal(resolveFieldKey(SH_ORDER, 'delivered').key, 'fulfillments.deliveredAt');
    assert.match(resolveFieldKey(SH_ORDER, 'refund amount').key, /refunds\.totalRefundedSet\.shopMoney\.amount/);
  });
  it('extractValue reads every resolved path — discovery and extraction agree', () => {
    assert.equal(extractValue(SH_ORDER, resolveFieldKey(SH_ORDER, 'tracking number').key), '1Z27691W0320913590');
    assert.equal(extractValue(SH_PRODUCT, resolveFieldKey(SH_PRODUCT, 'price').key), '49.00');
  });
  it('a SHALLOW key beats its own nested echo — depth tie-break, not ambiguity', () => {
    const r = resolveFieldKey(SH_ORDER, 'created');
    assert.equal(r.key, 'createdAt');   // NOT refunds.createdAt
    assert.equal(r.ambiguous, false);
  });
  it('same-depth distinct meanings STAY ambiguous — carrier vs number is a real question', () => {
    const r = resolveFieldKey(SH_ORDER, 'tracking');
    assert.equal(r.ambiguous, true);
    assert.ok(r.candidates.length >= 2);
  });
  it('ARRAY callers keep the shallow contract byte-for-byte', () => {
    const r = resolveFieldKey(Object.keys(SH_ORDER), 'tracking number');
    assert.equal(r.key, '', 'keys-array input must not resolve deep');
  });
  it('flat records resolve exactly as before (the VendorSuite regression guard)', () => {
    assert.equal(resolveFieldKey({ VendorExplanation: 'x', TicketId: 1 }, 'vendor explanation').key, 'VendorExplanation');
  });
});
