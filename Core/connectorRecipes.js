// Core/connectorRecipes.js — curated session-ride recipe catalog + endpoint templating (DESIGN_connectors.md §4, §12). CX-3.
//
// PURE: no chrome / DOM / fetch. A recipe binds a read intent to one of an app's OWN frontend endpoints, called by
// RIDING the user's existing browser login (the session-ride implementation — no credential of our own). This module
// is the curated catalog + `fillEndpoint` ({name} templating). The live fetch is the content script's SESSION_FETCH
// (same-origin → the login cookie rides); the tab relay is background/handlers/connector.js. recipeLegs() projects
// the catalog into OfferedLegs via connectorLeg.recipeToLeg, so the palette/router treat them like any other tool.
//
// Curated = trusted (§9): a curated read may run at low friction; user-added recipes (later) are untrusted → confirm.

import { recipeToLeg } from './connectorLeg.js';

/**
 * Substitute `{name}` placeholders in a template from `args`, URL-encoding each value. PURE.
 * An unfilled placeholder is left visible (so a missing required arg is obvious, not silently dropped).
 * Used for BOTH the origin (e.g. `{subdomain}.zendesk.com`) and the endpoint path.
 */
export function fillEndpoint(template, args = {}) {
  const a = (args && typeof args === 'object') ? args : {};
  return String(template ?? '').replace(/\{([a-zA-Z_][\w-]*)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(a, name) ? encodeURIComponent(String(a[name])) : m);
}

// The curated catalog. Seeded small + grows; later learnable from observed page traffic. Read-only for now
// (CX-3); writes need CSRF + the gate (CX-6). `origin`/`endpoint` carry {name} placeholders bound from `params`.
export const CONNECTOR_RECIPES = [
  {
    id: 'read_ticket', app: 'zendesk', name: 'Read a Zendesk ticket',
    does: 'fetch one Zendesk support ticket by its number, riding your Zendesk login',
    origin: '{subdomain}.zendesk.com', endpoint: '/api/v2/tickets/{id}.json', method: 'GET',
    params: [
      { name: 'subdomain', type: 'string', required: true },
      { name: 'id', type: 'integer', required: true },
    ],
  },
];

/** Project the curated catalog into session-ride OfferedLegs. PURE. (CX-4 feeds these into the palette.) */
export function recipeLegs({ account = 'me', trusted = true } = {}) {
  return CONNECTOR_RECIPES.map((r) => recipeToLeg(r, { account, trusted })).filter(Boolean);
}
