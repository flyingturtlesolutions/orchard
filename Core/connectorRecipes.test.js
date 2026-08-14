// Core/connectorRecipes.test.js — CX-3 curated recipe catalog + templating (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTOR_RECIPES, drillTargetRedirect, fillEndpoint, fillBody, encodeBodyForContentType, stripUnfilledJsonBody, recipeLegs, normalizeTicket, recipeForOrigin, connectorLegsForConnections, coerceParams, harvestedRecipeLegs, canonicalAppForHost, toShopifyGid, acGqlBody, acGqlEndpoint, persistedOpsForHost, opCaptureHint, askNamesOtherSystem, signInLandingPath, csrfSniffHosts} from './connectorRecipes.js';
import { recipeToLeg } from './connectorLeg.js';   // v1479 — identityGql threading assertion
import { gateActionForLeg } from './pipelineGate.js';   // v2.74.2069 — the destructive delete must REFUSE unattended

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

  it('v1749 — ONE app spelling per host: the canonical catalog name wins over the registrable label', () => {
    // the gl 104907 finding: the same endpoint projected as me.vendorsuite.* (catalog-direct) AND me.drhorton.*
    // (this projection deriving from the registrable label). Now: record.app wins; else the CATALOG names the host.
    assert.equal(canonicalAppForHost('vendorsuite.drhorton.com'), 'vendorsuite', 'exact catalog appHost');
    assert.equal(canonicalAppForHost('deako.zendesk.com'), 'zendesk', 'suffix match on appHost zendesk.com');
    assert.equal(canonicalAppForHost('some.unknown-site.com'), 'unknown-site', 'unknown host → registrable-label fallback');
    const vs = harvestedRecipeLegs([REC({ id: 'vs1', origin: 'vendorsuite.drhorton.com' })], { host: 'vendorsuite.drhorton.com' });
    assert.equal(vs[0].key, 'me.vendorsuite.vs1@vendorsuite.drhorton.com', 'harvested projection now matches the catalog spelling');
    const own = harvestedRecipeLegs([REC({ id: 'vs2', app: 'customapp', origin: 'vendorsuite.drhorton.com' })], { host: 'vendorsuite.drhorton.com' });
    assert.equal(own[0].key, 'me.customapp.vs2@vendorsuite.drhorton.com', "a record's OWN app always wins");
    const perRec = harvestedRecipeLegs([REC({ id: 'vs3', origin: 'vendorsuite.drhorton.com' })], { host: '' });
    assert.equal(perRec[0].key, 'me.vendorsuite.vs3@vendorsuite.drhorton.com', 'app derives PER RECORD from its own origin (the v1730 no-host lookup built me.site.*)');
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

describe('csrfSniffHosts — sniff-class appHosts for background pre-warm (v2.74.1760)', () => {
  it('lists each csrf:sniff appHost once; Shopify is the curated case', () => {
    const hosts = csrfSniffHosts();
    assert.ok(hosts.includes('admin.shopify.com'));
    assert.equal(hosts.length, new Set(hosts).size);
    assert.deepEqual(csrfSniffHosts([{ csrf: 'sniff', appHost: 'a.com' }, { csrf: 'sniff', appHost: 'a.com' }, { appHost: 'b.com' }]), ['a.com']);
    assert.deepEqual(csrfSniffHosts([]), []);
  });
});

describe('signInLandingPath — the bare root triggers login on most sites; Zendesk is the declared exception (v1704)', () => {
  it('DEFAULT is "/" — for most sites the bare origin is what redirects to login', () => {
    // THE VendorSuite BUG: its itemUrl is a HASH route (/#dashboard); v1701's derivation made a bogus /dashboard,
    // and even /#dashboard is not the trigger — visiting / is what redirects to the drhorton SSO.
    assert.equal(signInLandingPath('vendorsuite.drhorton.com'), '/');
    assert.equal(signInLandingPath('https://vendorsuite.drhorton.com'), '/');
    assert.equal(signInLandingPath('admin.shopify.com'), '/');
    assert.equal(signInLandingPath('support.deako.com'), '/');   // no recipe
    assert.equal(signInLandingPath(''), '/');
    assert.equal(signInLandingPath('example.com'), '/');
  });
  it('Zendesk is the ONE exception — root → help centre, so console:/agent is DECLARED on the recipe', () => {
    assert.equal(signInLandingPath('deako.zendesk.com'), '/agent');
    assert.equal(signInLandingPath('https://deako.zendesk.com'), '/agent');
    assert.equal(signInLandingPath('zendesk.com'), '/agent');
  });
  it('an explicit `console` wins; itemUrl is NOT a sign-in trigger and is no longer derived', () => {
    assert.equal(signInLandingPath('x', [{ appHost: 'x', console: '/login' }]), '/login');
    assert.equal(signInLandingPath('x', [{ appHost: 'x', itemUrl: '/dashboard/{id}' }]), '/', 'a human work page is not a sign-in entry');
    assert.equal(signInLandingPath('x', [{ appHost: 'x', itemUrl: '/#dashboard' }]), '/', 'a hash route is never mangled into a path');
    assert.equal(signInLandingPath('x', [{ appHost: 'x' }]), '/');
  });
  it('degenerate input does not throw', () => {
    for (const bad of [null, undefined, 7, {}]) assert.doesNotThrow(() => signInLandingPath(bad));
    assert.equal(signInLandingPath('x', null), '/');
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
    // RH-0a (v2.74.1564) — the HAR-verified contract: the BFF routes on ?operation&type + body operationName
    // (anonymous docs → the live http-404-empty), and two static headers ride every call. Asserted on the
    // LEG-PROJECTION path (the seeded-Ground seam, invariant #3).
    assert.equal(cust.tool.endpoint, '/api/shopify/{handle}?operation=Customers&type=query');
    assert.equal(cust.tool.body.operationName, 'Customers');
    assert.ok(/^query Customers\(/.test(cust.tool.body.query), 'the document is NAMED to match ?operation=');
    assert.deepEqual(cust.tool.requestHeaders, { 'apollographql-client-name': 'core', 'shopify-proxy-api-enable': 'true' });
    assert.ok(cust.tool.body && typeof cust.tool.body.query === 'string'); // gql READ body threads (write-only gating lifted)
    assert.equal(isReadOnlyGql(cust.tool.body.query), true);               // every curated READ document passes the belt
    for (const l of legs) {
      // v2.74.1905 — a persisted-op GET read (shopify_admin_search: the admin bar's own Search operation) carries
      // no gql body BY DESIGN — its document lives server-side behind the sha. The gql contract applies to the
      // free-form reads; the persisted read's contract is the op bank's (sha in path, variables in the QS).
      if (l.tool.persistedOp && (l.tool.method || 'GET').toUpperCase() === 'GET') {
        assert.match(String(l.tool.endpoint), /\/api\/operations\/\{op_sha\}\//, `${l.tool.recipeId} rides the op-sha path`);
        assert.equal(l.tool.gql, false, `${l.tool.recipeId} is not a gql leg`);
        continue;
      }
      assert.equal(isReadOnlyGql(l.tool.body.query), true);
      // every free-form read carries the full contract; the ?operation= name matches its body operationName
      const m = String(l.tool.endpoint).match(/\?operation=(\w+)&type=query$/);
      assert.ok(m, `${l.tool.recipeId} endpoint carries ?operation&type`);
      assert.equal(l.tool.body.operationName, m[1], `${l.tool.recipeId} operationName matches the route param`);
    }
  });
  it('SH-Q1 (v2.74.1558) — the orders QUEUE leg is list-shaped with the full fan-out contract (listUrl + drill join), on the LEG-projection path', () => {
    // The invariant-#3 seam: a marker that only the catalog-direct path carries is invisible to a seeded Ground —
    // assert on recipeLegs() (entry → leg), not on the raw entry.
    const q = shopReads().find((l) => l.tool.recipeId === 'shopify_orders_queue');
    assert.ok(q, 'the queue leg projects');
    assert.equal(q.tool.listUrl, '/store/{handle}/orders');
    assert.deepEqual(q.tool.drill, { via: 'shopify_order', param: 'order', from: 'name', matchOn: 'order', label: ['name', 'id', 'displayFulfillmentStatus', 'displayFinancialStatus'] });
    assert.ok(/status:open fulfillment_status:unfulfilled/.test(JSON.stringify(q.tool.body)), 'the queue query is FIXED — the backlog, not a param switch');
    assert.equal(isReadOnlyGql(q.tool.body.query), true);
    const via = shopReads().find((l) => l.tool.recipeId === 'shopify_order');
    assert.ok(via && via.tool.itemUrl, 'the drill target carries the record itemUrl (the case/show venue)');
    assert.ok((via.tool.params || via.params || []).length, 'the drill via-param exists on the detail leg');
  });
  it('fillBody fills {param}s inside GraphQL variables, leaves the query document untouched', () => {
    const cust = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_customer_by_email');
    const b = fillBody(cust.body, { email: 'jane.doe@example.com' });
    assert.equal(b.variables.q, 'email:"jane.doe@example.com"');
    assert.equal(b.variables.n, 5);
    assert.match(b.query, /^query Customers\(/);   // RH-0a — named document (the route param's twin)
    assert.equal(b.operationName, 'Customers', 'operationName survives the fill untouched');
  });
  it('recipeForOrigin + connections matching reach admin.shopify.com', () => {
    assert.ok(recipeForOrigin('admin.shopify.com'));
    const legs = connectorLegsForConnections([{ origin: 'admin.shopify.com' }], { mode: 'ask' });
    assert.ok(legs.some((l) => l.tool.recipeId === 'shopify_order'));
    assert.ok(!legs.some((l) => l.tool.app === 'zendesk'));                // appHost keying keeps sites separate
  });

  // ── CX-7b (v2.74.1387) — the ALLOWED Shopify WRITE: CustomerCreate. v2.74.2224 — document-in-body (the v2223
  // create's live-proven pattern): no persisted hash, nothing for an admin deploy to rotate. ──────────────────
  it('shopify_create_customer projects as an ACT leg (gated write) as a DOCUMENT mutation on the write path', () => {
    const leg = recipeLegs().find((l) => l && l.tool && l.tool.recipeId === 'shopify_create_customer');
    assert.ok(leg);
    assert.equal(leg.mode, 'act');                                         // it IS a write — gated, confirmed:true at both belts
    assert.notEqual(leg.safety, 'auto');
    assert.equal(leg.tool.method, 'POST');
    assert.equal(leg.tool.gql, true);                                      // document-in-body — inherited from SH (v2224)
    assert.ok(leg.tool.persistedOp == null, 'no hash demand — nothing to rotate');
    assert.equal(leg.tool.csrf, 'sniff');
    assert.match(String(leg.tool.endpoint), /\?operation=CustomerCreate&type=mutation$/);
    assert.match(String(leg.tool.body.query), /^mutation CustomerCreate\(\$customerInput/);
    assert.equal(isReadOnlyGql(leg.tool.body.query), false, 'a mutation document stays on the WRITE path');
    // banned money/inventory classes never became recipes
    assert.ok(!CONNECTOR_RECIPES.some((r) => /refund|return|draftorder|complete_order/i.test(r.id)));
  });
  it('create-customer body: email OR phone (unfilled optional drops); {handle} fills the endpoint path', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_create_customer');
    const b = fillBody(rec.body, { first_name: 'Jane', last_name: 'Doe', email: 'jane.doe@example.com' });
    assert.equal(b.variables.customerInput.firstName, 'Jane');
    assert.equal(b.variables.customerInput.email, 'jane.doe@example.com');
    assert.ok(!('phone' in b.variables.customerInput));                    // unfilled optional dropped (Shopify accepts email-only)
    assert.ok(!('note' in b.variables.customerInput));
    const path = fillEndpoint(rec.endpoint, { handle: 'deako' });
    assert.equal(path, '/api/shopify/deako?operation=CustomerCreate&type=mutation');
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
  it('shopify_update_customer: ACT leg, DOCUMENT mutation (v2224), partial body (only set fields ride)', () => {
    const leg = recipeLegs().find((l) => l && l.tool && l.tool.recipeId === 'shopify_update_customer');
    assert.ok(leg);
    assert.equal(leg.mode, 'act');
    assert.ok(leg.tool.persistedOp == null, 'no hash demand — nothing to rotate');
    assert.match(String(leg.tool.endpoint), /\?operation=EditCustomer&type=mutation$/);
    assert.equal(isReadOnlyGql(leg.tool.body.query), false, 'stays on the write path');
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
    // v2.74.2223 — DOCUMENT-IN-BODY, no longer a persisted op: the hash was a vendor-versioned artifact that
    // rotated on an admin deploy (op-hash-stale, live 2026-08-14) and disarmed a verified leg. Our own document
    // has nothing to rotate. The mutation document must FAIL isReadOnlyGql — that is what keeps it on the
    // confirm-gated write path (connector.js:1630) rather than the read fast-path.
    assert.ok(leg.tool.persistedOp == null, 'no hash demand — nothing for a vendor deploy to rotate');   // recipeToLeg normalizes absent → null
    assert.equal(leg.tool.gql, true);
    assert.match(String(leg.tool.endpoint), /\?operation=DraftOrderCreate&type=mutation$/);
    assert.match(String(leg.tool.body.query), /^mutation DraftOrderCreate/);
    assert.equal(isReadOnlyGql(leg.tool.body.query), false, 'a mutation document stays on the WRITE path');
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
    // v2.74.2223 — the pinned document's private variables envelope is GONE: our document declares only $input
    assert.ok(!('hasDiscountsPermission' in foc.variables));
    assert.ok(!('firstLineItems' in foc.variables));
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

describe('DK-2 (DESIGN_desks.md §5) — presence capability class threads catalog → leg (Invariant #3)', () => {
  const legs = recipeLegs({ account: 'me', trusted: true });
  it('EXACTLY the five operator-presence Aircall legs carry tool.capClass="presence" — nothing else in the catalog', () => {
    const presenceIds = legs.filter((l) => l && l.tool && l.tool.capClass === 'presence').map((l) => l.tool.recipeId).sort();
    assert.deepEqual(presenceIds, ['aw_my_agent', 'aw_my_availability', 'aw_set_availability', 'aw_team_availability', 'aw_teammate_roster']);
  });
  it('conversation-queue reads are NOT presence — they ARE the backlog', () => {
    for (const rid of ['aw_missed_calls', 'aw_open_conversations']) {
      const leg = legs.find((l) => l && l.tool && l.tool.recipeId === rid);
      assert.ok(leg, `${rid} projects a leg`);
      assert.equal(leg.tool.capClass, null);
    }
  });
  it('recipeToLeg threads capClass onto leg.tool; absent → null (hop 3)', () => {
    assert.equal(recipeToLeg({ id: 'x', name: 'X', endpoint: '/x', app: 'aircall', origin: 'workspace.aircall.io', capClass: 'presence' }, { trusted: true }).tool.capClass, 'presence');
    assert.equal(recipeToLeg({ id: 'y', name: 'Y', endpoint: '/y', app: 'aircall', origin: 'workspace.aircall.io' }, { trusted: true }).tool.capClass, null);
  });
});

describe('DK-7 (v2.74.1488) — the each-mode marker rides the resolve spec through to the leg (zero new hops)', () => {
  it('vs_warranty_tasks: leg.tool.resolve.divisionId carries each:true (the resolve object threads WHOLE)', () => {
    const leg = recipeLegs({ account: 'me', trusted: true }).find((l) => l && l.tool && l.tool.recipeId === 'vs_warranty_tasks');
    assert.ok(leg, 'vs_warranty_tasks projects a leg');
    assert.equal(leg.tool.resolve.divisionId.each, true);
    assert.ok(/"each"/.test(leg.does), 'the does-text teaches the model the sentinel');
  });
  it('v2.74.1559 — drill.also (dossier sidecar reads) survives the LEG-projection path; the contacts leg projects with the id discipline', () => {
    const legs = recipeLegs({ account: 'me', trusted: true });
    const q = legs.find((l) => l && l.tool && l.tool.recipeId === 'vs_warranty_tasks');
    // v2.74.1928 — the projected shape is now NORMALIZED to objects (an entry may re-key itself with
    // from/param/pick/extract; a bare-string catalog entry becomes `{id}`). The invariant-#3 point is unchanged
    // and stronger: hop 3 rebuilds drill field-by-field, and it must carry the WHOLE entry, not just its id.
    assert.deepEqual(q.tool.drill.also, [{ id: 'vs_task_contacts' }], 'hop 3 rebuilds drill field-by-field — a dropped `also` would be invisible on the seeded path (invariant #3)');
    const c = legs.find((l) => l && l.tool && l.tool.recipeId === 'vs_task_contacts');
    assert.ok(c, 'vs_task_contacts projects a leg');
    assert.equal(c.tool.endpoint, '/api/Vendor/Warranty/TaskContacts/{taskId}');
    const entry = CONNECTOR_RECIPES.find((r) => r.id === 'vs_task_contacts');
    const p = (entry.params || []).find((x) => x && x.name === 'taskId');
    assert.ok(p && p.required && /INTERNAL/i.test(p.hint || ''), 'the hint carries the internal-id discipline (live 195557: a ticket NUMBER fed as the id → http-500)');
  });
});

describe('connectorRecipes — LEG-1 (v2.74.1593): the Shopify store-pulse canary leg', () => {
  it('shopify_shop_pulse: params-free, pulse-marked, a NAMED read-only document on the RH-0a contract', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_shop_pulse');
    assert.ok(rec, 'the pulse leg exists');
    assert.deepEqual(rec.params, [], 'zero params — canary-eligible by construction');
    assert.equal(rec.pulse && rec.pulse.kind, 'liveness');
    assert.equal(rec.gql, true);
    assert.notEqual(rec.write, true);
    assert.match(rec.endpoint, /operation=Shop&type=query/, 'routes on the named-op contract (anonymous docs 404)');
    assert.equal(rec.body.operationName, 'Shop');
    assert.match(rec.body.query, /^query Shop\b/, 'the document is NAMED (the RH-0a lesson)');
    assert.equal(isReadOnlyGql(rec.body.query), true, 'the read-only belts accept it');
    assert.equal(rec.urlParam && rec.urlParam.name, 'handle', 'the only placeholder is the tab/banked handle');
  });
});

describe('connectorRecipes — LEG-2a (v2.74.1594): the SH-T4 checklist surface (wanted persisted-ops + coaching)', () => {
  it('persistedOpsForHost lists the catalog’s op-hash writes for the Shopify admin; other hosts get none', () => {
    const wanted = persistedOpsForHost('admin.shopify.com');
    const ops = wanted.map((w) => w.op).sort();
    // v2.74.1905 — Search joins: the first READ persisted op (the admin bar itself, HAR-authored). The checklist
    // is precisely where its one-time by-hand capture is coached, so listing it is the point, not an accident.
    // v2.74.1921 — Timeline joins: the second READ persisted op (the order page's lazy-loaded timeline fetch).
    // v2.74.1926 — order_creator rides the SAME op (one sha, one bank entry, one capture hint) — so the wanted
    // list must not gain a duplicate: the checklist asks a human to capture each OP once, not each leg.
    // v2.74.2069 — DeleteDraftOrder (the draft delete write) + DraftOrderList (its lookup viaLeg read) join.
    // v2.74.2223 — DraftOrderCreate LEAVES: the create is a document-in-body mutation (nothing to bank).
    // v2.74.2224 — ALL remaining writes leave (CustomerCreate / EditCustomer / DeleteDraftOrder converted on the
    // create's live PASS): the checklist now holds only the persisted READS (GET-with-encoded-variables — a
    // different transport shape, owed its own conversion look).
    assert.deepEqual([...new Set(ops)], ['DraftOrderList', 'OrderListData', 'Search', 'Timeline'], 'persisted READS only — every write is a document mutation now');
    assert.equal(ops.filter((o) => o === 'Timeline').length, 1, 'two legs, ONE Timeline capture demand');
    for (const w of wanted) { assert.ok(w.recipeId && w.recipeName, 'each carries its recipe identity for the checklist line'); }
    assert.deepEqual(persistedOpsForHost('deako.zendesk.com'), [], 'Zendesk writes are REST — no op-hash demands');
    assert.deepEqual(persistedOpsForHost(''), []);
  });
  it('opCaptureHint coaches each known op with a REVERSIBLE by-hand action; unknown ops get the safe default', () => {
    assert.match(opCaptureHint('CustomerCreate'), /Add customer/i);
    assert.match(opCaptureHint('CustomerCreate'), /delete it right after/i, 'the test action is reversible on purpose');
    assert.match(opCaptureHint('EditCustomer'), /tag/i);
    assert.match(opCaptureHint('DraftOrderCreate'), /draft order/i);
    assert.match(opCaptureHint('SomeFutureOp'), /once by hand/i);
  });
});

describe('connectorRecipes — HubSpot legs (HS-1, v2.74.1595: HAR-authored same-origin cookie-ride GET reads)', () => {
  const hs = () => CONNECTOR_RECIPES.filter((r) => r && r.app === 'hubspot');
  it('three GET reads on app.hubspot.com, all read-only, no write recipes', () => {
    const legs = hs();
    assert.deepEqual(legs.map((r) => r.id).sort(), ['hubspot_contact', 'hubspot_me', 'hubspot_teams']);
    for (const r of legs) {
      assert.equal(r.appHost, 'app.hubspot.com');
      assert.equal(r.method, 'GET', `${r.id} is a GET (no write-gate carve-out needed)`);
      assert.notEqual(r.write, true, `${r.id} is not a write`);
      assert.equal(r.probeAccept, 'json', 'JSON-liveness presence (the VendorSuite pattern) — no verifyIdentity misfire');
      assert.notEqual(r.verifyIdentity, true);
    }
  });
  it('{portalId} is the tab-URL urlParam (query position); {id} is the user param — both fill on the contact read', () => {
    const c = hs().find((r) => r.id === 'hubspot_contact');
    assert.equal(c.urlParam.name, 'portalId');
    // the tab-URL pattern captures the portal id from the app path (app.hubspot.com/<section>/<portalId>/…)
    const m = 'https://app.hubspot.com/contacts/1234567/record/0-1/998877'.match(new RegExp(c.urlParam.pattern));
    assert.equal(m && m[1], '1234567', 'portalId extracts from the ride tab, not the record id later in the path');
    // {id} is a required user param, {portalId} is NOT in the param list (tab-filled)
    assert.deepEqual(c.params.map((p) => p.name), ['id']);
    // fillEndpoint threads BOTH placeholders (portalId from tab-args, id from the user arg)
    assert.equal(fillEndpoint(c.endpoint, { portalId: '1234567', id: '998877' }),
      '/api/inbounddb-objects/v1/crm-objects/0-1/998877?portalId=1234567&allPropertiesFetchMode=latest_version');
  });
  it('hubspot_me is the params-free liveness CANARY (pulse-marked; its only placeholder is the tab-fillable {portalId})', () => {
    const me = hs().find((r) => r.id === 'hubspot_me');
    assert.deepEqual(me.params, []);
    assert.equal(me.pulse.kind, 'liveness');
    assert.match(me.endpoint, /\{portalId\}/);
    assert.match(me.endpoint, /login-verify\/hub-user-info/, 'the same endpoint as the base identityProbe (one read, two roles)');
    assert.equal(me.identityProbe, '/api/login-verify/hub-user-info');
  });
});

describe('connectorRecipes — askNamesOtherSystem (v2.74.1597: the named-system fence)', () => {
  it('the live break: "search hubspot for <email>" running a ZENDESK leg → fenced with "hubspot"', () => {
    assert.equal(askNamesOtherSystem('search hubspot for dmonk@deako.com', 'deako.zendesk.com'), 'hubspot');
    assert.equal(askNamesOtherSystem('show user in hubspot', 'deako.zendesk.com'), 'hubspot');
  });
  it('the leg that IS the named system passes (no gap)', () => {
    assert.equal(askNamesOtherSystem('search hubspot for dmonk@deako.com', 'app.hubspot.com'), null);
    assert.equal(askNamesOtherSystem('search zendesk for that email', 'deako.zendesk.com'), null);
  });
  it('a system named as CONTENT does not fence ("tickets about hubspot" is a legitimate zendesk search)', () => {
    assert.equal(askNamesOtherSystem('find tickets about hubspot', 'deako.zendesk.com'), null);
    assert.equal(askNamesOtherSystem('search for the hubspot integration bug', 'deako.zendesk.com'), null);
  });
  it('shared labels never self-fence: "in deako" with the deako.zendesk.com leg is that system', () => {
    assert.equal(askNamesOtherSystem('open the case in deako', 'deako.zendesk.com'), null);
  });
  it('degrades: empty ask / unknown leg host → null', () => {
    assert.equal(askNamesOtherSystem('', 'deako.zendesk.com'), null);
    assert.equal(askNamesOtherSystem('search hubspot for x', ''), null);
  });
});

// v2.74.1863 — the DRILL-TARGET REDIRECT. Live 175843 settled that catalog TEXT cannot keep a model out of a
// leg whose id it cannot validate: it quoted the warning and overrode it, reasoned about which id kind the
// number was, and finally took a prior redirect's SUCCESS as proof the typed number was internal. The redirect
// door is derived from the catalog's own drill declarations, so it needs no new field and covers every pair.
describe('drillTargetRedirect (v2.74.1863) — the door a user-named identifier belongs in', () => {
  it('THE LIVE PAIR: both VendorSuite drill targets redirect to the LIST leg and its address matcher', () => {
    assert.deepEqual(drillTargetRedirect('vs_warranty_task'), { parentId: 'vs_warranty_tasks', matchOn: 'address', joinParam: 'taskId' });
    assert.deepEqual(drillTargetRedirect('vs_task_contacts'), { parentId: 'vs_warranty_tasks', matchOn: 'address', joinParam: 'taskId' },
      'an `also` target is protected exactly like the `via` target — it takes the same id');
  });
  // v2.74.1868 — THIS ASSERTION USED TO CLAIM THE OPPOSITE, and the claim was the bug. v1863 keyed the redirect
  // on drill MEMBERSHIP and I wrote "Shopify gets it for free" as if breadth were the proof. Live 184948 showed
  // what free cost: `shopify_order` takes the ORDER NUMBER a person reads off the screen (no internal/display
  // split exists there), so the redirect pushed 69872 into the UNFULFILLED queue — a filtered subset that
  // cannot contain a fulfilled order — and answered "none match". The test moves with a corrected FACT about
  // the world (the v1804 `#divisionMenu` precedent), not with a design being softened.
  it('does NOT fire where a human can legitimately type the id (the v1863 over-reach, corrected)', () => {
    assert.equal(drillTargetRedirect('shopify_order'), null,
      'shopify_order takes the order NUMBER off the screen — redirecting it into the unfulfilled queue loses fulfilled orders');
  });
  it('fires only on a param DECLARED machineOnly — membership alone is not the property', () => {
    const cat = [
      { id: 'parent', drill: { via: 'child', param: 'id', matchOn: 'q' } },
      { id: 'child', params: [{ name: 'id', required: true }] },                       // drilled into, but typeable
    ];
    assert.equal(drillTargetRedirect('child', cat), null);
    cat[1].params[0].machineOnly = true;                                               // the same pair, declared
    assert.deepEqual(drillTargetRedirect('child', cat), { parentId: 'parent', matchOn: 'q', joinParam: 'id' });
  });
  it('a LIST leg is not a drill target — it is the destination, never the source', () => {
    assert.equal(drillTargetRedirect('vs_warranty_tasks'), null);
    assert.equal(drillTargetRedirect('shopify_orders_queue'), null);
  });
  it('a bare `via` with no join spec cannot redirect (nothing to route the value INTO)', () => {
    assert.equal(drillTargetRedirect('ticket_comments'), null, 'the Zendesk drills declare via only');
  });
  it('unknown ids and junk are null, never a throw', () => {
    for (const x of ['nope', '', null, undefined, 0]) assert.equal(drillTargetRedirect(x), null);
    assert.equal(drillTargetRedirect('vs_warranty_task', []), null, 'an empty catalog redirects nowhere');
  });
  it('never redirects a leg to ITSELF (a self-referential drill is inert, not a loop)', () => {
    assert.equal(drillTargetRedirect('x', [{ id: 'x', drill: { via: 'x', param: 'p', matchOn: 'm' } }]), null);
  });
});

// ── v2.74.2051 — the NAME-rung ban (user ruling, live 22:45Z run: 2 of 3 "matched" rows were name-rung false
// positives — a Shopify name search matches *a* person, not *the* homeowner; email/phone/address identify, a
// name only resembles). Catalog-wide ratchet: a contact-name rung must never return to ANY joinKey ladder.
describe('catalog — joinKey ladders carry no contact-NAME rungs', () => {
  it('every declared ladder identifies by email/phone/field, never by name', () => {
    for (const r of CONNECTOR_RECIPES.filter((x) => Array.isArray(x.joinKey))) {
      for (const rung of r.joinKey) {
        if (rung && typeof rung === 'object') {
          assert.notEqual(rung.type, 'name', `${r.id}: a contact-name joinKey rung is a false-positive machine`);
        }
      }
    }
  });
});

// ── v2.74.2055 — nested sanitation + the pre-filled-body strip (the draft-order review's confirmed classes) ──────
describe('coerceParams — nested sanitation (v2055)', () => {
  const SCHEMA = { type: 'object', properties: {
    line_items: { type: 'array', elementGid: { variantId: 'ProductVariant' } },
    applied_discount: { type: 'object' },
  }, required: ['line_items'] };
  it('a JSON-TEXT array emission parses instead of riding as one quoted string', () => {
    const out = coerceParams({ line_items: '[{"variantId":"45678","quantity":1}]' }, SCHEMA);
    assert.equal(Array.isArray(out.line_items), true);
    assert.equal(out.line_items[0].quantity, 1);
  });
  it('elementGid coerces a bare variant id inside elements; a full gid passes through', () => {
    const out = coerceParams({ line_items: [{ variantId: '45678', quantity: 1 }, { variantId: 'gid://shopify/ProductVariant/99', quantity: 2 }] }, SCHEMA);
    assert.equal(out.line_items[0].variantId, 'gid://shopify/ProductVariant/45678');
    assert.equal(out.line_items[1].variantId, 'gid://shopify/ProductVariant/99');
  });
  it('placeholder echoes and empty strings INSIDE elements drop; a fully-emptied object reads unfilled', () => {
    const out = coerceParams({
      line_items: [{ variantId: '{variant_id}', quantity: 1 }],
      applied_discount: { value: 100, valueType: '' },
    }, SCHEMA);
    assert.equal('variantId' in out.line_items[0], false, 'the echoed placeholder member dropped (v1405, one level down)');
    assert.equal(out.applied_discount.valueType, undefined, 'the empty member dropped (v1403, one level down)');
    assert.equal(out.applied_discount.value, 100);
    const gone = coerceParams({ applied_discount: { value: '', valueType: '{value_type}' } }, SCHEMA);
    assert.equal('applied_discount' in gone, false, 'a fully-emptied nested optional is unfilled everywhere');
  });
});

describe('stripUnfilledJsonBody — fillBody drop semantics for a PRE-FILLED string body (v2055)', () => {
  it('drops sole-placeholder members recursively, keeps real values', () => {
    const body = JSON.stringify({ operationName: 'DraftOrderCreate', variables: { input: {
      purchasingEntity: { customerId: 'gid://shopify/Customer/1' }, lineItems: '{line_items}',
      note: '{note}', appliedDiscount: '{applied_discount}', useCustomerDefaultAddress: true,
    } } });
    const out = JSON.parse(stripUnfilledJsonBody(body));
    const input = out.variables.input;
    assert.equal(input.purchasingEntity.customerId, 'gid://shopify/Customer/1');
    assert.equal(input.useCustomerDefaultAddress, true);
    for (const k of ['lineItems', 'note', 'appliedDiscount']) assert.equal(k in input, false, `${k} placeholder must not ride the wire`);
  });
  it('a non-JSON string returns unchanged (the executor refusals own it)', () => {
    assert.equal(stripUnfilledJsonBody('query { x }'), 'query { x }');
  });
});

// ── v2.74.2056 — RC-validate slice 1: the enum belt (resolve a word to a member; refuse-primitive; hop-3) ────────
import { resolveEnumValue, enumViolations } from './connectorRecipes.js';

describe('resolveEnumValue — word → declared enum member (v2056)', () => {
  const E = ['new', 'open', 'fixed', 'closed'];
  const SYN = { open: ['active', 'in progress'], fixed: ['resolved'] };
  it('exact match is case- and whitespace-insensitive', () => {
    assert.deepEqual(resolveEnumValue('open', E), { value: 'open' });
    assert.deepEqual(resolveEnumValue('  OPEN ', E), { value: 'open' });
  });
  it('a declared synonym maps to its member', () => {
    assert.deepEqual(resolveEnumValue('active', E, { synonyms: SYN }), { value: 'open' });
    assert.deepEqual(resolveEnumValue('In Progress', E, { synonyms: SYN }), { value: 'open' });
    assert.deepEqual(resolveEnumValue('resolved', E, { synonyms: SYN }), { value: 'fixed' });
  });
  it('a word two members both claim is AMBIGUOUS — never silently picked', () => {
    const r = resolveEnumValue('done', E, { synonyms: { open: ['done'], fixed: ['done'] } });
    assert.equal(r.ambiguous, true);
    assert.deepEqual(r.candidates.sort(), ['fixed', 'open']);
  });
  it('an unmapped word is unknown; a non-string enum (boolean) is never mapped', () => {
    assert.deepEqual(resolveEnumValue('banana', E, { synonyms: SYN }), { unknown: true });
    assert.deepEqual(resolveEnumValue('true', [true, false]), { unknown: true });
    assert.deepEqual(resolveEnumValue('', E), { unknown: true });
  });
});

describe('coerceParams — the enum resolution branch is strictly improve-or-noop (v2056)', () => {
  const SCHEMA = { type: 'object', properties: {
    status: { type: 'string', enum: ['new', 'open', 'fixed', 'closed'], enumSynonyms: { open: ['active'] } },
    pub: { type: 'boolean', enum: [true, false] },
  } };
  it('normalizes case and resolves a synonym', () => {
    assert.equal(coerceParams({ status: 'OPEN' }, SCHEMA).status, 'open');
    assert.equal(coerceParams({ status: 'active' }, SCHEMA).status, 'open');
  });
  it('an already-valid member is unchanged; an unknown value rides as-is (no worse than today)', () => {
    assert.equal(coerceParams({ status: 'open' }, SCHEMA).status, 'open');
    assert.equal(coerceParams({ status: 'banana' }, SCHEMA).status, 'banana');
  });
  it('a boolean enum is never word-mapped', () => {
    assert.equal(coerceParams({ pub: true }, SCHEMA).pub, true);
    assert.equal(coerceParams({ pub: false }, SCHEMA).pub, false);
  });
});

describe('enumViolations — the refuse-before-wire primitive (v2056)', () => {
  const SCHEMA = { type: 'object', properties: { status: { type: 'string', enum: ['new', 'open', 'fixed', 'closed'] }, pub: { type: 'boolean', enum: [true, false] } } };
  it('flags a non-blank out-of-enum string value only', () => {
    assert.deepEqual(enumViolations({ status: 'active' }, SCHEMA), [{ param: 'status', value: 'active', enum: ['new', 'open', 'fixed', 'closed'] }]);
    assert.deepEqual(enumViolations({ status: 'open' }, SCHEMA), []);
    assert.deepEqual(enumViolations({ status: '' }, SCHEMA), []);
    assert.deepEqual(enumViolations({ pub: true }, SCHEMA), []);   // boolean enum never a violation
  });
});

describe('enum belt — the catalog declarations + hop-3 (v2056)', () => {
  it('the live "active → open" mapping is declared on VS warranty status', () => {
    const vs = CONNECTOR_RECIPES.find((r) => r.id === 'vs_warranty_tasks');
    const status = vs.params.find((p) => p.name === 'status');
    assert.ok(status.enumSynonyms.open.includes('active'), 'the flagship synonym must be declared');
  });
  it('enumSynonyms rides hop 3 onto the projected leg schema', () => {
    const vs = CONNECTOR_RECIPES.find((r) => r.id === 'vs_warranty_tasks');
    const leg = recipeToLeg({ ...vs, app: 'vendorsuite', origin: 'vendorsuite.example.com', groundId: 'g' }, { trusted: true });
    assert.ok(leg.paramSchema.properties.status.enumSynonyms.open.includes('active'), 'a dropped enumSynonyms would be the seeded-path bug class');
  });
});

// ── v2.74.2069 — the DELETE-DRAFT capability: a destructive, human-confirmed reversal for create-draft, plus the
// draft-orders search read that is its lookup viaLeg. The delete rides the persisted-op POST transport (NOT REST
// DELETE), gates HARD (destructive → gated → gateActionForLeg refuses unattended), and resolves a draft NUMBER →
// gid via a `lookup` so no gid is ever typed — with NO `gid:` coercion on the destructive param (the chain-path
// pre-mint footgun). Reuses only already-sealed fields, so hopSeal.test.js auto-walks both new entries.
describe('shopify delete-draft (v2.74.2069) — destructive write + its draft-orders search read', () => {
  const legOf = (id) => recipeLegs({ account: 'me', trusted: true }).find((l) => l && l.tool && l.tool.recipeId === id);

  it('shopify_delete_order: ACT leg, GATED (destructive, reversible:false), persisted-op POST — never REST DELETE', () => {
    const leg = legOf('shopify_delete_order');
    assert.ok(leg, 'the delete leg projects');
    assert.equal(leg.mode, 'act');
    assert.equal(leg.safety, 'gated');                       // destructive → gated (human confirm only)
    assert.equal(leg.tool.method, 'POST');                   // a GraphQL mutation over POST, NOT method:'DELETE'
    assert.notEqual(leg.tool.method, 'DELETE');
    assert.equal(leg.tool.gql, true);                        // v2224 — document-in-body; the mutation doc fails isReadOnlyGql → write path
    assert.ok(leg.tool.persistedOp == null, 'no hash demand — nothing to rotate');
    assert.equal(leg.tool.csrf, 'sniff');                    // inherited from SH — a write needs the sniffed token
    assert.match(String(leg.tool.endpoint), /\?operation=DeleteDraftOrder&type=mutation$/);
    assert.equal(isReadOnlyGql(leg.tool.body.query), false, 'destructive mutation stays on the write path');
    assert.equal(leg.tool.reversible, false);                // the honest axis — a deleted draft cannot be restored
    assert.equal(leg.tool.outward, false);
    assert.equal(leg.tool.itemUrl, null);                    // the record ceases to exist — no "show" venue
    assert.equal(leg.tool.shopProbe, true);                  // Shopify liveness marker rides (from SH)
  });

  it('gateActionForLeg REFUSES the delete unattended (a human confirms every delete — §10.1 adopt-don\'t-undo)', () => {
    assert.equal(gateActionForLeg(legOf('shopify_delete_order')).decision, 'refused');
  });

  it('the delete body fills draftOrderDeleteInput.id from {draft_gid} (real HAR shape; param name == placeholder or the field silently drops)', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_delete_order');
    const b = fillBody(rec.body, { draft_gid: 'gid://shopify/DraftOrder/123456' });
    assert.equal(b.operationName, 'DeleteDraftOrder');
    assert.equal(b.variables.draftOrderDeleteInput.id, 'gid://shopify/DraftOrder/123456');   // v2.74.2071 — real HAR key
  });

  it('draft_gid carries a lookup (viaLeg the draft search) but NO gid: coercion (the destructive chain-path footgun)', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_delete_order');
    const p = rec.params.find((x) => x.name === 'draft_gid');
    assert.ok(p && p.required === true);
    assert.equal(p.gid, undefined, 'a gid: marker would pre-mint gid://shopify/DraftOrder/<D-number> and bypass the lookup on the chain path — forbidden on an irreversible delete');
    assert.ok(rec.lookup && rec.lookup.draft_gid, 'the destination carries a lookup spec');
    assert.equal(rec.lookup.draft_gid.viaLeg, 'shopify_draft_orders');
    assert.equal(rec.lookup.draft_gid.valueParam, 'query');
    assert.deepEqual(rec.lookup.draft_gid.match, ['name']);
    assert.equal(rec.lookup.draft_gid.id, 'id');
    assert.equal(rec.lookup.draft_gid.require[0].field, 'status');   // never delete a COMPLETED draft
  });

  it('coerceParams does NOT gid-coerce draft_gid — a bare D-number rides through unchanged for the lookup to resolve', () => {
    const leg = legOf('shopify_delete_order');
    const out = coerceParams({ draft_gid: 'D1023' }, leg.paramSchema);
    assert.equal(out.draft_gid, 'D1023');                    // untouched — no fabricated gid://shopify/DraftOrder/1023
  });

  it('the lookup marker rides hop 3 onto leg.tool (invariant #3: unread here = dropped on the seeded path)', () => {
    const leg = legOf('shopify_delete_order');
    assert.ok(leg.tool.lookup && leg.tool.lookup.draft_gid, 'lookup threads to the tool');
    assert.equal(leg.tool.lookup.draft_gid.viaLeg, 'shopify_draft_orders');
  });

  it('shopify_draft_orders: a READ (ask) on the persisted-op GET path — the delete lookup viaLeg', () => {
    const leg = legOf('shopify_draft_orders');
    assert.ok(leg, 'the draft-orders read projects');
    assert.equal(leg.mode, 'ask');
    assert.equal(leg.safety, 'auto');                        // trusted curated read
    assert.equal(leg.tool.method, 'GET');
    assert.equal(leg.tool.gql, false);
    assert.equal(leg.tool.persistedOp, 'DraftOrderList');
    assert.match(String(leg.tool.endpoint), /\/api\/operations\/\{op_sha\}\/DraftOrderList\/shopify\/\{handle\}/);
    assert.match(String(leg.tool.endpoint), /operationName=DraftOrderList/);
    assert.match(String(leg.tool.endpoint), /%22query%22%3A%22\{query\}%22/, 'the one fill slot rides percent-encoded');
    assert.equal(leg.tool.listUrl, '/store/{handle}/draft_orders');
    assert.deepEqual(leg.tool.displayId, ['name']);
  });

  it('the reversibility fix lives on the NEW delete leg — create-draft is NOT re-gated (regression fence, Scout B)', () => {
    const create = legOf('shopify_create_order');
    assert.equal(create.tool.reversible, true);
    assert.notEqual(create.safety, 'gated');
    assert.notEqual(gateActionForLeg(create).decision, 'refused');   // create still runs unattended in a reviewed pipeline
  });

  it('create-draft\'s does now NAMES its reversal (make reversible:true honest — prose only)', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_create_order');
    assert.match(rec.does, /shopify_delete_order|delete-draft/i);
  });

  it('the banned money/inventory id ban still holds — neither new id trips it (draft delete is not a money class)', () => {
    for (const id of ['shopify_delete_order', 'shopify_draft_orders']) {
      assert.equal(/refund|return|draftorder|complete_order/i.test(id), false, `${id} must not read as a banned class id`);
    }
  });

  it('the delete left the capture checklist (v2224 document conversion); its lookup read remains', () => {
    const ops = persistedOpsForHost('admin.shopify.com').map((w) => w.op);
    assert.ok(!ops.includes('DeleteDraftOrder'), 'a document mutation demands no capture');
    assert.ok(ops.includes('DraftOrderList'));
    assert.match(opCaptureHint('DraftOrderList'), /draft/i);
  });
});

// ── v2.74.2227 — the FIRST VendorSuite WRITE (vs_update_task_note) + the form-urlencoded transport ────────────
describe('connectorRecipes — vs_update_task_note: the HAR-authored warranty-note write (v2227)', () => {
  const legOf = (id) => recipeLegs().find((l) => l && l.tool && l.tool.recipeId === id);
  it('projects as a gated ACT leg on the cookie-ride write path with the declared no-token contract', () => {
    const leg = legOf('vs_update_task_note');
    assert.ok(leg, 'the write leg projects');
    assert.equal(leg.mode, 'act');
    assert.equal(leg.tool.method, 'POST');
    assert.equal(leg.tool.reversible, true, 'v2229 USER RULING — the write-back caller always append-preserves the prior text (consequenceNote.appendNote), making the act reversible-by-rewrite; unattended runs need gate auto');
    assert.equal(leg.tool.outward, false);
    assert.equal(leg.tool.csrf, 'none', 'HAR-proven: cookie + X-Requested-With, no token of any kind');
    assert.equal(leg.tool.bodyType, 'form', 'v2228 — routes the panel door to fillWriteBody; the undeclared default (json) JSON-stringified the body AND overrode the Content-Type (the live 500)');
    assert.match(String(leg.tool.contentType), /x-www-form-urlencoded/);
    assert.equal(leg.tool.endpoint, '/api/Vendor/Warranty/UpdateCompleteTask/false', 'the /false path segment: never complete via this leg');
    assert.equal(gateActionForLeg(leg).decision, 'auto', 'v2229 ruling — internal + reversible + declared ⇒ the sweep may write back unattended (gateCleared authority); the interactive HITL is untouched');
  });
  it('fillBody + encodeBodyForContentType reproduce the HAR wire string byte-for-byte', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'vs_update_task_note');
    const filled = fillBody(rec.body, { task_id: '10920483', note: '.' });
    assert.equal(encodeBodyForContentType(filled, rec.contentType), 'taskId=10920483&note=.', 'the capture, entry #57');
  });
  it('encodeBodyForContentType: json passes through untouched; form bodies are flat; null members drop', () => {
    const o = { a: 1 };
    assert.equal(encodeBodyForContentType(o, 'application/json'), o, 'not form → untouched');
    assert.equal(encodeBodyForContentType('already=a-string', 'application/x-www-form-urlencoded'), 'already=a-string');
    assert.equal(encodeBodyForContentType({ a: 'x y', b: null, nested: { z: 1 } }, 'application/x-www-form-urlencoded; charset=UTF-8'), 'a=x+y', 'null drops, nested is skipped (form bodies are flat), space → +');
  });
});
