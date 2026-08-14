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
import { resolveDatePhrase } from './dateResolve.js';   // v2.74.2063 — RC-validate slice B (DATE): pure phrase→ISO resolver (clock INJECTED)

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
// AU-6 §12.5 (v2.74.2209) — the HAND-OFF read: five fields, because that is the whole question. `order` is the
// answer (null until the draft is completed), `name` labels it for a human, `completedAt`/`status` say when and
// whether. Deliberately NOT the admin's ~400-line DraftOrderDetails document: a smaller ask is a smaller thing
// to be wrong about, and every field here is attested in the 2026-08-11 capture.
const _GQL_DRAFT_ONE = 'query DraftOrderDetails_0($id: ID!) { draftOrder(id: $id) { id name status completedAt order { id name } } }';
// v2.74.2223 — the CREATE as OUR OWN document (the §12.5/v2209 reads pattern, applied to the first write).
// WHY: the persisted-op hash is a VENDOR-VERSIONED artifact — it identifies Shopify's deploy, not our recipe —
// and it rotated between 2026-08-11 (#D29741 created through it) and 2026-08-14 (PERSISTED_OPERATION_NOT_FOUND,
// classified op-hash-stale, live 03:41 CDT). A verified leg that a vendor deploy can silently disarm makes every
// rotation a chore visit (re-bank by hand), which the iron principle forbids. A document is ours: nothing rotates.
// Selection is minimal on purpose (the _GQL_DRAFT_ONE lesson: a smaller ask is a smaller thing to be wrong
// about); `userErrors` rides for the §10.1 phantom-row screen, `id`+`name` for the extractors and the eye.
// TWO LOUD-FAIL UNKNOWNS, named (the RH-0a posture — it cannot fail quietly): `type=mutation` as the routing
// param mirrors the proven `type=query` (wrong → the live http-404-empty, fix is one param); `DraftOrderInput`
// is the PUBLIC schema's type name for a mutation field whose internal `input` variable and spellings are
// live-proven (wrong → a named GraphQL validation error, zero execution, zero side effects).
const _GQL_DRAFT_CREATE = 'mutation DraftOrderCreate($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id name status totalPrice } userErrors { field message } } }';
const _GQL_ORDERS = 'query Orders($q: String!, $n: Int!) { orders(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) { edges { node { id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet { shopMoney { amount currencyCode } } customer { email } lineItems(first: 10) { edges { node { title quantity } } } fulfillments { status displayStatus estimatedDeliveryAt deliveredAt trackingInfo { number company url } events(first: 10) { edges { node { status happenedAt } } } } returns(first: 10) { edges { node { id status returnLineItems(first: 10) { edges { node { quantity } } } reverseFulfillmentOrders(first: 5) { edges { node { reverseDeliveries(first: 5) { edges { node { deliverable { ... on ReverseDeliveryShippingDeliverable { tracking { carrierName number url } } } } } } } } } } } } refunds { createdAt note totalRefundedSet { shopMoney { amount currencyCode } } } tags note } } } }';
// v2.74.1904 — `sortKey: RELEVANCE`, from ADMIN-UI ground truth (user-supplied, 2026-07-31): the search bar's top
// five for "smart switch" were Smart Switch · Gen 2 · Bundle · Scene Controller · Gen 1 Refurbished, while this query
// returned a DRAFT scene controller, a Dimmer and an ARCHIVED Backplate — because an unsorted products connection
// orders by ID (oldest first among matches), so `first: n` truncated precisely the newer, relevant items. RELEVANCE
// is what the admin's own bar ranks by.
const _GQL_PRODUCTS = 'query Products($q: String!, $n: Int!) { products(first: $n, query: $q, sortKey: RELEVANCE) { edges { node { id title status totalInventory variants(first: 10) { edges { node { id title sku price inventoryQuantity } } } } } } }';
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
  // v2.74.2119 — find a user by EMAIL. `view_user` reads by id only, so after a create returns 422 DuplicateValue
  // ("that email already belongs to a user") there was no way to learn WHICH user — leaving the warranty desk
  // account un-bootstrappable on every run after the first (HAR deako.zendesk.com 2026-08-08).
  // NOTE the endpoint deliberately reuses `search_tickets`' proven `/api/v2/search.json` shape with a type:user
  // filter, rather than the /users/search.json form, which nothing here has observed. Read-only.
  { ...ZD, id: 'search_users', name: 'Find a Zendesk user by email',
    does: 'find a Zendesk user by email address (or name) — e.g. to resolve the id of an account that already exists, riding your login',
    endpoint: '/api/v2/search.json?query={query}%20type:user&per_page=25',
    listUrl: '/agent/search/1?type=user&q={query}',
    params: [{ name: 'query', type: 'string', required: true, hint: 'an email address (exact) or a name fragment' }] },
  // ── writes — gated HARD; fail-closed until the human confirms (CX-6/§9). Each carries a `body` template. ──────────
  // v2.74.2120 — TRANSPORT EVIDENCE (deako.zendesk.com HAR, 2026-08-08), recorded so it is not re-derived:
  //   · The agent UI does NOT create tickets over REST. It posts `POST /api/graphql` with
  //     operationName `CreateIssueTicketMutation`, query text INLINE (883 chars — no persisted-op hash, so it is
  //     replayable without a captured op), variables
  //     { ticket: { subject, priority, requesterId, submitterId, brandId, groupId, ticketFormId, tags[],
  //                 via:{viaChannel}, comment:{ body:{value,format}, isPublic, uploads[] } } },
  //     answering `createIssueTicket → ... on CreateIssueTicketSuccess { ticket { id } }` (a __typename union, so
  //     failure is a SIBLING VARIANT, not an HTTP error — the nested-errors shape Core/audit.js guards).
  //   · REST on the ticket namespace IS reachable on this tenant with the session ride: the same HAR shows
  //     `DELETE /api/v2/tickets/{id} → 204`.
  // The REST create below stays PRIMARY: documented, stable, and corroborated by that 204 — but it is not itself
  // in any HAR yet, so a first live create is the proof. The GraphQL mutation is the fallback if REST is blocked.
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
  // v2.74.1902 — the VendorSuite ride-leg declarations, ported (user: "work on shopify next, using the same
  // principles applied to vendorsuite ride legs"). Each is an EXISTING catalog field already threaded through all
  // three invariant-#3 hops (rideRecipe.js:95-98 · the v1432 spread · connectorLeg.js:193-199), so this is data,
  // not plumbing:
  //   displayId — the HUMAN id the row should headline (v1617; v1887 carries it into the shaper's facts). An
  //               order's is `name` ("DEAKO#69872" — what a user quotes); a customer's is their `email`. The gid
  //               is deliberately NOT a fallback — "gid://shopify/Customer/…" headlining a reply is the exact
  //               defect displayId exists to prevent.
  //   joinKey   — the declared cross-system identity ladder (v1633: a declaration is consumed BEFORE the
  //               name/shape heuristics). A customer joins other systems by EMAIL then PHONE; an order by its
  //               customer's email (`customer.email` — extractValue walks dotted paths). This is the reverse of
  //               vs_warranty_tasks' ladder, and it is what "for each order, find the warranty task" resolves by.
  { ...SH, id: 'shopify_customer_by_email', name: 'Find a Shopify customer by email', itemUrl: '/store/{handle}/customers/{id}',
    displayId: ['email'], joinKey: ['email', 'phone'],
    does: 'look up Shopify customer(s) by EMAIL, riding your admin login — search returns near-matches: confirm the exact email before trusting a hit',
    endpoint: '/api/shopify/{handle}?operation=Customers&type=query',
    body: { operationName: 'Customers', query: _GQL_CUSTOMERS, variables: { q: 'email:"{email}"', n: 5 } },
    params: [{ name: 'email', type: 'string', required: true }] },
  { ...SH, id: 'shopify_customer_by_phone', name: 'Find a Shopify customer by phone', itemUrl: '/store/{handle}/customers/{id}',
    displayId: ['email'], joinKey: ['email', 'phone'],
    does: 'look up Shopify customer(s) by PHONE number, riding your admin login — search returns near-matches: confirm the digits match exactly before trusting a hit',
    endpoint: '/api/shopify/{handle}?operation=Customers&type=query',
    body: { operationName: 'Customers', query: _GQL_CUSTOMERS, variables: { q: 'phone:"{phone}"', n: 5 } },
    params: [{ name: 'phone', type: 'string', required: true }] },
  // v2.74.1563 — the NAME lookup (live: "does Mousab have a shopify profile?" — the most natural CS ask had no
  // leg; only email/phone existed, so interpret force-fit the email leg). Shopify search matches bare words
  // against names; the near-match warning applies doubly (same/similar names are common).
  { ...SH, id: 'shopify_customer_search', name: 'Search Shopify customers by name', itemUrl: '/store/{handle}/customers/{id}',
    displayId: ['email'], joinKey: ['email', 'phone'],
    does: 'search Shopify customers by NAME (or any free search words), riding your admin login — returns near-matches: same or similar names are common, confirm the email before trusting a hit',
    endpoint: '/api/shopify/{handle}?operation=Customers&type=query',
    body: { operationName: 'Customers', query: _GQL_CUSTOMERS, variables: { q: '{query}', n: 5 } },
    params: [{ name: 'query', type: 'string', required: true, hint: 'the customer\'s name or free search words — for an exact email use the by-email lookup' }] },
  { ...SH, id: 'shopify_orders_for_customer', name: 'Shopify orders for a customer',
    displayId: ['name'], joinKey: ['customer.email'],
    // v2.74.1902 — the LIST leg carries its drill (the vs_warranty_tasks pattern): "her orders — and open 69872"
    // filters this list by the order param and drills via the by-number lookup, instead of needing a second ask.
    drill: { via: 'shopify_order', param: 'order', from: 'name', matchOn: 'order', label: ['name', 'id', 'displayFulfillmentStatus', 'displayFinancialStatus'] },
    does: 'list a customer’s recent Shopify orders by their EMAIL (status, totals, line items, fulfillment/tracking, refunds), riding your admin login; give an order number to drill straight into that one',
    endpoint: '/api/shopify/{handle}?operation=Orders&type=query',
    body: { operationName: 'Orders', query: _GQL_ORDERS, variables: { q: 'email:"{email}"', n: 5 } },
    params: [
      { name: 'email', type: 'string', required: true },
      { name: 'order', type: 'string', required: false, hint: 'an ORDER NUMBER — set ONLY when the user names one specific order to drill into' },   // NOT in the body — the drill join's filter
    ] },
  { ...SH, id: 'shopify_order', name: 'Look up a Shopify order', itemUrl: '/store/{handle}/orders/{id}',
    displayId: ['name'], joinKey: ['customer.email'],
    does: 'fetch one Shopify order by its ORDER NUMBER (digits, e.g. 69872 — not the DEAKO# prefix): status, totals, line items, fulfillment/tracking, refunds — riding your admin login',
    endpoint: '/api/shopify/{handle}?operation=Orders&type=query',
    body: { operationName: 'Orders', query: _GQL_ORDERS, variables: { q: 'name:{order}', n: 3 } },
    // AU-6 (v2.74.2209, §12.9) — THE SHIPPING WATCH LIVES HERE, on the per-record read, because no collection we
    // have can host it: the unfulfilled queue loses an order exactly when it ships. This leg reads ONE order by
    // name and sees it at any fulfillment status — and it is the most live-proven read in this catalog (40 ok
    // invocations in the local traces), so `_GQL_ORDERS`' fulfillment/tracking fields are attested, not hoped for.
    //
    // TWO KINDS OVER THE SAME ROWS, deliberately (§12.9.2's composition). A `field` observer reads the FIRST
    // fulfillment and is wrong the moment an order ships in two boxes; `set` reports each parcel as it appears
    // (keyed by its tracking number — one parcel, one number) and `member` reports that parcel later being
    // delivered. Split shipments and re-deliveries fall out of the same two rules.
    //
    // `probe.from: 'label'` + `digits` is the id-shape seam, and it is declared rather than inferred: a hand-off
    // yields a gid, this leg searches `name:`, and this leg's own does-line states the form (digits, never the
    // DEAKO# prefix). The 2026-08-11 capture shows the order name as `DEAKO#72044`, so the strip is required.
    reads: 'order', rows: 'data.orders.edges[].node', rowId: 'id',
    probe: { param: 'order', from: 'label', digits: true },
    observe: {
      shipStatus: { of: 'field', at: 'displayFulfillmentStatus' },
      parcels: { of: 'set', rows: 'fulfillments', id: 'trackingInfo.number',
        keep: { carrier: 'trackingInfo.company', eta: 'estimatedDeliveryAt' } },
      progress: { of: 'member', rows: 'fulfillments', id: 'trackingInfo.number',
        track: { status: 'displayStatus', deliveredAt: 'deliveredAt' } },
    },
    warm: '60d',   // §12.4 — an order's meaningful window tracks the merchant's return policy; declared, not derived
    params: [{ name: 'order', type: 'string', required: true }] },
  // v2.74.1921 — THE ORDER TIMELINE, HAR-authored (admin.shopify.com.har #2, 2026-08-01; entry 116 is the order
  // page's own Timeline fetch). The timeline section LAZY-LOADS on scroll — which is why the first HAR carried
  // zero of it, and why "who created this order?" was unanswerable from any read: the ACTOR exists only here
  // (the Orders query has no creator; OrderDetailsSidebar's attribution names the CHANNEL, "Draft Orders", not
  // the person). The second READ persisted op, same transport class as the admin search: GET, sha from the op
  // bank, variables pre-encoded in the query string with {orderGid} the one fill slot (fillEndpoint's
  // encodeURIComponent lands `gid://…` inside the JSON string correctly — verbatim match with the capture).
  // Response: data.node.events.edges[].node {message, createdAt, eventLabel, …} newest-first — the actor rides
  // IN the message ("<staff> created this order for <customer> from draft order …", label order_placed);
  // data.staffMember is the VIEWING admin, never the actor. primaryList unwraps the shape as-is (probed against
  // the raw capture: 7 rows, no staffMember hijack — the v1907 envelope rule generalized). Messages carry
  // page-authored HTML (<a href>) — they stay on the escape-first render path (injection boundary).
  { ...SH, id: 'shopify_order_events', name: 'Shopify order timeline', method: 'GET', gql: false, persistedOp: 'Timeline',
    displayId: ['message'],
    // v2.74.1926 — the `does` no longer promises the CREATOR. This window is `first:15` over a NEWEST-FIRST
    // connection, so `order_placed` (the oldest event) falls outside it on any busy order — and the bias is
    // exactly wrong: every return, refund and email pushes creation one slot further out, so it would miss
    // precisely on the orders someone bothers to audit. Creator asks route to `shopify_order_creator` below.
    does: 'the RECENT events on an order by its INTERNAL gid — the latest 15, newest first: returns, refunds, fulfillments, emails sent, notes. Answers "what has happened on this order lately". For the order\'s CREATOR use the order-creator lookup instead. First use may need one order page scrolled to its timeline by hand to bank the operation',
    endpoint: '/api/operations/{op_sha}/Timeline/shopify/{handle}?operationName=Timeline&variables=%7B%22id%22%3A%22{orderGid}%22%2C%22first%22%3A15%2C%22last%22%3Anull%2C%22before%22%3Anull%2C%22after%22%3Anull%7D',
    // v2.74.1922 — fromField: a machineOnly param binds from the RECORD, never from generation (live 123241: the
    // model CONSTRUCTED "gid://shopify/Order/59987" from the DEAKO number while the true gid sat in focus; the
    // act door's fill reads the newest focus record/list's `id` and overrides a generated value). The field rides
    // hop 1 verbatim (recipeFromCatalogEntry copies `params` whole), so the seeded path carries it too.
    params: [{ name: 'orderGid', type: 'string', required: true, machineOnly: true, fromField: 'id', hint: 'the order\'s INTERNAL gid (`id` on an order row, gid://shopify/Order/…) — never the DEAKO# number; fetch the order first, then ask from it' }] },
  // v2.74.1926 — THE CREATION EVENT, from the OTHER END of the connection. The v1921 timeline reads `first:15`
  // over a NEWEST-FIRST list, so `order_placed` — the OLDEST event — silently falls outside the window on any
  // busy order: HTTP 200, fifteen well-formed edges, no creator, no error. The failure is biased toward exactly
  // the orders a human would audit (each return/refund/email pushes creation one slot further out), which is the
  // v1874 "truncation that parses as complete" class. Reading the LAST page instead makes the creation event
  // structurally reachable regardless of history length.
  //
  // `last:3` not `last:1`: same-second events tie (the capture shows two at 17:04:15), and some orders open with
  // a preamble event before the placement — so take a small tail and SELECT BY LABEL, never by position. The
  // reader picks `eventLabel === 'order_placed'`; if that label is absent from the tail the honest answer is
  // "couldn't determine", never the nearest row. Same persisted op (`Timeline` — one sha, one bank entry, one
  // capture hint): the sha pins the DOCUMENT, and `$last`/`$before`/`$after` are already declared variables that
  // every captured call transmits as null. `first` is sent as null because a Relay connection rejects both
  // directions at once.
  //
  // Cheaper AND less exposed than the wide window: ~6 cost points instead of ~18, ~1KB instead of ~7.5KB, and the
  // 15-event window's customer emails, addresses and line items never leave the site (the DESIGN_llm_privacy
  // minimization direction, applied at the leg rather than at the redactor).
  //
  // ⚠ LIVE-UNVERIFIED, two ways (the capture holds ONE order, and it was draft-converted): whether Relay accepts
  // `first:null,last:3` on this document, and whether `order_placed` is the oldest label for a STOREFRONT order
  // as it is for a draft conversion. Both fail loudly (empty edges / no matching label), never silently.
  { ...SH, id: 'shopify_order_creator', name: 'Who created a Shopify order', method: 'GET', gql: false, persistedOp: 'Timeline',
    displayId: ['message'],
    does: 'WHO CREATED an order (and from what draft) by its INTERNAL gid — reads the order\'s creation event itself, so it is correct however long the order\'s history is. Use this for "who created/placed this order"; for recent activity use the order timeline. First use may need one order page scrolled to its timeline by hand to bank the operation',
    endpoint: '/api/operations/{op_sha}/Timeline/shopify/{handle}?operationName=Timeline&variables=%7B%22id%22%3A%22{orderGid}%22%2C%22first%22%3Anull%2C%22last%22%3A3%2C%22before%22%3Anull%2C%22after%22%3Anull%7D',
    params: [{ name: 'orderGid', type: 'string', required: true, machineOnly: true, fromField: 'id', hint: 'the order\'s INTERNAL gid (`id` on an order row, gid://shopify/Order/…) — never the DEAKO# number; fetch the order first, then ask from it' }] },
  // v2.74.1928 — THE ORDERS BREADTH LEG, HAR-authored (HAR #3, entry 727 — the orders index with a filter typed).
  // Everything before it reads orders through a FIXED lens: the queue is hardcoded open+unfulfilled, by-customer
  // takes an email, by-number takes one order. This is the index itself with its search slot open, which is what
  // any "across the orders" question needs — and the composition that answers "which orders did <staff> create"
  // reads its collection from here, then drills each row's `id` into the creation event (no other leg exposes a
  // gid per row alongside a free filter).
  //
  // The query slot speaks SHOPIFY SEARCH SYNTAX, and the v1927 gate is what makes handing it a model-composed
  // string safe: an unrecognized field is DROPPED by the server and the rows come back UNFILTERED, so without
  // that gate this leg would be a fabrication engine (proven: `staff_member:"…"` → invalid_field + 50 unfiltered
  // rows). The valid vocabulary from the same capture's filter drawer: status, financial_status,
  // fulfillment_status, delivery_status, return_status, chargeback_status, current_total_price, delivery_method,
  // destination, tag, processed_at, channel, risk_level, discount_code, product_id, credit_card_last4 — and
  // NOTHING for staff/creator, which is exactly why the per-item composition exists.
  //
  // Verbatim variables from the capture except `query`: sortKey PROCESSED_AT + reverse (newest first),
  // ordersFirst 50, `skipCustomer:true` KEPT (purchasingEntity already carries buyer identity, so the customer
  // fragment is redundant PII on 50 rows). Rows: {id (gid — the join key), name (DEAKO#…), createdAt/processedAt,
  // displayFinancialStatus, displayFulfillmentStatus, attribution, tags, purchasingEntity{email,firstName,…}}.
  // NO cursor param in v1: `after` stays null and the read is honestly capped at 50 — a bound the answer names
  // rather than a completeness it can't back (pageInfo.hasNextPage rides the response for the render to say so).
  { ...SH, id: 'shopify_orders_search', name: 'Search Shopify orders', method: 'GET', gql: false, persistedOp: 'OrderListData',
    listUrl: '/store/{handle}/orders', displayId: ['name'], joinKey: ['purchasingEntity.email'],
    coverage: 'selection',
    // v2.74.1929 — the `does` DECLARES THE DERIVED FIELD. The first wording ended "there is NO filter for who
    // created an order", which is true of the SITE and taught the router to refuse the ask outright (live
    // 21:41 — a clarify that listed the menu and declined, while the machinery to answer it was already
    // wired). A capability the model cannot name is unbuilt (unreachable-clause ruling), so the text now says
    // what Orchard CAN do — read `createdBy` per order — and keeps the honest caveat as a COST, not a refusal.
    does: 'search ORDERS across the store with a filter, newest first (up to 50): by status, payment/fulfillment status, tag, date (processed_at:>2026-07-25), channel, total, product, discount — the orders index itself; blank filter = the most recent orders. Each row can also be read for WHO CREATED it (the field `createdBy`, plus `createdByHuman`) — the site has no creator filter, so that is read per order and then filtered here: ask for the orders, then read or sort by createdBy',
    endpoint: '/api/operations/{op_sha}/OrderListData/shopify/{handle}?operationName=OrderListData&variables=%7B%22batchingV2Enabled%22%3Atrue%2C%22ordersFirst%22%3A50%2C%22ordersLast%22%3Anull%2C%22before%22%3Anull%2C%22after%22%3Anull%2C%22query%22%3A%22{query}%22%2C%22sortKey%22%3A%22PROCESSED_AT%22%2C%22reverse%22%3Atrue%2C%22skipPurchasingEntity%22%3Afalse%2C%22skipBusinessEntity%22%3Afalse%2C%22skipCustomer%22%3Atrue%2C%22skipFulfillmentDetails%22%3Afalse%2C%22skipShippingAddress%22%3Afalse%2C%22skipAutoSelectUnfulfilledDetails%22%3Atrue%2C%22savedViewId%22%3Anull%7D',
    // The per-row sidecar: the creation event, re-keyed from the row's OWN gid (`from:'id'` → `param:'orderGid'`)
    // — the primary drill's join value is the order NUMBER and would 404 the timeline. `pick` selects the
    // creation edge by LABEL (never by position: the tail is newest-first and ties exist), `extract` writes the
    // actor prose into a real FIELD so a branch can filter it deterministically, with no per-item LLM.
    drill: { via: 'shopify_order', param: 'order', from: 'name', matchOn: 'order',
      label: ['name', 'id', 'displayFulfillmentStatus', 'displayFinancialStatus'],
      also: [{ id: 'shopify_order_creator', from: 'id', param: 'orderGid',
        pick: { field: 'eventLabel', equals: 'order_placed' },
        extract: [{ from: 'message', as: 'createdBy', pattern: '^(.+?)\\s+created this order' },
          { from: 'attributeToUser', as: 'createdByHuman' }] }] },
    // v2.74.2063 — RC-validate slice B (DATE): declare the date-bearing FIELD(S) on the param, not in the resolver
    // (generality — Zendesk's search.query carries created>/solved> and would declare its own fields). coerceParams'
    // date branch reads this to normalize a relative operand inside {query} to a concrete ISO bound; dateFilterViolations
    // refuses an unparseable one. Both are DORMANT until a caller injects `now` (this slice ships zero now-callers).
    params: [{ name: 'query', type: 'string', required: false, dateFilter: { fields: ['processed_at'], grain: 'date' }, hint: 'Shopify order search syntax (status:open, tag:vip, financial_status:paid, processed_at:>2026-07-01) or blank for the newest orders — there is no staff/creator field' }] },
  { ...SH, id: 'shopify_search_products', name: 'Search Shopify products', itemUrl: '/store/{handle}/products/{id}',
    displayId: ['title'],
    does: 'search Shopify products by title or free words (with variants, price, inventory; drafts and archived included — say so when a hit is not ACTIVE), riding your admin login. For an exact SKU use the by-SKU lookup',
    endpoint: '/api/shopify/{handle}?operation=Products&type=query',
    body: { operationName: 'Products', query: _GQL_PRODUCTS, variables: { q: '{query}', n: 10 } },   // v1904 — 10, not 5: the ID-ordered truncation cost the top admin hits
    params: [{ name: 'query', type: 'string', required: true }] },
  // v2.74.1905 — THE ADMIN SEARCH BAR ITSELF, HAR-authored (admin.shopify.com.har, 2026-07-31; entry 235 is the
  // literal "smart switch" keystroke). The RELEVANCE experiment measured its ceiling in one probe — the bar is a
  // DIFFERENT SEARCH SERVICE (per-hit `score`, prefix matching), not products(query:), and no sortKey reaches it.
  // So this leg IS the bar: the persisted `Search` operation, GET with the variables JSON in the query string
  // (percent-encoded verbatim scaffold; {query} is the one fill slot — fillEndpoint's encodeURIComponent lands the
  // value inside the JSON string correctly). {op_sha} rides the SAME per-origin op bank as the writes — the tee's
  // OP_RE matches any /api/operations/<sha>/<Op>/ URL regardless of method, so ONE hand search with the tab ridden
  // banks it, and a deploy-rotated sha re-captures through the existing HASH_STALE path. Response:
  // data.shop.search.edges[].node {title, url, score, reference{status,…}} — ranked, drafts/archived included,
  // exactly what the user's paste showed the bar showing.
  { ...SH, id: 'shopify_admin_search', name: 'Search the Shopify admin (products)', method: 'GET', gql: false, persistedOp: 'Search',
    displayId: ['title'],
    does: 'search Shopify PRODUCTS by words exactly like the admin search bar — relevance-ranked, drafts and archived included (say so when a hit is not ACTIVE). First use may need one search done by hand in the admin to bank the operation',
    endpoint: '/api/operations/{op_sha}/Search/shopify/{handle}?operationName=Search&variables=%7B%22getRating%22%3Afalse%2C%22includeRollouts%22%3Atrue%2C%22query%22%3A%22{query}%22%2C%22annotatedSearchTerm%22%3Anull%2C%22types%22%3A%5B%22PRODUCT%22%5D%2C%22first%22%3A7%2C%22cursor%22%3Anull%2C%22sortField%22%3Anull%2C%22sortAscending%22%3Afalse%7D',
    params: [{ name: 'query', type: 'string', required: true, hint: 'plain product words ("smart switch") — quotes are not supported' }] },
  // v2.74.1904 — the by-SKU lookup, from the same admin ground truth: the create-order page searches SKU/variant as
  // first-class fields, and a bare "DK-SW-01" against the default search fields missed live. Field-targeted `sku:`
  // is Shopify's own query syntax — the by_email/by_phone house pattern (a separate simple leg over a param-switched
  // one), applied to products.
  { ...SH, id: 'shopify_product_by_sku', name: 'Find a Shopify product by SKU', itemUrl: '/store/{handle}/products/{id}',
    displayId: ['title'],
    does: 'look up the Shopify product carrying an exact variant SKU (title, status, variants, price, inventory), riding your admin login',
    endpoint: '/api/shopify/{handle}?operation=Products&type=query',
    body: { operationName: 'Products', query: _GQL_PRODUCTS, variables: { q: 'sku:{sku}', n: 5 } },
    params: [{ name: 'sku', type: 'string', required: true, hint: 'the exact variant SKU (e.g. DK-SW-01) — for words from a title use the product search instead' }] },
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
    displayId: ['name'], joinKey: ['customer.email'],
    drill: { via: 'shopify_order', param: 'order', from: 'name', matchOn: 'order', label: ['name', 'id', 'displayFulfillmentStatus', 'displayFinancialStatus'] },
    does: 'THE fulfillment queue: open orders not yet (fully) fulfilled, newest first — number, date, payment/fulfillment status, total, customer email, line items, tracking. Give an order number to drill straight into that one; say "on the site" to open it on the admin orders page. Fans out: "open each in a case"',
    // AU-6 (v2.74.2209) — THE SHIPPING WATCH IS NOT HERE, and this note is why, so nobody puts it back. v2208
    // declared `watches:['order']` + tracking observers on THIS leg, which cannot work: the query is fixed at
    // `status:open fulfillment_status:unfulfilled`, so an order LEAVES this collection at the moment it ships —
    // precisely the moment a tracking number appears. A watch whose subject exits the read before the watched
    // event is structurally blind, not merely unlucky. The observers moved to `shopify_order`, which reads ONE
    // order by name and therefore sees it whatever its fulfillment status.
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
  // AU-2 (v2.74.2147) — `itemUrl`: the draft's own admin page, so the created record is openable from the Records
  // card's eye button. Every OTHER Shopify write already carried one (customer create/edit, :647/:676) and the
  // draft-order create — the write this workflow exists to make — did not, so the one create a warranty run
  // produces was the one create with nowhere to go. Draft orders live at /draft_orders/, NOT /orders/: a draft is
  // a distinct admin object until it is completed, which is the same distinction the user's "the order needs to be
  // completed by a human" ruling turns on.
  // v2.74.2223 — DOCUMENT-IN-BODY, no longer a persisted op (see _GQL_DRAFT_CREATE above for the whole why).
  // Drops `gql:false, persistedOp:'DraftOrderCreate'` — the leg inherits SH's `gql:true` + `csrf:'sniff'` +
  // requestHeaders, exactly like the four live-proven document reads. A `mutation` document deliberately FAILS
  // isReadOnlyGql, so it STAYS on the write path (connector.js:1630 — both confirm belts, pipelineGate axes
  // unchanged); the 200-with-userErrors screen applies via `gql:true` just as it did via `persistedOp`. The
  // op-bank precondition this removes ("create one by hand once to bank the op") was a COST, never a gate — the
  // HITL/gate layer is the safety boundary, and it is untouched. The sibling persisted writes (customer
  // create/edit, the delete) stay persisted until this leg's first live run proves the BFF executes document
  // MUTATIONS as it does document queries; then their conversion is mechanical.
  { ...SH, id: 'shopify_create_order', name: 'Create a Shopify draft order', write: true, reversible: true, outward: false, itemUrl: '/store/{handle}/draft_orders/{id}',
    // v2.74.2203 — WHICH LEG UNDOES THIS ONE. `reversible: true` has been an assertion with no address since
    // v1681: it says an undo exists and names nothing, so every consumer had to know the pair by heart. PP-0d
    // (DESIGN_peritem_pipeline.md §6) called for exactly this — 'reversible becomes a leg REFERENCE, not a
    // boolean' — and the Records card is the first surface that needs to ASK. `gidType` is the entity the
    // created id belongs to, so a caller can rebuild the gid the delete wants without knowing Shopify's naming.
    undoLeg: 'shopify_delete_order', gidType: 'DraftOrder',
    // AU-6 (v2.74.2204, §12.4) — the WARM WINDOW is recipe DATA, not code: how long a record of this kind is
    // worth spending per-record reads on. 60d because a warranty draft's meaningful life runs to the merchant's
    // return policy — the thing worth seeing (a tracking number) lands on the ORDER, days after the draft. Not
    // derivable and different per store, so it is declared, visible and editable rather than inferred.
    warm: '60d',
    does: 'create a DRAFT order for a customer (line items by variant id + quantity) — a reversible draft the human reviews and completes; reversible via the delete-draft action (shopify_delete_order, human-confirmed) if it should not stand; for a free warranty replacement pass a 100% applied_discount and a zero shipping_line',
    // v2.74.2067 RC-1/RC-2 — LOOKUP resolution (Core/lookupRun.js): users type a customer EMAIL and a product
    // NAME, never gids. IN-PLACE: an email in `customer_gid` resolves via shopify_customer_by_email; a name/sku in
    // each line_items[].variantId resolves via by-SKU-then-search. A value already a `gid://` passes through. The
    // panel resolve seam invokes the search legs, ranks under `require` (Core/lookupResolve.rankLookupCandidates),
    // fills the gid, and shows the resolution in the HITL confirm; ambiguous/none/out-of-stock ASK, never guess.
    lookup: {
      customer_gid: { viaLeg: 'shopify_customer_by_email', valueParam: 'email', rows: 'data.customers.edges[].node',
        match: ['email'], id: 'id', label: ['firstName', 'lastName', 'email'], exact: true },
      line_items: { each: true, elementKey: 'variantId', from: 'product',
        viaLeg: ['shopify_product_by_sku', 'shopify_search_products'], valueParam: ['sku', 'query'],
        rows: 'data.products.edges[].node', pick: 'variants.edges[].node', id: 'id', match: ['sku', 'title'],
        label: ['title', 'sku', 'price'],
        // v2.74.2068 — a DRAFT order is REVERSIBLE, so do NOT require in-stock: out-of-stock / pre-order /
        // warranty-replacement drafts are normal, and a single-variant product often has UNTRACKED inventory
        // (inventoryQuantity null → the >0 gate false-refused it as "out of stock", live 2026-08-07). Keep the
        // ACTIVE gate so a genuinely archived/draft product is still refused before the wire.
        require: [{ field: 'status', equals: 'ACTIVE', fail: 'inactive' }] },
    },
    endpoint: '/api/shopify/{handle}?operation=DraftOrderCreate&type=mutation', itemUrl: '/store/{handle}/draft_orders/{id}',   // CX-7f — "show order" after a create opens the draft
    // The INPUT object is byte-identical to the persisted era — those spellings (purchasingEntity.customerId,
    // lineItems, useCustomerDefaultAddress, …) are LIVE-PROVEN (#D29741, 2026-08-11). Only the pinned document's
    // private variables envelope (hasDiscountsPermission / hasVaultedPaymentPermissions / firstLineItems) is
    // gone — those belonged to THEIR ~400-line document's reply gating, and our document declares only $input.
    body: { operationName: 'DraftOrderCreate', query: _GQL_DRAFT_CREATE, variables: {
      input: { purchasingEntity: { customerId: '{customer_gid}' }, lineItems: '{line_items}', useCustomerDefaultAddress: true, note: '{note}', poNumber: '{po_number}', tags: '{tags}', appliedDiscount: '{applied_discount}', shippingLine: '{shipping_line}' } } },
    // ⚠ LIVE-UNVERIFIED as a DOCUMENT mutation (v2.74.2223): the input spellings are live-proven but the
    // document route for mutations is not — first live run is the proof (fails loud + side-effect-free either
    // way; see _GQL_DRAFT_CREATE's two named unknowns).
    // v2.74.2055 — the three nested params carry HINTS (the CX-9f rule applied: shapes lived only in JS comments
    // the binder never sees) + `elementGid` (nested identifier members were unreachable by param-level `gid`).
    params: [
      { name: 'customer_gid', type: 'string', required: true, gid: 'Customer',
        hint: 'the customer — their EMAIL (e.g. jane@acme.com) is resolved to the Customer id for you; a gid:// is also accepted' },   // purchasingEntity.customerId — RC-1 resolves email → id via the `lookup` marker
      { name: 'line_items', type: 'array', required: true, elementGid: { variantId: 'ProductVariant' },
        // v2.74.2086 — the warranty SWITCH-IDENTITY rule moved OUT of this write leg into the WARRANTY PRESET
        // baseline (Core/appCatalog.js `warranty-manager`), so the PARSER applies it via <LEARNED> — the right
        // layer (a domain fact, not a create-order detail), and scoped to the Warranty desk instead of every draft.
        hint: 'array of {variantId, quantity} — variantId is the product by NAME or SKU (e.g. "Smart Dimmer" or DK-SW-02), resolved to the variant id for you (a gid:// is also accepted); quantity an integer ≥1' },
      { name: 'note', type: 'string', required: false, hint: 'a free-text note shown on the draft (staff-facing)' },
      { name: 'po_number', type: 'string', required: false, hint: 'a purchase-order number string, if the customer gave one' },
      { name: 'tags', type: 'array', required: false,
        hint: 'v2.74.2072 — an array of free-form tag strings on the draft, e.g. ["VIP","wholesale"] — a phrase like "tag it VIP and priority" becomes ["VIP","priority"]' },
      { name: 'applied_discount', type: 'object', required: false,
        hint: 'ONE order-level discount, object {value, valueType, title} — valueType PERCENTAGE or FIXED_AMOUNT; "10% off" → {value:10, valueType:"PERCENTAGE", title:"10% off"}, "$5 off" → {value:5, valueType:"FIXED_AMOUNT", title:"$5 off"}, a free warranty replacement → {value:100, valueType:"PERCENTAGE", title:"Warranty replacement"}' },
      { name: 'shipping_line', type: 'object', required: false,
        hint: 'object {title, price} — free shipping is {title:"Free shipping", price:"0.00"}' },
    ] },
  // v2.74.2069 — the DRAFT-ORDERS SEARCH read (persisted op DraftOrderList, already banked live on
  // admin.shopify.com). Two jobs: (a) a standalone "show my draft orders" read, and (b) the viaLeg the DELETE leg's
  // `lookup` resolves a draft NUMBER/name (#D1023) → the draft's internal gid through — so a user never types a gid
  // to delete. Same persisted-op GET transport as OrderListData/Search/Timeline: GET, {op_sha} from the per-origin
  // op bank, variables pre-encoded in the query string with {query} the one fill slot. Rows:
  // data.draftOrders.edges[].node { id: gid://shopify/DraftOrder/<n>, name: '#D1023',
  // status: OPEN|INVOICE_SENT|COMPLETED, totalPrice, customer{email} } — `name` is what the delete lookup matches on.
  // ⚠ LIVE-UNVERIFIED (same class as the create/timeline envelopes at connectorRecipes.js:693): the DraftOrderList
  // variables scaffold below is HAR-era hand-authoring modeled on OrderListData's sibling shape — the pinned document
  // may use plain `first`/`query` instead of `draftOrdersFirst`, and whether its `query` field-matches on a draft
  // NAME is unproven. Both fail LOUDLY (server userErrors / empty edges), never silently; first live run is the proof owed.
  // AU-6 §12.5 (v2.74.2209) — ONE DRAFT, read to answer ONE question: what did it become? HAR-AUTHORED
  // (admin.shopify.com.har, 2026-08-11, entry 92): the admin's own single-draft read is a DOCUMENT-IN-BODY POST
  // to `/api/shopify/{handle}?operation=DraftOrderDetails_0&type=query` — NOT a persisted-op hash call (those go
  // to /api/operations/<hash>/<Name>/...). So the document is ours to write, and this one asks for five fields
  // instead of replaying their ~400-line one.
  //
  // THE OPERATION NAME IS THEIRS, DELIBERATELY. The BFF ROUTES on `?operation=<name>` (SH const, RH-0a: an
  // anonymous doc gets a live http-404-empty), so the name has to be one it knows — `DraftOrderDetails_0` is
  // what the capture shows for this exact read. If it turns out the BFF also validates the body against a pinned
  // document for that name, this 404s LOUDLY and the fix is to paste their full query from the HAR; it cannot
  // fail quietly — and the fallback is already in the repo: docs/REFERENCE_shopify_draft_order_document.md holds
  // their full 393-line document verbatim, lifted out of the capture so it does not live in a Downloads folder.
  //
  // The assumption is a reasonable one, not a hope: `shopify_order`, `shopify_customer_by_email` and
  // `shopify_search_products` all send OUR OWN documents under Shopify operation names, and the first is
  // live-proven 40 times — so the BFF routes on the NAME and runs whatever document it is handed.
  //
  // `order` was null in the capture (that draft was OPEN) — the FIELD is what the capture proves, and null is
  // exactly what an un-completed draft should return. The completion reply seen at entry 122 confirms the shape
  // it takes when set: `draftOrder.order = { id: gid://shopify/Order/… }`.
  { ...SH, id: 'shopify_draft_order', name: 'Read one Shopify draft order',
    does: 'read ONE draft order by its internal id — its number, status, and (once completed) the ORDER it became. Used to answer \u0027what happened to this draft?\u0027; for a list of drafts use the draft-orders search',
    endpoint: '/api/shopify/{handle}?operation=DraftOrderDetails_0&type=query',
    body: { operationName: 'DraftOrderDetails_0', query: _GQL_DRAFT_ONE, variables: { id: '{draft_gid}' } },
    itemUrl: '/store/{handle}/draft_orders/{id}', displayId: ['name'],
    // AU-6 — what this leg is FOR, as data. `reads` marks it a per-record read of one draft; `probe` says how to
    // address one (a full gid, rebuilt from the numeric tail a create banks — the same rebuild the delete path
    // already makes); `handOff` names where the answer lives, with the order's NAME so a person reads
    // 'DEAKO#72044' and the order re-read has the key it searches by.
    reads: 'draft', rows: 'data.draftOrder',
    // v2.74.2222 — `exact: true`: this probe addresses ONE record by its own gid, so an OK reply whose row
    // resolved to nothing (`data.draftOrder: null`, HTTP 200) is the VENDOR stating non-existence — the one
    // reply shape §12.2 accepts as a `gone` observation (the sweep's _probeOne reads this flag). A search-shaped
    // probe (shopify_order's `name:` query) must NEVER declare it: an empty search is the v2214 query-mismatch
    // class, not a deletion.
    probe: { param: 'draft_gid', gid: 'DraftOrder', exact: true },
    handOff: { at: 'order.id', label: 'order.name', toKind: 'order' },
    // v2.74.2215 — `observe` is what makes this leg a PER-RECORD WATCH candidate at all: probePlan requires
    // `reads` AND `observe` (recordObserve.js), and without this block the leg was reachable ONLY as the
    // collection's handOffProbe target — which mattered the moment the collection went blind. Live 2026-08-11
    // (v2214's reconcile counts): our DraftOrderList poll (query:'' + savedViewId:null — the page's own proven
    // request rides a store-specific saved view we cannot hardcode) returned 50 drafts NOT including #D29741,
    // completed 30 minutes earlier. `matched=0`: the collection cannot see a completed draft in our request
    // shape, so the signal §12.5 expected it to raise never fires. A WARM draft now gets this one-row read
    // directly — the hand-off stops depending on the collection, which keeps only the cheap breadth watch on
    // drafts it CAN see.
    observe: { status: { of: 'field', at: 'status' } },   // OPEN → INVOICE_SENT — the pre-completion news this read can see
    // v2.74.2217 — a draft's meaningful window is how long it plausibly waits to be completed, and a warranty
    // draft waits on a HOMEOWNER — weeks are normal. Undeclared it fell to the 14d default, and a draft
    // completed on day 15 could never hand off in the background: cold suppresses this read, and the collection
    // cannot see COMPLETED drafts (v2215). 60d matches the order leg's declared horizon.
    warm: '60d',
    params: [{ name: 'draft_gid', type: 'string', required: true, gid: 'DraftOrder',
      hint: 'the draft\u0027s internal id or full gid — not its #D number' }] },
  { ...SH, id: 'shopify_draft_orders', name: 'Search Shopify draft orders', method: 'GET', gql: false, persistedOp: 'DraftOrderList',
    listUrl: '/store/{handle}/draft_orders', displayId: ['name'], joinKey: ['customer.email'], coverage: 'selection',
    does: 'search DRAFT orders — open/pending drafts not yet completed: number (#D…), status, customer, total; blank = the most recent drafts — riding your admin login. First use may need the Drafts list opened by hand once to bank the operation',
    // v2.74.2071 — REAL variables from a live HAR: {first, sortKey, reverse, query, savedViewId}. The v2070 fix
    // (first, not draftOrdersFirst) was right; dropped the undeclared last/before/after (the HAR omits them, so the
    // pinned doc does not declare them — sending them risks a "Variable not defined" error). query carries the search phrase.
    endpoint: '/api/operations/{op_sha}/DraftOrderList/shopify/{handle}?operationName=DraftOrderList&variables=%7B%22first%22%3A50%2C%22sortKey%22%3Anull%2C%22reverse%22%3Anull%2C%22query%22%3A%22{query}%22%2C%22savedViewId%22%3Anull%7D',
    // AU-6 (v2.74.2207, §12.9/§12.4) — THIS COLLECTION IS THE WATCH for draft records. `watches` names the record
    // KINDS its rows answer for, which is what makes it a poll candidate at all; `observe` names what counts as
    // news on one of those rows. Declared paths ONLY — a poll cannot invent an event, so a field nobody declared
    // is not news however much it moves.
    //
    // `coverage: 'selection'` above is LOAD-BEARING for this, not decoration: a draft missing from this read has
    // three innocent explanations (completed into an order, past `first: 50`, a filter moved), so absence here
    // must never be read as deletion. reconcileCollection enforces that; the marker is how it knows.
    watches: ['draft'], rowId: 'id', rows: 'data.draftOrders.edges[].node',
    // §12.5 (v2.74.2209) — SETTLED BY THE HAR (admin.shopify.com.har, 2026-08-11). v2208 declared
    // `handOff: {at:'order.id'}` here on the guess that the list might carry it. IT DOES NOT: the pinned
    // DraftOrderList document returns exactly
    //     id, name, poNumber, purchasingEntity, hasTimelineComment, note2, status, totalPriceSet, updatedAt
    // — so that declaration was INERT (it resolved to null every time, which is why it shipped harmless rather
    // than wrong: the fail-toward-nothing posture earned its keep).
    //
    // What the list CAN say is `status`, and the same capture proves two more things that make this work:
    // a COMPLETED draft REMAINS in the list (statuses seen: COMPLETED, INVOICE_SENT, OPEN), and the draft DETAIL
    // read does carry `order`. So the list raises the signal and one targeted re-read answers it — exactly
    // §12.5's second branch. State-triggered, not change-triggered, so a probe lost to a blip simply retries.
    //
    // v2.74.2215 — ⚠ THE CLAIM ABOVE WAS PROVEN AGAINST A REQUEST WE CANNOT REPRODUCE. The HAR's request rides
    // `query:null` + a STORE-SPECIFIC saved view (`savedViewId: gid://shopify/SavedView/…` — the admin's "All"
    // view); our poll sends `query:'' , savedViewId:null`, and live (v2214 reconcile counts: vendor=50
    // matched=0) that reply did NOT contain a draft completed 30 minutes earlier. So this probe is kept as a
    // free extra trigger for whatever this collection does see, but the hand-off no longer depends on it: the
    // draft DETAIL leg above now declares `observe`, making a warm draft a per-record watch of its own.
    handOffProbe: { when: { field: 'status', is: 'COMPLETED' }, via: 'shopify_draft_order' },
    observe: {
      status: { of: 'field', at: 'status' },          // OPEN → INVOICE_SENT → COMPLETED — the hand-off's own tell
      total: { of: 'field', at: 'totalPrice' },
    },
    params: [{ name: 'query', type: 'string', required: false, hint: 'Shopify draft search syntax (status:open) or a draft number like #D1023, or blank for the most recent drafts' }] },
  // v2.74.2069 — DELETE a Shopify DRAFT order (persisted op DeleteDraftOrder, already banked live). The
  // DESTRUCTIVE-write template (delete_ticket's safety axes: write:true, reversible:false, destructive:true) on the
  // Shopify persisted-op TRANSPORT (create's POST to the op bank, NOT delete_ticket's REST method:'DELETE' — the
  // actual call is a GraphQL mutation over the persisted-op POST; an HTTP DELETE to that URL never reaches the BFF).
  // reversible:false + destructive:true ⇒ hintToSafety → safety:'gated' and pipelineGate.gateActionForLeg REFUSES it
  // unattended ⇒ a human confirms EVERY delete, never auto (§10.1 adopt-don't-undo; a deleted draft cannot be
  // restored, so reversible:false is the honest axis). This IS the concrete reversal shopify_create_order's `does`
  // now names — a SEPARATE, human-confirmed action, never an engine auto-undo (no rollback runner exists in Core).
  //
  // draft_gid carries a `lookup` (viaLeg shopify_draft_orders) so a draft NUMBER/name resolves to the internal gid —
  // users never type gids. CRUCIAL: draft_gid carries NO `gid:` coercion marker (unlike create's customer_gid). On
  // the chain/map path coerceParams runs BEFORE the lookup, so a `gid:`-marked digit-bearing phrase ("D1023") would
  // be pre-minted into gid://shopify/DraftOrder/1023 — the human D-NUMBER, not the internal id — and _looksResolvedGid
  // would then SKIP the lookup and this IRREVERSIBLE delete would target the WRONG draft. Omitting `gid:` closes that
  // on both paths: the lookup alone mints the real gid, an already-gid value passes through, a bare number fails
  // exact-match and safely ASKS. (create's customer_gid has the same latent chain-path exposure, but it is a
  // REVERSIBLE write and a fabricated Customer gid 404s rather than hitting a different real customer — out of scope.)
  //
  // ⚠ LIVE-UNVERIFIED body envelope (same class as DraftOrderCreate at connectorRecipes.js:693): variables:{input:{id}}
  // is inferred from the admin's own EditCustomer op (input:{id}) + the public draftOrderDelete(DraftOrderDeleteInput{id}).
  // The internal DeleteDraftOrder op MAY instead take a bare variables:{id}; first live run is the proof owed — it
  // fails LOUD (server userErrors), never silently.
  { ...SH, id: 'shopify_delete_order', name: 'Delete a Shopify draft order', write: true, reversible: false, outward: false, destructive: true, gql: false, persistedOp: 'DeleteDraftOrder',
    does: 'permanently DELETE a Shopify DRAFT order by its number (#D1023) — IRREVERSIBLE, this cannot be undone; only unsent/open DRAFTS are deleted this way, never a completed or paid order — riding your admin login. A human confirms every delete',
    // v2.74.2069 — resolve a draft number/name → the draft's internal gid via the draft-orders search leg; a value
    // already a gid:// passes through, ambiguous/none/completed ASK (never guess on a destructive delete).
    lookup: {
      draft_gid: { viaLeg: 'shopify_draft_orders', valueParam: 'query', rows: 'data.draftOrders.edges[].node',
        match: ['name'], id: 'id', label: ['name', 'status'], exact: true,
        // belt-and-suspenders: never delete a COMPLETED draft (it corresponds to a real placed order). Only ever
        // yields an ASK, never a wrong delete; a harmless no-op if DraftOrderList omits completed drafts.
        require: [{ field: 'status', op: '!=', value: 'COMPLETED', fail: 'completed' }] },
    },
    endpoint: '/api/operations/{op_sha}/DeleteDraftOrder/shopify/{handle}',
    // v2.74.2071 — REAL shape from a live HAR (was the best-guess `input:{id}`): the variables key is
    // `draftOrderDeleteInput`, and the id is a full gid://shopify/DraftOrder/… (the lookup mints it).
    body: { operationName: 'DeleteDraftOrder', variables: { draftOrderDeleteInput: { id: '{draft_gid}' } } },
    params: [{ name: 'draft_gid', type: 'string', required: true,
      hint: 'the draft order number (e.g. #D1023 or D1023) — resolved to the exact draft for you; a gid:// is also accepted' }] },
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
    // v2.74.1877 — COVERAGE. `(divisionId × status)` is a PARTITION of the warranty corpus: every task sits in
    // exactly one cell, so a complete scan earns the definite negative ("isn't in any of them"). Contrast
    // `shopify_orders_queue` ("Open unfulfilled orders") and Zendesk's five views, which are SELECTIONS — a scan
    // over those can only ever say "not in what I read". Read from the catalog by id (Core/synthEntity.js), never
    // off the leg, so this is not an invariant-#3 field; anything undeclared falls back to `selection`, which
    // makes the definite negative unreachable. Forgetting to declare costs a weaker sentence, never a false one.
    coverage: 'partition',
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
        // v2.74.2020 — CityStateZip parts so MailingAddressInput is complete (address1+country alone was rejected)
        city: { cityStateZip: 'CityStateZip', part: 'city' },
        province: { cityStateZip: 'CityStateZip', part: 'province' },
        zip: { cityStateZip: 'CityStateZip', part: 'zip' },
        country: { literal: 'US' },        // VendorSuite is a US homebuilder feed; the code, not the name
      },
      // v2.74.2200 — how a CLASSIFIED warranty row fills a Shopify DRAFT ORDER (Core/armWrite.js). This is the
      // declaration the per-item act reads; without it 'draft the replacements' has no target and correctly
      // refuses rather than guessing which create a warranty row fills.
      //
      // `outcome` rungs make this a BRANCH-arm write rather than a row write: `count` and `product` are
      // DERIVED by the classifier from the instructions prose, they are not fields of the task, and no amount of
      // field-matching could have found them.
      shopify_create_order: {
        // The in-place `lookup` on shopify_create_order (v2055) turns an EMAIL into the Customer gid and a product
        // NAME into the variant gid, so the declaration names the human values and the resolver does the rest.
        customer_gid: { contact: 'primary', type: 'email' },
        line_items: { each: { variantId: { outcome: 'product' }, quantity: { outcome: 'count' } } },
        // A warranty replacement is not a sale. The leg's own `does` prescribes exactly this pair for the case
        // ('for a free warranty replacement pass a 100% applied_discount and a zero shipping_line'), and a draft
        // that bills a homeowner for a warranty part is a worse error than one that does not — a human still
        // completes the draft, so this is the reviewable default, not a payment.
        applied_discount: { const: { value: 100, valueType: 'PERCENTAGE', title: 'Warranty replacement' } },
        // v2.74.2203 (user direction) — a warranty draft is ALWAYS tagged, and always with the same four. Tags
        // are how these are found again in Shopify's own UI by someone who has never heard of Orchard: what it
        // is (replacement), why it exists (warranty, support), and that nobody is being billed (foc). They ride
        // the DECLARATION, not the leg, because they are a fact about warranty orders — the same reason the
        // switch-identity rule moved out of the create leg at v2086.
        tags: { const: ['replacement', 'support', 'foc', 'warranty'] },
        shipping_line: { const: { title: 'Free shipping', price: '0.00' } },
        // The draft says what it is FOR, on the draft itself, where the person completing it is looking. The
        // Records ledger's `incitedBy` answers the same question inside Orchard; this answers it in Shopify.
        note: { template: 'Warranty replacement — task {TaskNumber}, {AddressLine1}' },
      },
    },
    joinKey: [
      'AddressLine1',                          // 1. the warranty SHIPPING address - stable across systems
      { contact: 'primary', type: 'email' },   // 2-3. the PRIMARY homeowner contact
      { contact: 'primary', type: 'phone' },
      { contact: 'other', type: 'email' },     // 4-5. the OTHER homeowner contact (a different person on the task)
      { contact: 'other', type: 'phone' },
      // v2.74.2051 — NAME rungs REMOVED (user ruling, live 22:45Z run): a Shopify name search matches *a* person,
      // not *the* homeowner — 2 of 3 "matched" rows were name-rung false positives (same/similar names are
      // common; the by-name leg's own `does` already carries that warning). Email/phone/address identify; a name
      // only resembles. An unmatched row is an honest miss → the create path, never a wrong join.
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
      { name: 'status', type: 'string', enum: ['new', 'open', 'fixed', 'closed'], required: true,
        // v2.74.2056 — the live "show the ACTIVE tasks" case: 'active' is not a member; map the obvious synonyms
        // to the site's own words so the resolver fills the right one instead of 4xx-ing on the raw phrase.
        // 'done' deliberately UNMAPPED — it is ambiguous between fixed (repair done) and closed (task done); an
        // unmapped word rides as-is (no worse than today), never a confident wrong member (review, v2060).
        enumSynonyms: { open: ['active', 'in progress', 'in-progress', 'ongoing', 'outstanding'], fixed: ['resolved', 'repaired'], new: ['unassigned'] } },
      // v2.74.1860 — this param OWNS every number a person can name (ticket #4886921 · task number 01 · claim ·
      // job · street address). It matches against the row's whole label set and then drills with the row's real
      // internal id, so it is the ONLY correct door for a user-supplied identifier.
      { name: 'address', type: 'string', required: false, hint: 'ANY identifier the user names — a STREET address, a TICKET number (#4886921), a task/claim/job number. Set this whenever one specific property or task is named; it finds the row and drills into it. Never send such a number to "Warranty task details" instead' },   // NOT in the endpoint — the drill join's filter
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
        // v2.74.2020 — CityStateZip parts so MailingAddressInput is complete (address1+country alone was rejected)
        city: { cityStateZip: 'CityStateZip', part: 'city' },
        province: { cityStateZip: 'CityStateZip', part: 'province' },
        zip: { cityStateZip: 'CityStateZip', part: 'zip' },
        country: { literal: 'US' },        // VendorSuite is a US homebuilder feed; the code, not the name
      },
      // v2.74.2200 — how a CLASSIFIED warranty row fills a Shopify DRAFT ORDER (Core/armWrite.js). This is the
      // declaration the per-item act reads; without it 'draft the replacements' has no target and correctly
      // refuses rather than guessing which create a warranty row fills.
      //
      // `outcome` rungs make this a BRANCH-arm write rather than a row write: `count` and `product` are
      // DERIVED by the classifier from the instructions prose, they are not fields of the task, and no amount of
      // field-matching could have found them.
      shopify_create_order: {
        // The in-place `lookup` on shopify_create_order (v2055) turns an EMAIL into the Customer gid and a product
        // NAME into the variant gid, so the declaration names the human values and the resolver does the rest.
        customer_gid: { contact: 'primary', type: 'email' },
        line_items: { each: { variantId: { outcome: 'product' }, quantity: { outcome: 'count' } } },
        // A warranty replacement is not a sale. The leg's own `does` prescribes exactly this pair for the case
        // ('for a free warranty replacement pass a 100% applied_discount and a zero shipping_line'), and a draft
        // that bills a homeowner for a warranty part is a worse error than one that does not — a human still
        // completes the draft, so this is the reviewable default, not a payment.
        applied_discount: { const: { value: 100, valueType: 'PERCENTAGE', title: 'Warranty replacement' } },
        // v2.74.2203 (user direction) — a warranty draft is ALWAYS tagged, and always with the same four. Tags
        // are how these are found again in Shopify's own UI by someone who has never heard of Orchard: what it
        // is (replacement), why it exists (warranty, support), and that nobody is being billed (foc). They ride
        // the DECLARATION, not the leg, because they are a fact about warranty orders — the same reason the
        // switch-identity rule moved out of the create leg at v2086.
        tags: { const: ['replacement', 'support', 'foc', 'warranty'] },
        shipping_line: { const: { title: 'Free shipping', price: '0.00' } },
        // The draft says what it is FOR, on the draft itself, where the person completing it is looking. The
        // Records ledger's `incitedBy` answers the same question inside Orchard; this answers it in Shopify.
        note: { template: 'Warranty replacement — task {TaskNumber}, {AddressLine1}' },
      },
    },
    joinKey: [
      'AddressLine1',                          // 1. the warranty SHIPPING address - stable across systems
      { contact: 'primary', type: 'email' },   // 2-3. the PRIMARY homeowner contact
      { contact: 'primary', type: 'phone' },
      { contact: 'other', type: 'email' },     // 4-5. the OTHER homeowner contact (a different person on the task)
      { contact: 'other', type: 'phone' },
      // v2.74.2051 — name rungs removed (false positives — see vs_warranty_tasks' ladder note)
    ],   // PM-7 (v1634) — same ladder on the detail read
    // v2.74.1860 (live 155750: THREE http-500s in a row) — the `does` is now a REFUSAL, not a preference. Every
    // number a person can SEE is the wrong one: the list renders `#<TicketId>` and this endpoint takes the
    // internal `TaskId`, and the two are both 7-digit integers — indistinguishable by shape, so no runtime guard
    // can catch the mix-up and the site answers a bare 500. The router is the only place it can be prevented,
    // so the text has to say "never" in the router's own vocabulary. The drill path already works end-to-end
    // (label[] matches TicketId → drills with the row's real TaskId), which is why redirecting is safe.
    // v2.74.1861 — REWRITTEN FOR THE BUDGET, not for the reader. v1860's version said all the right things and
    // changed nothing live (gl 162926: "pull the full details for task id 4886286" → this leg → http-500 again,
    // with the fix loaded). Cause: interpretPrompt splits `does` on ' — ' and accumulates segments only while
    // the total stays ≤140 (interpretPrompt.js:236-238) — my seg0 was the useless "read a warranty task's full
    // details" and the entire refusal sat in a seg1 too long to fit, so it was dropped WHOLE. The router never
    // saw one word of it. Now seg0+seg1 = 131 chars and carry the whole discrimination; the rest is for humans.
    // (This is the v1753 budget-fill lesson repeating: a discriminating clause that does not FIT does not exist.)
    does: 'full details from an INTERNAL TaskId you already hold — a number a person typed is a TICKET id: send it to the task LIST as `address` — that finds the row and drills in with the real id (list rows and case records carry the TaskId; a number the user names never does)',
    endpoint: '/api/Vendor/Warranty/Task/{taskId}',
    params: [{ name: 'taskId', type: 'string', required: true, machineOnly: true, hint: 'the INTERNAL TaskId from a list row or case record ONLY — a number the user names is a TICKET number and 500s here; send it to the task LIST as `address` instead' }] },
  // v2.74.1559 — CURATED from the user's harvest (harvest_get_api_vendor_warranty_taskcontacts_id — the task
  // page's contact-dropdown lazy read; live 195557: the harvested {id} carried no semantics, so the binder fed a
  // human TICKET number → the known junk-taskId http-500). Same id discipline as vs_warranty_task; in a CASE the
  // focus param-fill supplies TaskId automatically, and the dossier `also`-pull bakes contacts in at spawn.
  { ...VS, id: 'vs_task_contacts', name: 'Warranty task contacts', itemUrl: '/#warranty',
    does: 'the homeowner CONTACTS for a warranty task (names, phone, email — the task page\'s contact dropdown) by its INTERNAL task id; in a case just ask ("homeowner\'s phone?") — the case record carries the id',
    endpoint: '/api/Vendor/Warranty/TaskContacts/{taskId}',
    params: [{ name: 'taskId', type: 'string', required: true, machineOnly: true, hint: 'the INTERNAL task id (TaskId from a list row / the case record) — never a ticket or task NUMBER' }] },
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
    params: [{ name: 'preference', type: 'string', enum: ['ALWAYS_OPENED', 'ALWAYS_CLOSED', 'DOING_BACK_OFFICE', 'OTHER'], required: true, hint: 'ALWAYS_OPENED = available; ALWAYS_CLOSED = unavailable / do-not-disturb / busy; DOING_BACK_OFFICE = back-office; OTHER = custom',
      // v2.74.2056 — the opaque-enum incident ("set me to unavailable/away" fell to teach): the hint's own
      // word→member mapping, made MACHINE-resolvable so the belt fills the member instead of leaning on the model.
      enumSynonyms: { ALWAYS_OPENED: ['available', 'online', 'open', 'free', 'active'], ALWAYS_CLOSED: ['unavailable', 'busy', 'do not disturb', 'do-not-disturb', 'dnd', 'away', 'offline'], DOING_BACK_OFFICE: ['back office', 'back-office', 'admin', 'backoffice'] } }] },   // v1470 — the opaque enum needs user-language mapping (live: "set me to unavailable" fell to teach)
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

  // ── UPS (v2.74.1936) — HAR-authored from www.ups.com.har (2026-08-01, with content). ─────────────────────────
  // v2.74.1938 — appHost is `www.ups.com`, NOT `ups.com`. The two-label form broke TWO things at once, both
  // silently, and both only visible from the user's side of the panel:
  //   · SETUP treats a 2-label appHost as a per-TENANT class (yourteam.zendesk.com) and will not bind it without
  //     a typed instance (`Core/capableSites.js`: deep = host.split('.').length >= 3 → concrete). So the UPS card
  //     could not be SELECTED at all — clicking it just re-asked for an address UPS does not have.
  //   · the token PUSH was rejected: sender validation is `csrfSniffHosts().includes(host)`, the real sender host
  //     is www.ups.com, and 'ups.com' does not match it — so the xsrf token could never bank however many times
  //     the page was visited.
  // The manifest tee matches `*://*.ups.com/*` (covers www), and the apex redirects to www in practice.
  // THE CARRIER GROUND. Why it matters beyond one more site: Shopify orders already carry
  // `fulfillments.trackingInfo.number` and the v1903 deep walk already reads it, so a track-by-number leg closes
  // a chain no single site offers — warranty task → homeowner → Shopify order → tracking number → carrier scan
  // history. Three grounds, one ask.
  //
  // TRANSPORT — two firsts, both generalized rather than special-cased (v1936):
  //   · CROSS-HOST: the page is www.ups.com, the API is webapis.ups.com. Same SITE, so the page's own fetch is
  //     allowed and this leg makes exactly the request the SPA makes; `apiHost` names it and the executor builds
  //     the URL from there instead of the ride tab's origin.
  //   · CSRF HEADER NAME: UPS sends `x-xsrf-token`, not `x-csrf-token`. The sniff mechanism was hardcoded to one
  //     spelling and was therefore structurally blind to this entire site; the tees now watch every known
  //     spelling and `csrfHeader` declares which one to SEND.
  // v2.74.1954 — CORRECTION. This block previously read "No cookies ride the cross-origin API host in the
  // capture — the xsrf token is the auth". That was wrong and load-bearing: the HAR is Chrome-SANITIZED (zero
  // Cookie and zero Set-Cookie across all 1775 entries, on every host including analytics), so it shows redaction,
  // not absence. Cookies do ride — `credentials:'include'` is unconditional at contentScript.js and
  // www.ups.com→webapis.ups.com is same-site. Do not re-reason from "the token is the auth"; it is a double-submit
  // scheme, and UPS's own analytics beacons carry `cp.X-XSRF-TOKEN-ST`, i.e. the SPA READS that cookie and echoes
  // it into the header. Header-sniffing sees only the echo, and only while the app is firing requests.
  // ALSO: this host runs TWO ASP.NET apps with SEPARATE key rings — /track/api tokens prefix CfDJ8Jcj9Ghl…,
  // /ship/api tokens prefix CfDJ8E_X1zdo… — and a ship token cannot decrypt at track. The bank keys on origin
  // alone (`rideCsrf:${origin}`), so the two collide in one slot. A token sniffed here may belong to the wrong app.
  { app: 'ups', appHost: 'www.ups.com', apiHost: 'webapis.ups.com', method: 'POST', csrf: 'sniff', csrfHeader: 'x-xsrf-token', csrfCookie: 'X-XSRF-TOKEN-ST',
    retention: { days: 120, approximate: true, source: 'UPS published policy: standard tracking stays online ~120 days' },   // HZ-1 — an empty result past this is "aged out", not "no such package"
    contentType: 'application/json', verifyIdentity: false, write: false,   // a plain-JSON POST that READS (v1936: the catalog's first — see rideRecipe hop 1)
    id: 'ups_track', name: 'Track a UPS package', displayId: ['trackingNumber'], listPath: 'trackDetails', itemUrl: '/track?tracknum={tracking}&loc=en_US',
    // v2.74.2002 — WHAT MATTERS about a tracked package. `listPath` lands the render on trackDetails[0], whose
    // 40+ siblings include UPS's own site plumbing (sendUpdatesOptions → a MyChoice preferences URL,
    // deliveryOptions, promo, progressBar*, cms.stapp.* i18n keys) and the consignee's name + street address.
    // The generic walk showed all of it and collapsed `milestones` to its first element's booleans. `show` is an
    // ordered allow-list, so everything not named here is omitted from DISPLAY — still retained and probeable.
    // shipToAddress is deliberately NOT shown: "where is my package" does not need a homeowner's home address.
    display: {
      show: ['packageStatus', 'simplifiedText', 'deliveredDateDetail', 'receivedBy', 'leftAt', 'errorText'],
      rows: { path: 'milestones', pick: ['date', 'time', 'location', 'name'], label: 'Scan history' },
    },
    does: 'TRACK a UPS package by its tracking number (1Z…): current status, delivery date/time, who signed for it, where it was left, and the full scan history city by city. Use for "where is / did it arrive / what happened to" a shipment — the tracking number comes from the order or shipment record. COVERS ABOUT THE LAST 120 DAYS: UPS drops standard tracking after roughly 4 months, so an older shipment returns nothing even though the number is valid',
    endpoint: '/track/api/Track/GetStatus?loc=en_US',
    // v2.74.1954 — CORRECTION: this said "verbatim from the capture (entry 1673)". It is not. Entry 1673 carries a
    // 5-field body with a different ClientUrl; this is the entry-1545 field set with a hand-edited ClientUrl that
    // matches no captured call. Harmless so far, but "verbatim" invites trusting it over the HAR — it is not a
    // transcript. TrackingNumber is an ARRAY (the API takes several); v1 fills exactly one so the answer is about
    // the package the user named.
    body: { Locale: 'en_US', TrackingNumber: ['{tracking}'], isBarcodeScanned: false, Requester: 'quic', ClientUrl: 'https://www.ups.com/track?loc=en_US&requester=QUIC/trackdetails', returnToValue: '', AssociatedBcdnNumber: null },
    // Response: { statusCode, trackedDateTime, trackDetails: [ { trackingNumber, packageStatus:'Delivered',
    //   packageStatusType:'D', deliveredDateDetail, receivedBy:'PETE', leftAt:'Dock', milestones[5],
    //   shipmentProgressActivities[17]{date,time,location,activityScan}, shipToAddress{}, … } ] }.
    // A NOT-FOUND is a 200 with trackDetails[0].errorCode '504' + errorText — the answer-shaper must read that as
    // an honest miss, never as "no status" (captured live: two of the three tracks in the HAR were exactly this).
    params: [{ name: 'tracking', type: 'string', required: true, hint: 'the UPS tracking number, e.g. 1Z27691W0233595715 (case-insensitive; the 1Z form is what orders carry)' }] },

  // The LIST leg and the ground's CANARY: params-free, so the daily visit has something safe to run (the LEG-1
  // discipline — a ground whose every read needs a param sits drift-blind between real uses).
  { app: 'ups', appHost: 'www.ups.com', apiHost: 'webapis.ups.com', method: 'POST', csrf: 'sniff', csrfHeader: 'x-xsrf-token', csrfCookie: 'X-XSRF-TOKEN-ST',
    retention: { days: 120, approximate: true, source: 'UPS published policy: standard tracking stays online ~120 days' },   // HZ-1 — an empty result past this is "aged out", not "no such package"
    contentType: 'application/json', verifyIdentity: false, write: false,   // a plain-JSON POST that READS (v1936: the catalog's first — see rideRecipe hop 1)
    id: 'ups_recent', name: 'Recently tracked UPS packages', displayId: ['trackingNumber'], listPath: 'recentlyTrackedData', listUrl: '/track?loc=en_US',
    pulse: { kind: 'liveness' }, coverage: 'selection',
    does: 'the packages recently tracked on this UPS account — tracking number, status (Delivered / In Transit), the status date and time, and who shipped it. Use for "what have I been tracking" or to find a package whose number you do not have to hand',
    endpoint: '/track/api/RecentlyTrackedData/GetRecentlyTrackedData?loc=en_US',
    body: { defaultValue: '12', Locale: 'en_US' },
    // Response: { status:'SUCCESS', recentlyTrackedData: [ { trackingNumber, packageStatusDescription,
    //   packageStatusDateInfo{packageStatusDate,packageStatusDateAndYear,packageStatusTime}, shipperName,
    //   statusCode, statusDescription } ] } — 10 rows in the capture, shipperName 'DEAKO, INC.'.
    // drill: a row's own tracking number feeds the by-number read, so "what happened to that one" works from the list.
    drill: { via: 'ups_track', param: 'tracking', from: 'trackingNumber', matchOn: 'tracking', label: ['trackingNumber', 'packageStatusDescription', 'shipperName'] },
    params: [] },
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

