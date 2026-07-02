// Core/brokerCatalog.js — CX-5a (v2.74.1305). The curated BROKER catalog: official-API connectors reached via the
// cloud OAuth/MCP proxy (DESIGN_connectors.md §5). This is the broker analog of CONNECTOR_RECIPES — which seeds the
// CLIENT session-ride path; this seeds the CLOUD broker path. Each entry names an MCP server that fronts a provider's
// official API, the hosts it serves, its OAuth scopes, and a SEED tool list.
//
// PURE: pure data + a pure projection. No chrome / network / OAuth / MCP client — all of those live in the Phase C-P3
// proxy (the extension never holds a third-party token or speaks MCP; it asks the broker to invoke a tool). The seed
// tool list is a stand-in that live `GET /connectors/tools` discovery SUPERSEDES once the proxy is connected; until
// then it lets a broker leg be SELECTED and lets the leg-assessor (Core/legAvailability) RECOMMEND the Broker for a
// Google-class Ground — even before any live round-trip exists.
//
// WHY GOOGLE LEADS: its client legs both FAIL — Drive dies on obfuscated / positional selectors
// (`div.VKy0Ic:nth-of-type(40)`), and Ride can't template the binary gRPC/protobuf write bodies (`/$rpc.*` → 0-param
// empty recipes). The official API via the broker is the ONLY leg that works. legAvailability encodes exactly this
// ("both client legs degraded → need the Broker"); this catalog is what makes that recommendation actionable.
//
// @module Core/brokerCatalog

import { mcpToolToLeg } from './connectorLeg.js';

/**
 * The curated broker connectors. Frozen. A `tools[]` entry is an MCP tool descriptor (the exact shape mcpToolToLeg
 * consumes): { name, description, inputSchema, annotations:{readOnlyHint?, destructiveHint?} }. readOnlyHint → the
 * leg is a read (mode 'ask', safety 'auto' since curated=trusted); a plain write → 'act'/'confirm'; destructiveHint
 * → 'gated'. Keep the seed list SMALL + representative — it is not meant to mirror the server's full surface.
 */
