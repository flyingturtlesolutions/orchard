// Core/connectorRecipes.js — curated session-ride recipe catalog + endpoint templating (DESIGN_connectors.md §4, §12–14). CX-3/CX-4a.
//
// PURE: no chrome / DOM / fetch. A recipe binds a read OR write intent to one of an app's OWN frontend endpoints —
// the SAME request the app's own UI button fires — called by RIDING the user's existing browser login (session-ride).
// It is the full-CRUD equivalent of the grounded DOM driver, not a read-only side channel: a write recipe carries a
// `body` template alongside the endpoint. This module is the curated catalog + the `fillEndpoint`/`fillBody` templaters.
//
// §13/§14 (CS Tools reframe): identity lives at the CONNECTION, not the ask. So recipes use `appHost` (the origin is
// auto-derived from the open `*.appHost` tab — the tab you're logged into IS the connection), and "my X" reads need
// no params: `verifyIdentity` triggers an identity probe whose user id fills `{me}` (e.g. `assignee:{me}`). The probe
// also closes the CS Tools trap — a logged-out session returns HTTP 200 + an anonymous sentinel, so a list read would
// look like "0 results"; verify the returned identity, never the status.

import { recipeToLeg } from './connectorLeg.js';
import { armable } from './rideRecipe.js';
import { AC_GQL as AC_GQL_DOCS } from './aircallGqlDocs.js';

/**
 * Substitute `{name}` placeholders in a template from `args`, URL-encoding each value. PURE.
 * An unfilled placeholder is left visible. Used for the origin, the endpoint path, and `{me}` (filled from the probe).
 */
