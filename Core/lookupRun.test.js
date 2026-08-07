// Core/lookupRun.test.js — v2.74.2067 RC-1. The lookup run-engine: phrase extraction, ordered attempts,
// verdict-from-response, and the injected-invoke orchestrator (try-in-order, first-resolved-wins, unreachable).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lookupPhrase, lookupAttempts, verdictFromResponse, resolveOneLookup, resolveLookupParams } from './lookupRun.js';

const CUST_SPEC = {
  from: 'customer', viaLeg: 'shopify_customer_by_email', valueParam: 'email',
  rows: 'customers.edges[].node', match: ['email'], id: 'id', label: ['firstName', 'lastName', 'email'], exact: true,
};
const PROD_SPEC = {
  from: 'product', viaLeg: ['shopify_product_by_sku', 'shopify_search_products'], valueParam: ['sku', 'query'],
  rows: 'products.edges[].node', pick: 'variants.edges[].node', id: 'id', match: ['sku', 'title'], label: ['sku', 'price'],
  require: [{ field: 'status', equals: 'ACTIVE', fail: 'inactive' }, { field: 'inventoryQuantity', op: '>', value: 0, fail: 'outOfStock' }],
};

const custResponse = (email) => ({ customers: { edges: [{ node: { id: 'gid://shopify/Customer/1', email, firstName: 'Jane', lastName: 'Doe' } }] } });
const emptyCustResponse = { customers: { edges: [] } };
const prodResponse = (title, variants) => ({ products: { edges: [{ node: { id: 'gid://shopify/Product/10', title, status: 'ACTIVE', variants: { edges: variants } } }] } });

describe('lookupPhrase — which bound param carries the phrase', () => {
  it('reads spec.from', () => {
    assert.equal(lookupPhrase(CUST_SPEC, { customer: 'jane@acme.com' }, 'customer_gid'), 'jane@acme.com');
  });
  it('falls back to the destination param when `from` is absent (in-place case)', () => {
    assert.equal(lookupPhrase({ rows: 'x' }, { customer_gid: 'jane@acme.com' }, 'customer_gid'), 'jane@acme.com');
  });
  it('empty when the source param is unbound', () => {
    assert.equal(lookupPhrase(CUST_SPEC, {}, 'customer_gid'), '');
    assert.equal(lookupPhrase(CUST_SPEC, { customer: null }, 'customer_gid'), '');
  });
});

describe('lookupAttempts — ordered (viaLeg, valueParam), arrays paired', () => {
  it('scalar viaLeg/valueParam', () => {
    assert.deepEqual(lookupAttempts(CUST_SPEC), [{ viaLeg: 'shopify_customer_by_email', valueParam: 'email' }]);
  });
  it('array viaLeg/valueParam pair by index (exact-key first)', () => {
    assert.deepEqual(lookupAttempts(PROD_SPEC), [
      { viaLeg: 'shopify_product_by_sku', valueParam: 'sku' },
      { viaLeg: 'shopify_search_products', valueParam: 'query' },
    ]);
  });
  it('no viaLeg → no attempts', () => {
    assert.deepEqual(lookupAttempts({ rows: 'x' }), []);
  });
});

describe('verdictFromResponse — getPath the rows then rank (pure)', () => {
  it('resolves an exact customer email', () => {
    const v = verdictFromResponse(CUST_SPEC, 'jane@acme.com', custResponse('jane@acme.com'));
    assert.equal(v.verdict, 'resolved');
    assert.equal(v.id, 'gid://shopify/Customer/1');
  });
  it('zero rows → none', () => {
    assert.equal(verdictFromResponse(CUST_SPEC, 'nobody@x.com', emptyCustResponse).verdict, 'none');
  });
});