/** The catalog's persisted-op WRITES for a host. PURE. @returns {Array<{op, recipeId, recipeName}>}
 * v2.74.1926 — DEDUPED BY OP. The checklist asks a human to perform each OPERATION once by hand; the unit of
 * capture is the op-sha, not the leg. Two legs can ride one document with different variables (order_events and
 * order_creator both use `Timeline`), and listing it twice would ask for the same gesture twice and read as two
 * outstanding demands when one capture satisfies both. First declarer names the row. */
export function persistedOpsForHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return [];
  const seen = new Set();
  const out = [];
  for (const r of CONNECTOR_RECIPES) {
    if (!r || !r.persistedOp || !r.appHost) continue;
    if (!(h === r.appHost || h.endsWith(`.${r.appHost}`))) continue;
    const op = String(r.persistedOp);
    if (seen.has(op)) continue;
    seen.add(op);
    out.push({ op, recipeId: r.id, recipeName: r.name });
  }
  return out;
}

// How a human banks each op — the "do it once by hand" coaching, per op (reversible test actions on purpose).
const _OP_CAPTURE_HINTS = {
  CustomerCreate: 'create any customer by hand (Customers → Add customer — test values are fine; you can delete it right after)',
  EditCustomer: 'edit any customer by hand (open one, change a field — e.g. add a tag — and Save; you can undo it right after)',
  DraftOrderCreate: 'create a draft order by hand (Orders → Drafts → Create order, any product; you can delete the draft right after)',
  // v2.74.1905 — the first READ persisted op: the admin search bar's own operation.
  Search: 'type anything into the admin search bar once (the magnifying glass, top bar) — that banks the search operation',
  // v2.74.1921 — the second READ persisted op: the order page's timeline fetch (it lazy-loads on scroll).
  Timeline: 'open any order page and scroll down to its timeline once — that banks the timeline operation',
  // v2.74.1928 — the orders index itself (the breadth read behind any across-the-orders question).
  OrderListData: 'open the Orders list once (Orders in the left nav) — that banks the order-index operation',
  // v2.74.2069 — the draft delete WRITE + the drafts-index READ (the delete lookup's viaLeg).
  DeleteDraftOrder: 'delete a draft order by hand (Orders → Drafts → open a test draft → More actions → Delete draft) — that banks the delete operation',
  DraftOrderList: 'open the Drafts list once (Orders → Drafts in the left nav) — that banks the draft-index operation',
};
/** The by-hand capture instruction for an op. PURE (a safe default for unmapped ops). */
export function opCaptureHint(op) {
  return _OP_CAPTURE_HINTS[String(op || '')] || 'perform that action once by hand in the admin with this tab open';
}

