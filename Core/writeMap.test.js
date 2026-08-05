// Core/writeMap.test.js — PM-6 (v2.74.1639): map misses → a reviewable write batch.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  writeMapPreflight, resolveWriteValue, buildWriteProposals, requireStalenessGuard, writeBatchSummary, WRITE_BATCH_CAP,
  parseCityStateZip, normalizeShopifyPhone, prepareShopifyCustomerCreateParams,
} from './writeMap.js';

const createLeg = {
  safety: 'confirm',
  tool: {
    id: 'shopify_create_customer', name: 'Create a Shopify customer', write: true,
    params: [
      { name: 'first_name', required: true }, { name: 'last_name', required: true },
      { name: 'email' }, { name: 'phone' }, { name: 'address1' }, { name: 'city' }, { name: 'country' },
    ],
  },
};
// v2.74.2021 — the LIVE shape: recipeToLeg puts names on leg.params + required on paramSchema, NOT tool.params.
const projectedCreateLeg = {
  safety: 'confirm',
  params: ['first_name', 'last_name', 'email', 'phone', 'address1', 'city', 'country'],
  paramSchema: { type: 'object', properties: {}, required: ['first_name', 'last_name'] },
  tool: { id: 'shopify_create_customer', recipeId: 'shopify_create_customer', name: 'Create a Shopify customer', write: true },
};
const searchLeg = { safety: 'auto', tool: { id: 'shopify_customer_search', params: [{ name: 'query' }] } };

const row = {
  AddressLine1: '1008 Harb Drive', City: 'ARCHDALE',
  __contacts: [
    { IsPrimary: true, FirstName: 'Dana', LastName: 'Reyes', Email: 'dana@example.com', Phone: '555-0100' },
    { IsPrimary: false, FirstName: 'Sam', LastName: 'Ortiz', Email: 'sam@example.com' },
  ],
};
const declared = {
  first_name: { contact: 'primary', type: 'FirstName' },
  last_name: { contact: 'primary', type: 'LastName' },
  email: { contact: 'primary', type: 'email' },
  address1: 'AddressLine1',
  country: { literal: 'US' },
};

describe('writeMap — preflight (what may batch at all)', () => {
  it('a trusted non-destructive write passes', () => {
    assert.equal(writeMapPreflight(createLeg).ok, true);
  });
  it('a READ is refused — a batch of reads is not a write batch', () => {
    const r = writeMapPreflight(searchLeg);
    assert.equal(r.ok, false); assert.match(r.reason, /read, not a write/);
  });
  it('destructive/gated never batches, whatever the caller wants', () => {
    for (const leg of [{ ...createLeg, safety: 'destructive' }, { ...createLeg, safety: 'gated' },
      { ...createLeg, tool: { ...createLeg.tool, destructive: true } }]) {
      const r = writeMapPreflight(leg);
      assert.equal(r.ok, false); assert.match(r.reason, /one at a time/);
    }
  });
  it('money and inventory stay a human click even when classed confirm', () => {
    for (const id of ['shopify_refund_order', 'shopify_capture_payment', 'x_adjust_stock', 'y_fulfill_order']) {
      const r = writeMapPreflight({ safety: 'confirm', tool: { id, write: true, params: [] } });
      assert.equal(r.ok, false, id); assert.match(r.reason, /human click/);
    }
  });
  it('no leg at all is refused, not crashed', () => {
    assert.equal(writeMapPreflight(null).ok, false);
  });
});

describe('writeMap — resolveWriteValue (declaration first, never invention)', () => {
  it('a declared contact rung reads the PRIMARY contact', () => {
    assert.equal(resolveWriteValue(row, 'first_name', declared), 'Dana');
    assert.equal(resolveWriteValue(row, 'email', declared), 'dana@example.com');
  });
  it('a declared literal rides as a constant', () => {
    assert.equal(resolveWriteValue(row, 'country', declared), 'US');
  });
  it('a declared path reads that field', () => {
    assert.equal(resolveWriteValue(row, 'address1', declared), '1008 Harb Drive');
  });
  it('an UNdeclared param falls back to the row key matching its own name', () => {
    assert.equal(resolveWriteValue(row, 'city', declared), 'ARCHDALE');
  });
  it('a DECLARED field absent on this row resolves EMPTY — it never falls back to a guess', () => {
    // The declaration is the author saying "this and nothing else". Falling back here would silently write
    // some other field's value into a customer record, which is precisely the failure this ordering prevents.
    const bare = { AddressLine1: 'x', Email: 'wrong@example.com', __contacts: [] };
    assert.equal(resolveWriteValue(bare, 'email', declared), '');
  });
  it('a junk row resolves empty rather than throwing', () => {
    assert.equal(resolveWriteValue(null, 'email', declared), '');
  });
});

