// Core/connectorRecipes.test.js — CX-3 curated recipe catalog + templating (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTOR_RECIPES, fillEndpoint, fillBody, recipeLegs, normalizeTicket, recipeForOrigin, connectorLegsForConnections, coerceParams, harvestedRecipeLegs, toShopifyGid, acGqlBody, acGqlEndpoint } from './connectorRecipes.js';
import { recipeToLeg } from './connectorLeg.js';   // v1479 — identityGql threading assertion

describe('harvestedRecipeLegs — armable harvested reads → invoke-palette legs (§17/§18)', () => {
  const REC = (over) => ({ id: 'r1', name: 'My schedules', does: 'list schedules', method: 'GET', endpoint: '/v2/admin/profiles/{id}/schedules', origin: 'deakoapi.deako.com', params: [{ name: 'id', type: 'string', required: true }], safetyClass: 'auto', enabled: true, reviewState: 'accepted', provenance: 'harvested', ...over });

  it('projects an ARMABLE read into a connector leg (key/domain/paramSchema/tool)', () => {
    const legs = harvestedRecipeLegs([REC()], { host: 'deakoapi.deako.com', mode: 'ask' });
    assert.equal(legs.length, 1);
    const l = legs[0];
    assert.equal(l.key, 'me.deako.r1@deakoapi.deako.com');                 // v1342 — host suffix on harvested legs
    assert.equal(l.domain, 'connector');
    assert.equal(l.mode, 'ask');
    assert.equal(l.safety, 'auto');                     // accepted (vetted) read → auto
    assert.equal(l.provenance, 'harvested');
    assert.equal(l.tool.impl, 'session');
    assert.equal(l.tool.endpoint, '/v2/admin/profiles/{id}/schedules');
    assert.deepEqual(l.paramSchema.required, ['id']);
  });

  it('the §18 ARM GUARD: pending / rejected / disabled are NOT projected', () => {
    assert.equal(harvestedRecipeLegs([REC({ reviewState: 'pending' })], { host: 'deakoapi.deako.com' }).length, 0);
    assert.equal(harvestedRecipeLegs([REC({ reviewState: 'rejected' })], { host: 'deakoapi.deako.com' }).length, 0);
    assert.equal(harvestedRecipeLegs([REC({ enabled: false })], { host: 'deakoapi.deako.com' }).length, 0);
  });

  it("CX-6 (v1303): a WRITE is now projected as an act-leg (selectable, gated at dispatch — never a casual read)", () => {
    const legs = harvestedRecipeLegs([REC({ id: 'w1', method: 'POST', safetyClass: 'gated' })], { host: 'deakoapi.deako.com', mode: 'ask' });
    assert.equal(legs.length, 1);                 // was 0 (reads-only skip) — writes now project; the dispatch confirm-gates + SESSION_REPLAY fail-closes on confirmed
    assert.equal(legs[0].tool.method, 'POST');
    assert.equal(legs[0].mode, 'act');            // a write is mode:'act', not a read — clearly a gated action
    assert.notEqual(legs[0].safety, 'auto');      // §9 — a write never auto-runs
  });

  it('dedups against seenKeys (a harvested recipe never shadows a curated one)', () => {
    const seen = new Set(['me.deako.r1@deakoapi.deako.com']);
    assert.equal(harvestedRecipeLegs([REC()], { host: 'deakoapi.deako.com', mode: 'ask', seenKeys: seen }).length, 0);
  });

  it('v1340 (review A/§18): carries the arm-guard pair — tool.recipeId (bare id) + tool.groundId when given', () => {
    const legs = harvestedRecipeLegs([REC()], { host: 'deakoapi.deako.com', mode: 'ask', groundId: 'g-42' });
    assert.equal(legs[0].tool.recipeId, 'r1');            // bare stored id, not the prefixed leg.key
    assert.equal(legs[0].tool.groundId, 'g-42');          // the recipe's Ground rides to the SESSION_REPLAY dispatch
    assert.equal(harvestedRecipeLegs([REC()], { host: 'deakoapi.deako.com', mode: 'ask' })[0].tool.groundId, undefined);   // no ground → not stamped
  });

  it('v1432 (Invariant #3): carries itemUrl/listUrl from the record → leg.tool (the SEEDED path is now lossless)', () => {
    const legs = harvestedRecipeLegs([REC({ itemUrl: '/#warranty', listUrl: '/#dashboard' })], { host: 'deakoapi.deako.com', mode: 'ask' });
    assert.equal(legs.length, 1);
    assert.equal(legs[0].tool.itemUrl, '/#warranty');   // "show X" opens the object's page — was DROPPED before the whole-record spread
    assert.equal(legs[0].tool.listUrl, '/#dashboard');
  });

  it('v1434 (CX-9b): resolve + the FULL drill (param/from/matchOn/label) survive the seeded path → leg.tool', () => {
    const legs = harvestedRecipeLegs([REC({
      resolve: { divisionId: { via: '/api/State', defaultPath: 'a.b.Id', lists: ['c'], match: ['Code', 'Name'], id: 'Id', label: 'Name' } },
      drill: { via: 'vs_warranty_task', param: 'taskId', from: 'TaskId', matchOn: 'address', label: ['AddressLine1', 'CityStateZip'] },
    })], { host: 'vendorsuite.drhorton.com', mode: 'ask' });
    assert.equal(legs.length, 1);
    assert.equal(legs[0].tool.resolve.divisionId.via, '/api/State');                       // the ID layer rides the leg
    assert.deepEqual(legs[0].tool.drill, { via: 'vs_warranty_task', param: 'taskId', from: 'TaskId', matchOn: 'address', label: ['AddressLine1', 'CityStateZip'] });   // join fields no longer pruned to {via}
    // a via-only drill still projects as {via} — the Zendesk fleet shape unchanged
    const zd = harvestedRecipeLegs([REC({ id: 'z1', drill: { via: 'ticket_comments' } })], { host: 'deako.zendesk.com', mode: 'ask' });
    assert.deepEqual(zd[0].tool.drill, { via: 'ticket_comments' });
  });

  it('v1432: a curated gql READ (POST + write:false) is NOT misclassed as a write; its transport markers flow', () => {
    const legs = harvestedRecipeLegs([REC({ id: 'g1', method: 'POST', write: false, gql: true, body: { query: 'query{x}' }, csrf: 'sniff' })], { host: 'deakoapi.deako.com', mode: 'ask' });
    assert.equal(legs.length, 1);
    assert.equal(legs[0].mode, 'ask');            // explicit write:false honored — a POST read stays a read (was: method→write=true)
    assert.equal(legs[0].safety, 'auto');         // trusted read → auto
    assert.equal(legs[0].tool.gql, true);
    assert.equal(legs[0].tool.csrf, 'sniff');
    assert.ok(legs[0].tool.body);                 // gql body threads for a read
  });

  it('v1432: a record with NO explicit write still method-derives (a non-GET harvested record stays a write — §9 fail-safe)', () => {
    const legs = harvestedRecipeLegs([REC({ id: 'h1', method: 'POST', safetyClass: 'gated' })], { host: 'deakoapi.deako.com', mode: 'ask' });
    assert.equal(legs[0].mode, 'act');            // write == null && method !== GET → write
    assert.notEqual(legs[0].safety, 'auto');
  });

  it('degrades on empty / garbage', () => {
    assert.deepEqual(harvestedRecipeLegs(), []);
    assert.deepEqual(harvestedRecipeLegs([null, {}], { host: 'x.com' }), []);
  });
});