export function fillEndpoint(template, args = {}) {
  const a = (args && typeof args === 'object') ? args : {};
  return String(template ?? '').replace(/\{([a-zA-Z_][\w-]*)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(a, name) ? encodeURIComponent(String(a[name])) : m);
}

const _SOLE_PLACEHOLDER = /^\{([a-zA-Z_][\w-]*)\}$/;
// v2.74.1657 — a VALUE that is an unfilled blank. DISTINCT from _SOLE_PLACEHOLDER above, which defines the
// {token} TEMPLATE syntax and must stay curly-only (fillEndpoint/fillBody parse with it — widening that would
// break template substitution itself). People and models write blanks three ways — [id], <id>, {id} — and all
// three are non-values. Live 125605/130630: "for [id]" bound `[id]` as a real param; it survived interpret,
// survived decompose, and reached two different executors, because only the curly form was rejected here.
const _PLACEHOLDER_VALUE = /^[[<{]\s*([a-zA-Z_][\w \-]*)\s*[\]>}]$/;
const _has = (a, name) => a && Object.prototype.hasOwnProperty.call(a, name);

// Recursively fill one body-template node. Returns {drop} when the node resolves to nothing (so an optional field /
// emptied object falls out of its parent), else {value}. A SOLE placeholder takes the arg's NATIVE value (number /
// boolean / string — so `status:'{status}'`→"solved", `assignee_id:'{me}'`→42, `public:'{public}'`→false); a mixed
// string interpolates to a string (unfilled placeholders left visible, mirroring fillEndpoint); literals pass through.
function _fillBodyNode(node, a) {
  if (typeof node === 'string') {
    const sole = node.match(_SOLE_PLACEHOLDER);
    // Drop the field when the arg reads as ABSENT: unfilled, '' / null / undefined, OR a bare placeholder token the
    // LLM binder ECHOED ("{company}") as the value for a param it couldn't fill (v1405). An empty/echoed optional must
    // NEVER ride the body — Shopify rejects phone:"" as "Phone is invalid" (v1403) and stores "{company}" LITERALLY in
    // an address. `false` / `0` are real values and stay — only ''/null/undefined/placeholder-echo read as absent.
    if (sole) { const val = _has(a, sole[1]) ? a[sole[1]] : undefined; return (val === '' || val == null || (typeof val === 'string' && _SOLE_PLACEHOLDER.test(val))) ? { drop: true } : { value: val }; }
    return { value: node.replace(/\{([a-zA-Z_][\w-]*)\}/g, (m, n) => (_has(a, n) ? String(a[n]) : m)) };
  }
  if (Array.isArray(node)) {
    const arr = [];
    for (const item of node) { const r = _fillBodyNode(item, a); if (!r.drop) arr.push(r.value); }
    return arr.length === 0 ? { drop: true } : { value: arr };     // an emptied array optional drops, symmetric with the object branch (so an all-unfilled addresses:[{…}] falls out clean)
  }
  if (node && typeof node === 'object') {
    const obj = {};
    let kept = 0;
    for (const [k, v] of Object.entries(node)) { const r = _fillBodyNode(v, a); if (!r.drop) { obj[k] = r.value; kept++; } }
    return kept === 0 ? { drop: true } : { value: obj };          // an object that fully empties drops from its parent
  }
  return { value: node };                                          // number / boolean / null literal
}

/**
 * Build a write request body from a recipe's body TEMPLATE + args. PURE. (§6 write flow / §12 binding.)
 * Optional fields whose placeholder is unfilled are OMITTED (not sent as the literal "{x}"); a GET (null template)
 * has no body → null. The required fields are enforced upstream by `paramSchema.required`, so a dropped field here is
 * always an intentionally-absent optional. `{me}` resolves from the identity probe just like an endpoint's `{me}`.
 */
export function fillBody(template, args = {}) {
  if (template == null) return null;
  const r = _fillBodyNode(template, (args && typeof args === 'object') ? args : {});
  return r.drop ? null : r.value;
}

/** Build a static Aircall Workspace GraphQL POST body from a HAR-captured document. PURE. */
export function acGqlBody(operationName, variables = {}) {
  const doc = AC_GQL_DOCS[operationName];
  if (!doc) return null;
  return { operationName: doc.operationName, variables, query: doc.query };
}

/** GraphQL endpoint for a named Aircall Workspace operation (`?name=` matches the SPA). PURE. */
export function acGqlEndpoint(operationName) {
  return `/graphql?name=${String(operationName || '')}`;
}

// The shared Zendesk session-ride identity (the operator's real queue, /api/v2 — same-origin + session-ride proven
// live, §12). `appHost` → origin auto-derived from the open `*.zendesk.com` tab; the probe fills `{me}` + closes the
// anonymous-sentinel trap (§14: a logged-out session returns 200 + an anon user, so verify identity, not status).
// All entries are GET reads (mode 'ask'); a TRUSTED curated read → safety 'auto'. Static query spaces are %20.
// FL-1c (v2.74.1347) — `itemUrl`: the HUMAN page for this recipe's object (the agent-workspace ticket view),
// templated on {id}. GROUND TRUTH: proposal/ledger targets link to the real page, assembled from TRUSTED data only
// (connection origin + this template + a sanitized id) — the model never mints URLs. view_user overrides (users).
const ZD = Object.freeze({ app: 'zendesk', appHost: 'zendesk.com', verifyIdentity: true, identityProbe: '/api/v2/users/me.json', method: 'GET', itemUrl: '/agent/tickets/{id}', console: '/agent' });   // v1704 — root → help centre; /agent → the agent sign-in (signInLandingPath exception)

/**
 * CX-7 (v2.74.1386) — is a GraphQL document READ-ONLY (a query, never a mutation/subscription)? The Shopify ride's
 * reads are POSTs, and a POST normally demands the HITL write gate — this predicate is what lets a curated GraphQL
 * READ run unconfirmed. Enforced at BOTH belts: background validates the template before dispatch, and the content
 * script re-validates the FINAL body at the execution boundary (ContentScripts SESSION_FETCH keeps an inline twin
 * of this exact logic — keep them in lockstep). String literals are stripped before the keyword scan. PURE.
 */
export function isReadOnlyGql(query) {
  const q = String(query || '').trim();
  if (!q || !/^(query\b|\{)/.test(q)) return false;
  const noStrings = q.replace(/"(?:[^"\\]|\\.)*"/g, '');
  return !(/\bmutation\b/i.test(noStrings) || /\bsubscription\b/i.test(noStrings));
}

// ── Shopify (CX-7, v2.74.1386 — from logs/run/ride-legs-spec.md §Shopify, the CS stack's LIVE implementation) ────
// Transport: the admin SPA's own GraphQL endpoint, POST /api/shopify/{handle} with {query, variables} — riding the
// user's real admin.shopify.com tab (no Playwright/Cloudflare problem: the logged-in tab IS the headed browser).
// `{handle}` (the store slug in /store/<handle>/…) fills from the RIDE TAB's URL (`urlParam`), never from the model.
// CSRF: REQUIRED on these POSTs and NOT in a meta tag — `csrf:'sniff'` makes INVOKE_SESSION capture `x-csrf-token`
// off the SPA's own outbound requests (MAIN-world tee) and cache it per origin. READ-ONLY BY POLICY (the spec's
// money=human-click-only rule): no Shopify mutations ship as recipes — their write path is store-captured persisted-op
// hashes that rotate on admin deploys (HASH_STALE), unportable as curated data; refunds/returns are navigate-only.
// Spec traps honored elsewhere: a 200-with-HTML login page = auth failure (SESSION_FETCH 'non-json'), and email/phone
// search returns NEAR-MATCHES — exact-match before binding a customer to anything (recipe `does` says so).
const _GQL_CUSTOMERS = 'query Customers($q: String!, $n: Int!) { customers(first: $n, query: $q) { edges { node { id firstName lastName email phone numberOfOrders tags defaultAddress { city province country } } } } }';
// CX-7c (v2.74.1388) — order read now carries RETURNS (return/exchange status + reverse tracking — the "where's my
// exchange?" question) and the refund AMOUNT (totalRefundedSet), plus the fulfillment event timeline. Spec §3.
const _GQL_ORDERS = 'query Orders($q: String!, $n: Int!) { orders(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) { edges { node { id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet { shopMoney { amount currencyCode } } customer { email } lineItems(first: 10) { edges { node { title quantity } } } fulfillments { status displayStatus estimatedDeliveryAt deliveredAt trackingInfo { number company url } events(first: 10) { edges { node { status happenedAt } } } } returns(first: 10) { edges { node { id status returnLineItems(first: 10) { edges { node { quantity } } } reverseFulfillmentOrders(first: 5) { edges { node { reverseDeliveries(first: 5) { edges { node { deliverable { ... on ReverseDeliveryShippingDeliverable { tracking { carrierName number url } } } } } } } } } } } } refunds { createdAt note totalRefundedSet { shopMoney { amount currencyCode } } } tags note } } } }';
const _GQL_PRODUCTS = 'query Products($q: String!, $n: Int!) { products(first: $n, query: $q) { edges { node { id title status totalInventory variants(first: 10) { edges { node { id title sku price inventoryQuantity } } } } } } }';
// CX-7c — the LIVENESS probe document: `{ shop { name } }` (spec §2 probeShopify). `shopProbe:true` makes
// INVOKE_SESSION run it once (cached) before the call — a clean signed-out verdict instead of a mid-call surprise.
// LEG-1 (v2.74.1593) — the same read, NAMED, as a standalone recipe document (the RH-0a contract 404s anonymous
// docs): the store-pulse canary's query. Tiny on purpose — the VERDICT is the value (session + route health).
const _GQL_SHOP = 'query Shop { shop { name currencyCode } }';
const SH = Object.freeze({
  app: 'shopify', appHost: 'admin.shopify.com', method: 'POST', gql: true, csrf: 'sniff', contentType: 'application/json',
  endpoint: '/api/shopify/{handle}', urlParam: { name: 'handle', pattern: '\\/store\\/([^\\/]+)' }, shopProbe: true,
  // RH-0a (v2.74.1564, DESIGN_route_heal.md §2) — the HAR-verified request contract (2026-07-17, 43/43 working
  // calls): the BFF now ROUTES on `?operation=<name>&type=query` + body `operationName` (anonymous docs → the
  // live http-404-empty), and the admin sends these two static headers on every call. The Userdigest lesson
  // made curated: headers are part of the route — keep what the capture shows, credential class excluded
  // (cookies/CSRF stay runtime-acquired by the sniffer).
  requestHeaders: { 'apollographql-client-name': 'core', 'shopify-proxy-api-enable': 'true' },
});

// ── VendorSuite (D.R. Horton vendor portal, vendorsuite.drhorton.com) — CX-9 (v2.74.1431), authored from HAR captures.
// SAME-ORIGIN COOKIE-RIDE: the SPA's own /api/* reads, riding the vendor's logged-in session — NO Bearer/Authorization
// header (v1430's cookie fallback carries them). {divisionId} = the D.R. Horton MARKET/division (Atlanta West-210 = 83,
// Seattle-750 = 10, …); the VENDOR (e.g. DEAKO) is the session, the DIVISION is the variable. Resolve {divisionId} from
// /api/VendorSuite/State: `access.DefaultDivision.Id` = the current division; `access.Hubs[].Divisions` = the whole list
// the vendor can pick (the #divisionMenu). {status} ∈ new | open | fixed | closed. Reads only here — the warranty-note
// WRITE (POST UpdateCompleteTask, form-urlencoded taskId+note) is a follow-on: it needs the form-urlencoded cookie-ride
// write transport verified AND recipeFromCatalogEntry taught to carry write/body/bodyType (today's lossy projection drops
// them), so it stays out of the curated surface until both land.
// CP-1 (v2.74.1506) — VendorSuite's auth spec: a JSON-LIVENESS probe (`probeAccept:'json'`), NOT an identity probe —
// the State read is user-scoped (access/DefaultDivision) but carries no {id,email} user shape, and when the SSO
// session expires it 403s. So: parseable JSON 2xx = signed in; anything else = signed out. NO `verifyIdentity`
// (no per-ride pre-flight — rides are bursty; outcomes + the heartbeat carry the presence instead).
const VS = Object.freeze({ app: 'vendorsuite', appHost: 'vendorsuite.drhorton.com', method: 'GET', identityProbe: '/api/VendorSuite/State', probeAccept: 'json' });
// CX-9b (v2.74.1434) — the DIVISION ID layer, as recipe DATA (the live test's lesson: users speak market language —
// "Atlanta West" / "210" — the API speaks internal ids — 83; wrong id = a silent empty list, not an error). The
// `resolve` marker declares how {divisionId} maps via the app's OWN State read: missing → the user's current division
// (DefaultDivision), a market number → Code match, a name → Name match; a Code/Id collision asks instead of guessing.
// Mechanism: Core/rideParamResolve.js + the panel dispatch hook — nothing VS-specific outside this spec.
const VS_DIVISION = Object.freeze({
  via: '/api/VendorSuite/State',
  defaultPath: 'access.DefaultDivision.Id',
  lists: ['currentHub.Divisions', 'access.Hubs[].Divisions'],
  match: ['Code', 'Name'],
  id: 'Id', label: 'Name',
  each: true,   // DK-7 (v2.74.1488) — "for each division…" fans the READ out over every accessible division (the model binds divisionId:"each"; reads only, capped)
});

// ── Aircall Workspace (CX-10, v2.74.1456) — HAR-authored from workspace.aircall.io + Zendesk CTI outbound captures.
// Transport: same-origin cookie-ride on workspace.aircall.io (CTI iframe OR standalone tab). GraphQL ops POST to
// `/graphql?name=<Operation>` with static documents in Core/aircallGqlDocs.js; REST BFF reads carry `requestHeaders`.
// Identity: `/v5/users/current_user` fills `{me}` (flat user shape — Core/connection.js probedUser). Place/answer/hangup
// are Twilio WebRTC — NOT recipes; DOM legs in the CTI iframe handle the media plane.
const _AC_HDR = Object.freeze({ 'aircall-platform': 'aircall-workspace' });
const _AC_AVAIL_Q = 'rules[]=phone_v4&rules[]=phone_v3&rules[]=client_v1';
// v2.74.1477 — requestHeaders BACK on the base (v1475 REVERTED): the v1476 wire trace disproved v1475's premise —
// `aircall-platform` was in the SENT set of a FAILING /graphql call, sourced from the CAPTURED bundle, i.e. the SPA
// DOES send it on /graphql. The 401 was never the header (err:"Token has expired."); v1475's +hdrs correlation was
// coincidental token-freshness. So `aircall-platform` rides ALL aircall calls, gql included.
const AC = Object.freeze({
  app: 'aircall', appHost: 'workspace.aircall.io', verifyIdentity: true,
  identityProbe: '/v5/users/current_user?activation_state=active', requestHeaders: _AC_HDR,
});
const AC_GQL = Object.freeze({ ...AC, method: 'POST', gql: true, contentType: 'application/json' });

// ── HubSpot (HS-1, v2.74.1595) — HAR-authored from app.hubspot.com (2026-07-17 capture, credential-blind analysis).
// SAME-ORIGIN COOKIE-RIDE: the app's own /api/* reads on app.hubspot.com, riding the user's logged-in session — NO
// Bearer. {portalId} = the HubSpot account/hub id, in the app URL path (`app.hubspot.com/<section>/<portalId>/…`,
// referer-proven) AND required as `?portalId=` on every API call — so it fills from the RIDE TAB's URL (`urlParam`,
// the Shopify-{handle} pattern; but in the QUERY, not the path), never from the model. One workspace per session
// (the HAR carried exactly 1 portalId). CSRF: the app sends `x-hubspot-csrf-hubspotapi` on POSTs (credential class,
// sniffed at runtime, NEVER banked) — the GET reads below need no token. LIVENESS (CP-1 pattern, mirrors VendorSuite):
// a JSON-2xx from `/api/login-verify/hub-user-info` = signed in; a redirect/401/non-JSON = signed out. NOT a
// `verifyIdentity` probe — hub-user-info's user shape is `{user_id, email}` (not the `{id}` probedUser/isAnonUser
// key on), so identity extraction would MISFIRE a signed-in user as anon; JSON-liveness is the honest verdict, and
// the identity NAME is deliberately absent (like the vendorsuite row). Frontend telemetry query params
// (`hs_static_app`/`clienttimeout`) are DROPPED — not part of the API contract; route-heal surfaces a surprise.
// Object type-ids are stable HubSpot constants: 0-1 Contact, 0-2 Company, 0-3 Deal, 0-5 Ticket.
const HS = Object.freeze({
  app: 'hubspot', appHost: 'app.hubspot.com', method: 'GET',
  identityProbe: '/api/login-verify/hub-user-info', probeAccept: 'json',
  urlParam: { name: 'portalId', pattern: 'app\\.hubspot\\.com\\/[a-z][a-z0-9-]*\\/(\\d{5,})' },
});

/**
 * CX-7c (v2.74.1388) — coerce a Shopify object id to a gid. Reads return `id` as a full gid
 * (`gid://shopify/Customer/123`); the model usually passes that back, but a bare numeric or a `#`-prefixed value
 * is normalized to the gid the write needs. A value that is already a gid passes through. PURE.
 */
export function toShopifyGid(value, kind) {
  const s = String(value == null ? '' : value).trim();
  if (!s || !kind) return s;
  if (/^gid:\/\/shopify\//i.test(s)) return s;
  const digits = s.replace(/[^0-9]/g, '');
  return digits ? `gid://shopify/${kind}/${digits}` : s;
}

// The curated catalog — full CRUD (CX-3/4a reads + CX-6a writes). `{me}` resolves server-side from the session cookie,
// so "my X" reads are param-free (no LLM binder, §13); by-id / search reads carry one typed param. A WRITE adds
// `write:true`, a non-GET `method`, and a `body` template (fillBody substitutes its `{param}`s). Writes are gated HARD
// (§9, full-session blast radius): the executor refuses a non-GET without an explicit post-HITL `confirmed:true`, so
// every write here is fail-closed until the human approves it — these definitions are the WHAT, not an auto-run grant.
// Excluded on purpose: ticket DELETE + status:closed (irreversible/admin — kept off the session-ride surface); money /
// inventory mutations stay navigate-only human-clicks, never a recipe (§9).
export const CONNECTOR_RECIPES = [
  // ── "my X" queue reads — param-free (identity = the session) ──────────────────────────────────────────────────
  // FL-1d (v2.74.1349) — `listUrl`: the COLLECTION's human page (the itemUrl counterpart for list-shaped reads).
  // These are search reads, so the honest view is the agent search page running the SAME query — "show me" after
  // "how many open tickets" opens the list the count came from, not a random item.
  // FL-10b (v2.74.1383) — `drill: { via }`: rows from this LIST read may be evidence-drilled through the named
  // comments read (fleet triage → per-ticket thread fetch → deterministic extract; Core/ticketEvidence.js).
  // Recipe DATA declares drillability; the fleet harness only follows the marker.
  { ...ZD, id: 'my_open_tickets', name: 'My open Zendesk tickets', pulse: { scope: 'mine', status: 'open' }, drill: { via: 'ticket_comments' },
    does: 'list your OPEN Zendesk tickets (assigned to you), riding your Zendesk login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:open%20assignee:{me}&per_page=25&sort_by=created_at&sort_order=desc',
    listUrl: '/agent/search/1?type=ticket&q=status%3Aopen%20assignee%3Ame',
    params: [] },
  { ...ZD, id: 'my_pending_tickets', name: 'My pending Zendesk tickets', pulse: { scope: 'mine', status: 'pending' },
    does: 'list your PENDING Zendesk tickets (awaiting the customer, assigned to you), riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:pending%20assignee:{me}&per_page=25&sort_by=updated_at&sort_order=desc',
    listUrl: '/agent/search/1?type=ticket&q=status%3Apending%20assignee%3Ame',
    params: [] },
  { ...ZD, id: 'my_solved_tickets', name: 'My recently solved Zendesk tickets',
    does: 'list your recently SOLVED Zendesk tickets (assigned to you), riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:solved%20assignee:{me}&per_page=25&sort_by=updated_at&sort_order=desc',
    listUrl: '/agent/search/1?type=ticket&q=status%3Asolved%20assignee%3Ame',
    params: [] },
  // ── FL-8a (v2.74.1358) — the ADMIN-view reads: the whole queue, not just mine (the fleet sweep's working set).
  // `pulse` (v1359; enriched v1375) — the read's GENERIC digest semantics, as DATA: {kind, scope, status}.
  // kind ('inventory' | 'backlog' | 'inflow') keys the harness's spike/count bookkeeping; scope+status place the
  // read's exact API `count` into the queue-state breakdown ("You: 4 open · 3 pending / Team: 32 open · 3
  // unassigned") — CODE assembles counts, the model never counts. Never keyed on a recipe id — a Gmail fleet app
  // tags its own reads and gets the same digest for free (the portability test). ──
  { ...ZD, id: 'all_open_tickets', name: 'All open Zendesk tickets (whole queue)', pulse: { kind: 'inventory', scope: 'team', status: 'open' }, drill: { via: 'ticket_comments' },
    does: 'list ALL open Zendesk tickets across the whole queue — everyone’s and unassigned, oldest first (the admin/queue-review view, not just yours), riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:open&per_page=100&sort_by=created_at&sort_order=asc',
    listUrl: '/agent/search/1?type=ticket&q=status%3Aopen',
    params: [] },
  { ...ZD, id: 'unassigned_tickets', name: 'Unassigned Zendesk tickets', pulse: { kind: 'backlog', scope: 'team', status: 'unassigned' }, drill: { via: 'ticket_comments' },
    does: 'list open Zendesk tickets with NO assignee (the assignment backlog), oldest first, riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:open%20assignee:none&per_page=100&sort_by=created_at&sort_order=asc',
    listUrl: '/agent/search/1?type=ticket&q=status%3Aopen%20assignee%3Anone',
    params: [] },
  { ...ZD, id: 'tickets_last_day', name: 'Zendesk tickets created in the last 24h', pulse: { kind: 'inflow' }, drill: { via: 'ticket_comments' },
    does: 'list Zendesk tickets CREATED in the last 24 hours (new-volume pulse — the digest / spike-detection feed), riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20created>24hours&per_page=100&sort_by=created_at&sort_order=desc',
    listUrl: '/agent/search/1?type=ticket&q=created%3E24hours',
    params: [] },
  // ── by-id / search reads — one typed param ───────────────────────────────────────────────────────────────────
  { ...ZD, id: 'read_ticket', name: 'Read a Zendesk ticket',
    does: 'fetch one Zendesk ticket by its number and summarize its DETAILS AS TEXT in the chat (for "what does it say / what’s it about" asks — NOT for showing/opening the page itself)',
    endpoint: '/api/v2/tickets/{id}.json',
    params: [{ name: 'id', type: 'integer', required: true }] },
  { ...ZD, id: 'ticket_comments', name: 'Read a Zendesk ticket conversation',
    does: 'read the full conversation (all comments, oldest first) on a Zendesk ticket by number, riding your login',
    endpoint: '/api/v2/tickets/{id}/comments.json?sort_order=asc',
    params: [{ name: 'id', type: 'integer', required: true }] },
  { ...ZD, id: 'search_tickets', name: 'Search Zendesk tickets',
    does: 'search your Zendesk tickets by keywords or a query (e.g. a subject, requester, or tag), riding your login',
    endpoint: '/api/v2/search.json?query={query}%20type:ticket&per_page=25&sort_by=updated_at&sort_order=desc',
    listUrl: '/agent/search/1?type=ticket&q={query}',
    params: [{ name: 'query', type: 'string', required: true }] },
  { ...ZD, id: 'view_user', name: 'Look up a Zendesk user',
    does: 'look up a Zendesk user (a requester / customer) by id, riding your login',
    endpoint: '/api/v2/users/{id}.json', itemUrl: '/agent/users/{id}',
    params: [{ name: 'id', type: 'integer', required: true }] },
  // ── writes — gated HARD; fail-closed until the human confirms (CX-6/§9). Each carries a `body` template. ──────────
  { ...ZD, id: 'create_ticket', name: 'Create a Zendesk ticket', write: true, reversible: true, outward: false, method: 'POST',
    does: 'open a NEW Zendesk ticket with a subject + first comment (optionally a priority / requester id), riding your login',
    endpoint: '/api/v2/tickets.json',
    body: { ticket: { subject: '{subject}', comment: { body: '{comment}' }, priority: '{priority}', requester_id: '{requester_id}' } },
    params: [
      { name: 'subject', type: 'string', required: true },
      { name: 'comment', type: 'string', required: true },
      { name: 'priority', type: 'string', required: false, enum: ['low', 'normal', 'high', 'urgent'] },
      { name: 'requester_id', type: 'integer', required: false },
    ] },
  { ...ZD, id: 'add_comment', name: 'Comment on a Zendesk ticket', write: true, reversible: false, outward: false, method: 'PUT',
    does: 'add a comment to a Zendesk ticket — public=true REPLIES to the customer, public=false adds an INTERNAL note — riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { comment: { body: '{comment}', public: '{public}' } } },
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'comment', type: 'string', required: true },
      { name: 'public', type: 'boolean', enum: [true, false], required: true },   // force the model to classify visibility — no accidental public reply
    ] },
  // FL-10c (v2.74.1383) — `autoRequires: 'evidence'`: UNATTENDED execution of this class needs same-run
  // CODE-verified proof (a drill verdict: POSITIVE sentiment + no open commitment + mine, or an aged empty stub)
  // on top of the autonomy policy. A human approving from a card is never gated by this.
  { ...ZD, id: 'update_ticket_status', name: 'Set a Zendesk ticket status', write: true, reversible: true, outward: false, method: 'PUT', autoRequires: 'evidence',
    does: 'change a Zendesk ticket status (open / pending / hold / solved), riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { status: '{status}' } },
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'status', type: 'string', enum: ['open', 'pending', 'hold', 'solved'], required: true },   // 'closed' excluded — terminal
    ] },
  { ...ZD, id: 'assign_ticket_to_me', name: 'Assign a Zendesk ticket to me', write: true, reversible: true, outward: false, method: 'PUT',
    does: 'assign a Zendesk ticket to YOURSELF (the logged-in agent), riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { assignee_id: '{me}' } },   // {me} fills from the identity probe — the assignee is NOT an ask param
    params: [{ name: 'id', type: 'integer', required: true }] },
  { ...ZD, id: 'update_ticket_priority', name: 'Set a Zendesk ticket priority', write: true, reversible: true, outward: false, method: 'PUT',
    does: 'change a Zendesk ticket priority (low / normal / high / urgent), riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { priority: '{priority}' } },
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'priority', type: 'string', enum: ['low', 'normal', 'high', 'urgent'], required: true },
    ] },
  { ...ZD, id: 'add_tags', name: 'Add tags to a Zendesk ticket', write: true, reversible: true, outward: false, method: 'PUT',
    does: 'add one or more tags to a Zendesk ticket (appends — does not replace), riding your login',
    endpoint: '/api/v2/tickets/{id}/tags.json',
    body: { tags: '{tags}' },                    // {tags} is a sole placeholder → the array passes through natively
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'tags', type: 'array', required: true },
    ] },
  { ...ZD, id: 'reassign_group', name: 'Move a Zendesk ticket to a group', write: true, reversible: true, outward: false, method: 'PUT',
    does: 'reassign a Zendesk ticket to a different group by group id, riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { group_id: '{group_id}' } },
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'group_id', type: 'integer', required: true },
    ] },
  // ── FL-8a (v2.74.1358) — the requester-fix pair: create the customer profile, then attach it to the ticket. ──
  { ...ZD, id: 'create_user', name: 'Create a Zendesk user (customer profile)', write: true, reversible: true, outward: false, method: 'POST',
    does: 'create a Zendesk END-USER (customer) profile with a name + email — e.g. to become the requester on a ticket that has none, riding your login',
    endpoint: '/api/v2/users.json', itemUrl: '/agent/users/{id}',
    body: { user: { name: '{name}', email: '{email}', role: 'end-user' } },   // role is a LITERAL — a sweep can never mint agents/admins
    params: [
      { name: 'name', type: 'string', required: true },
      { name: 'email', type: 'string', required: true },
    ] },
  { ...ZD, id: 'set_ticket_requester', name: 'Set a Zendesk ticket requester', write: true, reversible: true, outward: false, method: 'PUT',
    does: 'attach a requester (customer profile, by user id) to a Zendesk ticket — for tickets missing one, riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { requester_id: '{requester_id}' } },
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'requester_id', type: 'integer', required: true },
    ] },
  // ── destructive / consolidating — gated (the human approves; still fail-closed until CX-6b). User may also pick DOM. ──
  { ...ZD, id: 'merge_tickets', name: 'Merge Zendesk tickets', write: true, reversible: false, outward: false, destructive: true, method: 'POST',
    does: 'merge one or more SOURCE tickets INTO a target ticket (the sources are closed) — consolidating, riding your login',
    endpoint: '/api/v2/tickets/{id}/merge.json',
    // NOTE: merge returns a job_status (202 async) — the executor reports "queued"; the job-poll is a follow-up (CX-6c).
    body: { ids: '{source_ids}', target_comment: '{target_comment}', source_comment: '{source_comment}' },
    params: [
      { name: 'id', type: 'integer', required: true },        // the TARGET ticket (survives)
      { name: 'source_ids', type: 'array', required: true },  // tickets merged into the target, then closed
      { name: 'target_comment', type: 'string', required: false },
      { name: 'source_comment', type: 'string', required: false },
    ] },
  { ...ZD, id: 'mark_as_spam', name: 'Mark a Zendesk ticket as spam', write: true, reversible: false, outward: false, destructive: true, method: 'PUT',
    does: 'mark a Zendesk ticket as spam AND suspend its requester (hard to undo), riding your login',
    endpoint: '/api/v2/tickets/{id}/mark_as_spam.json',     // no body
    params: [{ name: 'id', type: 'integer', required: true }] },
  { ...ZD, id: 'delete_ticket', name: 'Delete a Zendesk ticket', write: true, reversible: false, outward: false, destructive: true, method: 'DELETE',
    does: 'permanently delete a Zendesk ticket by number (irreversible), riding your login',
    endpoint: '/api/v2/tickets/{id}.json',                  // no body
    params: [{ name: 'id', type: 'integer', required: true }] },

  // ── Shopify reads (CX-7) — GraphQL query documents are STATIC (params fill only the `variables`), so the
  // read-only belt validates a fixed text. All READ-ONLY by policy — no Shopify write recipes exist on purpose. ──
  // FL-1c/CX-7e (v2.74.1393) — `itemUrl`: the record's HUMAN admin page ("show profile" opens it, like "show ticket"
  // on Zendesk). {handle} fills from the read's tab-derived urlParam (the same /store/<handle>/ the read rode);
  // {id} is the RESULT's record id (a customer lookup by email → the customer gid, tail-stripped to numeric).
  { ...SH, id: 'shopify_customer_by_email', name: 'Find a Shopify customer by email', itemUrl: '/store/{handle}/customers/{id}',
    does: 'look up Shopify customer(s) by EMAIL, riding your admin login — search returns near-matches: confirm the exact email before trusting a hit',
    endpoint: '/api/shopify/{handle}?operation=Customers&type=query',
    body: { operationName: 'Customers', query: _GQL_CUSTOMERS, variables: { q: 'email:"{email}"', n: 5 } },
    params: [{ name: 'email', type: 'string', required: true }] },
  { ...SH, id: 'shopify_customer_by_phone', name: 'Find a Shopify customer by phone', itemUrl: '/store/{handle}/customers/{id}',
    does: 'look up Shopify customer(s) by PHONE number, riding your admin login — search returns near-matches: confirm the digits match exactly before trusting a hit',
    endpoint: '/api/shopify/{handle}?operation=Customers&type=query',
    body: { operationName: 'Customers', query: _GQL_CUSTOMERS, variables: { q: 'phone:"{phone}"', n: 5 } },
    params: [{ name: 'phone', type: 'string', required: true }] },
  // v2.74.1563 — the NAME lookup (live: "does Mousab have a shopify profile?" — the most natural CS ask had no
  // leg; only email/phone existed, so interpret force-fit the email leg). Shopify search matches bare words
  // against names; the near-match warning applies doubly (same/similar names are common).
  { ...SH, id: 'shopify_customer_search', name: 'Search Shopify customers by name', itemUrl: '/store/{handle}/customers/{id}',
    does: 'search Shopify customers by NAME (or any free search words), riding your admin login — returns near-matches: same or similar names are common, confirm the email before trusting a hit',
    endpoint: '/api/shopify/{handle}?operation=Customers&type=query',
    body: { operationName: 'Customers', query: _GQL_CUSTOMERS, variables: { q: '{query}', n: 5 } },
    params: [{ name: 'query', type: 'string', required: true, hint: 'the customer\'s name or free search words — for an exact email use the by-email lookup' }] },
  { ...SH, id: 'shopify_orders_for_customer', name: 'Shopify orders for a customer',
    does: 'list a customer’s recent Shopify orders by their EMAIL (status, totals, line items, fulfillment/tracking, refunds), riding your admin login',
    endpoint: '/api/shopify/{handle}?operation=Orders&type=query',
    body: { operationName: 'Orders', query: _GQL_ORDERS, variables: { q: 'email:"{email}"', n: 5 } },
    params: [{ name: 'email', type: 'string', required: true }] },
  { ...SH, id: 'shopify_order', name: 'Look up a Shopify order', itemUrl: '/store/{handle}/orders/{id}',
    does: 'fetch one Shopify order by its ORDER NUMBER (digits, e.g. 69872 — not the DEAKO# prefix): status, totals, line items, fulfillment/tracking, refunds — riding your admin login',
    endpoint: '/api/shopify/{handle}?operation=Orders&type=query',
    body: { operationName: 'Orders', query: _GQL_ORDERS, variables: { q: 'name:{order}', n: 3 } },
    params: [{ name: 'order', type: 'string', required: true }] },
  { ...SH, id: 'shopify_search_products', name: 'Search Shopify products',
    does: 'search Shopify products by title / sku / tag query (with variants, price, inventory), riding your admin login',
    endpoint: '/api/shopify/{handle}?operation=Products&type=query',
    body: { operationName: 'Products', query: _GQL_PRODUCTS, variables: { q: '{query}', n: 5 } },
    params: [{ name: 'query', type: 'string', required: true }] },
  // LEG-1 (v2.74.1593) — the STORE PULSE: the CX-7c liveness document promoted to a standalone, PARAMS-FREE
  // curated read. This is Shopify's CANARY (DESIGN_vitals.md §6 — the recorded no-canary blind spot): every other
  // SH read takes a required param, so the daily visit had nothing safe to run and the ground sat drift-blind
  // between real uses. pulse-marked so pickCanary prefers it; {handle} fills from the ride tab or the funnel-banked
  // lastUrlArgs (the ephemeral visit has no /store/ tab — the banked fallback is what makes this runnable there).
  { ...SH, id: 'shopify_shop_pulse', name: 'Shopify store pulse', pulse: { kind: 'liveness' },
    does: 'confirm the Shopify admin session and store identity (a tiny read-only health check — the canary the daily visit runs), riding your admin login',
    endpoint: '/api/shopify/{handle}?operation=Shop&type=query',
    body: { operationName: 'Shop', query: _GQL_SHOP, variables: {} },
    params: [] },
  // SH-Q1 (v2.74.1558) — the QUEUE leg: the first LIST-shaped Shopify read, the entry point the desk/case
  // machinery fans out over (sweep → per-order cases → "show this order"), mirroring vs_warranty_tasks' shape:
  // listUrl = the section-open + on-site-open eligibility; drill = dossier depth at case spawn + the cold
  // on-site open's row join. drill.from feeds the row's OWN `name` back into the by-number lookup — a prefixed
  // name ("DEAKO#69872") matches itself in Shopify search syntax, so the join is self-consistent by construction.
  // Query FIXED (status:open + not fully fulfilled): the queue IS the fulfillment backlog — separate simple legs
  // over one param-switched one, the by_email/by_phone house pattern. No each-mode (one store per handle).
  { ...SH, id: 'shopify_orders_queue', name: 'Open unfulfilled Shopify orders', listUrl: '/store/{handle}/orders',
    drill: { via: 'shopify_order', param: 'order', from: 'name', matchOn: 'order', label: ['name', 'id', 'displayFulfillmentStatus', 'displayFinancialStatus'] },
    does: 'THE fulfillment queue: open orders not yet (fully) fulfilled, newest first — number, date, payment/fulfillment status, total, customer email, line items, tracking. Give an order number to drill straight into that one; say "on the site" to open it on the admin orders page. Fans out: "open each in a case"',
    endpoint: '/api/shopify/{handle}?operation=Orders&type=query',
    body: { operationName: 'Orders', query: _GQL_ORDERS, variables: { q: 'status:open fulfillment_status:unfulfilled', n: 10 } },
    params: [
      { name: 'order', type: 'string', required: false, hint: 'an ORDER NUMBER — set ONLY when the user names one specific order to drill into' },   // NOT in the body — the drill join's filter, like vs_warranty_tasks' `address`
    ] },

  // ── Shopify write (CX-7b, v2.74.1387) — the spec's ALLOWED mutation class (customer create is NOT money; the
  // banned classes stay banned: refunds/returns/inventory never ship as recipes). Shopify admin mutations are
  // PERSISTED OPERATIONS: POST /api/operations/<sha256>/<OpName>/shopify/<handle> — the sha is per-store and
  // rotates on admin deploys, so it is NEVER curated data: `persistedOp` makes INVOKE_SESSION fill {op_sha} from
  // the per-origin op bank the MAIN-world tee captures off the SPA's own traffic (create one customer by hand
  // once with the tab ridden → the op is banked; a stale hash after a deploy re-captures the same way).
  // Fail-closed like every write: confirmed:true at both belts + sniffed CSRF; 200-with-userErrors = failure.
  // PP-4 (v2.74.1680, USER DECISION) — `reversible: true, outward: false`: this write may run unattended inside
  // a reviewed pipeline run. Their stated policy: profile creation is "a system internal step, and it is
  // reversible" — nothing leaves our boundary and we can delete what we made.
  //
  // It does NOT loosen the ordinary path. `hintToSafety` is raise-only and still floors this at `confirm`, and
  // both executor belts still fail closed without `confirmed:true`. The axes are read only by
  // `Core/pipelineGate.js`, which has the run, the trial and the case around it. Two gates, different scopes.
  //
  // The declaration is an OPT-IN by design: absence means undeclared, and `gateAction` fails an undeclared write
  // CLOSED. That is why this sits on one recipe and not on a shared default.
  { ...SH, id: 'shopify_create_customer', name: 'Create a Shopify customer', write: true, gql: false, persistedOp: 'CustomerCreate',
    reversible: true, outward: false,
    does: 'create a NEW Shopify customer profile (name + email and/or phone — at least one contact is required; optional mailing address), riding your admin login',
    endpoint: '/api/operations/{op_sha}/CustomerCreate/shopify/{handle}', itemUrl: '/store/{handle}/customers/{id}',   // CX-7f — "show customer" after a create opens the new record (id from the reply, handle from the ride tab)
    // CX-7 — the optional mailing address rides as customerInput.addresses[0]. With NO address field set, the inner
    // object empties → the array empties → `addresses` drops entirely (the array-drop symmetry in _fillBodyNode), so
    // a contact-only create is byte-identical to before. province/country map to the GraphQL CODES (provinceCode
    // "WA", countryCode "US"); if this store's persisted op wants names or a different key, the live userErrors names
    // it (same hand-authored-guess caveat as the op variable shape — CX-8 body-capture forges this exactly later).
    body: { operationName: 'CustomerCreate', variables: { customerInput: {
      firstName: '{first_name}', lastName: '{last_name}', email: '{email}', phone: '{phone}', note: '{note}',
      addresses: [{ address1: '{address1}', address2: '{address2}', city: '{city}', provinceCode: '{province}', countryCode: '{country}', zip: '{zip}', company: '{company}' }],
    } } },
    params: [
      { name: 'first_name', type: 'string', required: true },
      { name: 'last_name', type: 'string', required: true },
      { name: 'email', type: 'string', required: false },      // email OR phone — unfilled optionals drop from the body (fillBody);
      { name: 'phone', type: 'string', required: false },      // Shopify rejects a contactless input with userErrors (surfaced honestly)
      { name: 'note', type: 'string', required: false },
      { name: 'address1', type: 'string', required: false },   // street — the presence of any address field builds addresses[0]
      { name: 'address2', type: 'string', required: false },
      { name: 'city', type: 'string', required: false },
      { name: 'province', type: 'string', required: false },   // → provinceCode, e.g. "WA"
      { name: 'country', type: 'string', required: false },    // → countryCode, e.g. "US"
      { name: 'zip', type: 'string', required: false },
      { name: 'company', type: 'string', required: false },
    ] },
  // CX-7c (v2.74.1388) — EDIT an existing customer (spec's ALLOWED EditCustomer op). Partial: only filled fields
  // ride the body (fillBody drops unfilled optionals). `customer_gid` gid-coerces (bare id → gid) — it's the `id`
  // a customer read returned.
  { ...SH, id: 'shopify_update_customer', name: 'Edit a Shopify customer', write: true, reversible: false, outward: false, gql: false, persistedOp: 'EditCustomer',
    does: 'update fields on an EXISTING Shopify customer (name, email, phone, note, tags) — only the fields you set change; identify them by the customer id from a lookup',
    endpoint: '/api/operations/{op_sha}/EditCustomer/shopify/{handle}', itemUrl: '/store/{handle}/customers/{id}',   // CX-7f — "show customer" after an edit opens the record
    body: { operationName: 'EditCustomer', variables: { input: { id: '{customer_gid}', firstName: '{first_name}', lastName: '{last_name}', email: '{email}', phone: '{phone}', note: '{note}', tags: '{tags}' } } },
    params: [
      { name: 'customer_gid', type: 'string', required: true, gid: 'Customer' },
      { name: 'first_name', type: 'string', required: false },
      { name: 'last_name', type: 'string', required: false },
      { name: 'email', type: 'string', required: false },
      { name: 'phone', type: 'string', required: false },
      { name: 'note', type: 'string', required: false },
      { name: 'tags', type: 'array', required: false },
    ] },
  // CX-7c (v2.74.1388) — create a DRAFT order (spec: "safe/reversible" — a draft is NOT a charge; completing it is
  // the money step and stays HUMAN-CLICK, never a recipe). The FOC/warranty-replacement path: pass a 100%
  // PERCENTAGE `applied_discount` + a zero `shipping_line`. Nested structures ride as WHOLE object params (sole
  // placeholders → native value; unfilled → dropped), so an ordinary paid draft omits them cleanly.
  { ...SH, id: 'shopify_create_order', name: 'Create a Shopify draft order', write: true, reversible: true, outward: false, gql: false, persistedOp: 'DraftOrderCreate',
    does: 'create a DRAFT order for a customer (line items by variant id + quantity) — a reversible draft the human reviews and completes; for a free warranty replacement pass a 100% applied_discount and a zero shipping_line',
    endpoint: '/api/operations/{op_sha}/DraftOrderCreate/shopify/{handle}', itemUrl: '/store/{handle}/draft_orders/{id}',   // CX-7f — "show order" after a create opens the draft
    body: { operationName: 'DraftOrderCreate', variables: {
      input: { purchasingEntity: { customerId: '{customer_gid}' }, lineItems: '{line_items}', useCustomerDefaultAddress: true, note: '{note}', poNumber: '{po_number}', tags: '{tags}', appliedDiscount: '{applied_discount}', shippingLine: '{shipping_line}' },
      hasDiscountsPermission: true, hasVaultedPaymentPermissions: true, firstLineItems: 50 } },
    params: [
      { name: 'customer_gid', type: 'string', required: true, gid: 'Customer' },   // purchasingEntity.customerId — the customer's id from a lookup
      { name: 'line_items', type: 'array', required: true },   // [{ variantId: 'gid://shopify/ProductVariant/…', quantity: 1 }] — variant ids from a product search
      { name: 'note', type: 'string', required: false },
      { name: 'po_number', type: 'string', required: false },
      { name: 'tags', type: 'array', required: false },
      { name: 'applied_discount', type: 'object', required: false },   // { value, valueType: 'PERCENTAGE'|'FIXED_AMOUNT', title } — 100% PERCENTAGE for a warranty replacement
      { name: 'shipping_line', type: 'object', required: false },       // { title, price } — { price: '0.00' } for free shipping
    ] },
  // ── VendorSuite (CX-9) — the curated cookie-ride READS. {divisionId}/{status}/{taskId} are explicit params for now;
  // the convivial auto-fill of {divisionId} from VendorSuite/State (access.DefaultDivision.Id) is the next slice.
  // FL-1c/1d (v2.74.1432) — `itemUrl`/`listUrl`: VendorSuite is a hash-route SPA with ONLY 4 sections (#warranty /
  // #dashboard / #settings / #documents — no per-task route), so "show warranty" opens the #warranty SECTION (the
  // honest home of the task), exactly like "show ticket" opens a Zendesk ticket. The section link carries no {id}
  // placeholder — the read's result id has nowhere per-task to go, so it just opens the section the object lives in. ──
  { ...VS, id: 'vs_state', name: 'My VendorSuite state', itemUrl: '/#dashboard',
    does: 'read your VendorSuite state — your current division, the divisions you can access, your permissions, and current announcements — riding your login',
    endpoint: '/api/VendorSuite/State', params: [] },
  { ...VS, id: 'vs_versions', name: 'VendorSuite versions',
    does: 'the VendorSuite app component versions and environment',
    endpoint: '/api/Versions', params: [] },
  // CX-9b — `resolve` on every {divisionId} read (name/market-number/missing → the internal id); `drill` on the LIST:
  // its rows join into the DETAILS read by TaskId, matched on a bound `address` (an optional param that is NOT in the
  // endpoint — fillEndpoint ignores it — it exists so the binder has a declared slot for "…at 123 Main St", and the
  // panel's deterministic join consumes it: CODE matches the row, the model never joins). One ask → division+status+
  // address → the task's full details.
  { ...VS, id: 'vs_warranty_tasks', name: 'Warranty tasks by status', listUrl: '/#warranty',
    resolve: { divisionId: VS_DIVISION },
    // CX-9k (v2.74.1617) — the row's HUMAN display id, preference-ordered (the generic first-…Number scan landed on
    // the per-home claim sequence — every bullet read "#01"). TicketId is the number users quote ("ticket 4867009");
    // TaskNumber the site's own task number.
    displayId: ['TicketId', 'TaskNumber'],
    // PM (v2.74.1633, user's domain rule) — the CROSS-SYSTEM join key, preference-ordered. The homeowner's EMAIL,
    // PHONE and even NAME can differ in the other system (a spouse ordered, a work address, a changed account) —
    // but the SHIPPING ADDRESS of a warranty request is the same address the parts went to, so it's the stable
    // key for matching this task to an order/customer elsewhere. Consumed BEFORE the name/shape heuristics when
    // the ask doesn't name a field (the v1617 displayId lesson: a declaration beats a smarter guess). Bonus: it
    // lives on the LIST row, so the default join needs no per-row drill.
    // PM-6 (v2.74.1639) — how a warranty row fills a Shopify customer CREATE, for the reviewed write batch.
    // Contact rungs match by TYPE SUBSTRING (not an exact key), so this survives field-name variation across
    // divisions; anything that does not resolve is reported per-row as unproposable and never invented.
    writeMap: {
      shopify_create_customer: {
        first_name: { contact: 'primary', type: 'first' },
        last_name: { contact: 'primary', type: 'last' },
        email: { contact: 'primary', type: 'email' },
        phone: { contact: 'primary', type: 'phone' },
        address1: 'AddressLine1',          // the join key itself — proven live (v1638 trace)
        country: { literal: 'US' },        // VendorSuite is a US homebuilder feed; the code, not the name
      },
    },
    joinKey: [
      'AddressLine1',                          // 1. the warranty SHIPPING address - stable across systems
      { contact: 'primary', type: 'email' },   // 2-4. the PRIMARY homeowner contact
      { contact: 'primary', type: 'phone' },
      { contact: 'primary', type: 'name' },
      { contact: 'other', type: 'email' },     // 5-7. the OTHER homeowner contact (a different person on the task)
      { contact: 'other', type: 'phone' },
      { contact: 'other', type: 'name' },
    ],
    // v2.74.1519 — TicketId/TaskId join the drill match (the live miss: "ticket 4867009" bound cleanly but the
    // match fields were address-shaped only, so a warranty-ticket ask could never find its row).
    // v2.74.1559 — `also`: catalog-owned SIDECAR reads the case dossier pulls alongside the drill (same join id) —
    // a case is born knowing its homeowner CONTACTS, not just the address (the task page's contact dropdown fires
    // this lazy endpoint; the harvested capture proved it, this curates it).
    // v2.74.1655 — JobNumber + SearchField added to the match set. Live: "get warranty task instructions for
    // 498840035" reported "No match" while the row plainly CONTAINS that number — it is the JobNumber, which was
    // not in this list. The ids a person actually holds are the JobNumber (498840035) and the TicketId
    // (4866871 / 4866871-04-01); TaskId (10834758) is internal and never shown, yet it is what the detail
    // endpoint takes — so every human lookup needs this row-match hop to resolve one into the other.
    // `SearchField` is VendorSuite's OWN pipe-delimited index of every id + address + community, built for
    // exactly this ("498840035|7048 eclipse trail|…|4866871|…|4866871-04-01"); it goes last as the catch-all,
    // after the precise fields, and it also absorbs the leading-whitespace quirk in the raw JobNumber value.
    drill: { via: 'vs_warranty_task', param: 'taskId', from: 'TaskId', matchOn: 'address', label: ['AddressLine1', 'CityStateZip', 'TaskNumber', 'ClaimNumber', 'ProjectName', 'TicketId', 'TaskId', 'JobNumber', 'SearchField'], also: ['vs_task_contacts'] },
    does: 'list a division\'s warranty tasks by status (new / open / fixed / closed; division optional — blank = your current one) — task number, claim number, address, age, allowed amount. The division can be a name ("Atlanta West"), a market number ("210"), blank for your current division, or "each" to list EVERY division you can access ("for each division…" / "across all divisions"); give a street address or a warranty ticket / task number to drill straight into that one task\'s details — or say "on the site" / "on vendorsuite" to open that record on the warranty page itself instead',
    endpoint: '/api/Vendor/Warranty/Tasks/{divisionId}/{status}',
    params: [
      { name: 'divisionId', type: 'string', required: true, hint: 'the DIVISION — a name ("Atlanta West"), a market number ("210"), or exactly "each" for every accessible division; never a street' },
      { name: 'status', type: 'string', enum: ['new', 'open', 'fixed', 'closed'], required: true },
      { name: 'address', type: 'string', required: false, hint: 'a STREET address or task number — set ONLY when the user names one specific property/task to drill into' },   // NOT in the endpoint — the drill join's filter
    ] },
  { ...VS, id: 'vs_warranty_task', name: 'Warranty task details', itemUrl: '/#warranty',
    displayId: ['TicketId', 'TaskNumber'],   // CX-9k — the detail head's "#id" shows the human number too
    // PM-6 (v2.74.1639) — how a warranty row fills a Shopify customer CREATE, for the reviewed write batch.
    // Contact rungs match by TYPE SUBSTRING (not an exact key), so this survives field-name variation across
    // divisions; anything that does not resolve is reported per-row as unproposable and never invented.
    writeMap: {
      shopify_create_customer: {
        first_name: { contact: 'primary', type: 'first' },
        last_name: { contact: 'primary', type: 'last' },
        email: { contact: 'primary', type: 'email' },
        phone: { contact: 'primary', type: 'phone' },
        address1: 'AddressLine1',          // the join key itself — proven live (v1638 trace)
        country: { literal: 'US' },        // VendorSuite is a US homebuilder feed; the code, not the name
      },
    },
    joinKey: [
      'AddressLine1',                          // 1. the warranty SHIPPING address - stable across systems
      { contact: 'primary', type: 'email' },   // 2-4. the PRIMARY homeowner contact
      { contact: 'primary', type: 'phone' },
      { contact: 'primary', type: 'name' },
      { contact: 'other', type: 'email' },     // 5-7. the OTHER homeowner contact (a different person on the task)
      { contact: 'other', type: 'phone' },
      { contact: 'other', type: 'name' },
    ],   // PM-7 (v1634) — same ladder on the detail read
    does: 'read a warranty task\'s full details by its INTERNAL task id (from a task list row — for a human task number or an address, use the task LIST with that as the address filter)',
    endpoint: '/api/Vendor/Warranty/Task/{taskId}',
    params: [{ name: 'taskId', type: 'string', required: true, hint: 'the INTERNAL task id from a list row — for a human task number or address, use the task LIST' }] },
  // v2.74.1559 — CURATED from the user's harvest (harvest_get_api_vendor_warranty_taskcontacts_id — the task
  // page's contact-dropdown lazy read; live 195557: the harvested {id} carried no semantics, so the binder fed a
  // human TICKET number → the known junk-taskId http-500). Same id discipline as vs_warranty_task; in a CASE the
  // focus param-fill supplies TaskId automatically, and the dossier `also`-pull bakes contacts in at spawn.
  { ...VS, id: 'vs_task_contacts', name: 'Warranty task contacts', itemUrl: '/#warranty',
    does: 'the homeowner CONTACTS for a warranty task (names, phone, email — the task page\'s contact dropdown) by its INTERNAL task id; in a case just ask ("homeowner\'s phone?") — the case record carries the id',
    endpoint: '/api/Vendor/Warranty/TaskContacts/{taskId}',
    params: [{ name: 'taskId', type: 'string', required: true, hint: 'the INTERNAL task id (TaskId from a list row / the case record) — never a ticket or task NUMBER' }] },
  { ...VS, id: 'vs_warranty_stats', name: 'Warranty task counts', listUrl: '/#dashboard',
    resolve: { divisionId: VS_DIVISION },
    does: 'COUNTS of warranty tasks (new / open / fixed) for a division — answers "how many tasks are open/new/fixed" with the dashboard statistic, NEVER the task list itself; division by name, market number, or blank for your current one',   // v2.74.1751 — count-vocabulary added: scoreboard run 1 showed "how many … are open" pulling the LIST leg @0.95 over this one
    endpoint: '/api/Vendor/Dashboard/Statistic/{divisionId}/Warranty',
    params: [{ name: 'divisionId', type: 'string', required: true }] },
  { ...VS, id: 'vs_announcements', name: 'Vendor announcements', listUrl: '/#dashboard',
    resolve: { divisionId: VS_DIVISION },
    does: 'a division\'s vendor announcements — title, message, dates, attachments; division by name, market number, or blank for your current one',
    endpoint: '/api/Vendor/Announcement/{divisionId}',
    params: [{ name: 'divisionId', type: 'string', required: true }] },

  // ── HubSpot (HS-1) — the HAR-PROVEN same-origin cookie-ride GET reads. All READ-ONLY (GET). {portalId} fills from
  // the ride tab (urlParam); {id} is the record id from a lookup/URL. The v3 batch/read + graphql search POSTs are a
  // documented follow-on (they need the REST-POST-read write-gate carve-out — a safety-surface change deferred to
  // its own slice; a by-email SEARCH isn't in this HAR at all — HubSpot's public search is a POST /search, unproven
  // here). itemUrl opens the record's human page: app.hubspot.com/contacts/{portalId}/record/0-1/{id}. ──
  { ...HS, id: 'hubspot_me', name: 'My HubSpot portal', pulse: { kind: 'liveness' },
    does: 'confirm your HubSpot session and read your portal + user identity (account id, your name/email, whether the portal is expired) — a tiny read-only health check, riding your login',
    endpoint: '/api/login-verify/hub-user-info?portalId={portalId}', params: [] },
  { ...HS, id: 'hubspot_teams', name: 'HubSpot teams',
    does: 'list the teams in your HubSpot portal (name, member user ids, child teams), riding your login — answers "what teams are there?", "who is on <team>?"',
    endpoint: '/api/app-users/v1/teams?portalId={portalId}', params: [] },
  { ...HS, id: 'hubspot_contact', name: 'Look up a HubSpot contact', itemUrl: '/contacts/{portalId}/record/0-1/{id}',
    does: 'read one HubSpot CONTACT by its record id (all properties — name, email, phone, company, lifecycle stage, owner), riding your login. NOTE: this reads by the internal record id; a by-email search is a separate leg (not yet built)',
    endpoint: '/api/inbounddb-objects/v1/crm-objects/0-1/{id}?portalId={portalId}&allPropertiesFetchMode=latest_version',
    params: [{ name: 'id', type: 'string', required: true, hint: 'the contact\'s HubSpot record id (the long number in the record URL), NOT an email' }] },

  // ── Aircall Workspace — supervisor / inbox reads ───────────────────────────────────────────────────────────────
  // DK-2 (DESIGN_desks.md §5) — capClass:'presence' = operator STATE (my/team availability, roster, set). A desk
  // carries it, but the queue SWEEP never sweeps it as backlog ("set my availability" is not a queue item); it stays
  // a DIRECT capability on the interpret palette. Threads through recipeFromCatalogEntry → recipeToLeg (Invariant #3).
  { ...AC, id: 'aw_team_availability', name: 'Team availability (all agents)', capClass: 'presence', pulse: { kind: 'inventory', scope: 'team' },
    does: 'list EVERY teammate\'s live availability across the company (available / on_mobile / offline / do_not_disturb / other), riding your Aircall Workspace login — answers "who is available?", "is anyone free right now?"',
    endpoint: `/v3/availabilities?${_AC_AVAIL_Q}`, params: [] },
  { ...AC, id: 'aw_my_availability', name: 'My availability status', capClass: 'presence',
    does: 'read YOUR OWN current availability on all channels (phone + client), riding your login — answers "am I available?", "what is my status?", "am I on do-not-disturb?"',
    endpoint: `/v3/users/{me}/availabilities?${_AC_AVAIL_Q}`, params: [] },
  { ...AC, id: 'aw_my_agent', name: 'My Aircall agent profile and teams', capClass: 'presence', method: 'POST', gql: true, contentType: 'application/json',
    does: 'read your agent profile — teams you belong to (with member ids), default outbound line, availability state, and associated phone lines',
    endpoint: acGqlEndpoint('GetCurrentAgentV2_Query'),
    body: acGqlBody('GetCurrentAgentV2_Query', {}), params: [] },
  { ...AC, id: 'aw_teammate_roster', name: 'Teammate roster and status', capClass: 'presence', method: 'POST', gql: true, contentType: 'application/json',
    does: 'list teammates with their live availabilityStatus (on_mobile / offline / do_not_disturb / other) — the supervisor roster view',
    endpoint: acGqlEndpoint('lookupTeammates'),
    body: acGqlBody('lookupTeammates', { input: { filters: { query: '' }, pageRequest: { limit: 50 } } }), params: [] },
  { ...AC, id: 'aw_teammate_search', name: 'Search teammates by name or extension', method: 'POST', gql: true, contentType: 'application/json',
    does: 'search teammates by name, extension, or partial phone digits — returns availabilityStatus per hit',
    endpoint: acGqlEndpoint('lookupTeammates'),
    body: acGqlBody('lookupTeammates', { input: { filters: { query: '{query}' }, pageRequest: { limit: 25 } } }),
    params: [{ name: 'query', type: 'string', required: true }] },
  { ...AC, id: 'aw_search_teams', name: 'List Aircall teams', method: 'POST', gql: true, contentType: 'application/json',
    does: 'list Aircall teams with their member agent ids — use with team availability to filter the roster',
    endpoint: acGqlEndpoint('SearchTeamsQuery'),
    body: acGqlBody('SearchTeamsQuery', { from: 0, limit: 25 }), params: [] },
  { ...AC, id: 'aw_missed_calls', name: 'Missed calls inbox', method: 'POST', gql: true, contentType: 'application/json', pulse: { kind: 'backlog', scope: 'team', status: 'missed' },
    does: 'list OPEN missed inbound calls (newest first) with contact extracts including Zendesk user links when integrated',
    endpoint: acGqlEndpoint('CallEngagementsList_Query'),
    body: acGqlBody('CallEngagementsList_Query', { pageRequest: { limit: 25, sort: 'desc' }, filters: { status: 'OPENED', callType: ['ALL_MISSED'] } }),
    listUrl: '/inbox/calls?category=missedcalls', params: [] },
  { ...AC, id: 'aw_open_conversations', name: 'Open conversations inbox', method: 'POST', gql: true, contentType: 'application/json',
    does: 'list open Aircall Workspace conversations (calls + SMS threads unified), riding your login',
    endpoint: acGqlEndpoint('ConversationsList_Query'),
    body: acGqlBody('ConversationsList_Query', { pageRequest: { limit: 25, sort: 'desc' }, filters: { status: { in: ['OPENED'] }, withGroupSmsMmsConversations: true, withWhatsappUsernameConversations: false } }),
    listUrl: '/inbox/conversations?category=open', params: [] },
  { ...AC, id: 'aw_unread_count', name: 'Unread conversation count', method: 'POST', gql: true, contentType: 'application/json',
    does: 'how many Aircall Workspace conversations have unread engagements',
    endpoint: acGqlEndpoint('GetUnreadAircallWorkspaceConversationsCount'),
    body: acGqlBody('GetUnreadAircallWorkspaceConversationsCount', {}), params: [] },
  // ── contact / pre-dial / post-call (Zendesk CTI outbound capture) ─────────────────────────────────────────────
  { ...AC, id: 'aw_contact_by_phone', name: 'Find contact by phone', method: 'POST', gql: true, contentType: 'application/json',
    does: 'look up an Aircall contact by phone number — includes CRM extracts (Zendesk user link, HubSpot, etc.) when integrated',
    endpoint: acGqlEndpoint('ContactByPhoneNumber_Query'),
    body: acGqlBody('ContactByPhoneNumber_Query', { input: { phoneNumber: '{phone}' } }),
    params: [{ name: 'phone', type: 'string', required: true, hint: 'digits only or E.164 — the number you are about to dial or just called' }] },
  { ...AC, id: 'aw_authorized_lines', name: 'Authorized lines for a number', method: 'POST', gql: true, contentType: 'application/json',
    does: 'check which of YOUR phone lines are authorized to dial a given number — the pre-dial gate the CTI runs before outbound',
    endpoint: acGqlEndpoint('SearchAuthorizedLines_Query'),
    body: acGqlBody('SearchAuthorizedLines_Query', { filter: { phoneNumber: { match: '{phone}' } }, limit: 5 }),
    params: [{ name: 'phone', type: 'string', required: true }] },
  { ...AC, id: 'aw_conversation_by_number', name: 'Conversation for line and number', method: 'POST', gql: true, contentType: 'application/json',
    does: 'find the Aircall Workspace conversation thread for an outbound/inbound number on a specific line — includes Zendesk externalLink in contact extracts',
    endpoint: acGqlEndpoint('ConversationByNumber_Query'),
    body: acGqlBody('ConversationByNumber_Query', { lineID: '{lineId}', phoneNumber: '{phone}', withMessagingAI: true }),
    itemUrl: '/inbox/conversations/{id}', params: [
      { name: 'lineId', type: 'string', required: true, hint: 'your Aircall line id (from my agent profile / default line)' },
      { name: 'phone', type: 'string', required: true, hint: 'the external number digits' },
    ] },
  { ...AC, id: 'aw_my_line', name: 'My phone line details',
    does: 'read one of your Aircall phone lines — digits, timezone, recording settings',
    endpoint: '/v3/numbers/{lineId}', params: [{ name: 'lineId', type: 'string', required: true }] },
  { ...AC, id: 'aw_call_history', name: 'Call history for a number',
    does: 'search your recent calls to/from a phone number on a specific line (post-hoc log — the call itself is WebRTC, not this read)',
    endpoint: '/v4/calls/search?category=custom_filter&per_page=25&page=1&numbers[]={phone}&number_ids[]={lineId}&strict_call_ownership=true',
    params: [
      { name: 'phone', type: 'string', required: true },
      { name: 'lineId', type: 'string', required: true },
    ] },
  // ── writes (gated; self-only availability) ───────────────────────────────────────────────────────────────────
  { ...AC, id: 'aw_set_availability', name: 'Set my Aircall availability', capClass: 'presence', write: true, reversible: true, outward: false, method: 'POST', gql: true, contentType: 'application/json',
    does: 'set YOUR availability preference — answers "set me to available / unavailable / do-not-disturb / busy / back-office"; does not place or answer calls',
    endpoint: acGqlEndpoint('UpdateAgent_Mutation'),
    // v2.74.1479 — {me} = the AGENT id (input.ID), NOT the REST user id: resolve it from the GraphQL agent read
    // (getAgentV2.ID) over the WORKING transport. The /v5 REST identityProbe 401s here (live 00:08:58), and it would
    // return the wrong id anyway. GetCurrentAgentV2_Query returns exactly the ID UpdateAgent_Mutation wants.
    identityGql: { endpoint: acGqlEndpoint('GetCurrentAgentV2_Query'), body: acGqlBody('GetCurrentAgentV2_Query', {}), idPath: 'data.getAgentV2.ID' },
    body: acGqlBody('UpdateAgent_Mutation', { input: { ID: '{me}', availability: { preference: '{preference}' } } }),
    params: [{ name: 'preference', type: 'string', enum: ['ALWAYS_OPENED', 'ALWAYS_CLOSED', 'DOING_BACK_OFFICE', 'OTHER'], required: true, hint: 'ALWAYS_OPENED = available; ALWAYS_CLOSED = unavailable / do-not-disturb / busy; DOING_BACK_OFFICE = back-office; OTHER = custom' }] },   // v1470 — the opaque enum needs user-language mapping (live: "set me to unavailable" fell to teach)
  { ...AC, id: 'aw_send_sms', name: 'Send an SMS from my line', write: true, reversible: false, destructive: true, outward: true, method: 'POST', gql: true, contentType: 'application/json',
    // v2.74.1459 (safety review) — destructive: an SMS is an OUTWARD-FACING message to a real external person (can't
    // unsend), so it rides the two-step confirm tier (safetyClass 'destructive'), same as Zendesk merge/mark-as-spam —
    // never the single-click write gate. The §9 outward-comms rule: a message a human receives is human-approved.
    // PP-3 (v2.74.1661) — `outward: true` now says that DIRECTLY. This is a no-op on behavior (destructive already
    // gates it) and a correction to the VOCABULARY: this leg destroys nothing, and reading `destructive` here as
    // evidence that "destructive means irreversible" is what made the axis ambiguous in the first place. The
    // mislabel had a real cost one entry over — `add_comment` with public:true is equally unsendable and sits at
    // single-click, because there was no word for the property it shares with this leg.
    does: 'send an SMS text from one of your Aircall lines to an external number, riding your login',
    endpoint: acGqlEndpoint('sendMessage_Mutation'),
    body: acGqlBody('sendMessage_Mutation', { input: { text: '{text}', mediaKeys: [], lineID: '{lineId}', externalNumber: '{phone}' } }),
    params: [
      { name: 'lineId', type: 'string', required: true },
      { name: 'phone', type: 'string', required: true },
      { name: 'text', type: 'string', required: true },
    ] },
  { ...AC, id: 'aw_close_conversation', name: 'Close conversation after a call', write: true, reversible: true, outward: false, method: 'POST', gql: true, contentType: 'application/json',
    does: 'close/wrap up an Aircall Workspace conversation by its call id (post-call housekeeping — the Zendesk CTI wrap-up step)',
    endpoint: acGqlEndpoint('closeConversationByCallID_Mutation'),
    body: acGqlBody('closeConversationByCallID_Mutation', { callID: '{callId}' }),
    params: [{ name: 'callId', type: 'string', required: true, hint: 'the Aircall call id from the conversation/call read — NOT the Zendesk ticket id' }] },
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