// v2.74.2056 — RC-validate slice 1: the resolver family's missing VALIDATE half (docs/DESIGN_resolve.md §10.5),
// enum-first. Two pure primitives + a coerceParams branch below.
const _enumNorm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
/**
 * Resolve a human WORD to a declared enum MEMBER. PURE. Reuses resolveRideParam's verdict vocabulary:
 * { value } (a member — exact/case/whitespace/declared-synonym) | { ambiguous, candidates } | { unknown };
 * never silently picks between two members that both claim a synonym. STRING enums only — a boolean enum
 * (add_comment `public`) is a classification the model must make, not a word to map. The `synonyms` map is a
 * per-param catalog declaration `{ member: [word, …] }`; without it, only case/whitespace normalization applies.
 */
export function resolveEnumValue(word, enumList, { synonyms = null } = {}) {
  const list = Array.isArray(enumList) ? enumList.filter((x) => typeof x === 'string') : [];
  if (!list.length) return { unknown: true };
  const w = _enumNorm(word);
  if (!w) return { unknown: true };
  const exact = list.find((m) => m.toLowerCase() === w);
  if (exact) return { value: exact };
  if (synonyms && typeof synonyms === 'object') {
    const owners = [];
    for (const m of list) {
      const s = synonyms[m];
      const arr = Array.isArray(s) ? s : (s != null ? [s] : []);
      if (arr.some((x) => _enumNorm(x) === w)) owners.push(m);
    }
    if (owners.length === 1) return { value: owners[0] };
    if (owners.length > 1) return { ambiguous: true, candidates: owners };
  }
  return { unknown: true };
}