describe('fillEndpoint — {name} templating (pure, §12)', () => {
  it('fills placeholders from args and URL-encodes', () => {
    assert.equal(fillEndpoint('/api/v2/tickets/{id}.json', { id: 12345 }), '/api/v2/tickets/12345.json');
    assert.equal(fillEndpoint('{subdomain}.zendesk.com', { subdomain: 'acme' }), 'acme.zendesk.com');
    assert.equal(fillEndpoint('/q/{term}', { term: 'a b/c' }), '/q/a%20b%2Fc');
    assert.equal(fillEndpoint('assignee:{me}', { me: 42 }), 'assignee:42');   // §14 — {me} from the identity probe
  });
  it('leaves an unfilled placeholder visible; tolerates junk', () => {
    assert.equal(fillEndpoint('/t/{id}', {}), '/t/{id}');
    assert.equal(fillEndpoint(null, {}), '');
    assert.equal(fillEndpoint('/x', null), '/x');
  });
});

describe('recipeLegs — catalog → session-ride connector legs', () => {
  it('every recipe projects to a connector leg (impl=session, account-namespaced key)', () => {
    const legs = recipeLegs({ account: 'acme', trusted: true });
    assert.ok(legs.length >= 1);
    for (const leg of legs) {
      assert.equal(leg.domain, 'connector');
      assert.equal(leg.tool.impl, 'session');
      assert.ok(leg.key.startsWith('acme.'));
    }
  });
  it('the Zendesk reads are present, appHost-based, identity-verified (§14)', () => {
    const legs = recipeLegs({ account: 'acme', trusted: true });
    const mine = legs.find((l) => l.key === 'acme.zendesk.my_open_tickets');
    assert.ok(mine);
    assert.equal(mine.mode, 'ask');
    assert.equal(mine.safety, 'auto');               // trusted curated read → low friction
    assert.equal(mine.tool.appHost, 'zendesk.com');
    assert.equal(mine.tool.origin, null);            // origin derived from the open tab
    assert.equal(mine.tool.verifyIdentity, true);
    assert.match(mine.tool.endpoint, /assignee:\{me\}/);
    const read = legs.find((l) => l.key === 'acme.zendesk.read_ticket');
    assert.ok(read);
    assert.equal(read.tool.endpoint, '/api/v2/tickets/{id}.json');
    assert.equal(read.tool.appHost, 'zendesk.com');
  });
  it('CONNECTOR_RECIPES is non-empty curated data', () => {
    assert.ok(Array.isArray(CONNECTOR_RECIPES) && CONNECTOR_RECIPES.length >= 1);
  });
});

describe('normalizeTicket — render subset (CS Tools 10 fields)', () => {
  it('keeps the useful fields, trims description to 500, synthesizes a ticket url, drops the rest', () => {
    const out = normalizeTicket(
      { id: 7, subject: 's', status: 'open', priority: 'high', requester_id: 1, assignee_id: 2, tags: ['a'],
        created_at: 'c', updated_at: 'u', description: 'x'.repeat(900), raw_extra: 'dropped' },
      'deako.zendesk.com');
    assert.equal(out.id, 7);
    assert.equal(out.status, 'open');
    assert.equal(out.description.length, 500);
    assert.equal(out.url, 'https://deako.zendesk.com/agent/tickets/7');
    assert.equal(out.raw_extra, undefined);
  });
});