describe('resolveOneLookup — the injected-invoke orchestrator', () => {
  it('customer: one exact-email invoke → resolved', async () => {
    const calls = [];
    const invokeSearch = async (leg, params) => { calls.push([leg, params]); return custResponse('jane@acme.com'); };
    const v = await resolveOneLookup(CUST_SPEC, 'jane@acme.com', { invokeSearch });
    assert.equal(v.verdict, 'resolved');
    assert.equal(v.id, 'gid://shopify/Customer/1');
    assert.equal(v.viaLeg, 'shopify_customer_by_email');
    assert.deepEqual(calls, [['shopify_customer_by_email', { email: 'jane@acme.com' }]]);
  });

  it('blank phrase → blank, no invoke spent', async () => {
    let called = false;
    const v = await resolveOneLookup(CUST_SPEC, '', { invokeSearch: async () => { called = true; return {}; } });
    assert.equal(v.verdict, 'blank');
    assert.equal(called, false);
  });

  it('product: exact SKU on the FIRST leg resolves and STOPS (never calls the search leg)', async () => {
    const calls = [];
    const invokeSearch = async (leg, params) => {
      calls.push(leg);
      if (leg === 'shopify_product_by_sku') return prodResponse('Smart Switch Gen 2', [{ node: { id: 'gid://shopify/ProductVariant/100', sku: 'DK-SW-02', inventoryQuantity: 12 } }]);
      return prodResponse('x', []);
    };
    const v = await resolveOneLookup(PROD_SPEC, 'DK-SW-02', { invokeSearch });
    assert.equal(v.verdict, 'resolved');
    assert.equal(v.id, 'gid://shopify/ProductVariant/100');
    assert.deepEqual(calls, ['shopify_product_by_sku'], 'exact SKU hit → does not fall through to the relevance search');
  });

  it('product: SKU leg finds nothing → falls through to the search leg → ambiguous', async () => {
    const calls = [];
    const invokeSearch = async (leg) => {
      calls.push(leg);
      if (leg === 'shopify_product_by_sku') return { products: { edges: [] } };
      return prodResponse('Smart Dimmer', [
        { node: { id: 'gid://shopify/ProductVariant/110', sku: 'WHT', title: 'White', inventoryQuantity: 3 } },
        { node: { id: 'gid://shopify/ProductVariant/111', sku: 'BLK', title: 'Black', inventoryQuantity: 5 } },
      ]);
    };
    const v = await resolveOneLookup(PROD_SPEC, 'Smart Dimmer', { invokeSearch });
    assert.equal(v.verdict, 'ambiguous');
    assert.equal(v.candidates.length, 2);
    assert.deepEqual(calls, ['shopify_product_by_sku', 'shopify_search_products'], 'tried in order');
  });

  it('every leg errors → unreachable (not none — a failed search is not an empty result)', async () => {
    const v = await resolveOneLookup(PROD_SPEC, 'anything', { invokeSearch: async () => { throw new Error('boom'); } });
    assert.equal(v.verdict, 'unreachable');
    assert.equal(v.unreachable, true);
  });

  it('a leg returns rows but no match → none (reachable, just empty of matches)', async () => {
    const v = await resolveOneLookup(CUST_SPEC, 'ghost@x.com', { invokeSearch: async () => emptyCustResponse });
    assert.equal(v.verdict, 'none');
  });

  it('no invokeSearch injected → unreachable, never throws', async () => {
    const v = await resolveOneLookup(CUST_SPEC, 'jane@acme.com', {});
    assert.equal(v.verdict, 'unreachable');
  });
});