/**
 * The refuse-BEFORE-wire primitive (the slice-2 seam — exported now, wired into the executor pre-flight later):
 * every non-blank param whose value is NOT a member of its declared STRING enum after coerceParams. PURE. A caller
 * uses this to refuse a call rather than SPEND it on a value the site will 4xx (the live incident: the model
 * bailed on an opaque enum, then a false 'success' polluted conversation memory). Empty/absent params and boolean
 * enums are never violations.
 */
export function enumViolations(params, paramSchema) {
  const props = (paramSchema && typeof paramSchema === 'object' && paramSchema.properties) || {};
  const out = [];
  for (const [k, v] of Object.entries((params && typeof params === 'object') ? params : {})) {
    const en = props[k] && props[k].enum;
    if (!Array.isArray(en) || !en.every((x) => typeof x === 'string')) continue;   // string enums only
    if (v == null || v === '') continue;
    if (typeof v === 'string' && !en.includes(v)) out.push({ param: k, value: v, enum: en.slice() });
  }
  return out;
}

// v2.74.2063 — RC-validate slice B (DATE). Find `field:<op><operand>` date tokens for the declared dateFilter fields
// inside a search-syntax value. PURE. Shopify writes `processed_at:>2026-07-01`, Zendesk `created>2026-01-01` (no
// colon) — both are matched. The operand is a quoted "…" phrase (so a multi-word 'last month' survives) or a bare
// non-space/comma token. Yields { field, op, operand(unquoted), operandRaw, index, length, whole }.
function _dateTokens(query, fields) {
  const list = (Array.isArray(fields) ? fields : []).filter((f) => typeof f === 'string' && f);
  if (!list.length || typeof query !== 'string' || !query) return [];
  const alt = list.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp('\\b(' + alt + ')(:)?\\s*(>=|<=|>|<|=)?\\s*("[^"]*"|[^\\s(),]+)', 'g');
  const out = [];
  let m;
  while ((m = re.exec(query))) {
    out.push({ field: m[1], op: m[3] || '', operandRaw: m[4], operand: m[4].replace(/^"|"$/g, ''), index: m.index, length: m[0].length, whole: m[0] });
  }
  return out;
}

