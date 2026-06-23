// Core/connectorRecipes.test.js — CX-3 curated recipe catalog + templating (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTOR_RECIPES, fillEndpoint, recipeLegs, normalizeTicket } from './connectorRecipes.js';

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
