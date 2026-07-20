// Core/rideRecipe.test.js — the per-Ground ride-recipe model (§18 slice 1). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  safetyClassForMethod, safetyRank, originMatchesAppHost, recipeFromCatalogEntry,
  seedFromCatalog, mergeRecipes, setEnabled, review, downgradeSafety, editMeta, armable, acceptPendingReads,
  curatedRidesForConnections, mergeRideCatalogForAnswer, catalogArmedEntries,
} from './rideRecipe.js';

// A miniature of the CONNECTOR_RECIPES shape.
const CATALOG = [
  { id: 'my_open_tickets', name: 'My open Zendesk tickets', does: 'list open', method: 'GET', endpoint: '/api/v2/search.json', params: [], appHost: 'zendesk.com' },
  { id: 'add_comment', name: 'Comment on a ticket', does: 'reply', method: 'PUT', endpoint: '/api/v2/tickets/{id}.json', params: [{ name: 'id' }], appHost: 'zendesk.com', write: true, body: {} },
  { id: 'delete_ticket', name: 'Delete a ticket', does: 'delete', method: 'DELETE', endpoint: '/api/v2/tickets/{id}.json', params: [{ name: 'id' }], appHost: 'zendesk.com', write: true, destructive: true },
  { id: 'shopify_orders', name: 'Orders', does: 'list orders', method: 'GET', endpoint: '/admin/orders.json', params: [], appHost: 'myshopify.com' },
];

describe('rideRecipe — safety classing (method IS the class, §9)', () => {
  it('GET → auto, non-GET → gated, destructive → destructive', () => {
    assert.equal(safetyClassForMethod('GET'), 'auto');
    assert.equal(safetyClassForMethod('get'), 'auto');
    assert.equal(safetyClassForMethod('PUT'), 'gated');
    assert.equal(safetyClassForMethod('POST'), 'gated');
    assert.equal(safetyClassForMethod('DELETE', { destructive: true }), 'destructive');
    assert.equal(safetyClassForMethod('GET', { destructive: true }), 'destructive');   // flag wins
  });
  it('rank orders auto < gated < destructive', () => {
    assert.ok(safetyRank('auto') < safetyRank('gated'));
    assert.ok(safetyRank('gated') < safetyRank('destructive'));
    assert.equal(safetyRank('nonsense'), -1);
  });
});

describe('rideRecipe — origin match', () => {
  it('exact host + subdomain match; foreign host does not', () => {
    assert.equal(originMatchesAppHost('zendesk.com', 'zendesk.com'), true);
    assert.equal(originMatchesAppHost('deako.zendesk.com', 'zendesk.com'), true);
    assert.equal(originMatchesAppHost('https://deako.zendesk.com/', 'zendesk.com'), true);
    assert.equal(originMatchesAppHost('evil-zendesk.com', 'zendesk.com'), false);   // not a subdomain
    assert.equal(originMatchesAppHost('myshopify.com', 'zendesk.com'), false);
  });
});