// Pick the concrete ISO bound a resolved verdict places under a comparator. PURE. A single day (`iso`) places under
// ANY comparator; a RANGE places `from` under `>`/`>=` and `to` under `<`/`<=` — but an equality / no-op range gets
// NULL (don't guess an end: that is the silent-mis-filter class this belt exists to kill).
function _pickDateBound(v, op) {
  if (!v || v.unknown) return null;
  if (v.iso) return v.iso;
  if ((op === '>' || op === '>=') && v.from) return v.from;
  if ((op === '<' || op === '<=') && v.to) return v.to;
  return null;
}

// Rewrite each RELATIVE date operand inside a search-syntax value to a concrete ISO bound, in place. PURE +
// improve-or-noop: only a token whose operand resolveDatePhrase resolves (and whose bound differs) is rewritten; an
// already-ISO or unresolved operand is left byte-identical. `now` (an ISO string) is INJECTED — absent, this is a
// no-op (the branch stays DORMANT until a caller supplies the clock).
function _normalizeDateQuery(value, dateFilter, now) {
  if (typeof value !== 'string' || !value || !now) return value;
  const fields = dateFilter && Array.isArray(dateFilter.fields) ? dateFilter.fields : [];
  const toks = _dateTokens(value, fields);
  if (!toks.length) return value;
  let out = value;
  for (let i = toks.length - 1; i >= 0; i--) {   // right-to-left so earlier indices stay valid across splices
    const t = toks[i];
    const bound = _pickDateBound(resolveDatePhrase(t.operand, now), t.op);
    if (!bound || bound === t.operand) continue;
    const replaced = t.whole.slice(0, t.whole.length - t.operandRaw.length) + bound;
    out = out.slice(0, t.index) + replaced + out.slice(t.index + t.length);
  }
  return out;
}

