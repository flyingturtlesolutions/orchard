// Core/routerHints.js — v2.74.1862. THE ROUTER-FACING ONE-LINER for a curated recipe, keyed by recipe id.
//
// WHY THIS EXISTS. `interpretPrompt` renders a leg's `does` into the prompt's `detail:` line under a hard 140-char
// budget (it splits on ' — ' and accumulates whole segments while they fit — interpretPrompt.js:236-238). Measured
// 2026-07-28: **22 of 60 curated entries are CLIPPED, and 2,541 authored characters never reach the router** —
// including `vs_task_contacts`' "by its INTERNAL task id" warning, whose absence produced a live http-500, and
// `vs_warranty_stats`' "NEVER the task list itself", whose absence let count-asks pull the list leg for four runs.
// Authors were writing careful discriminating prose into a field the router reads only the first 140 chars of.
//
// Two ways to fix that; this is the one that keeps both readers honest:
//   • RAISE THE BUDGET — costs only ~4% input tokens, but restores 2,541 chars of HUMAN-facing prose, diluting the
//     router's attention rather than sharpening it. More tokens ≠ more signal.
//   • SPLIT THE AUDIENCE (this file) — `does` goes on serving humans and the surfaces that read it whole
//     (groundFacts, the decomposer, answer prose); a hint is authored FOR the budget and says only what a router
//     needs: when to pick this leg over its siblings, and when NOT to.
//
// KEYED BY RECIPE ID, NOT THREADED THROUGH THE ENTRY. That is deliberate and it sidesteps invariant #3 entirely:
// a hint carried as a recipe FIELD would have to survive all three catalog→leg hops to reach a SEEDED Ground's
// legs (the exact class the invariant records). A lookup by `tool.recipeId` at render time reaches curated and
// seeded legs identically, with no hops to drop it on.
//
// THE SEAL (Core/catalogConformance.js): a clipped `does` with no hint here is a VIOLATION, and a hint whose
// recipe no longer exists is a VIOLATION. Both directions, so this file cannot silently rot or silently miss.
//
// WRITING ONE: ≤140 chars, no ' — ' needed (it is rendered whole). State the DISCRIMINATOR — the thing that picks
// this leg over the sibling it is confused with — not a summary. "NEVER x" earns its place when a live trace shows
// the confusion. Sanitized through the same fence as every other catalog string at render.

export const ROUTER_HINT_MAX = 140;

export const ROUTER_HINTS = Object.freeze({
  // ── Zendesk ────────────────────────────────────────────────────────────────────────────────────────────────
  all_open_tickets: "the WHOLE queue: everyone's + unassigned open tickets, oldest first — for your own, use the my-tickets legs",
  read_ticket: "one ticket's CONTENTS as text (\"what does it say / what's it about\") — never for opening or showing the page",

  // ── Shopify ────────────────────────────────────────────────────────────────────────────────────────────────
  shopify_customer_by_phone: 'find a Shopify customer by PHONE digits — near-matches: confirm the number matches exactly before trusting a hit',
  shopify_customer_search: 'search Shopify customers by NAME or free words — fuzzy, so confirm the email before trusting a hit',
  shopify_order: 'one Shopify order by its ORDER NUMBER (digits like 69872, never the DEAKO# prefix): status, totals, tracking',
  // v2.74.1904 — the product pair splits like by_email/by_phone: free words vs an exact SKU.
  shopify_search_products: 'a products-API query for field syntax (status:, tag:, vendor:) — plain words prefer the admin search; exact SKU the by-SKU leg',
  shopify_admin_search: 'search products by WORDS the way the admin bar does — relevance-ranked; the first choice for "find/search <product words>"',
  shopify_order_events: 'the order TIMELINE by internal gid — WHO created/refunded/fulfilled it and when; fetch the order first, then ask',
  shopify_product_by_sku: 'the product carrying an EXACT variant SKU (like DK-SW-01) — never for words from a title',
  shopify_shop_pulse: 'a params-free health check that the Shopify admin session works — not a data read',
  shopify_orders_queue: 'THE fulfillment queue: open unfulfilled orders, newest first; give an order number to drill straight into one',
  shopify_create_customer: 'CREATE a new Shopify customer profile — needs a name plus an email and/or phone (at least one contact)',
  shopify_update_customer: 'EDIT an EXISTING Shopify customer (name/email/phone/note/tags) by the id from a lookup; only fields you set change',
  shopify_create_order: 'create a DRAFT order (variant id + qty) for a human to complete — free replacement: 100% discount + zero shipping',

  // ── VendorSuite ────────────────────────────────────────────────────────────────────────────────────────────
  // vs_state's `does` advertises "and current announcements", which made a bare "any announcements?" ambiguous
  // against vs_announcements by construction. The hint hands that sense to the other leg.
  vs_state: 'your own VendorSuite context: current division, divisions you can access, permissions (announcement TEXT: use the announcements leg)',
  vs_warranty_tasks: "tasks by status (new/open/fixed/closed); division: name, market#, blank=current, or 'each'; any number/address a person names → `address`",
  vs_warranty_task: 'full details ONLY from an INTERNAL TaskId you already hold; a number a person typed is a TICKET id → send it to the task LIST as `address`',
  vs_task_contacts: "homeowner contacts (name/phone/email) by INTERNAL TaskId only; a number a person names is a TICKET id → use the task LIST's `address`",
  vs_warranty_stats: "COUNTS only (\"how many new/open/fixed\") from the dashboard statistic — NEVER the task list itself; division by name, market#, or blank",

  // ── HubSpot ────────────────────────────────────────────────────────────────────────────────────────────────
  hubspot_me: 'a health check of your HubSpot session + portal identity — not a contact or data read',
  hubspot_teams: 'the teams in your HubSpot portal (name, members, child teams) — "what teams are there?", "who is on <team>?"',
  hubspot_contact: 'ONE HubSpot contact by its INTERNAL record id — there is NO by-email lookup here; an email search is not built',

  // ── Aircall ────────────────────────────────────────────────────────────────────────────────────────────────
  aw_team_availability: "EVERY teammate's live availability company-wide (\"who is available?\") — not your own status",
  aw_my_availability: 'YOUR OWN availability right now ("am I available?", "am I on do-not-disturb?") — reads only, never sets',
  aw_conversation_by_number: 'the conversation thread for a number ON A SPECIFIC LINE — needs both the line and the number',
  aw_set_availability: 'SET your availability (available / unavailable / do-not-disturb / busy / back-office) — a write; never places or answers calls',
});

/** The router-facing line for a recipe id, or '' when none is declared. PURE. */
export function routerHintFor(recipeId) {
  const id = (recipeId == null) ? '' : String(recipeId);
  return Object.prototype.hasOwnProperty.call(ROUTER_HINTS, id) ? ROUTER_HINTS[id] : '';
}