describe('rideRecipe — seed from catalog', () => {
  it('keeps only origin-matching entries; curated → accepted/enabled/trust 1', () => {
    const seeded = seedFromCatalog(CATALOG, { groundId: 'g1', origin: 'deako.zendesk.com' });
    assert.deepEqual(seeded.map((r) => r.id).sort(), ['add_comment', 'delete_ticket', 'my_open_tickets']);   // not shopify
    const open = seeded.find((r) => r.id === 'my_open_tickets');
    assert.equal(open.provenance, 'curated');
    assert.equal(open.reviewState, 'accepted');
    assert.equal(open.enabled, true);
    assert.equal(open.trust, 1);
    assert.equal(open.safetyClass, 'auto');
    assert.equal(open.origin, 'deako.zendesk.com');
    assert.equal(seeded.find((r) => r.id === 'add_comment').safetyClass, 'gated');
    assert.equal(seeded.find((r) => r.id === 'delete_ticket').safetyClass, 'destructive');
  });

  it('v1432 (Invariant #3): carries the FULL markers so a SEEDED record is invocation-complete', () => {
    const rec = recipeFromCatalogEntry(
      { id: 'x', name: 'X', does: 'd', method: 'POST', endpoint: '/e', appHost: 'zendesk.com',
        itemUrl: '/agent/tickets/{id}', listUrl: '/agent/search', write: true, gql: true, csrf: 'sniff',
        bodyType: 'form', contentType: 'application/json', verifyIdentity: true, identityProbe: '/me.json',
        persistedOp: 'CreateX', shopProbe: true, pulse: { kind: 'inflow' }, drill: { via: 'y' }, urlParam: { name: 'h', pattern: 'p' },
        resolve: { divisionId: { via: '/api/State', defaultPath: 'a.b', lists: ['c'], match: ['Code'], id: 'Id', label: 'Name' } } },
      { groundId: 'g1', origin: 'deako.zendesk.com' });
    assert.equal(rec.itemUrl, '/agent/tickets/{id}');
    assert.equal(rec.listUrl, '/agent/search');
    assert.equal(rec.write, true);
    assert.equal(rec.gql, true);
    assert.equal(rec.csrf, 'sniff');
    assert.equal(rec.bodyType, 'form');
    assert.equal(rec.contentType, 'application/json');
    assert.equal(rec.verifyIdentity, true);
    assert.equal(rec.identityProbe, '/me.json');
    assert.equal(rec.persistedOp, 'CreateX');
    assert.equal(rec.shopProbe, true);
    assert.deepEqual(rec.pulse, { kind: 'inflow' });
    assert.deepEqual(rec.drill, { via: 'y' });
    assert.deepEqual(rec.urlParam, { name: 'h', pattern: 'p' });
    assert.equal(rec.resolve.divisionId.defaultPath, 'a.b');   // CX-9b (v1434) — the resolve specs ride the seeded record
    // a plain GET read carries NONE of these — additive, no empty keys (byte-identical to the pre-v1432 record)
    const plain = recipeFromCatalogEntry({ id: 'p', method: 'GET', endpoint: '/g', appHost: 'zendesk.com' }, { origin: 'deako.zendesk.com' });
    for (const k of ['itemUrl', 'listUrl', 'write', 'gql', 'csrf', 'bodyType', 'verifyIdentity', 'persistedOp', 'shopProbe', 'pulse', 'drill', 'urlParam', 'resolve']) {
      assert.equal(k in plain, false, `plain read must not carry ${k}`);
    }
  });
});

describe('rideRecipe — merge preserves user state', () => {
  it('a re-seed keeps a disabled/reviewed recipe disabled; harvested entries survive a re-seed; new harvest adds', () => {
    let coll = seedFromCatalog(CATALOG, { groundId: 'g1', origin: 'deako.zendesk.com' });
    coll = coll.map((r) => (r.id === 'my_open_tickets' ? setEnabled(r, false) : r));
    // a harvested recipe added to the collection
    const harvested = { id: 'harvest_a1', groundId: 'g1', origin: 'deako.zendesk.com', name: 'recent', does: 'x', method: 'GET', endpoint: '/api/v2/x', params: [], provenance: 'harvested', safetyClass: 'auto', trust: 0.3, enabled: true, reviewState: 'pending' };
    coll = mergeRecipes(coll, [harvested]);
    assert.ok(coll.find((r) => r.id === 'harvest_a1'));                                  // harvested added
    assert.equal(coll.find((r) => r.id === 'my_open_tickets').enabled, false);           // edit survived the add
    // RE-SEED the curated catalog → user disable preserved, harvested entry kept, endpoint refreshed
    const reseed = seedFromCatalog([{ ...CATALOG[0], endpoint: '/api/v2/search.json?v2' }, CATALOG[1], CATALOG[2]], { groundId: 'g1', origin: 'deako.zendesk.com' });
    coll = mergeRecipes(coll, reseed);
    assert.equal(coll.find((r) => r.id === 'my_open_tickets').enabled, false);           // user disable preserved
    assert.equal(coll.find((r) => r.id === 'my_open_tickets').endpoint, '/api/v2/search.json?v2');  // mechanical refreshed
    assert.ok(coll.find((r) => r.id === 'harvest_a1'));                                  // harvested NOT clobbered by re-seed
  });
});

