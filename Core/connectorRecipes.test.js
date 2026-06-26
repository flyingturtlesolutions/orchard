// Core/connectorRecipes.test.js — CX-3 curated recipe catalog + templating (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTOR_RECIPES, fillEndpoint, fillBody, recipeLegs, normalizeTicket } from './connectorRecipes.js';

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