describe('writeMap — buildWriteProposals', () => {
  const misses = [{ row, label: '#01 1008 Harb Drive', value: '1008 Harb Drive' }];

  it('builds one proposal carrying the EXACT params it will send', () => {
    const { proposals, unproposable } = buildWriteProposals(misses, { leg: createLeg, declared, why: 'no Shopify match' });
    assert.equal(unproposable.length, 0);
    assert.equal(proposals.length, 1);
    assert.deepEqual(proposals[0].params, {
      first_name: 'Dana', last_name: 'Reyes', email: 'dana@example.com',
      address1: '1008 Harb Drive', city: 'ARCHDALE', country: 'US',
    });   // no `phone`: undeclared + contact-only (see the sidecar test below)
    assert.equal(proposals[0].safety, 'confirm');
    assert.deepEqual(proposals[0].targets, ['#01 1008 Harb Drive']);
  });

  it('a row missing a REQUIRED param is unproposable and names what is missing — never invented', () => {
    const nameless = [{ row: { AddressLine1: 'x', __contacts: [{ IsPrimary: true, Email: 'a@b.c' }] }, label: '#02', value: 'x' }];
    const { proposals, unproposable } = buildWriteProposals(nameless, { leg: createLeg, declared });
    assert.equal(proposals.length, 0);
    assert.deepEqual(unproposable, [{ label: '#02', missing: ['first_name', 'last_name'] }]);
  });

  it('an UNDECLARED contact-shaped param drops rather than guessing a person', () => {
    // `phone` is not declared and exists only inside the contacts sidecar. Resolving it would mean picking
    // whichever contact happens to be first in the array — so it drops, and the customer is created without
    // a phone rather than with the wrong homeowner's.
    const { proposals } = buildWriteProposals(misses, { leg: createLeg, declared });
    assert.equal('phone' in proposals[0].params, false);
  });

  it('the fallback never reaches into the contacts sidecar, whatever the array order', () => {
    const swapped = { AddressLine1: 'a', __contacts: [{ IsPrimary: false, Phone: 'OTHER-999' }, { IsPrimary: true, Phone: 'PRIMARY-111' }] };
    assert.equal(resolveWriteValue(swapped, 'phone', {}), '');
    assert.equal(resolveWriteValue(swapped, 'phone', { phone: { contact: 'primary', type: 'phone' } }), 'PRIMARY-111');
    assert.equal(resolveWriteValue(swapped, 'phone', { phone: { contact: 'other', type: 'phone' } }), 'OTHER-999');
  });

  it('the staleness guard rides when a readLeg is supplied — the duplicate defence', () => {
    const { proposals } = buildWriteProposals(misses, {
      leg: createLeg, declared, readLeg: searchLeg, readParamName: 'query', basedOnPath: 'data.customers.edges.0.node.id',
    });
    assert.equal(proposals[0].readLeg, searchLeg);
    assert.deepEqual(proposals[0].readParams, { query: '1008 Harb Drive' });
    assert.deepEqual(proposals[0].basedOn, { path: 'data.customers.edges.0.node.id', value: '' });
  });

  it('caps the batch and reports the drop — a list nobody can read is a rubber stamp', () => {
    const many = Array.from({ length: WRITE_BATCH_CAP + 4 }, (_, i) => ({ row, label: `#${i}`, value: `v${i}` }));
    const r = buildWriteProposals(many, { leg: createLeg, declared });
    assert.equal(r.proposals.length, WRITE_BATCH_CAP);
    assert.equal(r.capped, true);
    assert.equal(r.dropped, 4);
  });

  it('no rows → an empty batch, not a crash', () => {
    assert.deepEqual(buildWriteProposals(null, { leg: createLeg, declared }).proposals, []);
  });
});

describe('writeMap — requireStalenessGuard (a create batch without a re-check is a duplicate factory)', () => {
  it('passes when every proposal carries the guard', () => {
    const ps = [{ readLeg: searchLeg, basedOn: { path: 'p', value: '' }, targets: ['#01'] }];
    assert.equal(requireStalenessGuard(ps).ok, true);
  });
  it('fails CLOSED and names the bare items', () => {
    const r = requireStalenessGuard([{ targets: ['#01'], name: 'Create' }, { readLeg: searchLeg, basedOn: {}, targets: ['#02'] }]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.bare, ['#01']);
  });
});

