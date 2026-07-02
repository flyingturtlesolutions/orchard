// Core/mcpServers.js — MP-2a (v2.74.1308). The curated MCP SERVER REGISTRY: a `server` id → its remote endpoint,
// provider, transport, and OAuth scopes. This is the "WHERE to reach it" half; Core/brokerCatalog is the "WHAT tools +
// safety" half — a consumer joins them by `server` id (brokerCatalog 'google-calendar' → this URL). The backend MCP
// client (MP-2b) resolves an INVOKE_CONNECTOR's server → this endpoint, then MP-1 (Core/mcpClient) speaks to it.
//
// Endpoints are OFFICIAL vendor-hosted remote MCP servers CONFIRMED by the 2026-07-01 coverage research — no guessed
// URLs. Google Calendar was verified against Google's config guide; the rest are their published endpoints. This is a
// CURATED SEED: a LIVE registry (MCP_REGISTRIES below) supersedes it as coverage grows, so keep it small + high-
// confidence. A server id with no seed entry = "resolve via the live registry" (MP-3), not "unsupported".
//
// ⚠ Zendesk is DELIBERATELY ABSENT — it's an MCP *consumer* (connects Zendesk TO external servers in action flows),
// not a hosted server others can call → no curated-MCP path → it stays on session-ride (the tail Orchard already owns).
//
// PURE: data + lookup, no network. @module Core/mcpServers

export const MCP_SERVERS = Object.freeze({
  // Every entry has a real https url + provider (the invariant the tests lock). scopes only where confirmed; the OAuth
  // flow / the server's protected-resource metadata (RFC 9728) declares the rest at link time (MP-3).
  'google-calendar': Object.freeze({ url: 'https://calendarmcp.googleapis.com/mcp/v1', provider: 'google', transport: 'streamable-http', scopes: ['https://www.googleapis.com/auth/calendar.events'] }),
  'notion':          Object.freeze({ url: 'https://mcp.notion.com/mcp', provider: 'notion', transport: 'streamable-http', scopes: [] }),
  'github':          Object.freeze({ url: 'https://api.githubcopilot.com/mcp/', provider: 'github', transport: 'streamable-http', scopes: [] }),
  'hubspot':         Object.freeze({ url: 'https://mcp.hubspot.com', provider: 'hubspot', transport: 'streamable-http', scopes: [] }),
});

// The live registries to discover FROM (the research's "don't hardcode the catalog" finding, as code). MP-3 fetches
// these to resolve servers beyond the seed above. Ordered by authority.
export const MCP_REGISTRIES = Object.freeze([
  'https://registry.modelcontextprotocol.io',   // the official MCP Registry (canonical)
  'https://remote-mcp-servers.com',             // remote-only, built on the official registry spec
  'https://www.pulsemcp.com',                   // large aggregator, filterable by "remote"
]);

const _id = (x) => String(x == null ? '' : x).trim();

/** The seed endpoint record for a server id (with the id folded in), or null when it's not in the curated seed. PURE. */
export function mcpServerFor(id) {
  const s = MCP_SERVERS[_id(id)];
  return s ? { id: _id(id), ...s } : null;
}

/** The provider a server belongs to (google-calendar → 'google'), or null. PURE. */
export function mcpProviderFor(id) {
  const s = MCP_SERVERS[_id(id)];
  return s ? s.provider : null;
}

/** Is this server id in the curated seed? (A false is NOT "unsupported" — it may resolve via the live registry.) PURE. */
export function isKnownMcpServer(id) {
  return Object.prototype.hasOwnProperty.call(MCP_SERVERS, _id(id));
}