/**
 * Coerce param VALUES against a leg's paramSchema before a connector call. PURE. An integer/number param given as a
 * STRING (the LLM often includes a "#", e.g. "#64775") → its digits as a Number — so `{id}` fills to `64775`, not the
 * URL-encoded `%2364775` that the server rejects (the read_ticket http-400). Unknown / already-typed params pass through.
 */
// ── v2.74.1597 — the NAMED-SYSTEM fence (pure): does the ask explicitly designate a DIFFERENT system than the
// leg selected to run? The live break: "search hubspot for <email>" had no HubSpot search leg, so interpret picked
// the closest semantic match — the ZENDESK search — and answered with 25 tickets WITHOUT naming the system. An ask
// that says the system's name must never be silently served by another system. Tokens derive from the catalog's own
// appHosts (labels minus generic ones), so a new connector fences itself the day its base lands. The designator
// grammar is deliberately NARROW — "on/in/from/via/at <system>" or "<verb> <system>" — so a token mentioned as
// CONTENT ("tickets about hubspot") never fences a legitimate search.
// v1598 SCOPE NOTE: at the dispatch site this is the FALLBACK only — the turn's TARGET_RESOLVE verdict (TR-1
// explicit, the ONE routing vocabulary) is consumed first; this catches the residue the resolver can't see (a
// system with NO ground yet — the catalog knows it before any visit — or a dispatch path that didn't resolve). ──
const _GENERIC_HOST_LABELS = new Set(['app', 'www', 'admin', 'api', 'workspace', 'my', 'com', 'io', 'net', 'org', 'co']);
function _hostLabels(host) {
  return String(host || '').toLowerCase().replace(/^https?:\/\//, '').split('.').filter((l) => l && !_GENERIC_HOST_LABELS.has(l));
}
/** @returns {string|null} the named system token when the ask designates one the leg does NOT belong to. PURE. */
export function askNamesOtherSystem(ask, legHost) {
  const t = String(ask || '').toLowerCase();
  if (!t) return null;
  const legLabels = new Set(_hostLabels(legHost));
  if (!legLabels.size) return null;
  const tokens = new Set();
  for (const r of CONNECTOR_RECIPES) { for (const l of _hostLabels(r && r.appHost)) tokens.add(l); }
  for (const tok of tokens) {
    if (legLabels.has(tok)) continue;                       // the leg IS that system — no gap
    const des = new RegExp(`\\b(?:on|in|from|via|at)\\s+(?:the\\s+)?${tok}\\b|\\b(?:search|check|open|show|ask|query|find\\s+in|look\\s*up)\\s+${tok}\\b`, 'i');
    if (des.test(t)) return tok;
  }
  return null;
}

// ── LEG-2a (v2.74.1594) — the SH-T4 checklist surface ──────────────────────────────────────────────────────────────
// The op bank is STORE-CAPTURED (a persisted-op hash only exists after the human performs the action once by hand
// with the tab open); these helpers expose the catalog's DEMANDS on it, so the `ops` viewer can show wanted-vs-
// banked instead of only what happens to be captured — the by-hand banking session becomes a checklist.

/** The catalog's persisted-op WRITES for a host. PURE. @returns {Array<{op, recipeId, recipeName}>} */
export function persistedOpsForHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return [];
  return CONNECTOR_RECIPES
    .filter((r) => r && r.persistedOp && r.appHost && (h === r.appHost || h.endsWith(`.${r.appHost}`)))
    .map((r) => ({ op: String(r.persistedOp), recipeId: r.id, recipeName: r.name }));
}