export const BROKER_CATALOG = Object.freeze([
  Object.freeze({
    server: 'google-calendar',
    provider: 'google',
    label: 'Google Calendar',
    hosts: ['calendar.google.com'],
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    // v2.74.1316 — schemas corrected to Google's PUBLISHED tool reference (…/api/v3/reference/mcp/tools_list/*) after
    // the first live create_event rejected the guessed names ("Unknown name \"start\""): times are startTime/endTime
    // (ISO 8601, BOTH required on create), attendees is attendeeEmails, list filters are startTime/endTime (not
    // timeMin/timeMax) + fullText/pageSize. Seed schemas rot — live tools/list discovery stays the durable successor.
    tools: [
      { name: 'list_events', description: 'List calendar events in a time range', annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: { startTime: { type: 'string' }, endTime: { type: 'string' }, calendarId: { type: 'string' }, pageSize: { type: 'integer' }, fullText: { type: 'string' } }, required: [] } },
      { name: 'create_event', description: 'Create a calendar event', annotations: {},
        inputSchema: { type: 'object', properties: { summary: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' }, description: { type: 'string' }, location: { type: 'string' }, calendarId: { type: 'string' }, timeZone: { type: 'string' }, allDay: { type: 'boolean' }, attendeeEmails: { type: 'array' } }, required: ['summary', 'startTime', 'endTime'] } },
      { name: 'update_event', description: 'Update an existing calendar event', annotations: {},
        inputSchema: { type: 'object', properties: { eventId: { type: 'string' }, summary: { type: 'string' }, startTime: { type: 'string' }, endTime: { type: 'string' }, calendarId: { type: 'string' } }, required: ['eventId'] } },
      { name: 'delete_event', description: 'Delete a calendar event', annotations: { destructiveHint: true },
        inputSchema: { type: 'object', properties: { eventId: { type: 'string' }, calendarId: { type: 'string' } }, required: ['eventId'] } },
    ],
  }),
  Object.freeze({
    server: 'google-gmail',
    provider: 'google',
    label: 'Gmail',
    hosts: ['mail.google.com'],
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    tools: [
      { name: 'list_messages', description: 'List Gmail messages matching a query', annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: { q: { type: 'string' }, maxResults: { type: 'number' } }, required: [] } },
      { name: 'create_draft', description: 'Create a draft email', annotations: {},
        inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: [] } },
      { name: 'send_message', description: 'Send an email', annotations: {},
        inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to'] } },
    ],
  }),
]);

const _host = (h) => String(h || '').toLowerCase().replace(/^www\./, '');

/**
 * The broker connector entry serving a host, or null. Match is exact-host or a proper subdomain suffix — we do NOT
 * broadly match `*.google.com`, because each Google product is a distinct server + OAuth scope (calendar ≠ gmail).
 * @param {string} host  e.g. 'calendar.google.com'
 * @param {ReadonlyArray} [catalog]
 * @returns {object|null}
 */
export function brokerConnectorForHost(host, catalog = BROKER_CATALOG) {
  const h = _host(host);
  if (!h) return null;
  for (const entry of (Array.isArray(catalog) ? catalog : [])) {
    const hosts = (entry && Array.isArray(entry.hosts)) ? entry.hosts.map(_host) : [];
    if (hosts.some((x) => x && (x === h || h.endsWith('.' + x)))) return entry;
  }
  return null;
}

/**
 * Project the broker connector serving `host` → cloud-broker OfferedLegs (impl:'oauth'), one per seed tool. The
 * curated catalog is TRUSTED, so a readOnlyHint tool drops to 'auto'; writes floor at 'confirm'; destructive → 'gated'
 * (the same §9 rule the session-ride path uses). Returns [] when no connector serves the host. PURE.
 *
 * Note on `linked`: an UNLINKED provider still projects its legs (so the user can SEE + pick "Create event via
 * Google", and the pick is what triggers the OAuth link). The caller filters on link-state when it wants only
 * immediately-runnable legs; this projection is link-agnostic on purpose.
 * @param {string} host
 * @param {{ catalog?:ReadonlyArray, account?:string }} [opts]
 * @returns {Array<object>}
 */
export function brokerLegsForHost(host, { catalog = BROKER_CATALOG, account = 'me' } = {}) {
  const entry = brokerConnectorForHost(host, catalog);
  if (!entry) return [];
  const tools = Array.isArray(entry.tools) ? entry.tools : [];
  return tools
    .map((t) => mcpToolToLeg(t, { account, server: entry.server, trusted: true }))
    .filter(Boolean);
}

/**
 * CX-5c — the PALETTE projection: broker legs for a host, gated on the provider being LINKED (OAuth granted, per
 * the `connector:linkedProviders` cache the LINK/UNLINK handlers maintain). An unlinked provider's legs stay OUT of
 * the interpret palette — a selectable-but-dead leg reads as broken; the leg-assessor + `link: <provider>` are the
 * discovery/repair path. Optional seenKeys dedupes against already-collected legs (RAG/curated/harvested). PURE.
 * @param {string} host
 * @param {string[]} linkedProviders   e.g. ['google']
 * @param {{ catalog?:ReadonlyArray, account?:string, mode?:('ask'|'act'|null), seenKeys?:Set<string> }} [opts]
 * @returns {Array<object>}
 */
export function brokerLegsForLinked(host, linkedProviders, { catalog = BROKER_CATALOG, account = 'me', mode = null, seenKeys = null } = {}) {
  const linked = new Set((Array.isArray(linkedProviders) ? linkedProviders : []).map((p) => String(p || '').toLowerCase()));
  if (!linked.size) return [];
  const entry = brokerConnectorForHost(host, catalog);
  if (!entry || !linked.has(String(entry.provider || '').toLowerCase())) return [];
  return brokerLegsForHost(host, { catalog, account })
    .filter((l) => !mode || l.mode === mode)
    .filter((l) => !(seenKeys && seenKeys.has(l.key)));
}
