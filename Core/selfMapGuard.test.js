// Core/selfMapGuard.test.js — SM-1 (v2.74.1974).
//
// Two live incidents are encoded here as opposing arms. Neither may pass at the other's expense:
//   101132  declared "vendorsuite", resolved shopify_customer_by_phone → MUST divert (invention)
//   04:04   declared "shopify",     resolved a shopify ORDERS leg      → MUST NOT divert (entity read)
// The old test (declared-vs-SOURCE) fired on both, which is why the second one broke.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { declaredMismatchesResolved, isEntityRead } from './selfMapGuard.js';

const leg = (recipeId, appHost, key) => ({ key: key || recipeId, tool: { recipeId, appHost } });
const resolved = (l) => ({ leg: l });

const shopCustomers = leg('shopify_customer_search', 'admin.shopify.com');
const shopOrders = leg('shopify_orders_for_customer', 'admin.shopify.com');
const vsTasks = leg('vendorsuite_open_tasks', 'app.vendorsuite.com');

describe('declaredMismatchesResolved — the invention test', () => {
  it('FIRES on live 101132: "vendorsuite" declared, a Shopify leg resolved', () => {
    // The regression arm. If this ever goes false, a TaskId can again be sent to Shopify as a phone number and
    // the tally reported as a "vendorsuite lookup" — the wrong-but-plausible class that errors nowhere.
    assert.equal(declaredMismatchesResolved('vendorsuite', resolved(shopCustomers)), true);
  });

  it('FIRES when a system was named and nothing resolved at all', () => {
    // Absence was 101132's actual cause (no vendorsuite "customer by phone" leg). Naming a system that serves
    // nothing must stay a diversion, not fall through to a per-row map with no leg to run.
    assert.equal(declaredMismatchesResolved('vendorsuite', null), true);
    assert.equal(declaredMismatchesResolved('vendorsuite', resolved({ tool: {} })), true);
    assert.equal(declaredMismatchesResolved('vendorsuite', resolved({ tool: { appHost: '' } })), true);
  });

  it('does NOT fire when the declared name agrees with the resolved host', () => {
    assert.equal(declaredMismatchesResolved('shopify', resolved(shopOrders)), false);
    assert.equal(declaredMismatchesResolved('Shopify', resolved(shopOrders)), false);
    assert.equal(declaredMismatchesResolved('shopify.com', resolved(shopOrders)), false);
    assert.equal(declaredMismatchesResolved('vendorsuite', resolved(vsTasks)), false);
  });

  it('ignores the public-suffix and www labels when matching', () => {
    assert.equal(declaredMismatchesResolved('ups', resolved(leg('ups_track', 'www.ups.com'))), false);
    // "com"/"www" must never be what a declared name matches ON, or every system would agree with every host.
    assert.equal(declaredMismatchesResolved('com', resolved(shopOrders)), true);
    assert.equal(declaredMismatchesResolved('www', resolved(shopOrders)), true);
  });

  it('has no opinion when nothing was declared', () => {
    // Silence, not a diversion: an undeclared target is a different branch's problem.
    for (const d of [null, undefined, '', '   ', '---']) {
      assert.equal(declaredMismatchesResolved(d, resolved(shopCustomers)), false);
    }
  });

  it('reads origin when appHost is absent, and tolerates a scheme', () => {
    assert.equal(declaredMismatchesResolved('shopify', resolved({ tool: { origin: 'https://admin.shopify.com' } })), false);
    assert.equal(declaredMismatchesResolved('vendorsuite', resolved({ tool: { origin: 'https://admin.shopify.com' } })), true);
  });
});

describe('isEntityRead — a related record, not a field of the row in hand', () => {
  it('TRUE for live 04:04: rows from customers, readAsk resolved to orders', () => {
    // The arm that broke. "get their last order" was sent to the field-read path, which matched `numberOfOrders`
    // — a COUNT off the pinned customer. The user asked for an order and got an integer.
    assert.equal(isEntityRead(resolved(shopOrders), shopCustomers), true);
  });

  it('FALSE when the readAsk resolves back to the very leg the rows came from', () => {
    // "for each open task, get the homeowner's phone" — a field of the row in hand. v1898 routes these to the
    // per-item field read, and must keep doing so.
    assert.equal(isEntityRead(resolved(shopCustomers), shopCustomers), false);
  });

  it('FALSE across two PROJECTIONS of one recipe — a leg is rebuilt per invocation', () => {
    // Object identity is not enough. If this regressed, one recipe read as two records and a field read would be
    // misfiled as an entity read.
    const a = leg('shopify_customer_search', 'admin.shopify.com', 'k1');
    const b = leg('shopify_customer_search', 'admin.shopify.com', 'k2');
    assert.equal(isEntityRead(resolved(a), b), false);
    assert.equal(isEntityRead(resolved({ ...a, key: undefined }), { ...b, key: undefined }), false);
  });

  it('FALSE when nothing resolved — there is no record to read', () => {
    assert.equal(isEntityRead(null, shopCustomers), false);
    assert.equal(isEntityRead({}, shopCustomers), false);
    assert.equal(isEntityRead(resolved(null), shopCustomers), false);
  });

  it('does not throw on junk from either side', () => {
    for (const t of [null, undefined, {}, { leg: {} }, 'nope', 7]) {
      for (const s of [null, undefined, {}, { tool: null }]) {
        assert.doesNotThrow(() => isEntityRead(t, s));
      }
    }
  });
});

describe('the two tests together — the diversion decision', () => {
  // Mirrors the guard: divert when invented, OR when same-ground AND not an entity read.
  const diverts = (declared, target, srcLeg, sameGround) =>
    declaredMismatchesResolved(declared, target) || (sameGround && !isEntityRead(target, srcLeg));

  it('101132 diverts and 04:04 does not — the pair the old test could not separate', () => {
    assert.equal(diverts('vendorsuite', resolved(shopCustomers), vsTasks, false), true, '101132 must divert');
    assert.equal(diverts('shopify', resolved(shopOrders), shopCustomers, true), false, '"their last order" must run per-row');
  });

  it('a genuine same-system field read still diverts', () => {
    // No invention (shopify agrees with admin.shopify.com), same ground, and the readAsk resolved back to the
    // source leg → a field of the row in hand. This is v1898's case and it must keep reaching the field read.
    assert.equal(diverts('shopify', resolved(shopCustomers), shopCustomers, true), true);
  });

  it('an honest cross-system map is untouched by either test', () => {
    assert.equal(diverts('shopify', resolved(shopCustomers), vsTasks, false), false);
  });
});
