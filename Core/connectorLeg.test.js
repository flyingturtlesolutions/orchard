// Core/connectorLeg.test.js — CX-1 connector leg projection (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { recipeToLeg, mcpToolToLeg, hintToSafety, pruneSchema, connectorLegKey } from './connectorLeg.js';
import { toOfferedLeg } from './palette.js';

describe('hintToSafety — hints may only RAISE caution (§9)', () => {
  it('destructive → gated (always, even alongside readOnly)', () => {
    assert.equal(hintToSafety({ destructiveHint: true }, true), 'gated');
    assert.equal(hintToSafety({ destructiveHint: true, readOnlyHint: true }, true), 'gated');
  });
  it('trusted read → auto; untrusted read → confirm (a self-claim cannot lower)', () => {
    assert.equal(hintToSafety({ readOnlyHint: true }, true), 'auto');
    assert.equal(hintToSafety({ readOnlyHint: true }, false), 'confirm');
  });
  it('no hints (treated as a write) → confirm floor', () => {
    assert.equal(hintToSafety({}, true), 'confirm');
    assert.equal(hintToSafety(undefined, false), 'confirm');
  });
});

describe('pruneSchema — keep type/enum/required, drop verbosity (§12)', () => {
  it('v1317: format survives the prune (the binder must know a field wants ISO 8601)', () => {
    const out = pruneSchema({ type: 'object', properties: { startTime: { type: 'string', format: 'date-time', description: 'dropped' } }, required: [] });
    assert.deepEqual(out.properties.startTime, { type: 'string', format: 'date-time' });
  });
  it('reduces to the binding skeleton', () => {
    const out = pruneSchema({
      type: 'object',
      properties: { q: { type: 'string', description: 'long…' }, n: { type: 'integer' }, ch: { type: 'string', enum: ['a', 'b'] } },
      required: ['q'],
    });
    assert.equal(out.properties.q.type, 'string');
    assert.equal(out.properties.q.description, undefined);   // verbosity dropped
    assert.deepEqual(out.properties.ch.enum, ['a', 'b']);
    assert.deepEqual(out.required, ['q']);
  });
  it('tolerates junk without throwing', () => {
    assert.deepEqual(pruneSchema(null).properties, {});
    assert.deepEqual(pruneSchema(undefined).required, []);
  });
});

describe('recipeToLeg — session-ride recipe → client connector leg (§4)', () => {
  const recipe = {
    id: 'read_ticket', name: 'Read a Zendesk ticket', does: 'fetch one ticket by id',
    app: 'zendesk', origin: 'acme.zendesk.com', endpoint: '/api/v2/tickets/{id}.json',
    params: [{ name: 'id', type: 'integer', required: true }],
  };

  it('projects to a connector leg: impl=session, account-namespaced key, GET default', () => {
    const leg = recipeToLeg(recipe, { account: 'acme', trusted: true });
    assert.equal(leg.domain, 'connector');
    assert.equal(leg.source, 'builtin');
    assert.equal(leg.key, 'acme.zendesk.read_ticket@acme.zendesk.com');   // v1342 — origin suffix when recipe carries origin
    assert.equal(leg.tool.recipeId, 'read_ticket');      // v1340 (review A/§18) — the BARE id rides on the tool so the arm guard can match stored records
    assert.equal(leg.tool.impl, 'session');
    assert.equal(leg.tool.origin, 'acme.zendesk.com');
    assert.equal(leg.tool.endpoint, '/api/v2/tickets/{id}.json');
    assert.equal(leg.tool.method, 'GET');
    assert.equal(leg.mode, 'ask');                       // a read
    assert.equal(leg.safety, 'auto');                    // trusted read
    assert.deepEqual(leg.params, ['id']);
    // FL-1c/1d (v1347/1349) — the ground-truth HUMAN page templates thread recipe → tool (null when absent).
    assert.equal(leg.tool.itemUrl, null);
    assert.equal(leg.tool.listUrl, null);
    const withUrls = recipeToLeg({ ...recipe, itemUrl: '/agent/tickets/{id}', listUrl: '/agent/search/1?q={query}' }, { account: 'acme', trusted: true });
    assert.equal(withUrls.tool.itemUrl, '/agent/tickets/{id}');
    assert.equal(withUrls.tool.listUrl, '/agent/search/1?q={query}');
    assert.equal(leg.paramSchema.properties.id.type, 'integer');
    assert.deepEqual(leg.paramSchema.required, ['id']);
  });

  it('a write recipe → act mode + confirm (floors even when trusted); honors method', () => {
    const leg = recipeToLeg({ ...recipe, id: 'update_ticket', write: true, method: 'put' }, { account: 'acme', trusted: true });
    assert.equal(leg.mode, 'act');
    assert.equal(leg.safety, 'confirm');
    assert.equal(leg.tool.method, 'PUT');
  });

  it('an untrusted read still confirms (no self-lowering)', () => {
    assert.equal(recipeToLeg(recipe, { account: 'acme', trusted: false }).safety, 'confirm');
  });

  it('passes through palette.toOfferedLeg unchanged (already-normalized → identity)', () => {
    const leg = recipeToLeg(recipe, { account: 'acme', trusted: true });
    assert.equal(toOfferedLeg(leg), leg);
  });

  it('an appHost recipe (no origin) → leg with tool.appHost + verifyIdentity + identityProbe (§14)', () => {
    const leg = recipeToLeg({
      id: 'my_open_tickets', app: 'zendesk', name: 'My open tickets', appHost: 'zendesk.com',
      verifyIdentity: true, identityProbe: '/api/v2/users/me.json',
      endpoint: '/api/v2/search.json?query=assignee:{me}', method: 'GET', params: [],
    }, { account: 'me', trusted: true });
    assert.ok(leg);
    assert.equal(leg.tool.impl, 'session');
    assert.equal(leg.tool.appHost, 'zendesk.com');
    assert.equal(leg.tool.origin, null);
    assert.equal(leg.tool.verifyIdentity, true);
    assert.equal(leg.tool.identityProbe, '/api/v2/users/me.json');
  });

  it('rejects an incomplete recipe (no origin AND no appHost, or no endpoint)', () => {
    assert.equal(recipeToLeg({ id: 'x', app: 'zendesk' }, {}), null);                              // no endpoint, no host
    assert.equal(recipeToLeg({ id: 'x', app: 'zendesk', endpoint: '/y' }, {}), null);              // host missing
    assert.equal(recipeToLeg(null, {}), null);
  });
});

