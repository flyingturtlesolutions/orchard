// Core/rideRecipe.test.js — the per-Ground ride-recipe model (§18 slice 1). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  safetyClassForMethod, safetyRank, originMatchesAppHost, recipeFromCatalogEntry,
  seedFromCatalog, mergeRecipes, setEnabled, review, downgradeSafety, editMeta, armable, acceptPendingReads,
  curatedRidesForConnections, mergeRideCatalogForAnswer, catalogArmedEntries,
  hostRideInventory, formatHostRideInventory,
  bareOrigin, partitionRecipesByOrigin, ownOriginRecipes,
} from './rideRecipe.js';
import { recipeToLeg } from './connectorLeg.js';   // PP-3 (v1661) — hop 3, so the Invariant-#3 test can assert on the LEG rather than the record

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
  it('an explicit verifyIdentity:false survives hop 1 — declared-off is a declaration, not an absence (v2049)', () => {
    const rec = recipeFromCatalogEntry({ id: 'u', method: 'POST', endpoint: '/t', appHost: 'www.ups.com', verifyIdentity: false, write: false }, { origin: 'www.ups.com' });
    assert.equal(rec.verifyIdentity, false, 'the declared NO must be stored, not dropped (the v1936 write:false class)');
    assert.equal(rec.write, false);
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

describe('PM (v2.74.1633) — joinKey rides the SEEDED path (Invariant #3 hop 1)', () => {
  it('recipeFromCatalogEntry carries joinKey; absent stays absent', () => {
    const rec = recipeFromCatalogEntry({ id: 'x', method: 'GET', endpoint: '/e', appHost: 'a.com', joinKey: ['AddressLine1'] }, { origin: 'a.com' });
    assert.deepEqual(rec.joinKey, ['AddressLine1']);
    assert.ok(!('joinKey' in recipeFromCatalogEntry({ id: 'y', method: 'GET', endpoint: '/e', appHost: 'a.com' }, { origin: 'a.com' })));
  });
});

describe('PP-3 (v2.74.1661) — `outward` rides the SEEDED path (Invariant #3 hop 1)', () => {
  it('recipeFromCatalogEntry carries outward; absent stays absent', () => {
    const rec = recipeFromCatalogEntry({ id: 'x', method: 'POST', endpoint: '/e', appHost: 'a.com', write: true, outward: true }, { origin: 'a.com' });
    assert.equal(rec.outward, true);
    assert.ok(!('outward' in recipeFromCatalogEntry({ id: 'y', method: 'GET', endpoint: '/e', appHost: 'a.com' }, { origin: 'a.com' })));
  });

  it('THE INVARIANT: a SEEDED record reaches recipeToLeg still gated — the curated path is not the test', () => {
    // The failure this guards is the one Invariant #3 was written from: the curated app keeps working (it reads
    // the catalog ENTRY directly) while a forged / Overview-workbench Ground silently loses the marker, because
    // only the seeded path exercises all three hops. So: go entry → record → leg, and assert on the LEG.
    const rec = recipeFromCatalogEntry(
      { id: 'send', method: 'POST', endpoint: '/msg', appHost: 'a.com', app: 'aircall', write: true, outward: true },
      { origin: 'a.com' },
    );
    const leg = recipeToLeg({ ...rec, app: 'aircall', origin: 'a.com' }, { trusted: true });
    assert.ok(leg, 'the seeded record must still build a leg');
    assert.equal(leg.safety, 'gated', 'outward survived catalog → record → leg');

    // And the control: the same leg WITHOUT the marker is merely a write, so a silent drop would be visible here.
    const bare = recipeFromCatalogEntry({ id: 'send', method: 'POST', endpoint: '/msg', appHost: 'a.com', app: 'aircall', write: true }, { origin: 'a.com' });
    assert.equal(recipeToLeg({ ...bare, app: 'aircall', origin: 'a.com' }, { trusted: true }).safety, 'confirm');
  });
});

describe('PP-4 (v2.74.1680) — the pipeline-gate axes ride the SEEDED path (Invariant #3 hop 1)', () => {
  it('carries BOTH booleans, including `false` — half a declaration gates', () => {
    // v1661 carried only `outward: true` (it was raise-only then). Once `pipelineGate` began treating UNDECLARED
    // as "gate", dropping `outward: false` silently reduced {reversible:true, outward:false} to half a
    // declaration, and the create the user had approved for unattended running still queued.
    const rec = recipeFromCatalogEntry(
      { id: 'w', method: 'POST', endpoint: '/e', appHost: 'a.com', write: true, reversible: true, outward: false },
      { origin: 'a.com' },
    );
    assert.equal(rec.reversible, true);
    assert.equal(rec.outward, false, 'a FALSE is a declaration, not an absence');
  });

  it('an explicit reversible:false survives too', () => {
    const rec = recipeFromCatalogEntry({ id: 'w', method: 'POST', endpoint: '/e', appHost: 'a.com', reversible: false }, { origin: 'a.com' });
    assert.equal(rec.reversible, false);
  });

  it('an UNDECLARED axis stays absent — the record must not invent a permissive default', () => {
    const rec = recipeFromCatalogEntry({ id: 'w', method: 'POST', endpoint: '/e', appHost: 'a.com', write: true }, { origin: 'a.com' });
    assert.ok(!('reversible' in rec));
    assert.ok(!('outward' in rec));
  });

  it('END TO END: entry → record → leg keeps the axes, and the GLOBAL floor is unchanged', () => {
    const rec = recipeFromCatalogEntry(
      { id: 'w', name: 'Create a thing', app: 'x', method: 'POST', endpoint: '/e', appHost: 'a.com', write: true, reversible: true, outward: false },
      { origin: 'a.com' },
    );
    const leg = recipeToLeg({ ...rec, app: 'x', origin: 'a.com' }, { trusted: true });
    assert.equal(leg.tool.reversible, true);
    assert.equal(leg.tool.outward, false);
    assert.equal(leg.safety, 'confirm', 'the pipeline axes must NOT relax the ordinary write gate');
  });
});

// ── v2.74.2053 — the appHost side of the compare (review defect, confirmed): harvested cross-host records
// store the CAPTURED API host in `origin` with the PAGE host in `appHost` — the INVERSE of the curated
// convention. An origin-only door dropped the §20 deakoapi class as pollution.
describe('own-origin partition — harvested cross-host records stay OWN (v2053)', () => {
  const harvested = { id: 'h1', origin: 'deakoapi.deako.com', appHost: 'app.deako.com', provenance: 'harvested', method: 'GET' };
  it('a record whose appHost matches the anchor is OWN even when its origin is the captured API host', () => {
    const p = partitionRecipesByOrigin([harvested], 'app.deako.com');
    assert.equal(p.own.length, 1, 'the §20 class must not read as pollution');
    assert.equal(p.foreign.length, 0);
  });
  it('and it is still FOREIGN under a ground that owns neither host — true pollution keeps partitioning out', () => {
    const q = partitionRecipesByOrigin([harvested], 'admin.shopify.com');
    assert.equal(q.foreign.length, 1);
    assert.deepEqual(q.foreignOrigins, ['deakoapi.deako.com']);
  });
  it('an appHost-only record (empty origin — the manual-recipe shape) is OWN under its appHost', () => {
    const p = partitionRecipesByOrigin([{ id: 'm1', origin: '', appHost: 'zendesk.com' }], 'zendesk.com');
    assert.equal(p.own.length, 1);
  });
});

describe('own-origin partition — the SW read-door filter (v2.74.2052, the v1937 panel semantics)', () => {
  const UPS_OWN = [
    // legitimate UPS rows: origin www.ups.com, API on a SIBLING host — apiHost must never enter the compare
    { id: 'ups_recent', origin: 'www.ups.com', apiHost: 'webapis.ups.com', method: 'POST', write: false },
    { id: 'ups_track', origin: 'www.ups.com', apiHost: 'webapis.ups.com', method: 'POST', write: false },
  ];
  const FOREIGN = [
    { id: 'vs_state', origin: 'vendorsuite.drhorton.com', method: 'GET' },
    { id: 'sh_pulse', origin: 'admin.shopify.com', method: 'POST', gql: true },
    { id: 'no_origin', method: 'GET' },   // empty origin — dropped, named '(no origin)'
  ];

  it('bareOrigin: lowercase; strips scheme, ONE leading www., trailing slashes', () => {
    assert.equal(bareOrigin('https://www.ups.com/'), 'ups.com');
    assert.equal(bareOrigin('WWW.UPS.COM'), 'ups.com');
    assert.equal(bareOrigin('admin.shopify.com'), 'admin.shopify.com');
    assert.equal(bareOrigin('http://x.test///'), 'x.test');
    assert.equal(bareOrigin(''), '');
    assert.equal(bareOrigin(null), '');
  });

  it('THE WWW-GROUND CASE (the v1937 lesson): a www ground KEEPS its own records — bare BOTH sides', () => {
    // v1919-b bare'd only the record side and dropped both legitimate UPS legs on the first www ground,
    // reporting the ground's own rows as pollution. The compare must be bare-to-bare.
    const p = partitionRecipesByOrigin(UPS_OWN, 'www.ups.com');
    assert.equal(p.own.length, 2, 'both legitimate rows kept on the www ground');
    assert.equal(p.foreign.length, 0);
    // and the same records against the bare form of the host — subdomain-free equivalence, both directions
    assert.equal(partitionRecipesByOrigin(UPS_OWN, 'ups.com').own.length, 2);
    assert.equal(partitionRecipesByOrigin([{ id: 'a', origin: 'ups.com' }], 'www.ups.com').own.length, 1);
  });

  it('foreign rows drop; foreignOrigins are BARE names (the v2.74.2049 names-list fix), empty origin → (no origin)', () => {
    const p = partitionRecipesByOrigin([...UPS_OWN, ...FOREIGN], 'www.ups.com');
    assert.deepEqual(p.own.map((r) => r.id), ['ups_recent', 'ups_track']);
    assert.equal(p.foreign.length, 3);
    assert.deepEqual([...p.foreignOrigins].sort(), ['(no origin)', 'admin.shopify.com', 'vendorsuite.drhorton.com']);
  });

  it('apiHost NEVER enters the compare — a differing apiHost must not mark a record foreign', () => {
    // the exact inversion hazard: an apiHost-aware compare silently kills the UPS ground's only legs
    assert.equal(ownOriginRecipes(UPS_OWN, 'www.ups.com').length, 2);
  });

  it('the anchor is the GROUND host, so a majority-foreign store still keeps only the own rows', () => {
    // UPS live shape: 33 foreign vs 2 own — a modal-of-records anchor would invert the fix
    const store = [...FOREIGN, ...FOREIGN, ...FOREIGN, ...UPS_OWN];
    const p = partitionRecipesByOrigin(store, 'www.ups.com');
    assert.deepEqual(p.own.map((r) => r.id), ['ups_recent', 'ups_track']);
  });

  it('an EMPTY anchor host filters nothing (no anchor, no verdict); scheme/slash on the anchor is tolerated', () => {
    const p = partitionRecipesByOrigin([...UPS_OWN, ...FOREIGN], '');
    assert.equal(p.own.length, 5, 'no anchor → everything passes through');
    assert.equal(p.foreign.length, 0);
    assert.equal(ownOriginRecipes(UPS_OWN, 'https://www.ups.com/').length, 2);
  });

  it('malformed input: non-array recipes → empty own; null rows land in foreign as (no origin)', () => {
    assert.deepEqual(partitionRecipesByOrigin(null, 'x.test'), { own: [], foreign: [], foreignOrigins: [] });
    const p = partitionRecipesByOrigin([null, { id: 'a', origin: 'x.test' }], 'x.test');
    assert.equal(p.own.length, 1);
    assert.deepEqual(p.foreignOrigins, ['(no origin)']);
  });
});

describe('hostRideInventory / formatHostRideInventory — TR-1 meta (v2.74.1761)', () => {
  it('lists armable curated rides for a host; pending excluded; markdown when non-empty', () => {
    const cat = [
      { id: 'a', name: 'Find customer', does: 'by email', method: 'GET', endpoint: '/c', appHost: 'admin.shopify.com' },
      { id: 'b', name: 'Create customer', does: 'write', method: 'POST', endpoint: '/c', appHost: 'admin.shopify.com', write: true },
      { id: 'z', name: 'Tickets', does: 'list', method: 'GET', endpoint: '/t', appHost: 'zendesk.com' },
    ];
    const items = hostRideInventory([], { host: 'admin.shopify.com', catalog: cat });
    assert.equal(items.length, 2);
    assert.equal(items[0].id, 'a');
    assert.equal(items[0].write, false);
    assert.equal(items[1].id, 'b');
    assert.equal(items[1].write, true);
    const md = formatHostRideInventory('admin.shopify.com', items);
    assert.ok(md.includes('Find customer') && md.includes('Create customer') && md.includes('*(write)*'));
    assert.equal(formatHostRideInventory('x', []), null);
    const pending = [{ id: 'p', name: 'P', method: 'GET', endpoint: '/p', origin: 'admin.shopify.com', enabled: true, reviewState: 'pending' }];
    assert.equal(hostRideInventory(pending, { host: 'admin.shopify.com' }).length, 0);
  });
});