describe('rideRecipe — edit transforms + arm guard', () => {
  const base = recipeFromCatalogEntry(CATALOG[0], { groundId: 'g1', origin: 'deako.zendesk.com' });
  it('downgradeSafety TIGHTENS only', () => {
    assert.equal(downgradeSafety(base, 'gated').safetyClass, 'gated');                    // auto→gated ok
    assert.equal(downgradeSafety(base, 'destructive').safetyClass, 'destructive');        // auto→destructive ok
    const gated = { ...base, safetyClass: 'gated' };
    assert.equal(downgradeSafety(gated, 'auto').safetyClass, 'gated');                    // gated→auto REFUSED
  });
  it('review + editMeta', () => {
    assert.equal(review(base, 'reject').reviewState, 'rejected');
    assert.equal(review({ ...base, reviewState: 'pending' }, 'accept').reviewState, 'accepted');
    assert.equal(editMeta(base, { does: 'list my open tickets' }).does, 'list my open tickets');
  });
  it('armable = enabled AND accepted; pending/rejected/disabled are NOT armable', () => {
    assert.equal(armable(base), true);                                                   // curated: enabled + accepted
    assert.equal(armable({ ...base, reviewState: 'pending' }), false);                    // harvested-pending: blocked
    assert.equal(armable({ ...base, reviewState: 'rejected' }), false);
    assert.equal(armable(setEnabled(base, false)), false);
  });
  it('acceptPendingReads bulk-accepts pending GETs (auto) ONLY — writes/destructive stay pending', () => {
    const recs = [
      { id: 'r1', reviewState: 'pending', safetyClass: 'auto' },         // GET read → accepted
      { id: 'r2', reviewState: 'pending', safetyClass: 'gated' },        // write → stays pending
      { id: 'r3', reviewState: 'pending', safetyClass: 'destructive' },  // delete → stays pending
      { id: 'r4', reviewState: 'accepted', safetyClass: 'auto' },        // already accepted → untouched
      { id: 'r5', reviewState: 'rejected', safetyClass: 'auto' },        // rejected (not pending) → untouched
    ];
    const { recipes, accepted } = acceptPendingReads(recs);
    assert.equal(accepted, 1);
    assert.equal(recipes.find((r) => r.id === 'r1').reviewState, 'accepted');
    assert.equal(recipes.find((r) => r.id === 'r2').reviewState, 'pending');
    assert.equal(recipes.find((r) => r.id === 'r3').reviewState, 'pending');
    assert.equal(recipes.find((r) => r.id === 'r5').reviewState, 'rejected');
    assert.deepEqual(acceptPendingReads([]), { recipes: [], accepted: 0 });
  });
});

describe('curatedRidesForConnections — IL_ANSWER ride projection (v2.74.1458)', () => {
  const AC_CAT = [
    { id: 'aw_team_availability', name: 'Team availability (all agents)', does: 'list every teammate availability', method: 'GET', endpoint: '/v3/availabilities', params: [], appHost: 'workspace.aircall.io' },
    { id: 'aw_close_conversation', name: 'Close conversation after a call', does: 'wrap up', method: 'POST', endpoint: '/graphql', params: [{ name: 'callId' }], appHost: 'workspace.aircall.io', write: true, gql: true },
  ];
  it('projects curated catalog rides for connected origins without a Ground', () => {
    const rides = curatedRidesForConnections([{ origin: 'https://workspace.aircall.io', label: 'Aircall' }], AC_CAT);
    assert.equal(rides.length, 2);
    assert.equal(rides[0].reviewState, 'accepted');
    assert.equal(rides.find((r) => r.id === 'aw_team_availability').origin, 'workspace.aircall.io');
  });
  it('mergeRideCatalogForAnswer: stored records override curated on the same origin|id', () => {
    const curated = curatedRidesForConnections([{ origin: 'https://workspace.aircall.io' }], AC_CAT);
    const stored = [{ ...curated[0], reviewState: 'rejected', enabled: false }];
    const merged = mergeRideCatalogForAnswer(curated, stored);
    assert.equal(merged.find((r) => r.id === 'aw_team_availability').reviewState, 'rejected');
    assert.equal(merged.length, 2);
  });
});

