// Core/connectorRecipes.js — curated session-ride recipe catalog + endpoint templating (DESIGN_connectors.md §4, §12–14). CX-3/CX-4a.
//
// PURE: no chrome / DOM / fetch. A recipe binds a read intent to one of an app's OWN frontend endpoints, called by
// RIDING the user's existing browser login (session-ride). This module is the curated catalog + `fillEndpoint`.
//
// §13/§14 (CS Tools reframe): identity lives at the CONNECTION, not the ask. So recipes use `appHost` (the origin is
// auto-derived from the open `*.appHost` tab — the tab you're logged into IS the connection), and "my X" reads need
// no params: `verifyIdentity` triggers an identity probe whose user id fills `{me}` (e.g. `assignee:{me}`). The probe
// also closes the CS Tools trap — a logged-out session returns HTTP 200 + an anonymous sentinel, so a list read would
// look like "0 results"; verify the returned identity, never the status.

import { recipeToLeg } from './connectorLeg.js';

/**
 * Substitute `{name}` placeholders in a template from `args`, URL-encoding each value. PURE.
 * An unfilled placeholder is left visible. Used for the origin, the endpoint path, and `{me}` (filled from the probe).
 */
export function fillEndpoint(template, args = {}) {
  const a = (args && typeof args === 'object') ? args : {};
  return String(template ?? '').replace(/\{([a-zA-Z_][\w-]*)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(a, name) ? encodeURIComponent(String(a[name])) : m);
}

// The curated catalog (Zendesk first — the operator's real queue). Read-only for now (CX-3/4a); writes need CSRF +
// the gate (CX-6). `appHost` → origin from the open tab; `{me}` → the probed user id; static query spaces are %20.
export const CONNECTOR_RECIPES = [
  {
    id: 'my_open_tickets', app: 'zendesk', name: 'My open Zendesk tickets',
    does: 'list your open Zendesk tickets, riding your Zendesk login',
    appHost: 'zendesk.com', verifyIdentity: true, identityProbe: '/api/v2/users/me.json',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:open%20assignee:{me}&per_page=25&sort_by=created_at&sort_order=desc',
    method: 'GET', params: [],
  },
  {
    id: 'read_ticket', app: 'zendesk', name: 'Read a Zendesk ticket',
    does: 'fetch one Zendesk ticket by its number, riding your login',
    appHost: 'zendesk.com', verifyIdentity: true, identityProbe: '/api/v2/users/me.json',
    endpoint: '/api/v2/tickets/{id}.json', method: 'GET',
    params: [{ name: 'id', type: 'integer', required: true }],
  },
];

// The "useful subset" render shape (CS Tools normalizeTicket — 10 of ~80 fields). Pure; used by the CX-4a.2 list render.
export function normalizeTicket(t, origin = '') {
  const x = (t && typeof t === 'object') ? t : {};
  return {
    id: x.id, subject: x.subject, status: x.status, priority: x.priority,
    requester_id: x.requester_id, assignee_id: x.assignee_id, tags: x.tags,
    created_at: x.created_at, updated_at: x.updated_at,
    description: typeof x.description === 'string' ? x.description.slice(0, 500) : null,
    url: (origin && x.id != null) ? `https://${origin}/agent/tickets/${x.id}` : null,
  };
}

/** Project the curated catalog into session-ride OfferedLegs. PURE. (CX-4 feeds these into the palette.) */
export function recipeLegs({ account = 'me', trusted = true } = {}) {
  return CONNECTOR_RECIPES.map((r) => recipeToLeg(r, { account, trusted })).filter(Boolean);
}