/**
 * v2.74.2063 — RC-validate slice B (DATE): the refuse-BEFORE-wire primitive for date operands, beside enumViolations
 * (the slice-2 seam — exported now, wired into the executor pre-flight later). PURE. For every declared `dateFilter`
 * param, each `field:<op><operand>` date token whose operand resolveDatePhrase CANNOT resolve (with the injected
 * `now`) is a violation — a caller refuses rather than SPEND the call on a phrase the site would drop / mis-filter
 * (the same fabrication-engine risk the query gate names). DORMANT: zero callers this slice, and a no-op without
 * `now` (a relative phrase is unjudgeable with no clock, so it never false-positives). Returns [{ param, value, field }].
 */
export function dateFilterViolations(params, paramSchema, { now } = {}) {
  const props = (paramSchema && typeof paramSchema === 'object' && paramSchema.properties) || {};
  const out = [];
  if (!now) return out;   // no clock → cannot judge a relative phrase; stay silent (never false-positive)
  for (const [k, v] of Object.entries((params && typeof params === 'object') ? params : {})) {
    const df = props[k] && props[k].dateFilter;
    if (!df || typeof df !== 'object' || typeof v !== 'string' || !v) continue;
    for (const t of _dateTokens(v, Array.isArray(df.fields) ? df.fields : [])) {
      const r = resolveDatePhrase(t.operand, now);
      if (r && r.unknown) out.push({ param: k, value: t.operand, field: t.field });
    }
  }
  return out;
}