describe('the Zendesk CRUD catalog (v2.74.1236; multi-app since CX-7 v2.74.1386 — Zendesk invariants scope to app)', () => {
  const allLegs = recipeLegs({ account: 'me', trusted: true });
  const legs = allLegs.filter((l) => l.tool.app === 'zendesk');
  const byId = (id) => legs.find((l) => l.key === `me.zendesk.${id}`);
  const reads = legs.filter((l) => l.mode === 'ask');
  const writes = legs.filter((l) => l.mode === 'act');

  it('every recipe has a unique id and projects to a valid session leg (identity at the connection)', () => {
    const ids = CONNECTOR_RECIPES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'recipe ids must be unique');
    assert.equal(allLegs.length, CONNECTOR_RECIPES.length);   // all project (none dropped as incomplete)
    for (const leg of legs) {
      assert.equal(leg.tool.impl, 'session');
      assert.equal(leg.tool.appHost, 'zendesk.com');       // identity lives at the connection
      assert.equal(leg.tool.origin, null);                 // origin derived from the open tab
      assert.equal(leg.tool.verifyIdentity, true);         // §14 — never trust status alone
    }
  });

  it('zendesk reads → ask / auto / GET / no body; every write (any app) → act / non-GET / never auto (§9)', () => {
    assert.ok(reads.length >= 7 && writes.length >= 10);
    for (const leg of reads) {
      assert.equal(leg.safety, 'auto');                    // trusted curated read → low friction
      assert.equal(leg.tool.method, 'GET');
      assert.equal(leg.tool.body, null);
    }
    for (const leg of allLegs.filter((l) => l.mode === 'act')) {   // the write floor is catalog-wide, not per-app
      assert.notEqual(leg.tool.method, 'GET');
      assert.ok(leg.safety === 'confirm' || leg.safety === 'gated', `${leg.key} never auto`);   // safety in the class, not omission
    }
  });

  it('field-edit writes → confirm + a JSON body template; destructive/consolidating → gated (§9)', () => {
    for (const id of ['create_ticket', 'add_comment', 'update_ticket_status', 'update_ticket_priority', 'reassign_group', 'assign_ticket_to_me', 'add_tags']) {
      const t = byId(id);
      assert.equal(t.safety, 'confirm', id);
      assert.ok(t.tool.body && typeof t.tool.body === 'object', `${id} carries a body template`);
    }
    for (const id of ['merge_tickets', 'mark_as_spam', 'delete_ticket']) {
      assert.equal(byId(id).safety, 'gated', id);          // destructiveHint always raises to gated, trusted or not
    }
  });

  it('the queue reads (open/pending/solved) are param-free and scope to assignee:{me} (§13)', () => {
    for (const id of ['my_open_tickets', 'my_pending_tickets', 'my_solved_tickets']) {
      const leg = byId(id);
      assert.ok(leg, id);
      assert.deepEqual(leg.params, []);                    // no LLM binder — identity fills server-side
      assert.match(leg.tool.endpoint, /assignee:\{me\}/);
    }
  });

  it('fillEndpoint binds + URL-encodes the search query', () => {
    assert.equal(
      fillEndpoint(byId('search_tickets').tool.endpoint, { query: 'login bug' }),
      '/api/v2/search.json?query=login%20bug%20type:ticket&per_page=25&sort_by=updated_at&sort_order=desc');
  });

  it('create_ticket → POST tickets.json, {subject,comment} required, body fills', () => {
    const t = byId('create_ticket');
    assert.equal(t.mode, 'act');
    assert.equal(t.tool.method, 'POST');
    assert.equal(t.tool.endpoint, '/api/v2/tickets.json');
    assert.deepEqual(t.paramSchema.required.slice().sort(), ['comment', 'subject']);
    const body = fillBody(t.tool.body, { subject: 'Printer down', comment: 'It will not print' });
    assert.equal(body.ticket.subject, 'Printer down');
    assert.equal(body.ticket.comment.body, 'It will not print');
    assert.equal('priority' in body.ticket, false);       // optional + unfilled → dropped (not literal "{priority}")
  });

  it('update_ticket_status → PUT with a status enum that EXCLUDES the irreversible closed', () => {
    const t = byId('update_ticket_status');
    assert.equal(t.tool.method, 'PUT');
    assert.ok(t.paramSchema.properties.status.enum.includes('solved'));
    assert.ok(!t.paramSchema.properties.status.enum.includes('closed'));
  });

  it('assign_ticket_to_me binds the assignee from the identity probe ({me}), not an ask param', () => {
    const t = byId('assign_ticket_to_me');
    assert.deepEqual(t.params, ['id']);                                          // only the ticket id comes from the ask
    assert.equal(fillBody(t.tool.body, { id: 7, me: 42 }).ticket.assignee_id, 42);   // {me} from the probe, native number
  });

  it('add_tags carries an array through the body (sole placeholder → native array)', () => {
    const t = byId('add_tags');
    assert.equal(t.tool.endpoint, '/api/v2/tickets/{id}/tags.json');
    assert.deepEqual(fillBody(t.tool.body, { id: 7, tags: ['billing', 'vip'] }), { tags: ['billing', 'vip'] });
  });

  it('merge_tickets → gated POST merge.json; body fills source_ids, drops the optional comments', () => {
    const t = byId('merge_tickets');
    assert.equal(t.tool.method, 'POST');
    assert.equal(t.tool.endpoint, '/api/v2/tickets/{id}/merge.json');
    assert.deepEqual(t.paramSchema.required.slice().sort(), ['id', 'source_ids']);
    assert.deepEqual(fillBody(t.tool.body, { id: 9, source_ids: [3, 4] }), { ids: [3, 4] });   // comments omitted
  });

  it('delete_ticket / mark_as_spam → gated, non-GET, NO body template (bodyless writes)', () => {
    for (const id of ['delete_ticket', 'mark_as_spam']) {
      const t = byId(id);
      assert.equal(t.safety, 'gated', id);
      assert.notEqual(t.tool.method, 'GET');
      assert.equal(t.tool.body, null, `${id} sends no body`);
    }
    assert.equal(byId('delete_ticket').tool.method, 'DELETE');
  });

  it('an UNTRUSTED projection never drops to auto — reads floor at confirm, writes stay confirm/gated (§9)', () => {
    for (const leg of recipeLegs({ account: 'me', trusted: false })) assert.notEqual(leg.safety, 'auto');
  });
});

