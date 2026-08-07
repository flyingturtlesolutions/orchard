// Core/lookupResolve.test.js — v2.74.2064 RC-0. The pure LOOKUP ranker's six verdicts, the resolved-envelope
// primitives, lookupDestParams, and the invariant-#3 hop seal for the `lookup` marker. All headless/pure.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  rankLookupCandidates, mintResolvedEnvelope, isResolvedEnvelope, lookupDestParams,
} from './lookupResolve.js';
import { recipeFromCatalogEntry } from './rideRecipe.js';
import { recipeToLeg } from './connectorLeg.js';
import { harvestedRecipeLegs } from './connectorRecipes.js';

// ── Fixtures modelled on the Shopify GraphQL shapes the resolver will see (rows already getPath-extracted) ──
const CUSTOMERS = [
  { id: 'gid://shopify/Customer/1', email: 'jane@acme.com', firstName: 'Jane', lastName: 'Doe' },
  { id: 'gid://shopify/Customer/2', email: 'bob@acme.com', firstName: 'Bob', lastName: 'Roe' },
];
const CUST_SPEC = { from: 'email', match: ['email'], id: 'id', label: ['firstName', 'lastName', 'email'], exact: true };

const PRODUCTS = [
  { id: 'gid://shopify/Product/10', title: 'Smart Switch Gen 2', status: 'ACTIVE',
    variants: { edges: [{ node: { id: 'gid://shopify/ProductVariant/100', sku: 'DK-SW-02', title: 'Default', price: '49.00', inventoryQuantity: 12 } }] } },
  { id: 'gid://shopify/Product/11', title: 'Smart Dimmer', status: 'ACTIVE',
    variants: { edges: [
      { node: { id: 'gid://shopify/ProductVariant/110', sku: 'DK-DM-01-WHT', title: 'White', price: '59.00', inventoryQuantity: 3 } },
      { node: { id: 'gid://shopify/ProductVariant/111', sku: 'DK-DM-01-BLK', title: 'Black', price: '59.00', inventoryQuantity: 0 } },
    ] } },
  { id: 'gid://shopify/Product/12', title: 'Old Switch', status: 'DRAFT',
    variants: { edges: [{ node: { id: 'gid://shopify/ProductVariant/120', sku: 'OLD-1', title: 'Default', price: '10.00', inventoryQuantity: 5 } }] } },
];
const PROD_SPEC = {
  from: 'product', match: ['sku', 'title'], pick: 'variants.edges[].node', id: 'id', label: ['sku', 'price'], exact: true,
  require: [{ field: 'status', equals: 'ACTIVE', fail: 'inactive' }, { field: 'inventoryQuantity', op: '>', value: 0, fail: 'outOfStock' }],
};

describe('rankLookupCandidates — the six row-based verdicts (customer scalar)', () => {
  it('exact email → resolved, the Customer gid', () => {
    const r = rankLookupCandidates(CUSTOMERS, CUST_SPEC, 'jane@acme.com');
    assert.equal(r.verdict, 'resolved');
    assert.equal(r.id, 'gid://shopify/Customer/1');
    assert.match(r.label, /Jane/);
  });
  it('email case/space-insensitive still resolves', () => {
    assert.equal(rankLookupCandidates(CUSTOMERS, CUST_SPEC, '  JANE@ACME.COM ').verdict, 'resolved');
  });
  it('unknown email but rows returned → no-exact (never auto), with near empty', () => {
    const r = rankLookupCandidates(CUSTOMERS, CUST_SPEC, 'nobody@nowhere.com');
    assert.equal(r.verdict, 'no-exact');
    assert.deepEqual(r.candidates, []);
  });
  it('zero rows from the search → none', () => {
    assert.equal(rankLookupCandidates([], CUST_SPEC, 'jane@acme.com').verdict, 'none');
  });
  it('blank phrase → blank (nothing to resolve — never picks the first row)', () => {
    assert.equal(rankLookupCandidates(CUSTOMERS, CUST_SPEC, '').verdict, 'blank');
    assert.equal(rankLookupCandidates(CUSTOMERS, CUST_SPEC, '   ').verdict, 'blank');
    assert.equal(rankLookupCandidates(CUSTOMERS, CUST_SPEC, null).verdict, 'blank');
  });
});

