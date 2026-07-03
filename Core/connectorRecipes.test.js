// Core/connectorRecipes.test.js — CX-3 curated recipe catalog + templating (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTOR_RECIPES, fillEndpoint, fillBody, recipeLegs, normalizeTicket, recipeForOrigin, connectorLegsForConnections, coerceParams, harvestedRecipeLegs } from './connectorRecipes.js';

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

describe('the Zendesk CRUD catalog (v2.74.1236)', () => {
  const legs = recipeLegs({ account: 'me', trusted: true });
  const byId = (id) => legs.find((l) => l.key === `me.zendesk.${id}`);
  const reads = legs.filter((l) => l.mode === 'ask');
  const writes = legs.filter((l) => l.mode === 'act');

  it('every recipe has a unique id and projects to a valid session leg (identity at the connection)', () => {
    const ids = CONNECTOR_RECIPES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, 'recipe ids must be unique');
    assert.equal(legs.length, CONNECTOR_RECIPES.length);   // all project (none dropped as incomplete)
    for (const leg of legs) {
      assert.equal(leg.tool.impl, 'session');
      assert.equal(leg.tool.appHost, 'zendesk.com');       // identity lives at the connection
      assert.equal(leg.tool.origin, null);                 // origin derived from the open tab
      assert.equal(leg.tool.verifyIdentity, true);         // §14 — never trust status alone
    }
  });

  it('reads → ask / auto / GET / no body; every write → act / non-GET / never auto (§9)', () => {
    assert.ok(reads.length >= 7 && writes.length >= 10);
    for (const leg of reads) {
      assert.equal(leg.safety, 'auto');                    // trusted curated read → low friction
      assert.equal(leg.tool.method, 'GET');
      assert.equal(leg.tool.body, null);
    }
    for (const leg of writes) {
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