describe('fillBody — write-body templating (pure, §6/§12)', () => {
  it('a sole placeholder takes the arg NATIVE value; a mixed string interpolates to a string', () => {
    assert.equal(fillBody('{id}', { id: 7 }), 7);                         // number, not "7"
    assert.equal(fillBody({ a: '{b}' }, { b: false }).a, false);          // boolean preserved (not dropped)
    assert.equal(fillBody('ref {id}', { id: 7 }), 'ref 7');               // mixed → string
  });
  it('an optional unfilled field drops; an object that fully empties drops from its parent', () => {
    assert.deepEqual(fillBody({ ticket: { subject: '{s}', priority: '{p}' } }, { s: 'hi' }), { ticket: { subject: 'hi' } });
    assert.equal(fillBody({ ticket: { meta: { x: '{x}' } } }, {}), null); // everything empties → null body
  });
  it('a placeholder filled with "" / null drops like an unfilled one (v1403 — the LLM binder emits "" for a param it can\'t fill; Shopify rejects phone:"" as "Phone is invalid")', () => {
    assert.deepEqual(fillBody({ c: { firstName: '{first_name}', phone: '{phone}' } }, { first_name: 'Divine', phone: '' }), { c: { firstName: 'Divine' } });   // phone:"" dropped
    assert.deepEqual(fillBody({ c: { email: '{email}', phone: '{phone}' } }, { email: 'a@b.co', phone: null }), { c: { email: 'a@b.co' } });                     // phone:null dropped
    assert.equal(fillBody({ c: { phone: '{phone}' } }, { phone: '' }), null);   // the only field empties → the object → the whole body drops
    assert.equal(fillBody({ a: '{b}' }, { b: 0 }).a, 0);                         // 0 is a REAL value — kept (only '' / null / undefined read as absent)
  });
  it('a placeholder-ECHO value ("{company}" — the LLM binder emitting a token it could not fill) drops, in fillBody AND coerceParams (v1405)', () => {
    // fillBody: the echoed token must never ride the body (else Shopify stores "{company}" LITERALLY in an address)
    assert.deepEqual(fillBody({ addr: { city: '{city}', company: '{company}' } }, { city: 'Seattle', company: '{company}' }), { addr: { city: 'Seattle' } });
    // coerceParams: scrub the echo at the param boundary → unfilled everywhere (body + endpoint)
    assert.deepEqual(coerceParams({ city: 'Seattle', company: '{company}', address2: '{address2}' }, { properties: {} }), { city: 'Seattle' });
    // a real value that merely CONTAINS braces mid-string is NOT a bare token → kept
    assert.equal(coerceParams({ note: 'call re {order}' }, { properties: {} }).note, 'call re {order}');
  });
  it('null template → null (a GET has no body); literals pass through untouched', () => {
    assert.equal(fillBody(null, {}), null);
    assert.deepEqual(fillBody({ public: false, n: 3 }, {}), { public: false, n: 3 });
  });
});

describe('recipeForOrigin — pick the strong-probe recipe for a host (AS-4 verify)', () => {
  it('matches a recipe by appHost suffix; a generic site → null', () => {
    assert.equal(recipeForOrigin('https://deako.zendesk.com').app, 'zendesk');   // subdomain of zendesk.com
    assert.equal(recipeForOrigin('zendesk.com').app, 'zendesk');                 // exact host
    assert.equal(recipeForOrigin('https://support.deako.com'), null);            // no recipe → generic verify path
    assert.equal(recipeForOrigin(''), null);
  });
});

