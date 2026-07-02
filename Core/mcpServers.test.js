// Core/mcpServers.test.js — MP-2a (v2.74.1308): the curated MCP server registry (id → endpoint). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MCP_SERVERS, MCP_REGISTRIES, mcpServerFor, mcpProviderFor, isKnownMcpServer } from './mcpServers.js';
import { brokerConnectorForHost } from './brokerCatalog.js';

describe('mcpServers — the curated seed registry', () => {
  it('resolves Google Calendar to its verified official endpoint', () => {
    const s = mcpServerFor('google-calendar');
    assert.equal(s.url, 'https://calendarmcp.googleapis.com/mcp/v1');
    assert.equal(s.provider, 'google');
    assert.ok(s.scopes.includes('https://www.googleapis.com/auth/calendar.events'));
    assert.equal(s.id, 'google-calendar');
  });
  it('resolves the other confirmed servers', () => {
    assert.equal(mcpServerFor('notion').url, 'https://mcp.notion.com/mcp');
    assert.equal(mcpServerFor('github').url, 'https://api.githubcopilot.com/mcp/');
    assert.equal(mcpServerFor('hubspot').url, 'https://mcp.hubspot.com');
  });
  it('every seed entry has a real https URL + provider (the invariant — no guessed/blank endpoints)', () => {
    for (const [id, s] of Object.entries(MCP_SERVERS)) {
      assert.match(s.url, /^https:\/\/.+/, `${id} url`);
      assert.ok(s.provider, `${id} provider`);
      assert.ok(Array.isArray(s.scopes), `${id} scopes`);
    }
  });
  it('an unknown id → null (not a throw); isKnownMcpServer reflects the seed', () => {
    assert.equal(mcpServerFor('does-not-exist'), null);
    assert.equal(mcpProviderFor('does-not-exist'), null);
    assert.equal(isKnownMcpServer('notion'), true);
    assert.equal(isKnownMcpServer(''), false);
  });
  it('Zendesk is ABSENT — it is an MCP consumer, not a hosted server → session-ride, not curated-MCP', () => {
    assert.equal(isKnownMcpServer('zendesk'), false);
    assert.equal(mcpServerFor('zendesk'), null);
  });
  it('the registry + registries list are frozen (curated, not mutated at runtime)', () => {
    assert.ok(Object.isFrozen(MCP_SERVERS));
    assert.ok(Object.isFrozen(MCP_REGISTRIES));
    assert.ok(MCP_REGISTRIES.some((u) => /modelcontextprotocol\.io/.test(u)));
  });
});

describe('mcpServers × brokerCatalog — the two halves join by server id', () => {
  it('the Google Calendar broker connector has a matching endpoint in the server registry', () => {
    const connector = brokerConnectorForHost('calendar.google.com');   // { server: 'google-calendar', … }
    assert.ok(connector);
    const endpoint = mcpServerFor(connector.server);
    assert.ok(endpoint, 'brokerCatalog server id resolves to a real MCP endpoint');
    assert.equal(endpoint.provider, connector.provider);
  });
});