describe('rankLookupCandidates — product → variant (the new invoke-and-rank kind, nested pick + require gate)', () => {
  it('exact SKU → resolved (the auto path), the nested ProductVariant gid', () => {
    const r = rankLookupCandidates(PRODUCTS, PROD_SPEC, 'DK-SW-02');
    assert.equal(r.verdict, 'resolved');
    assert.equal(r.id, 'gid://shopify/ProductVariant/100');
  });
  it('exact single-variant product NAME → resolved (product title matched on the parent, not the variant title)', () => {
    const r = rankLookupCandidates(PRODUCTS, PROD_SPEC, 'Smart Switch Gen 2');
    assert.equal(r.verdict, 'resolved');
    assert.equal(r.id, 'gid://shopify/ProductVariant/100');
  });
  it('two-variant product NAME → ambiguous (both variants surfaced, mustNotWrite until picked)', () => {
    const r = rankLookupCandidates(PRODUCTS, PROD_SPEC, 'Smart Dimmer');
    assert.equal(r.verdict, 'ambiguous');
    assert.equal(r.candidates.length, 2);
    assert.deepEqual(r.candidates.map((c) => c.id).sort(),
      ['gid://shopify/ProductVariant/110', 'gid://shopify/ProductVariant/111']);
  });
  it('out-of-stock variant → require-failed, naming the outOfStock clause', () => {
    const r = rankLookupCandidates(PRODUCTS, PROD_SPEC, 'DK-DM-01-BLK');
    assert.equal(r.verdict, 'require-failed');
    assert.equal(r.clause.fail, 'outOfStock');
    assert.equal(r.clause.field, 'inventoryQuantity');
  });
  it('DRAFT product → require-failed, naming the inactive clause (status lives on the PARENT product)', () => {
    const r = rankLookupCandidates(PRODUCTS, PROD_SPEC, 'Old Switch');
    assert.equal(r.verdict, 'require-failed');
    assert.equal(r.clause.fail, 'inactive');
  });
  it('near-but-not-exact name → no-exact, surfacing the near candidate (the confidently-wrong guard, §3)', () => {
    const r = rankLookupCandidates(PRODUCTS, PROD_SPEC, 'Smart Switch');
    assert.equal(r.verdict, 'no-exact');
    assert.equal(r.candidates[0].id, 'gid://shopify/ProductVariant/100');
  });
});

describe('rankLookupCandidates — the require AND-list ops + edges', () => {
  const rows = [{ id: 'x', name: 'Widget', qty: 5, tier: 'gold', kind: 'A' }];
  it('op > passes / fails at the boundary', () => {
    assert.equal(rankLookupCandidates(rows, { id: 'id', match: ['name'], require: [{ field: 'qty', op: '>', value: 4 }] }, 'Widget').verdict, 'resolved');
    assert.equal(rankLookupCandidates(rows, { id: 'id', match: ['name'], require: [{ field: 'qty', op: '>', value: 5 }] }, 'Widget').verdict, 'require-failed');
  });
  it('op in / != / exists', () => {
    assert.equal(rankLookupCandidates(rows, { id: 'id', match: ['name'], require: [{ field: 'tier', op: 'in', values: ['gold', 'silver'] }] }, 'Widget').verdict, 'resolved');
    assert.equal(rankLookupCandidates(rows, { id: 'id', match: ['name'], require: [{ field: 'kind', op: '!=', value: 'B' }] }, 'Widget').verdict, 'resolved');
    assert.equal(rankLookupCandidates(rows, { id: 'id', match: ['name'], require: [{ field: 'missing', exists: true }] }, 'Widget').verdict, 'require-failed');
  });
  it('a relaxable clause is still REPORTED failed (the caller decides, not the ranker)', () => {
    const r = rankLookupCandidates(rows, { id: 'id', match: ['name'], require: [{ field: 'qty', op: '>', value: 99, fail: 'lowStock', relaxable: true }] }, 'Widget');
    assert.equal(r.verdict, 'require-failed');
    assert.equal(r.clause.relaxable, true);
  });
  it('no require declared → resolved (a site that needs no gate omits it)', () => {
    assert.equal(rankLookupCandidates(rows, { id: 'id', match: ['name'] }, 'Widget').verdict, 'resolved');
  });
  it('AND semantics: any one clause failing fails the candidate', () => {
    const r = rankLookupCandidates(rows, { id: 'id', match: ['name'], require: [{ field: 'tier', equals: 'gold' }, { field: 'qty', op: '>', value: 99 }] }, 'Widget');
    assert.equal(r.verdict, 'require-failed');
  });
});