describe('connectorLegsForConnections — connected sites → selectable interpret legs (CX-4c)', () => {
  it('matches recipes by connection host, origin-enriched to the instance; reads-only via mode; no match → []', () => {
    const legs = connectorLegsForConnections([{ origin: 'https://deako.zendesk.com', label: 'Deako' }], { mode: 'ask' });
    assert.ok(legs.length >= 7);                                              // the Zendesk reads
    assert.ok(legs.every((l) => l.mode === 'ask'));                          // reads only
    assert.ok(legs.every((l) => l.tool.origin === 'deako.zendesk.com'));     // origin-enriched to the SPECIFIC instance
    assert.ok(legs.some((l) => l.key === 'me.zendesk.my_open_tickets@deako.zendesk.com'));   // v1342 — host-suffixed keys
    assert.deepEqual(connectorLegsForConnections([{ origin: 'https://support.deako.com' }], { mode: 'ask' }), []);  // no recipe app
    assert.deepEqual(connectorLegsForConnections([]), []);
  });
  it('without a mode filter, writes are included too (gated downstream)', () => {
    assert.ok(connectorLegsForConnections([{ origin: 'https://x.zendesk.com' }]).some((l) => l.mode === 'act'));
  });
  it('v1342: two connected instances of the same app get DISTINCT host-suffixed keys', () => {
    const a = connectorLegsForConnections([{ origin: 'https://a.zendesk.com' }], { mode: 'ask' });
    const b = connectorLegsForConnections([{ origin: 'https://b.zendesk.com' }], { mode: 'ask' });
    const ka = a.find((l) => l.tool.endpoint && l.key.includes('my_open'))?.key;
    const kb = b.find((l) => l.tool.endpoint && l.key.includes('my_open'))?.key;
    assert.ok(ka && kb && ka !== kb);
    assert.ok(ka.endsWith('@a.zendesk.com'));
    assert.ok(kb.endsWith('@b.zendesk.com'));
  });
});

describe('coerceParams — clean integer ids before a connector call (CX-4c http-400 fix)', () => {
  const ps = { type: 'object', properties: { id: { type: 'integer' }, query: { type: 'string' } }, required: ['id'] };
  it('strips "#"/stray text from an integer param → a Number; leaves strings + un-parseable values', () => {
    assert.deepEqual(coerceParams({ id: '#64775' }, ps), { id: 64775 });        // the read_ticket http-400 case
    assert.deepEqual(coerceParams({ id: 64775 }, ps), { id: 64775 });           // already a number
    assert.deepEqual(coerceParams({ id: 'ticket 7' }, ps), { id: 7 });
    assert.deepEqual(coerceParams({ query: '#open status' }, ps), { query: '#open status' });   // a string param is untouched
    assert.deepEqual(coerceParams({ id: 'abc' }, ps), { id: 'abc' });           // no digits → leave it (required-gate catches)
  });
  it('v1342: coerces string booleans (public:"false" must not stay a truthy string)', () => {
    const ps = { type: 'object', properties: { public: { type: 'boolean' } }, required: [] };
    assert.deepEqual(coerceParams({ public: 'false' }, ps), { public: false });
    assert.deepEqual(coerceParams({ public: 'true' }, ps), { public: true });
    assert.deepEqual(coerceParams({ public: '0' }, ps), { public: false });
  });
});

// ── CX-7 (v2.74.1386) — the Shopify ride leg: GraphQL read POSTs + sniffed CSRF + tab-URL {handle} ─────────────
import { isReadOnlyGql } from './connectorRecipes.js';

describe('CX-7 — isReadOnlyGql (the gql read-only belt, twinned in ContentScripts SESSION_FETCH)', () => {
  it('accepts query documents, rejects mutations/subscriptions/garbage', () => {
    assert.equal(isReadOnlyGql('query($q: String!) { customers(first: 5, query: $q) { edges { node { id } } } }'), true);
    assert.equal(isReadOnlyGql('{ shop { name myshopifyDomain } }'), true);
    assert.equal(isReadOnlyGql('mutation { customerCreate(input: {}) { customer { id } } }'), false);
    assert.equal(isReadOnlyGql('query Sneaky { x } mutation Evil { y }'), false);     // mutation anywhere outside strings
    assert.equal(isReadOnlyGql('query { orders(query: "tag:mutation-club") { edges { node { id } } } }'), true);   // keyword inside a STRING is fine
    assert.equal(isReadOnlyGql('subscription { x }'), false);
    assert.equal(isReadOnlyGql(''), false);
    assert.equal(isReadOnlyGql(null), false);
  });
});