describe('catalogArmedEntries — CX-9r catalog-armed origins (v2.74.1463)', () => {
  it('an open-tab host matching a curated appHost projects WITHOUT a Ground (subdomain + exact)', () => {
    const entries = catalogArmedEntries(['deako.zendesk.com', 'workspace.aircall.io'], [
      ...CATALOG,
      { id: 'aw_x', name: 'Team availability', does: 'who is available', method: 'GET', endpoint: '/v3/a', appHost: 'workspace.aircall.io' },
    ]);
    const zd = entries.find((e) => e.host === 'deako.zendesk.com');
    const ac = entries.find((e) => e.host === 'workspace.aircall.io');
    assert.ok(zd && zd.gid === null, 'subdomain matches appHost zendesk.com');
    assert.equal(zd.texts.length, 3);                          // the 3 zendesk CATALOG entries, not shopify
    assert.ok(ac && ac.texts[0].includes('Team availability')); // texts = name+does (the vocab source)
  });
  it('covered hosts (a real ride-armed Ground exists) are skipped — stored user state outranks the catalog', () => {
    const entries = catalogArmedEntries(['deako.zendesk.com'], CATALOG, ['DEAKO.zendesk.com']);
    assert.equal(entries.length, 0);
  });
  it('non-matching hosts and duplicates drop; evil-suffix host does NOT match', () => {
    const entries = catalogArmedEntries(['example.com', 'evil-zendesk.com', 'a.zendesk.com', 'a.zendesk.com'], CATALOG);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].host, 'a.zendesk.com');
  });
  it('malformed input → empty', () => {
    assert.deepEqual(catalogArmedEntries(null, CATALOG), []);
    assert.deepEqual(catalogArmedEntries(['x.zendesk.com'], null), []);
  });
});

describe('rideRecipe — LEG-1 (v2.74.1593): lastUrlArgs is user-state (a catalog refresh must keep it)', () => {
  it('mergeRecipes preserves the funnel-banked lastUrlArgs while mechanical fields refresh', () => {
    const existing = [{ id: 'sh_pulse', endpoint: '/api/shopify/{handle}?operation=Shop&type=query', lastOkAt: 5, lastUrlArgs: { handle: 'deako' } }];
    const reseed = [{ id: 'sh_pulse', endpoint: '/api/shopify/{handle}?operation=ShopV2&type=query' }];
    const merged = mergeRecipes(existing, reseed);
    const rec = merged.find((r) => r.id === 'sh_pulse');
    assert.match(rec.endpoint, /ShopV2/, 'mechanical field refreshed from the catalog');
    assert.deepEqual(rec.lastUrlArgs, { handle: 'deako' }, 'the banked handle survives — the ephemeral canary depends on it');
    assert.equal(rec.lastOkAt, 5, 'proof-of-life untouched');
  });
});

describe('CX-9k (v2.74.1617) — displayId rides the SEEDED path (Invariant #3 hop 1)', () => {
  it('recipeFromCatalogEntry carries displayId; an entry without one stays byte-identical (no empty key)', () => {
    const rec = recipeFromCatalogEntry({ id: 'x', method: 'GET', endpoint: '/e', appHost: 'a.com', displayId: ['TicketId'] }, { origin: 'a.com' });
    assert.deepEqual(rec.displayId, ['TicketId']);
    const plain = recipeFromCatalogEntry({ id: 'y', method: 'GET', endpoint: '/e', appHost: 'a.com' }, { origin: 'a.com' });
    assert.ok(!('displayId' in plain));
  });
});
