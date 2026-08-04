// Core/identifierShapes.test.js — SG-1 (v2.74.1947). The live case is the first test: a UPS tracking number
// bound to a Shopify order slot, which returned HTTP 200 and banked as a success (2026-08-02 15:46, twice).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { identifierShape, misboundIdentifierParams } from './identifierShapes.js';

const shopifyLeg = { tool: { appHost: 'admin.shopify.com', origin: 'admin.shopify.com', recipeId: 'shopify_order' } };
const upsLeg     = { tool: { appHost: 'www.ups.com', origin: 'www.ups.com', recipeId: 'ups_track' } };

describe('identifierShapes — the live mis-bind', () => {
  it('recognizes a 1Z tracking number as UPS-owned', () => {
    const s = identifierShape('1Z27691W0233595715');
    assert.equal(s && s.id, 'ups-tracking');
    assert.equal(s.owner, 'UPS');
  });

  it('THE LIVE CASE: a UPS tracking number in a Shopify order slot is refused', () => {
    const out = misboundIdentifierParams(shopifyLeg, { order: '1Z27691W0233595715' });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'order');
    assert.equal(out[0].shape, 'ups-tracking');
    assert.equal(out[0].owner, 'UPS');
    assert.equal(out[0].host, 'admin.shopify.com');
  });

  it('the SAME value on the UPS leg passes — right shape, right site', () => {
    assert.deepEqual(misboundIdentifierParams(upsLeg, { id: '1Z27691W0233595715' }), []);
  });

  it('is symmetric: a Shopify gid on a UPS leg is refused', () => {
    const out = misboundIdentifierParams(upsLeg, { orderId: 'gid://shopify/Order/12345' });
    assert.equal(out.length, 1);
    assert.equal(out[0].shape, 'shopify-gid');
  });

  it('passes a gid on its own site', () => {
    assert.deepEqual(misboundIdentifierParams(shopifyLeg, { orderId: 'gid://shopify/Order/12345' }), []);
  });
});

describe('identifierShapes — the false positives it must never produce', () => {
  it('leaves a tracking number in a NON-identifier slot alone (Shopify fulfillments carry carrier numbers)', () => {
    // The failure that would be WORSE than the bug: refusing a legitimate write that attaches a carrier number
    // to a Shopify fulfillment. Only the slot that NAMES the record is judged.
    assert.deepEqual(misboundIdentifierParams(shopifyLeg, { trackingNumber: '1Z27691W0233595715' }), []);
  });

  it('says nothing about unrecognized id shapes (a guard, not a whitelist)', () => {
    assert.deepEqual(misboundIdentifierParams(shopifyLeg, { orderId: '#1234' }), []);
    assert.deepEqual(misboundIdentifierParams(shopifyLeg, { orderId: 'SO-99-B' }), []);
  });

  it('is anchored — a 1Z embedded in a longer string is not a tracking number', () => {
    assert.equal(identifierShape('note-1Z27691W0233595715-copy'), null);
    assert.equal(identifierShape('1Z2769'), null);
  });

  it('stays silent when there is no host to judge against', () => {
    assert.deepEqual(misboundIdentifierParams({ tool: {} }, { order: '1Z27691W0233595715' }), []);
  });
});

describe('identifierShapes — shape and tolerance', () => {
  it('checks array values and reports one finding per param', () => {
    const out = misboundIdentifierParams(shopifyLeg, { order: ['1Z27691W0233595715', '1Z27691W9027963824'] });
    assert.equal(out.length, 1);
  });

  it('resolves a scheme-prefixed origin to a bare host', () => {
    const leg = { tool: { origin: 'https://admin.shopify.com/' } };
    assert.equal(misboundIdentifierParams(leg, { order: '1Z27691W0233595715' }).length, 1);
  });

  it('tolerates junk input', () => {
    assert.deepEqual(misboundIdentifierParams(null, { order: '1Z27691W0233595715' }), []);
    assert.deepEqual(misboundIdentifierParams(shopifyLeg, null), []);
    assert.deepEqual(misboundIdentifierParams(shopifyLeg, { order: null, o2: undefined }), []);
    assert.equal(identifierShape(null), null);
    assert.equal(identifierShape({}), null);
  });
});

describe('probeTemplate — PS-2 (v2.74.1995): every declared template satisfies its own shape', () => {
  it('each shape that declares a probeTemplate produces a shape-valid, sentinel-carrying value', async () => {
    // A catalog-wide invariant rather than a per-shape test: whoever adds the NEXT shape gets this check free,
    // and a template edited out of spec fails here instead of shipping a probe the router cannot read.
    const { probeValue } = await import('./peritemMap.js');
    const { shapesForOwner } = await import('./identifierShapes.js');
    for (const owner of ['ups', 'shopify']) {
      for (const sh of shapesForOwner(owner)) {
        if (typeof sh.probeTemplate !== 'string') continue;
        const v = probeValue([sh], 'MAPQ7VALUEZ');
        assert.ok(v, `${sh.id}: probeTemplate must yield a value`);
        assert.ok(sh.re.test(v), `${sh.id}: "${v}" must match its own shape`);
        assert.ok(v.includes('MAPQ7VALUEZ'), `${sh.id}: "${v}" must stay findable`);
      }
    }
  });
});