describe('CX-7 — Shopify recipes project with the transport markers', () => {
  const shopReads = () => recipeLegs().filter((l) => l && l.tool && l.tool.app === 'shopify' && l.mode === 'ask');
  it('shopify reads: gql POST + csrf sniff + urlParam {handle} thread onto the leg tool; body threads for gql reads', () => {
    const legs = shopReads();
    assert.ok(legs.length >= 5);
    const byId = new Map(legs.map((l) => [l.tool.recipeId, l]));
    const cust = byId.get('shopify_customer_by_email');
    assert.ok(cust);
    assert.equal(cust.mode, 'ask');
    assert.equal(cust.tool.method, 'POST');
    assert.equal(cust.tool.gql, true);
    assert.equal(cust.tool.csrf, 'sniff');
    assert.deepEqual(cust.tool.urlParam, { name: 'handle', pattern: '\\/store\\/([^\\/]+)' });
    assert.equal(cust.tool.endpoint, '/api/shopify/{handle}');
    assert.ok(cust.tool.body && typeof cust.tool.body.query === 'string'); // gql READ body threads (write-only gating lifted)
    assert.equal(isReadOnlyGql(cust.tool.body.query), true);               // every curated READ document passes the belt
    for (const l of legs) assert.equal(isReadOnlyGql(l.tool.body.query), true);
  });
  it('fillBody fills {param}s inside GraphQL variables, leaves the query document untouched', () => {
    const cust = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_customer_by_email');
    const b = fillBody(cust.body, { email: 'jane.doe@example.com' });
    assert.equal(b.variables.q, 'email:"jane.doe@example.com"');
    assert.equal(b.variables.n, 5);
    assert.match(b.query, /^query\(/);
  });
  it('recipeForOrigin + connections matching reach admin.shopify.com', () => {
    assert.ok(recipeForOrigin('admin.shopify.com'));
    const legs = connectorLegsForConnections([{ origin: 'admin.shopify.com' }], { mode: 'ask' });
    assert.ok(legs.some((l) => l.tool.recipeId === 'shopify_order'));
    assert.ok(!legs.some((l) => l.tool.app === 'zendesk'));                // appHost keying keeps sites separate
  });

  // ── CX-7b (v2.74.1387) — the ALLOWED Shopify WRITE: CustomerCreate as a persisted operation ──────────────────
  it('shopify_create_customer projects as an ACT leg (gated write) with the persistedOp marker; still no NOT-gql', () => {
    const leg = recipeLegs().find((l) => l && l.tool && l.tool.recipeId === 'shopify_create_customer');
    assert.ok(leg);
    assert.equal(leg.mode, 'act');                                         // it IS a write — gated, confirmed:true at both belts
    assert.notEqual(leg.safety, 'auto');
    assert.equal(leg.tool.method, 'POST');
    assert.equal(leg.tool.gql, false);                                     // persisted op, not the ad-hoc gql read endpoint
    assert.equal(leg.tool.persistedOp, 'CustomerCreate');
    assert.equal(leg.tool.csrf, 'sniff');
    assert.equal(leg.tool.endpoint, '/api/operations/{op_sha}/CustomerCreate/shopify/{handle}');
    // banned money/inventory classes never became recipes
    assert.ok(!CONNECTOR_RECIPES.some((r) => /refund|return|draftorder|complete_order/i.test(r.id)));
  });
  it('create-customer body: email OR phone (unfilled optional drops); {op_sha}/{handle} fill the endpoint path', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_create_customer');
    const b = fillBody(rec.body, { first_name: 'Jane', last_name: 'Doe', email: 'jane.doe@example.com' });
    assert.equal(b.variables.customerInput.firstName, 'Jane');
    assert.equal(b.variables.customerInput.email, 'jane.doe@example.com');
    assert.ok(!('phone' in b.variables.customerInput));                    // unfilled optional dropped (Shopify accepts email-only)
    assert.ok(!('note' in b.variables.customerInput));
    const path = fillEndpoint(rec.endpoint, { op_sha: 'a1b2c3d4e5f60718', handle: 'deako' });
    assert.equal(path, '/api/operations/a1b2c3d4e5f60718/CustomerCreate/shopify/deako');
  });

  // ── CX-7c (v2.74.1388) — EditCustomer + DraftOrderCreate writes, gid coercion, order-read returns, liveness ──
  it('toShopifyGid: bare id → gid, # stripped, full gid passthrough', () => {
    assert.equal(toShopifyGid('12345', 'Customer'), 'gid://shopify/Customer/12345');
    assert.equal(toShopifyGid('#12345', 'Customer'), 'gid://shopify/Customer/12345');
    assert.equal(toShopifyGid('gid://shopify/Customer/12345', 'Customer'), 'gid://shopify/Customer/12345');
    assert.equal(toShopifyGid(12345, 'ProductVariant'), 'gid://shopify/ProductVariant/12345');
  });
  it('coerceParams gid-coerces a param carrying a gid Kind (customer_gid on the update leg)', () => {
    const leg = recipeLegs().find((l) => l && l.tool && l.tool.recipeId === 'shopify_update_customer');
    const out = coerceParams({ customer_gid: '9987', email: 'x@example.com' }, leg.paramSchema);
    assert.equal(out.customer_gid, 'gid://shopify/Customer/9987');
    assert.equal(out.email, 'x@example.com');                             // non-gid param untouched
  });
  it('shopify_update_customer: ACT leg, persistedOp EditCustomer, partial body (only set fields ride)', () => {
    const leg = recipeLegs().find((l) => l && l.tool && l.tool.recipeId === 'shopify_update_customer');
    assert.ok(leg);
    assert.equal(leg.mode, 'act');
    assert.equal(leg.tool.persistedOp, 'EditCustomer');
    assert.equal(leg.tool.shopProbe, true);
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_update_customer');
    const b = fillBody(rec.body, { customer_gid: 'gid://shopify/Customer/9987', phone: '+15551234567' });
    assert.equal(b.variables.input.id, 'gid://shopify/Customer/9987');
    assert.equal(b.variables.input.phone, '+15551234567');
    assert.ok(!('email' in b.variables.input));                          // unset field dropped — partial update
    assert.ok(!('firstName' in b.variables.input));
  });
  it('shopify_create_order: ACT leg (draft, reversible); FOC nested params ride whole or drop cleanly', () => {
    const leg = recipeLegs().find((l) => l && l.tool && l.tool.recipeId === 'shopify_create_order');
    assert.ok(leg);
    assert.equal(leg.mode, 'act');
    assert.equal(leg.tool.persistedOp, 'DraftOrderCreate');
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_create_order');
    // FOC warranty replacement: 100% discount + free shipping ride as whole objects
    const foc = fillBody(rec.body, {
      customer_gid: 'gid://shopify/Customer/9987',
      line_items: [{ variantId: 'gid://shopify/ProductVariant/55', quantity: 1 }],
      applied_discount: { value: 100, valueType: 'PERCENTAGE', title: 'Warranty replacement' },
      shipping_line: { title: 'Free shipping', price: '0.00' },
    });
    assert.equal(foc.variables.input.purchasingEntity.customerId, 'gid://shopify/Customer/9987');
    assert.deepEqual(foc.variables.input.lineItems, [{ variantId: 'gid://shopify/ProductVariant/55', quantity: 1 }]);
    assert.equal(foc.variables.input.appliedDiscount.value, 100);
    assert.equal(foc.variables.input.shippingLine.price, '0.00');
    assert.equal(foc.variables.hasDiscountsPermission, true);            // permission literals always ride
    assert.equal(foc.variables.firstLineItems, 50);
    // an ordinary paid draft: no discount/shipping objects → they DROP entirely (no half-formed structs)
    const paid = fillBody(rec.body, { customer_gid: 'gid://shopify/Customer/9987', line_items: [{ variantId: 'gid://shopify/ProductVariant/55', quantity: 2 }] });
    assert.ok(!('appliedDiscount' in paid.variables.input));
    assert.ok(!('shippingLine' in paid.variables.input));
    assert.equal(paid.variables.input.useCustomerDefaultAddress, true);
  });
  it('the order read carries returns + the refund amount (spec §3 CS fields)', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_order');
    assert.match(rec.body.query, /returns\(first:/);
    assert.match(rec.body.query, /totalRefundedSet/);
    assert.match(rec.body.query, /carrierName/);                          // reverse-delivery tracking
    assert.equal(isReadOnlyGql(rec.body.query), true);                    // still a read — heavier, still passes the belt
  });
  it('every Shopify leg carries the shopProbe liveness marker', () => {
    for (const l of recipeLegs().filter((l) => l.tool && l.tool.app === 'shopify')) assert.equal(l.tool.shopProbe, true);
  });
  it('CX-7e: customer/order reads carry an itemUrl (the admin profile/order page) with {handle}+{id}', () => {
    const byId = new Map(recipeLegs().map((l) => [l.tool.recipeId, l]));
    assert.equal(byId.get('shopify_customer_by_email').tool.itemUrl, '/store/{handle}/customers/{id}');
    assert.equal(byId.get('shopify_customer_by_phone').tool.itemUrl, '/store/{handle}/customers/{id}');
    assert.equal(byId.get('shopify_order').tool.itemUrl, '/store/{handle}/orders/{id}');
    // filled with the tab handle + the returned record id → the real admin page
    assert.equal(fillEndpoint('/store/{handle}/customers/{id}', { handle: 'deako', id: '12345' }), '/store/deako/customers/12345');
  });

  // ── CX-10 (v2.74.1456) — Aircall Workspace curated legs from HAR captures ─────────────────────────────────────
  it('recipeForOrigin + connections matching reach workspace.aircall.io', () => {
    const hit = recipeForOrigin('workspace.aircall.io');
    assert.ok(hit);
    assert.equal(hit.app, 'aircall');
    const legs = connectorLegsForConnections([{ origin: 'https://workspace.aircall.io', label: 'Aircall' }], { mode: 'ask' });
    assert.ok(legs.some((l) => l.tool.recipeId === 'aw_team_availability'));
    assert.ok(legs.some((l) => l.tool.recipeId === 'aw_conversation_by_number'));
    assert.ok(!legs.some((l) => l.tool.app === 'zendesk'));
  });
  it('Aircall REST legs carry requestHeaders + verifyIdentity; GraphQL legs carry gql + static query docs', () => {
    const byId = new Map(recipeLegs().filter((l) => l.tool && l.tool.app === 'aircall').map((l) => [l.tool.recipeId, l]));
    const team = byId.get('aw_team_availability');
    assert.deepEqual(team.tool.requestHeaders, { 'aircall-platform': 'aircall-workspace' });
    assert.equal(team.tool.verifyIdentity, true);
    assert.equal(team.tool.identityProbe, '/v5/users/current_user?activation_state=active');
    const gql = byId.get('aw_contact_by_phone');
    assert.equal(gql.tool.gql, true);
    assert.equal(gql.tool.method, 'POST');
    assert.match(gql.tool.endpoint, /^\/graphql\?name=ContactByPhoneNumber_Query$/);
    assert.ok(gql.tool.body && typeof gql.tool.body.query === 'string');
    assert.equal(gql.tool.body.operationName, 'ContactByPhoneNumber_Query');
  });
  it('acGqlBody / acGqlEndpoint build HAR-static GraphQL ride shapes; fillBody fills variables', () => {
    assert.equal(acGqlEndpoint('lookupTeammates'), '/graphql?name=lookupTeammates');
    const raw = acGqlBody('ContactByPhoneNumber_Query', { input: { phoneNumber: '{phone}' } });
    assert.equal(raw.operationName, 'ContactByPhoneNumber_Query');
    const filled = fillBody(raw, { phone: '+15551234567' });
    assert.equal(filled.variables.input.phoneNumber, '+15551234567');
    assert.match(filled.query, /^query ContactByPhoneNumber_Query/);
  });
  it('Aircall writes project as ACT legs (gated); reads stay ask', () => {
    const byId = new Map(recipeLegs().filter((l) => l.tool && l.tool.app === 'aircall').map((l) => [l.tool.recipeId, l]));
    assert.equal(byId.get('aw_close_conversation').mode, 'act');
    assert.equal(byId.get('aw_set_availability').mode, 'act');
    assert.equal(byId.get('aw_team_availability').mode, 'ask');
  });

  // v2.74.1459 (review) — invariant locks: catch a doc-less op, a read that would be blocked as a write, or a write
  // that would run unconfirmed — the exact classes the manual review verified.
  it('every Aircall GraphQL leg resolves its op to a real document (no dangling acGqlBody)', () => {
    for (const l of recipeLegs().filter((l) => l.tool && l.tool.app === 'aircall' && l.tool.gql === true)) {
      assert.ok(l.tool.body && typeof l.tool.body.query === 'string' && l.tool.body.query.length > 0,
        `aircall gql leg ${l.tool.recipeId} has no resolved query document (missing AC_GQL entry?)`);
    }
  });
  it('every Aircall READ gql leg passes isReadOnlyGql (runs unconfirmed); every WRITE gql leg does NOT (gates)', () => {
    for (const l of recipeLegs().filter((l) => l.tool && l.tool.app === 'aircall' && l.tool.gql === true)) {
      const ro = isReadOnlyGql(l.tool.body.query);
      if (l.mode === 'ask') assert.equal(ro, true, `${l.tool.recipeId}: a READ document must be read-only or it is blocked as a write`);
      else assert.equal(ro, false, `${l.tool.recipeId}: a WRITE document must NOT classify read-only (would run unconfirmed!)`);
    }
  });
  it('aw_send_sms rides the DESTRUCTIVE (two-step) tier — outward-facing message; ordinary writes stay single-confirm', () => {
    const byId = new Map(recipeLegs().filter((l) => l.tool && l.tool.app === 'aircall').map((l) => [l.tool.recipeId, l]));
    assert.equal(byId.get('aw_send_sms').safety, 'gated');            // outward SMS → two-step confirm
    assert.equal(byId.get('aw_close_conversation').safety, 'confirm'); // internal wrap-up → single confirm
    assert.equal(byId.get('aw_set_availability').safety, 'confirm');   // self-only preference → single confirm
  });
});