// v2.74.2055 — NESTED sanitation (review: every protection stopped at the top level while the catalog's most
// shape-demanding params are nested — a placeholder echo INSIDE line_items rode the wire verbatim, and
// {value:100, valueType:''} was the v1403 'Phone is invalid' class rebuilt one level down). PURE: drop
// placeholder-echo and empty-string members recursively; a fully-emptied container reads as unfilled.
function _scrubNested(v) {
  if (typeof v === 'string') return (v === '' || _PLACEHOLDER_VALUE.test(v.trim())) ? undefined : v;
  if (Array.isArray(v)) { const a = v.map(_scrubNested).filter((x) => x !== undefined); return a.length ? a : undefined; }
  if (v && typeof v === 'object') {
    const o = {}; let kept = 0;
    for (const [k, x] of Object.entries(v)) { const r = _scrubNested(x); if (r !== undefined) { o[k] = r; kept++; } }
    return kept ? o : undefined;
  }
  return v;
}

/**
 * v2.74.2055 — apply fillBody's DROP semantics to a PRE-FILLED JSON body string. The chat door fills via
 * fillWriteBody, whose placeholder-INTACT contract is correct for its own observed-write context — but a
 * catalog-templated write reaching the executor as a string then carried literal "{applied_discount}" members
 * onto the wire (probe-verified; a paid draft deterministically failed GraphQL coercion post-confirm, and a
 * succeeding warranty draft stored "{note}" garbage). One pass here makes the entry's 'unfilled → dropped'
 * contract true for every door. Non-JSON strings return unchanged — the executor's other refusals own them. PURE.
 */