describe('resolved-envelope primitives (§6 — provenance, not value shape)', () => {
  it('mint → is a well-formed envelope; a bare gid / plain object is NOT', () => {
    const env = mintResolvedEnvelope('customer_gid', 'gid://shopify/Customer/1', 'belief_7');
    assert.equal(isResolvedEnvelope(env), true);
    assert.equal(env.value, 'gid://shopify/Customer/1');
    assert.equal(env.from, 'belief_7');
    assert.equal(isResolvedEnvelope('gid://shopify/Customer/1'), false);
    assert.equal(isResolvedEnvelope({ customer_gid: 'gid://shopify/Customer/1' }), false);
    assert.equal(isResolvedEnvelope({ __resolved: true }), false, 'needs param + value, not just the flag');
    assert.equal(isResolvedEnvelope(null), false);
  });
  it('mint tolerates a missing `from`', () => {
    const env = mintResolvedEnvelope('variantId', 'gid://x/1');
    assert.equal(isResolvedEnvelope(env), true);
    assert.equal('from' in env, false);
  });
});

describe('lookupDestParams — the future missingRequiredParams exemption source', () => {
  it('reads keys from a record, a leg.tool, or returns [] when absent', () => {
    assert.deepEqual(lookupDestParams({ lookup: { customer_gid: {}, line_items: {} } }).sort(), ['customer_gid', 'line_items']);
    assert.deepEqual(lookupDestParams({ tool: { lookup: { customer_gid: {} } } }), ['customer_gid']);
    assert.deepEqual(lookupDestParams({}), []);
    assert.deepEqual(lookupDestParams(null), []);
    assert.deepEqual(lookupDestParams({ lookup: [] }), [], 'an array is not a dest map');
  });
});

describe('invariant #3 — the `lookup` marker survives all three hops (seeded ≡ direct)', () => {
  const MARKER = {
    customer_gid: { from: 'email', viaLeg: 'shopify_customer_by_email', valueParam: 'email',
      rows: 'customers.edges[].node', match: ['email'], id: 'id', label: ['firstName', 'lastName', 'email'], exact: true },
  };
  const ENTRY = {
    id: 'synthetic_lookup_leg', app: 'test', appHost: 'example.com', origin: 'https://example.com',
    name: 'synthetic lookup leg', does: 'a synthetic leg carrying a lookup marker, for the hop seal',
    write: true, reversible: true, method: 'POST', endpoint: '/api/x', persistedOp: 'X',
    params: [{ name: 'customer_gid', type: 'string', required: true }], lookup: MARKER,
  };

  it('hop 1 — recipeFromCatalogEntry copies `lookup` onto the seeded record', () => {
    const rec = recipeFromCatalogEntry(ENTRY, { groundId: 'g1', origin: 'https://example.com' });
    assert.deepEqual(rec.lookup, MARKER);
  });
  it('hop 3 — recipeToLeg reads `lookup` onto leg.tool.lookup', () => {
    // recipeToLeg reads a projectable RECORD directly (it needs id/app/endpoint/origin) — the enum/date hop-seal
    // precedent; hop 1's copy is asserted separately above, and the full pipeline below.
    const rec = { ...ENTRY, host: 'https://example.com', groundId: 'g1' };
    const leg = recipeToLeg(rec, { trusted: true });
    assert.ok(leg, 'the record projects');
    assert.deepEqual(leg.tool.lookup, MARKER);
  });
  it('hops 1→2→3 end-to-end (harvestedRecipeLegs, the SEEDED pipeline) carries it intact', () => {
    const rec = recipeFromCatalogEntry(ENTRY, { groundId: 'g1', origin: 'https://example.com' });
    const legs = harvestedRecipeLegs([rec], { host: 'example.com', account: 'me', groundId: 'g1' });
    const leg = legs.find((l) => l && l.tool && l.tool.lookup);
    assert.ok(leg, 'the seeded leg projects and carries lookup (the invariant-#3 drop site)');
    assert.deepEqual(leg.tool.lookup, MARKER);
  });
  it('a leg with NO lookup marker projects tool.lookup === null (byte-safe default, keeps the hop seal green)', () => {
    const leg = recipeToLeg({ ...ENTRY, id: 'no_lookup', lookup: undefined }, { trusted: true });
    assert.ok(leg, 'the record projects');
    assert.equal(leg.tool.lookup, null);
  });
});