// How a human banks each op — the "do it once by hand" coaching, per op (reversible test actions on purpose).
const _OP_CAPTURE_HINTS = {
  CustomerCreate: 'create any customer by hand (Customers → Add customer — test values are fine; you can delete it right after)',
  EditCustomer: 'edit any customer by hand (open one, change a field — e.g. add a tag — and Save; you can undo it right after)',
  DraftOrderCreate: 'create a draft order by hand (Orders → Drafts → Create order, any product; you can delete the draft right after)',
};
/** The by-hand capture instruction for an op. PURE (a safe default for unmapped ops). */
export function opCaptureHint(op) {
  return _OP_CAPTURE_HINTS[String(op || '')] || 'perform that action once by hand in the admin with this tab open';
}

export function coerceParams(params, paramSchema) {
  const props = (paramSchema && typeof paramSchema === 'object' && paramSchema.properties) || {};
  const out = {};
  for (const [k, v] of Object.entries((params && typeof params === 'object') ? params : {})) {
    if (typeof v === 'string' && _PLACEHOLDER_VALUE.test(v.trim())) continue;   // v1405 — the LLM binder sometimes ECHOES a placeholder token ("{company}") as the value for a param it couldn't fill; drop it here so it's treated as unfilled everywhere (body + endpoint), never stored literally. v1657 — ALSO [id]/<id>: the binding layer is the one choke point every executor passes through, so one drop here covers the filter path, the direct-param path, and anything added later
    const t = props[k] && props[k].type;
    const gidKind = props[k] && props[k].gid;
    if (gidKind && (typeof v === 'string' || typeof v === 'number')) {   // CX-7c — a customer/variant id → its gid form
      out[k] = toShopifyGid(v, gidKind);
    } else if ((t === 'integer' || t === 'number') && typeof v === 'string') {
      const n = Number(v.replace(/[^0-9.\-]/g, ''));   // strip '#', spaces, stray text
      out[k] = Number.isFinite(n) && v.replace(/[^0-9.\-]/g, '') !== '' ? n : v;
    } else if (t === 'boolean') {   // v1342 (review I) — "false" must not serialize as a truthy string
      if (typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes') out[k] = true;
        else if (s === 'false' || s === '0' || s === 'no') out[k] = false;
        else out[k] = v;
      } else out[k] = !!v;
    } else { out[k] = v; }
  }
  return out;
}