export function stripUnfilledJsonBody(text) {
  const s = String(text || '');
  if (!/^\s*[\[{]/.test(s)) return s;
  try {
    const parsed = JSON.parse(s);
    const scrubbed = _scrubNested(parsed);
    return JSON.stringify(scrubbed === undefined ? (Array.isArray(parsed) ? [] : {}) : scrubbed);
  } catch { return s; }
}

export function coerceParams(params, paramSchema, { now } = {}) {   // v2.74.2063 — `now` (ISO) INJECTED for the date branch; absent keeps every caller's 2-arg behavior byte-identical (dormant)
  const props = (paramSchema && typeof paramSchema === 'object' && paramSchema.properties) || {};
  const out = {};
  for (const [k, vRaw] of Object.entries((params && typeof params === 'object') ? params : {})) {
    let v = vRaw;
    if (typeof v === 'string' && _PLACEHOLDER_VALUE.test(v.trim())) continue;
    // v2.74.2055 — an array/object param emitted as JSON TEXT parses first (the common LLM emission absent
    // structured outputs — else it rides as ONE quoted string into a structured GraphQL variable and dies at
    // coercion after the call is spent); then nested scrub + declared element-gid coercion (the bare
    // variant-id case toShopifyGid existed for, unreachable through the param-level slot).
    {
      const _t = props[k] && props[k].type;
      if ((_t === 'array' || _t === 'object') && typeof v === 'string' && /^\s*[\[{]/.test(v)) {
        try { v = JSON.parse(v); } catch { /* leave as-is — the response trap reports honestly */ }
      }
      if ((_t === 'array' || _t === 'object') && v && typeof v === 'object') {
        const scrubbed = _scrubNested(v);
        if (scrubbed === undefined) continue;   // fully-empty nested optional → unfilled everywhere
        v = scrubbed;
        const eg = props[k] && props[k].elementGid;
        if (eg && typeof eg === 'object' && Array.isArray(v)) {
          v = v.map((el) => {
            if (!el || typeof el !== 'object') return el;
            const o2 = { ...el };
            for (const [f, kind] of Object.entries(eg)) {
              if (o2[f] != null && (typeof o2[f] === 'string' || typeof o2[f] === 'number')) o2[f] = toShopifyGid(o2[f], kind);
            }
            return o2;
          });
        }
      }
    }   // v1405 — the LLM binder sometimes ECHOES a placeholder token ("{company}") as the value for a param it couldn't fill; drop it here so it's treated as unfilled everywhere (body + endpoint), never stored literally. v1657 — ALSO [id]/<id>: the binding layer is the one choke point every executor passes through, so one drop here covers the filter path, the direct-param path, and anything added later
    // v2.74.2056 — RC-validate slice 1: normalize a STRING-enum value to its member (case / whitespace /
    // declared synonym) BEFORE it ships. STRICTLY improve-or-noop: an exact member is unchanged; "OPEN"/"active"
    // → "open" when resolvable; an unresolvable value rides as-is (no worse than today — the refuse-before-wire
    // path is enumViolations, wired in slice 2). Boolean enums (`public`) are a classification, never word-mapped.
    {
      const _pt = props[k] && props[k].type;
      const en = props[k] && props[k].enum;
      // string-typed param ONLY (v2060 review — closes the latent trap of an enum declared beside gid/int/bool:
      // resolving `v` before the type dispatch would then feed a string into the wrong coercion).
      if ((_pt === 'string' || _pt == null) && !(props[k] && props[k].gid)
        && Array.isArray(en) && en.every((x) => typeof x === 'string') && typeof v === 'string' && v.trim() !== '' && !en.includes(v)) {
        const r = resolveEnumValue(v, en, { synonyms: props[k] && props[k].enumSynonyms });
        if (r && r.value) v = r.value;
      }
    }
    // v2.74.2063 — RC-validate slice B (DATE): normalize a RELATIVE date operand inside a declared `dateFilter`
    // param's value to a concrete ISO bound (reads the hop-3 slot props[k].dateFilter). STRICTLY improve-or-noop and
    // DORMANT until `now` is injected — no caller passes { now } this slice (the now-supplying callers are all in
    // contended files), so absent a clock this leaves the value byte-identical, exactly like slice 1's enumViolations
    // shipped callerless. Boolean/int/gid params are never date-typed, so the string guard keeps this off their path.
    {
      const df = props[k] && props[k].dateFilter;
      if (df && typeof df === 'object' && typeof v === 'string' && now) v = _normalizeDateQuery(v, df, now);
    }
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
    // v2.74.1868 — but ONLY for records that were actually harvested. A CURATED record reaching this projection
    // (seedFromCatalog stamps `provenance:'curated'`) is the same binding as its curated-direct twin and must
    // ride the same executor. Stamping header-replay on it sent every curated leg down SESSION_REPLAY, which has
    // no `{handle}` tab-fill — so live 184948 killed FOUR Shopify legs at once with `blocked needs-handle`
    // (customer_by_phone · customer_search · orders_queue · shop_pulse), every one of them working minutes
    // earlier through the curated-direct path. THE CHANNEL IS THE INVARIANT-#3 DIVERGENCE MY OWN HOP SEAL
    // EXEMPTS (`SEEDED_ONLY_TOOL_FIELDS`) — the seal keeps every field honest and waves through the one
    // difference that decides which executor runs. §20 exists for captured cross-origin APIs, not catalog entries.
    if (r.provenance !== 'curated') leg.tool.replay = 'headers';
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

/**
 * v2.74.1863 — THE DRILL-TARGET REDIRECT (pure, catalog-derived).
 *
 * A "drill target" is a leg reachable only with an id that comes OUT of another leg's rows: `vs_warranty_task`
 * takes an internal `TaskId`, `vs_task_contacts` the same, `shopify_order` an order id from the queue. The
 * catalog already declares every one of these relationships (`drill: {via, param, matchOn, also[]}`), so this
 * needs no new field — it just reads the arrow backwards.
 *
 * WHY IT EXISTS. Live 175843 settled that TEXT cannot keep a model out of these legs. `INTERPRET_RAW` caught
 * three distinct overrides in one run: it quoted the "never use a typed number" warning and picked the leg
 * anyway; it REASONED that "4867009 appears to be a task identifier"; and — the one no wording survives — it
 * inferred *"RECENT_TURNS shows 'pull the full details for task id 4886921' succeeded, so we have the internal
 * TaskId"*, when that success came through the LIST door where the number matched a DISPLAY id and the drill
 * supplied a different internal one. **The redirect's own success became the evidence for the next failure.**
 * The two id kinds are both 7-digit integers, so no value check can separate them either (v1860).
 *
 * What CAN be known is PROVENANCE: an id that came from a drill join or a case record is real; one the model
 * bound out of the ask is a display id. The caller supplies that bit; this function supplies the door to send
 * it to instead.
 *
 * @returns {{parentId, matchOn, joinParam}|null} — the LIST leg that owns this target, and the param a
 *   user-named identifier belongs in (its matcher accepts BOTH id kinds and drills with the real one).
 */
export function drillTargetRedirect(recipeId, catalog = CONNECTOR_RECIPES) {
  const id = String(recipeId || '');
  if (!id) return null;
  const list = Array.isArray(catalog) ? catalog : [];
  const target = list.find((r) => r && r.id === id);
  if (!target) return null;
  for (const r of list) {
    const d = r && r.drill;
    if (!d || !d.matchOn || !d.param) continue;                       // a `via` with no join spec cannot redirect
    const also = Array.isArray(d.also) ? d.also : [];
    if (d.via !== id && !also.includes(id)) continue;
    if (r.id === id) continue;                                        // never redirect a leg to itself
    // v2.74.1868 — THE JOIN PARAM MUST DECLARE ITSELF MACHINE-ONLY. v1863 keyed the redirect on drill MEMBERSHIP,
    // which conflates two different properties: "this leg is drilled into" and "a human cannot type this id".
    // They coincide in VendorSuite (the list renders #TicketId, the details leg needs the internal TaskId) and
    // NOT in Shopify — `shopify_order` takes the order NUMBER a person reads off the screen. Live 184948 caught
    // it: the redirect fired on `shopify_order` (correct by the old rule), sent 69872 into the UNFULFILLED
    // queue — a filtered subset that structurally cannot hold a fulfilled order — and turned a working lookup
    // into a confident miss. Membership was a correlation in a sample of one; `machineOnly` is the property.
    const p = (Array.isArray(target.params) ? target.params : []).find((x) => x && x.name === d.param);
    if (!p || p.machineOnly !== true) continue;
    return { parentId: String(r.id), matchOn: String(d.matchOn), joinParam: String(d.param) };
  }
  return null;
}