describe('resolveLookupParams — the whole draft-order lookup map (customer scalar + line_items each)', () => {
  // The real draft-order shape: IN-PLACE resolution — the email rides in `customer_gid`, a product name/sku rides
  // in each line_items[].variantId (no `from` on the scalar → the destination itself carries the phrase).
  const LOOKUP = {
    customer_gid: { viaLeg: 'shopify_customer_by_email', valueParam: 'email', rows: 'customers.edges[].node', match: ['email'], id: 'id', label: ['firstName', 'lastName', 'email'], exact: true },
    line_items: { each: true, elementKey: 'variantId', from: 'product', ...PROD_SPEC },
  };
  // invokeSearch routes by leg id + the query value; email→customer, sku/name→product variants.
  const invokeSearch = async (leg, params) => {
    if (leg === 'shopify_customer_by_email') return custResponse(params.email);
    if (leg === 'shopify_product_by_sku') {
      if (params.sku === 'DK-SW-02') return prodResponse('Smart Switch Gen 2', [{ node: { id: 'gid://shopify/ProductVariant/100', sku: 'DK-SW-02', inventoryQuantity: 12 } }]);
      return { products: { edges: [] } };
    }
    if (leg === 'shopify_search_products') {
      if (String(params.query).toLowerCase().includes('switch')) return prodResponse('Smart Switch Gen 2', [{ node: { id: 'gid://shopify/ProductVariant/100', sku: 'DK-SW-02', title: 'Default', inventoryQuantity: 12 } }]);
      return { products: { edges: [] } };
    }
    return null;
  };

  it('resolves customer email → gid AND a product name → the variant gid, quantity preserved', async () => {
    const params = { customer_gid: 'jane@acme.com', line_items: [{ variantId: 'Smart Switch Gen 2', quantity: 2 }] };
    const r = await resolveLookupParams(LOOKUP, params, { invokeSearch });
    assert.equal(r.needs, null);
    assert.equal(r.params.customer_gid, 'gid://shopify/Customer/1');
    assert.deepEqual(r.params.line_items, [{ variantId: 'gid://shopify/ProductVariant/100', quantity: 2 }]);
  });

  it('exact SKU line item resolves too', async () => {
    const params = { customer_gid: 'jane@acme.com', line_items: [{ variantId: 'DK-SW-02', quantity: 1 }] };
    const r = await resolveLookupParams(LOOKUP, params, { invokeSearch });
    assert.equal(r.params.line_items[0].variantId, 'gid://shopify/ProductVariant/100');
  });

  it('a value ALREADY a gid is passed through untouched (user gave the gid — no invoke)', async () => {
    let called = 0;
    const spy = async (...a) => { called++; return invokeSearch(...a); };
    const params = { customer_gid: 'gid://shopify/Customer/9', line_items: [{ variantId: 'gid://shopify/ProductVariant/9', quantity: 1 }] };
    const r = await resolveLookupParams(LOOKUP, params, { invokeSearch: spy });
    assert.equal(r.needs, null);
    assert.equal(r.params.customer_gid, 'gid://shopify/Customer/9');
    assert.equal(called, 0, 'nothing to resolve → no search spent');
  });

  it('an unresolvable product STOPS the whole write with needs (never partial-dispatch)', async () => {
    const params = { customer_gid: 'jane@acme.com', line_items: [{ variantId: 'nonexistent widget', quantity: 1 }] };
    const r = await resolveLookupParams(LOOKUP, params, { invokeSearch });
    assert.ok(r.needs, 'returns needs, not a half-filled write');
    assert.equal(r.needs.param, 'line_items');
    assert.equal(r.needs.index, 0);
    // customer resolved before the failure, but the write is blocked by needs
  });

  it('an unknown customer email → needs (none), before any line-item work', async () => {
    const params = { customer_gid: 'ghost@nowhere.com', line_items: [{ variantId: 'DK-SW-02', quantity: 1 }] };
    const r = await resolveLookupParams(LOOKUP, params, { invokeSearch: async (leg, p) => leg === 'shopify_customer_by_email' ? emptyCustResponse : invokeSearch(leg, p) });
    assert.ok(r.needs);
    assert.equal(r.needs.param, 'customer_gid');
    assert.equal(r.needs.reason, 'none');
  });

  it('empty lookup map → passthrough, no needs', async () => {
    const r = await resolveLookupParams(null, { a: 1 }, { invokeSearch });
    assert.deepEqual(r.params, { a: 1 });
    assert.equal(r.needs, null);
  });
});