describe('writeMap — writeBatchSummary (honest counts)', () => {
  it('names the unfillable and the truncated, not just the happy count', () => {
    const s = writeBatchSummary({ proposals: [1, 2], unproposable: [1], capped: true, dropped: 7, system: 'Shopify' });
    assert.match(s, /2 to create in Shopify/);
    assert.match(s, /1 I can't fill/);
    assert.match(s, /7 beyond/);
  });
  it('a clean batch says only what happened', () => {
    assert.equal(writeBatchSummary({ proposals: [1], system: 'Shopify' }), '1 to create in Shopify');
  });
});

// v2.74.2020 — live CustomerInput coercion wall: incomplete MailingAddressInput + non-E.164 phone.
describe('writeMap — CityStateZip + Shopify create prep (v2020)', () => {
  it('parseCityStateZip splits "City, ST ZIP"', () => {
    assert.deepEqual(parseCityStateZip('Cumming, GA 30040'), { city: 'Cumming', province: 'GA', zip: '30040' });
    assert.deepEqual(parseCityStateZip('ABERDEEN, NC 28315'), { city: 'ABERDEEN', province: 'NC', zip: '28315' });
    assert.deepEqual(parseCityStateZip('Somewhere NC 28315'), { city: 'Somewhere', province: 'NC', zip: '28315' });
    assert.deepEqual(parseCityStateZip(''), {});
    assert.deepEqual(parseCityStateZip('no zip here'), {});
  });
  it('cityStateZip declaration resolves city / province / zip parts', () => {
    const r = { CityStateZip: 'Cumming, GA 30040', AddressLine1: '1 Main' };
    const decl = {
      city: { cityStateZip: 'CityStateZip', part: 'city' },
      province: { cityStateZip: 'CityStateZip', part: 'province' },
      zip: { cityStateZip: 'CityStateZip', part: 'zip' },
    };
    assert.equal(resolveWriteValue(r, 'city', decl), 'Cumming');
    assert.equal(resolveWriteValue(r, 'province', decl), 'GA');
    assert.equal(resolveWriteValue(r, 'zip', decl), '30040');
  });
  it('normalizeShopifyPhone → E.164 for US 10/11-digit; drops junk', () => {
    assert.equal(normalizeShopifyPhone('(704) 555-1212'), '+17045551212');
    assert.equal(normalizeShopifyPhone('1-704-555-1212'), '+17045551212');
    assert.equal(normalizeShopifyPhone('+17045551212'), '+17045551212');
    assert.equal(normalizeShopifyPhone('555'), '');
    assert.equal(normalizeShopifyPhone(''), '');
  });
  it('prepareShopifyCustomerCreateParams drops address1+country alone (the live fail shape)', () => {
    const out = prepareShopifyCustomerCreateParams({
      first_name: 'A', last_name: 'B', email: 'a@b.c',
      address1: '1 Main', country: 'US', phone: '704-555-1212',
    });
    assert.equal(out.phone, '+17045551212');
    assert.equal('address1' in out, false);
    assert.equal('country' in out, false);
    assert.equal(out.first_name, 'A');
  });
  it('prepare keeps a complete address and normalizes phone', () => {
    const out = prepareShopifyCustomerCreateParams({
      first_name: 'A', last_name: 'B', phone: '7045551212',
      address1: '1 Main', city: 'Cumming', province: 'GA', zip: '30040', country: 'US',
    });
    assert.equal(out.phone, '+17045551212');
    assert.equal(out.city, 'Cumming');
    assert.equal(out.province, 'GA');
    assert.equal(out.zip, '30040');
  });
  it('a projected leg (no tool.params) still fills proposals — the live create shape (v2021)', () => {
    const { proposals, unproposable } = buildWriteProposals(
      [{ row, label: '#01', value: '1008 Harb Drive' }],
      { leg: projectedCreateLeg, declared, why: 'no match' },
    );
    assert.equal(unproposable.length, 0);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].params.first_name, 'Dana');
    assert.equal(proposals[0].params.last_name, 'Reyes');
    assert.equal(proposals[0].params.email, 'dana@example.com');
    assert.equal(proposals[0].params.address1, '1008 Harb Drive');
  });

  it('buildWriteProposals runs prepare on shopify_create_customer (incomplete address omitted from preview)', () => {
    const bareAddr = {
      AddressLine1: '1 Main', CityStateZip: 'garbage',
      __contacts: [{ IsPrimary: true, FirstName: 'A', LastName: 'B', Email: 'a@b.c', Phone: '704-555-1212' }],
    };
    const decl = {
      first_name: { contact: 'primary', type: 'first' },
      last_name: { contact: 'primary', type: 'last' },
      email: { contact: 'primary', type: 'email' },
      phone: { contact: 'primary', type: 'phone' },
      address1: 'AddressLine1',
      city: { cityStateZip: 'CityStateZip', part: 'city' },
      province: { cityStateZip: 'CityStateZip', part: 'province' },
      zip: { cityStateZip: 'CityStateZip', part: 'zip' },
      country: { literal: 'US' },
    };
    const leg = {
      safety: 'confirm',
      tool: {
        id: 'shopify_create_customer', name: 'Create', write: true,
        params: [
          { name: 'first_name', required: true }, { name: 'last_name', required: true },
          { name: 'email' }, { name: 'phone' }, { name: 'address1' }, { name: 'city' },
          { name: 'province' }, { name: 'zip' }, { name: 'country' },
        ],
      },
    };
    const { proposals } = buildWriteProposals([{ row: bareAddr, label: '#1', value: '1 Main' }], { leg, declared: decl });
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].params.phone, '+17045551212');
    assert.equal('address1' in proposals[0].params, false);
    assert.equal('country' in proposals[0].params, false);
  });
});