describe('connectorLegKey — host suffix (v1342)', () => {
  it('suffixes @host when set; bare key when not', () => {
    assert.equal(connectorLegKey({ account: 'me', app: 'zendesk', id: 'read_ticket' }), 'me.zendesk.read_ticket');
    assert.equal(connectorLegKey({ account: 'me', app: 'zendesk', id: 'read_ticket', host: 'a.zendesk.com' }), 'me.zendesk.read_ticket@a.zendesk.com');
  });
});

describe('mcpToolToLeg — MCP tool → cloud-broker connector leg (§5)', () => {
  const tool = {
    name: 'get_ticket', description: 'Get a ticket by id',
    inputSchema: { type: 'object', properties: { ticket_id: { type: 'integer', description: 'the id' } }, required: ['ticket_id'] },
    annotations: { readOnlyHint: true },
  };

  it('projects to impl=oauth, server-namespaced key, schema carried + pruned', () => {
    const leg = mcpToolToLeg(tool, { account: 'acme', server: 'zendesk', trusted: true });
    assert.equal(leg.domain, 'connector');
    assert.equal(leg.key, 'acme.zendesk.get_ticket');
    assert.equal(leg.tool.impl, 'oauth');
    assert.equal(leg.tool.server, 'zendesk');
    assert.equal(leg.mode, 'ask');
    assert.equal(leg.safety, 'auto');                    // trusted + readOnly
    assert.deepEqual(leg.params, ['ticket_id']);
    assert.equal(leg.paramSchema.properties.ticket_id.type, 'integer');
    assert.equal(leg.paramSchema.properties.ticket_id.description, undefined);
  });

  it('a tool with no readOnly hint defaults to act/confirm (safe)', () => {
    const leg = mcpToolToLeg({ name: 'post_comment', inputSchema: { properties: { body: { type: 'string' } } } }, { server: 'zendesk', trusted: true });
    assert.equal(leg.mode, 'act');
    assert.equal(leg.safety, 'confirm');
  });

  it('a destructive tool → gated even if trusted', () => {
    const leg = mcpToolToLeg({ name: 'delete_ticket', annotations: { destructiveHint: true } }, { server: 'zendesk', trusted: true });
    assert.equal(leg.safety, 'gated');
  });

  it('rejects without a server or a name', () => {
    assert.equal(mcpToolToLeg(tool, { trusted: true }), null);              // no server
    assert.equal(mcpToolToLeg({ description: 'x' }, { server: 'z' }), null); // no name
  });
});