describe('v2.74.1468 — harvestedRecipeLegs: a gql READ record is a READ even unannotated (the live "Sent" bug)', () => {
  const GQL_REC = (over) => ({ id: 'gr1', name: 'Teammate roster', does: 'list teammates', method: 'POST', gql: true,
    contentType: 'application/json', endpoint: '/graphql?name=lookupTeammates',
    body: { operationName: 'lookupTeammates', variables: {}, query: 'query lookupTeammates { agents { ID } }' },
    origin: 'workspace.aircall.io', params: [], provenance: 'curated', safetyClass: 'gated',
    enabled: true, reviewState: 'accepted', trust: 1, ...over });
  it('read-only document + no write flag → mode ask, safety auto (never the confirm gate)', () => {
    const legs = harvestedRecipeLegs([GQL_REC({})], { host: 'workspace.aircall.io', mode: 'ask' });
    assert.equal(legs.length, 1);
    assert.equal(legs[0].mode, 'ask');
    assert.equal(legs[0].safety, 'auto');           // trusted curated READ — the write class was the live bug
  });
  it('a mutation document (still no write flag) stays a WRITE — §9 fail-safe holds', () => {
    const legs = harvestedRecipeLegs([GQL_REC({ id: 'gm1', body: { query: 'mutation { updateAgent { ID } }' } })], { host: 'workspace.aircall.io', mode: 'ask' });
    assert.equal(legs[0].mode, 'act');
    assert.notEqual(legs[0].safety, 'auto');
  });
  it('explicit write:true always wins, even with a read-shaped document', () => {
    const legs = harvestedRecipeLegs([GQL_REC({ id: 'gw1', write: true })], { host: 'workspace.aircall.io', mode: 'ask' });
    assert.equal(legs[0].mode, 'act');
    assert.notEqual(legs[0].safety, 'auto');
  });
});

