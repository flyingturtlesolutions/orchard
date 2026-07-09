// Core/legOverview.test.js — OV-1 (v2.74.1413): the cross-Ground leg inventory + rollups + work queue.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildLegOverview } from './legOverview.js';

const GROUNDS = [
  {
    groundId: 'gz', host: 'deako.zendesk.com', label: 'Deako Zendesk',
    recipes: [
      { id: 'read_ticket', name: 'Read ticket', does: 'read a ticket', method: 'GET', endpoint: '/api/v2/tickets/{id}', params: [{ name: 'id' }], provenance: 'curated', safetyClass: 'auto', enabled: true, reviewState: 'accepted' },
      { id: 'harvested_read', name: 'Harvested read', does: 'a captured read', method: 'GET', provenance: 'harvested', safetyClass: 'auto', enabled: true, reviewState: 'pending' },   // needs verify
    ],
  },
  {
    groundId: 'gs', host: 'admin.shopify.com', label: 'Shopify',
    recipes: [
      { id: 'create_customer', name: 'Create customer', does: 'create a customer', method: 'POST', endpoint: '/api/operations/{op}/CustomerCreate', provenance: 'observed', safetyClass: 'gated', enabled: true, reviewState: 'accepted' },
    ],
    driveSections: [{ type: 'fragments', label: 'Fragments', count: 1, entries: [{ id: 'f_search', name: 'Search products' }] }],
    brokerSections: [{ type: 'tools', label: 'Tools', count: 1, entries: [{ id: 'hs_search', name: 'HubSpot search' }] }],
  },
];

describe('buildLegOverview — cross-Ground aggregation', () => {
  it('flattens every ground/class into a uniform leg list, tagged with class + ground', () => {
    const ov = buildLegOverview({ grounds: GROUNDS });
    assert.equal(ov.legs.length, 5);                                   // 3 ride + 1 drive + 1 broker
    assert.deepEqual(ov.counts.byClass, { drive: 1, ride: 3, broker: 1 });
    const rt = ov.legs.find((e) => e.id === 'read_ticket');
    assert.equal(rt.class, 'ride');
    assert.equal(rt.host, 'deako.zendesk.com');
    assert.equal(rt.method, 'GET');
    assert.equal(rt.safetyClass, 'auto');
    // a drive/broker entry gets sensible lifecycle defaults
    const drv = ov.legs.find((e) => e.id === 'f_search');
    assert.equal(drv.class, 'drive');
    assert.equal(drv.provenance, 'observed');
    assert.equal(drv.reviewState, 'accepted');
  });

  it('VERIFIED = armed + reviewed + enabled; a pending recipe is NOT verified and lands in the queue', () => {
    const ov = buildLegOverview({ grounds: GROUNDS });
    assert.equal(ov.legs.find((e) => e.id === 'read_ticket').verified, true);      // accepted + enabled
    assert.equal(ov.legs.find((e) => e.id === 'harvested_read').verified, false);  // pending → not armed
    assert.equal(ov.legs.find((e) => e.id === 'create_customer').verified, true);  // accepted write
    assert.equal(ov.counts.verified, 4);
    assert.equal(ov.counts.unverified, 1);
    assert.deepEqual(ov.counts.byState, { pending: 1, accepted: 4, rejected: 0 });
  });

  it('a REJECTED recipe is NOT verified and NOT counted as accepted (armable is derived, not read)', () => {
    const ov = buildLegOverview({ grounds: [{ groundId: 'g', host: 'x.com', recipes: [
      { id: 'ok_read', name: 'OK', method: 'GET', safetyClass: 'auto', enabled: true, reviewState: 'accepted' },
      { id: 'nope', name: 'Rejected', method: 'GET', safetyClass: 'auto', enabled: true, reviewState: 'rejected' },
    ] }] });
    const rej = ov.legs.find((e) => e.id === 'nope');
    assert.equal(rej.armable, false);         // derived: enabled but NOT accepted → not armable
    assert.equal(rej.verified, false);        // the bug was: defaulted armable:true → rejected read as verified
    assert.equal(ov.counts.verified, 1);      // only ok_read
    assert.deepEqual(ov.counts.byState, { pending: 0, accepted: 1, rejected: 1 });
    assert.ok(ov.queue.some((e) => e.id === 'nope'));   // a rejected leg is unverified → surfaces in the work queue
  });

  it('the work QUEUE holds what needs the developer (pending / unverified)', () => {
    const ov = buildLegOverview({ grounds: GROUNDS });
    assert.equal(ov.queue.length, 1);
    assert.equal(ov.queue[0].id, 'harvested_read');
    assert.equal(ov.queue[0].reviewState, 'pending');
  });

  it('per-ground summaries carry the class breakdown + pending count', () => {
    const ov = buildLegOverview({ grounds: GROUNDS });
    const gz = ov.grounds.find((g) => g.groundId === 'gz');
    assert.deepEqual(gz.byClass, { drive: 0, ride: 2, broker: 0 });
    assert.equal(gz.pending, 1);
    const gs = ov.grounds.find((g) => g.groundId === 'gs');
    assert.deepEqual(gs.byClass, { drive: 1, ride: 1, broker: 1 });
    assert.equal(gs.pending, 0);
  });

  it('the queue orders pending first, then riskiest safety class first', () => {
    const ov = buildLegOverview({ grounds: [{ groundId: 'g', host: 'x.com', recipes: [
      { id: 'a_read', name: 'A read', method: 'GET', safetyClass: 'auto', enabled: true, reviewState: 'pending' },
      { id: 'z_del', name: 'Z delete', method: 'DELETE', safetyClass: 'destructive', enabled: true, reviewState: 'pending' },
    ] }] });
    assert.equal(ov.queue[0].id, 'z_del');    // destructive pending outranks an auto pending
    assert.equal(ov.queue[1].id, 'a_read');
  });

  it('empty input → an empty overview (no throw)', () => {
    const ov = buildLegOverview({});
    assert.deepEqual(ov.legs, []);
    assert.equal(ov.counts.total, 0);
    assert.deepEqual(ov.queue, []);
    assert.equal(ov.counts.verified, 0);
  });
});
