// Core/writeMap.test.js — PM-6 (v2.74.1639): map misses → a reviewable write batch.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  writeMapPreflight, resolveWriteValue, buildWriteProposals, requireStalenessGuard, writeBatchSummary, WRITE_BATCH_CAP,
  parseCityStateZip, normalizeShopifyPhone, prepareShopifyCustomerCreateParams,
  parseFreeformAddress, droppedAddressReport,
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

// v2.74.2063 — §10.5 item 3: PLACE-NAME resolver. Full state names, freeform-address split, country-name → ISO,
// and the silent incomplete-address drop turned into a drop-WITH-REPORT. Each of these fails on pre-change code
// (parseCityStateZip hard-required a 2-letter state; the freeform/country/report functions did not exist).
describe('writeMap — GEO / place resolver (v2062)', () => {
  it('BYTE-IDENTICAL: the 2-letter path is unchanged — the frozen VendorSuite feed', () => {
    // Mirrors the frozen block above; a widened regex would move these, so re-assert them here too.
    assert.deepEqual(parseCityStateZip('Cumming, GA 30040'), { city: 'Cumming', province: 'GA', zip: '30040' });
    assert.deepEqual(parseCityStateZip('Somewhere NC 28315'), { city: 'Somewhere', province: 'NC', zip: '28315' });
    // the comma+2-letter form MUST win over the name table — Georgia is also a real town in Vermont
    assert.deepEqual(parseCityStateZip('Georgia, VT 05468'), { city: 'Georgia', province: 'VT', zip: '05468' });
  });

  it('parseCityStateZip now resolves a FULL state name (both comma and no-comma)', () => {
    assert.deepEqual(parseCityStateZip('Cumming, Georgia 30040'), { city: 'Cumming', province: 'GA', zip: '30040' });
    assert.deepEqual(parseCityStateZip('Cumming Georgia 30040'), { city: 'Cumming', province: 'GA', zip: '30040' });
  });

  it('parseCityStateZip resolves MULTI-WORD state names (longest match wins)', () => {
    assert.deepEqual(parseCityStateZip('Raleigh North Carolina 27601'), { city: 'Raleigh', province: 'NC', zip: '27601' });
    assert.deepEqual(parseCityStateZip('New York New York 10001'), { city: 'New York', province: 'NY', zip: '10001' });
  });

  it('an unresolvable state stays EMPTY — never a guess', () => {
    assert.deepEqual(parseCityStateZip('Somewhere Freedonia 30040'), {});
    assert.deepEqual(parseCityStateZip('no zip here'), {});
    assert.deepEqual(parseCityStateZip(''), {});
  });

  it('parseFreeformAddress splits a one-line address, peeling a secondary unit into address2', () => {
    assert.deepEqual(parseFreeformAddress('123 Main St Apt 4, Cumming Georgia 30040'),
      { address1: '123 Main St', address2: 'Apt 4', city: 'Cumming', province: 'GA', zip: '30040' });
    assert.deepEqual(parseFreeformAddress('1008 Harb Drive, ARCHDALE, NC 28315'),
      { address1: '1008 Harb Drive', city: 'ARCHDALE', province: 'NC', zip: '28315' });   // no address2 key at all
    assert.deepEqual(parseFreeformAddress('nonsense'), {});
    assert.deepEqual(parseFreeformAddress(''), {});
  });

  it('resolveWriteValue: {address,part} reads one part of a freeform address', () => {
    const row = { RawAddr: '123 Main St Apt 4, Cumming Georgia 30040' };
    assert.equal(resolveWriteValue(row, 'address2', { address2: { address: 'RawAddr', part: 'address2' } }), 'Apt 4');
    assert.equal(resolveWriteValue(row, 'address1', { address1: { address: 'RawAddr', part: 'address1' } }), '123 Main St');
    assert.equal(resolveWriteValue(row, 'province', { province: { address: 'RawAddr', part: 'province' } }), 'GA');
    // an unplaceable freeform address resolves each part to EMPTY, not a guess
    assert.equal(resolveWriteValue({ RawAddr: 'nonsense' }, 'city', { city: { address: 'RawAddr', part: 'city' } }), '');
  });

  it('resolveWriteValue: {countryName} maps a country NAME to its ISO code', () => {
    assert.equal(resolveWriteValue({ Country: 'United States' }, 'country', { country: { countryName: 'Country' } }), 'US');
    assert.equal(resolveWriteValue({ Country: 'Canada' }, 'country', { country: { countryName: 'Country' } }), 'CA');
    assert.equal(resolveWriteValue({ Country: 'US' }, 'country', { country: { countryName: 'Country' } }), 'US');   // idempotent
    assert.equal(resolveWriteValue({ Country: 'Freedonia' }, 'country', { country: { countryName: 'Country' } }), '');
  });

  it('droppedAddressReport mirrors the mutator: reports what it WOULD drop, silent when complete', () => {
    const rep = droppedAddressReport({ first_name: 'A', last_name: 'B', address1: '1 Main', country: 'US' });
    assert.equal(rep.dropped, true);
    assert.deepEqual(rep.fields, ['address1', 'country']);
    assert.match(rep.reason, /incomplete address/);
    // a complete address → no drop
    assert.deepEqual(droppedAddressReport({ first_name: 'A', address1: '1 Main', city: 'Cumming', province: 'GA', zip: '30040' }), { dropped: false });
    // a contact-only row → nothing to drop
    assert.deepEqual(droppedAddressReport({ first_name: 'A', last_name: 'B', email: 'a@b.c' }), { dropped: false });
  });

  it('buildWriteProposals: an unplaceable address is REPORTED on `partial`, and the contact-only create STILL ships', () => {
    const bareAddr = {
      AddressLine1: '1 Main', CityStateZip: 'garbage',
      __contacts: [{ IsPrimary: true, FirstName: 'A', LastName: 'B', Email: 'a@b.c' }],
    };
    const decl = {
      first_name: { contact: 'primary', type: 'first' },
      last_name: { contact: 'primary', type: 'last' },
      email: { contact: 'primary', type: 'email' },
      address1: 'AddressLine1',
      city: { cityStateZip: 'CityStateZip', part: 'city' },
      country: { literal: 'US' },
    };
    const leg = {
      safety: 'confirm',
      tool: {
        id: 'shopify_create_customer', name: 'Create', write: true,
        params: [
          { name: 'first_name', required: true }, { name: 'last_name', required: true },
          { name: 'email' }, { name: 'address1' }, { name: 'city' }, { name: 'country' },
        ],
      },
    };
    const r = buildWriteProposals([{ row: bareAddr, label: '#1', value: '1 Main' }], { leg, declared: decl });
    assert.equal(r.proposals.length, 1);                          // the create still ships…
    assert.equal('address1' in r.proposals[0].params, false);     // …minus the address
    assert.equal('country' in r.proposals[0].params, false);
    assert.equal(r.partial.length, 1);                            // …but the drop is now REPORTED
    assert.equal(r.partial[0].label, '#1');
    assert.deepEqual(r.partial[0].droppedFields, ['address1', 'country']);
    assert.match(r.partial[0].reason, /incomplete address/);
  });

  it('buildWriteProposals: a COMPLETE address leaves `partial` empty', () => {
    const fullAddr = {
      AddressLine1: '1 Main', CityStateZip: 'Cumming, GA 30040',
      __contacts: [{ IsPrimary: true, FirstName: 'A', LastName: 'B' }],
    };
    const decl = {
      first_name: { contact: 'primary', type: 'first' },
      last_name: { contact: 'primary', type: 'last' },
      address1: 'AddressLine1',
      city: { cityStateZip: 'CityStateZip', part: 'city' },
      zip: { cityStateZip: 'CityStateZip', part: 'zip' },
    };
    const leg = {
      safety: 'confirm',
      tool: {
        id: 'shopify_create_customer', name: 'Create', write: true,
        params: [{ name: 'first_name', required: true }, { name: 'last_name', required: true }, { name: 'address1' }, { name: 'city' }, { name: 'zip' }],
      },
    };
    const r = buildWriteProposals([{ row: fullAddr, label: '#1', value: '1 Main' }], { leg, declared: decl });
    assert.equal(r.proposals.length, 1);
    assert.equal(r.proposals[0].params.city, 'Cumming');
    assert.equal(r.partial.length, 0);
  });

  it('writeBatchSummary surfaces the partial (address-drop) count', () => {
    const s = writeBatchSummary({ proposals: [1, 2], partial: [1], system: 'Shopify' });
    assert.match(s, /2 to create in Shopify/);
    assert.match(s, /1 with an address I couldn't place/);
    // no partials → the line is absent
    assert.equal(writeBatchSummary({ proposals: [1], system: 'Shopify' }).includes('address'), false);
  });
});