/**
 * The first curated recipe whose `appHost` matches an origin (host === appHost or a subdomain of it). PURE. Lets the
 * setup-time verify (AS-4) pick the STRONG identity probe for a recipe-backed site (e.g. `deako.zendesk.com` →
 * `zendesk.com`); a generic site (no match) falls back to the reach/login heuristic. Recipes share appHost+probe, so
 * any match suffices for the probe.
 */
export function recipeForOrigin(origin) {
  const host = String(origin || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  if (!host) return null;
  return CONNECTOR_RECIPES.find((r) => {
    const ah = String(r.appHost || '').toLowerCase();
    return ah && (host === ah || host.endsWith('.' + ah));
  }) || null;
}

/**
 * Hosts whose curated rides need a sniffed CSRF (`csrf:'sniff'` — Shopify class). PURE.
 * Used by the vitals/boot pre-warm (v2.74.1760): bank a token from an ALREADY-OPEN tab before the first ask.
 */
export function csrfSniffHosts(catalog = CONNECTOR_RECIPES) {
  const out = [];
  for (const r of (Array.isArray(catalog) ? catalog : [])) {
    if (!r || r.csrf !== 'sniff') continue;
    const h = String(r.appHost || r.origin || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * The path a signed-out human should be sent to in order to trigger THIS connector's real sign-in. PURE.
 * v2.74.1704 — DEFAULT `/`, explicit `console` for the exceptions. (Superseded the v1701 itemUrl derivation.)
 *
 * ── THE RULE, AND WHY THE DERIVATION WAS WRONG ──────────────────────────────────────────────────────────────
 * For MOST sites the bare origin root IS the sign-in trigger: visiting `https://<origin>/` while signed out
 * redirects to the login (VendorSuite's `/` → the drhorton SSO at `cplogin.drhorton.com`; Shopify/HubSpot/Aircall
 * likewise). So the DEFAULT is `/`.
 *
 * v1701 tried to be clever and DERIVE a console path from the recipe's human page (`itemUrl`/`listUrl`). That was
 * wrong twice over, and VendorSuite proved it: its itemUrl is a HASH ROUTE (`/#dashboard`), which the derivation
 * mangled into a bogus real path `/dashboard` — and even the correct `/#dashboard` is not the sign-in trigger,
 * the bare `/` is. A human WORK page is not a sign-in ENTRY page; conflating them is the bug.
 *
 * ── THE ONE REAL EXCEPTION IS DECLARED, NOT DERIVED ─────────────────────────────────────────────────────────
 * Zendesk's root goes to the public HELP CENTRE, not the agent login; only `/agent` produces
 * `/auth/v3/signin?…&role=agent`. That is a genuine exception, so the ZD recipe DECLARES `console: '/agent'`.
 * Declaration over heuristic — the honest version of the v1701 intent. Any site whose root does not trigger login
 * adds its own `console`; everything else gets `/` and is correct.
 */
export function signInLandingPath(origin, recipes = CONNECTOR_RECIPES) {
  const host = String(origin || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  if (!host) return '/';
  const r = (Array.isArray(recipes) ? recipes : []).find((x) => {
    const ah = String(x && x.appHost || '').toLowerCase();
    return ah && (host === ah || host.endsWith('.' + ah));
  });
  const explicit = r ? String(r.console || '').trim() : '';
  return explicit.startsWith('/') ? explicit : '/';
}

// A short, stable `app` slug for a host's registrable domain (deakoapi.deako.com → 'deako'). Used only to build a
// unique leg.key (`account.app.id`); not semantic. PURE.
function _appFromHost(host) {
  const h = String(host || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  const labels = h.split('.').filter(Boolean);
  if (labels.length >= 2) return labels[labels.length - 2] || 'site';   // the registrable label (deako, zendesk)
  return labels[0] || 'site';
}

// v2.74.1749 — ONE app spelling per host (gl 104907: interpret held me.vendorsuite.* AND me.drhorton.* for the
// SAME endpoint — a catalog-direct leg keeps the curated `app`, while the harvested projection below derived
// 'drhorton' from the registrable label). The leg KEY is identity for pins, banked bindings, aliases, and the
// vitals tick; two spellings make all four unstable. The CURATED CATALOG is the canonical namer for any host it
// knows (exact match, then suffix — 'deako.zendesk.com' matches appHost 'zendesk.com'); the registrable label
// stays the fallback for hosts it has never heard of. PURE.
const _CANONICAL_APP_BY_HOST = (() => {
  const m = new Map();
  for (const e of CONNECTOR_RECIPES) {
    const app = e && e.app; if (!app) continue;
    for (const raw of [e.appHost, e.origin]) {
      const k = String(raw || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
      if (k && !m.has(k)) m.set(k, app);
    }
  }
  return m;
})();
export function canonicalAppForHost(host) {
  const h = String(host || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!h) return _appFromHost(h);
  if (_CANONICAL_APP_BY_HOST.has(h)) return _CANONICAL_APP_BY_HOST.get(h);
  for (const [k, app] of _CANONICAL_APP_BY_HOST) if (h.endsWith('.' + k)) return app;
  return _appFromHost(h);
}

/**
 * §17/§18 — project a Ground's HARVESTED ride-recipes into session-ride connector legs for the IL invoke palette. PURE.
 * Gated by the §18 ARM GUARD: only `armable` recipes (enabled ∧ accepted) are projected — a `pending`/`rejected`/disabled
 * one is never a tool. For `mode:'ask'` only READS (GET) are projected (writes await their own confirm path). Adapts the
 * per-Ground record (Core/rideRecipe.js shape: origin · method · safetyClass) to recipeToLeg's recipe shape, deriving
 * `app` from the host + mapping method→write/safetyClass→destructive. `trusted:true` because an ACCEPTED recipe is
 * user-vetted (so its read drops to 'auto'). Dedups against `seenKeys` (so a harvested recipe can't shadow a curated one).
 *   recipes: per-Ground ride-recipes · host: the connected origin's host · seenKeys: keys already in the palette
 */
export function harvestedRecipeLegs(recipes, { host = '', account = 'me', mode = null, seenKeys = null, groundId = '' } = {}) {
  const list = Array.isArray(recipes) ? recipes : [];
  const seen = seenKeys instanceof Set ? seenKeys : new Set();
  const out = [];
  for (const r of list) {
    if (!r || !armable(r)) continue;                                   // the §18 gate — accepted ∧ enabled only
    const method = String(r.method || 'GET').toUpperCase();
    // A record's OWN `write` wins (a curated gql READ is a POST but write:false); else method-derive (a harvested §17
    // record may carry no `write`, and a non-GET must still class as a write, never silently a read). §9 fail-safe.
    // v2.74.1468 — EXCEPT a read-only GraphQL document: a gql READ tunnels through POST with no `write` annotation,
    // and method-derivation classed it a WRITE → mode 'act' → the HITL confirm fired for a ROSTER READ and the 200
    // rendered as "Sent" (live: aw_teammate_roster). recipeLegs (the catalog-direct path) already applied
    // isReadOnlyGql; this record path — which CX-9r's catalog-armed origins ride — did not (Invariant #3's shape:
    // the curated-direct path got the rule, the seeded path didn't). A `mutation` NEVER passes isReadOnlyGql, and an
    // explicit write:true always wins — the §9 fail-safe holds.
    const write = r.write === true || (r.write == null && method !== 'GET'
      && !(r.gql === true && r.body && typeof r.body === 'object' && isReadOnlyGql(String(r.body.query || ''))));
    // v2.74.1303 (CX-6) — writes ARE now projected (mode:'act' legs): the dispatch confirm-gates them AND the
    // SESSION_REPLAY handler fail-closes on `confirmed:true`, so a demonstrated "Create X" is selectable and can only
    // run through the HITL gate — a write reaching execution un-confirmed is refused at the boundary. (Was: reads-only skip.)
    // v2.74.1432 (Invariant #3) — SPREAD the whole record so recipeToLeg (the SINGLE field-reader) receives EVERY carried
    // marker (itemUrl/listUrl/gql/csrf/urlParam/persistedOp/shopProbe/verifyIdentity/identityProbe/pulse/drill) — not the
    // old hand-picked subset that silently dropped "show X" (itemUrl) + every non-cookie transport marker on the SEEDED
    // path. A new recipe field now flows here for free; only recipeFromCatalogEntry + recipeToLeg still need the field added.
    const leg = recipeToLeg({
      ...r,
      // v1749 — the record's OWN app wins (a curated-merged record names itself); else the CANONICAL app for its
      // host. The old `_appFromHost(host)` here OVERRODE r.app and used ONE host for every record — the exact
      // double-spelling gl 104907 caught (me.vendorsuite.* vs me.drhorton.* for one endpoint).
      app: r.app || canonicalAppForHost(r.origin || host),
      origin: r.origin || host, method, write,
      destructive: r.destructive === true || r.safetyClass === 'destructive',
    }, { account, trusted: true });                                    // accepted = user-vetted → read drops to 'auto'
    if (!leg) continue;
    if (seen.has(leg.key)) continue; seen.add(leg.key);
    leg.provenance = 'harvested';                                      // mark the source
    // §20 — header-replay routing: the endpoint (leg.tool.origin, e.g. the cross-origin API host) is reached by replaying
    // the page-captured auth HEADERS FROM the app tab (sessionHost = the connected host where the login + token live). The
    // dispatch sees tool.replay==='headers' → SESSION_REPLAY instead of cookie-ride INVOKE_SESSION.
    leg.tool.sessionHost = host;
    leg.tool.replay = 'headers';
    // v2.74.1340 (review A/§18) — carry the recipe's Ground so the SESSION_REPLAY dispatch can hand the arm guard
    // its {groundId, recipeId} pair (the executor re-checks armable at run time, not just at projection time).
    if (groundId) leg.tool.groundId = String(groundId);
    out.push(leg);
  }
  return out;
}

/**
 * The session-ride legs an app can use given its CONNECTED sites (CX-4c). PURE. A recipe matches when its `appHost`
 * equals a connection's host or is its parent domain (`deako.zendesk.com` → `zendesk.com` recipes); each matching leg
 * is **origin-enriched** to ride the SPECIFIC connected instance (so the ride targets `deako.zendesk.com`, not any
 * Zendesk). Feeds the interpret candidate set so the IL can SELECT a connected recipe. Pass `mode:'ask'` for reads only.
 *   connections: [{ origin, label }]   → [OfferedLeg with tool.origin set]
 */
export function connectorLegsForConnections(connections, { account = 'me', trusted = true, mode = null } = {}) {
  const hosts = (Array.isArray(connections) ? connections : [])
    .map((c) => String((c && c.origin) || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  if (!hosts.length) return [];
  const legs = recipeLegs({ account, trusted });
  const out = []; const seen = new Set();
  for (const host of hosts) {
    for (const leg of legs) {
      if (!leg || (mode && leg.mode !== mode)) continue;
      const ah = String((leg.tool && leg.tool.appHost) || '').toLowerCase();
      if (!ah || !(host === ah || host.endsWith('.' + ah))) continue;
      const k = `${host}|${leg.key}`;
      if (seen.has(k)) continue; seen.add(k);
      const enriched = { ...leg, key: leg.key.includes('@') ? leg.key : `${leg.key}@${host}`, tool: { ...leg.tool, origin: host } };
      out.push(enriched);   // ride the SPECIFIC connected instance (host-suffixed key)
    }
  }
  return out;
}