describe('v2.74.1477 — aircall-platform rides EVERY aircall call (v1475 reverted: the SPA sends it on /graphql too)', () => {
  const AC_ENTRIES = CONNECTOR_RECIPES.filter((e) => e && e.appHost === 'workspace.aircall.io');
  it('every aircall entry (gql + REST) carries the routing header', () => {
    for (const e of AC_ENTRIES) {
      assert.ok(e.requestHeaders && e.requestHeaders['aircall-platform'] === 'aircall-workspace', `${e.id} must carry aircall-platform (the SPA sends it on gql + REST)`);
    }
  });
});

describe('v2.74.1479 — aw_set_availability resolves {me} from the GraphQL agent read (the {me}≠agent-id fix)', () => {
  const sa = CONNECTOR_RECIPES.find((e) => e && e.id === 'aw_set_availability');
  it('carries identityGql pointing at getAgentV2.ID (the id UpdateAgent_Mutation wants), via the gql transport', () => {
    assert.ok(sa && sa.identityGql, 'aw_set_availability must carry identityGql');
    assert.equal(sa.identityGql.idPath, 'data.getAgentV2.ID');
    assert.ok(/\/graphql\?name=GetCurrentAgentV2_Query/.test(sa.identityGql.endpoint));
    assert.ok(sa.identityGql.body && /getAgentV2/.test(sa.identityGql.body.query), 'the identity doc reads getAgentV2');
    assert.ok(/\{me\}/.test(JSON.stringify(sa.body)), 'the mutation body still templates {me} for the executor to fill');
  });
  it('recipeToLeg threads identityGql onto leg.tool (Invariant #3 hop)', () => {
    const leg = recipeToLeg({ ...sa, app: 'aircall', origin: 'workspace.aircall.io' }, { trusted: true });
    assert.ok(leg && leg.tool && leg.tool.identityGql && leg.tool.identityGql.idPath === 'data.getAgentV2.ID');
  });
});
