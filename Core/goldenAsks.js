/**
 * Core/goldenAsks.js — the golden-ask CORPUS, v0 (Stage 2 of the hardening arc; v2.74.1726). PURE DATA + helpers.
 *
 * Spec: docs/DESIGN_hardening_ladder.md §6 (one corpus, four consumers) · docs/HANDOFF_hardening_arc.md §4.
 * The four consumers: A-0b reads it for coverage (every leg ↔ ≥1 ask — goldenAsks.test.js), B.5 freezes real
 * decisions for its asks, C.1 runs it live and scores aim, and the NEGATIVES encode what must never happen.
 *
 * ── Entry shape ────────────────────────────────────────────────────────────────────────────────────────────
 *   { ask,                       // a NATURAL user phrasing — never a paraphrase of the leg's `does` (else C.1
 *                                //   measures string-match, not routing); trace-verbatim where one exists
 *     expect: { legId } |        // the leg this ask must resolve to (recipe id or builtin key), XOR
 *             { intent },        // the INTENTS clause it must land in (branch / fieldread / case / map / write)
 *     accept?: [ids],            // ADDITIONAL leg ids scored as a hit (run 1: the catalog's own drill-via-list
 *                                //   pattern makes vs_warranty_tasks a correct answer for a single-task ask —
 *                                //   the primary legId still carries A-0b coverage; accept never does)
 *     mustNotResolve?: [ids],    // NEGATIVE: legs this ask must NEVER resolve to (the case→Zendesk class)
 *     expectParams?: {k: str|true}, // v1876 — the leg is necessary, NOT sufficient. Which SLOT must carry the
 *                                //   value: a string is a case-insensitive contains-check, `true` = any non-empty.
 *     mustNotBindParams?: [keys],// NEGATIVE: slots that must stay EMPTY. Live 174833: "warranty tasks on Misty
 *                                //   Creek" resolved to the RIGHT leg and died anyway, because the router bound
 *                                //   the place-name to `divisionId` (required, place-shaped) instead of `address`
 *                                //   (the drill's declared row filter) — so the resolver honestly answered "I
 *                                //   don't know division Misty Creek". A leg-only assertion scored it a HIT, and
 *                                //   the whole text half of the synthetic find leg shipped unreachable.
 *     mustNotIntent?: [intents], // NEGATIVE: intents this ask must never land in (run 2's answer-class — an
 *                                //   act-ask drawing `answer` fabricates about data never fetched)
 *     mustNotWrite?: true,       // NEGATIVE: must never resolve to any write-class leg ("how many…" ≠ a write)
 *     mustBeGated?: true,        // the resolved leg's safety class must NOT be 'auto' (delete/merge/sms class)
 *     mintedAt }                 // provenance stamp — the manifest version that authored/last-corrected the entry
 *
 * Negative keying SETTLED (2026-07-23, was an open decision): BOTH forms exist — `mustNotResolve` (forbidden
 * legs, precise) and `mustNotWrite`/`mustBeGated` (class constraints, robust to catalog growth). An entry may be
 * positive + negative at once ("delete ticket 5" expects delete_ticket AND must be gated).
 *
 * ── Discipline ─────────────────────────────────────────────────────────────────────────────────────────────
 * · Re-harvest ADDS, never replaces (decision-gate §6): new entries get new stamps; old entries never die.
 * · WAIVED_LEGS is the visible, shrinking escape hatch (HANDOFF §4). v0 ships EMPTY — full coverage on day one.
 * · The meta-test (goldenAsks.test.js) enforces both directions: every leg covered-or-waived, and every entry's
 *   ids/intents actually exist (an entry naming a deleted leg is red — corpus rot is loud, not silent).
 */

const MINTED = 'v2.74.1726';   // v0 — every founding entry carries this; later harvests stamp their own

const _e = (list) => list.map((e) => ({ mintedAt: MINTED, ...e }));

export const GOLDEN_ASKS = Object.freeze(_e([
  // ── Zendesk reads ─────────────────────────────────────────────────────────────────────────────────────────
  { ask: 'show my open tickets', expect: { legId: 'my_open_tickets' } },
  { ask: 'show my pending tickets', expect: { legId: 'my_pending_tickets' } },
  { ask: 'what did I solve recently', expect: { legId: 'my_solved_tickets' } },
  { ask: 'show the whole open queue', expect: { legId: 'all_open_tickets' } },
  { ask: 'any unassigned tickets?', expect: { legId: 'unassigned_tickets' } },
  { ask: 'what tickets came in over the last 24 hours', expect: { legId: 'tickets_last_day' } },
  { ask: 'read ticket 4521', expect: { legId: 'read_ticket' } },
  { ask: 'show the conversation on ticket 4521', expect: { legId: 'ticket_comments' } },
  { ask: 'search tickets for water heater', expect: { legId: 'search_tickets' } },
  { ask: 'look up the zendesk user jane@example.com', expect: { legId: 'view_user' } },
  // ── Zendesk writes ────────────────────────────────────────────────────────────────────────────────────────
  { ask: 'create a zendesk ticket about the broken faucet at 12 Elm', expect: { legId: 'create_ticket' } },
  { ask: 'add a comment to ticket 4521 saying the parts shipped', expect: { legId: 'add_comment' } },
  { ask: 'set ticket 4521 to solved', expect: { legId: 'update_ticket_status' } },
  { ask: 'assign ticket 4521 to me', expect: { legId: 'assign_ticket_to_me' } },
  { ask: 'make ticket 4521 urgent', expect: { legId: 'update_ticket_priority' } },
  { ask: 'tag ticket 4521 with warranty', expect: { legId: 'add_tags' } },
  { ask: 'move ticket 4521 to the billing group', expect: { legId: 'reassign_group' } },
  { ask: 'create a zendesk profile for John Smith, john@example.com', expect: { legId: 'create_user' } },
  { ask: 'set the requester on ticket 4521 to john@example.com', expect: { legId: 'set_ticket_requester' } },
  { ask: 'merge ticket 4520 into 4521', expect: { legId: 'merge_tickets' }, mustBeGated: true },
  { ask: 'mark ticket 4521 as spam', expect: { legId: 'mark_as_spam' }, mustBeGated: true },
  // the ladder-§6 canonical: the destructive ask resolves AND stays behind the gate
  { ask: 'delete ticket 5', expect: { legId: 'delete_ticket' }, mustBeGated: true },
  // ── Shopify ───────────────────────────────────────────────────────────────────────────────────────────────
  { ask: 'find the shopify customer with email jane@example.com', expect: { legId: 'shopify_customer_by_email' } },
  { ask: 'find the customer with phone 206-555-0147', expect: { legId: 'shopify_customer_by_phone' } },
  { ask: 'search shopify customers named Rivera', expect: { legId: 'shopify_customer_search' } },
  { ask: 'show the shopify orders for this customer', expect: { legId: 'shopify_orders_for_customer' } },
  { ask: 'look up shopify order 1043', expect: { legId: 'shopify_order' } },
  { ask: 'search shopify products for valve', expect: { legId: 'shopify_search_products' }, accept: ['shopify_admin_search'] },   // v1905 — the admin-bar leg is an equally-correct answer for free words
  // v2.74.1905 — the admin search bar itself (HAR-authored): plain product words rank the way the admin ranks them.
  { ask: 'find the smart switch product', expect: { legId: 'shopify_admin_search' }, expectParams: { query: 'smart switch' }, mintedAt: 'v2.74.1905' },
  // v2.74.1904 — the by-SKU lookup (admin-UI ground truth: the create-order page searches SKU as a first-class
  // field; bare "DK-SW-01" against the default search fields missed live). The negative pins the house split:
  // an exact SKU must not fall to the free-text product search.
  { ask: 'find the product with sku DK-SW-01', expect: { legId: 'shopify_product_by_sku' }, expectParams: { sku: 'DK-SW-01' }, mustNotResolve: ['shopify_search_products'], mintedAt: 'v2.74.1904' },
  // v2.74.1921 — the order timeline (HAR-authored): actor-bearing events are ONLY here — a who/what-happened ask
  // on an order must reach the events leg, never settle for the order record's customer.
  { ask: 'show the order timeline — what has happened on it recently', expect: { legId: 'shopify_order_events' }, mintedAt: 'v2.74.1921' },
  // v2.74.1926 — the creator ask must reach the LAST-page leg: the recent-events window is newest-first, so the
  // creation event is outside it on any busy order (a silent miss biased toward audited orders).
  { ask: 'who created this order?', expect: { legId: 'shopify_order_creator' }, mustNotResolve: ['shopify_order_events'], mintedAt: 'v2.74.1926' },
  // v2.74.1928 — the orders BREADTH read: every "across the orders" question starts here (the queue leg is
  // hardcoded open+unfulfilled and cannot answer a filtered or historical ask).
  { ask: 'find orders tagged draft from this week', expect: { legId: 'shopify_orders_search' }, mintedAt: 'v2.74.1928' },
  // v2.74.1936 — UPS (HAR-authored). The by-number read is the composition target (an order's tracking number
  // feeds it); the recent list is the params-free entry point and the ground's canary.
  { ask: 'where is package 1Z27691W0233595715?', expect: { legId: 'ups_track' }, expectParams: { tracking: '1Z27691W0233595715' }, mintedAt: 'v2.74.1936' },
  { ask: 'what packages have I tracked recently?', expect: { legId: 'ups_recent' }, mintedAt: 'v2.74.1936' },
  { ask: "how's the store doing today", expect: { legId: 'shopify_shop_pulse' } },
  { ask: 'show the unfulfilled orders', expect: { legId: 'shopify_orders_queue' } },
  { ask: 'create a shopify profile for the homeowner', expect: { legId: 'shopify_create_customer' } },   // trace-adjacent (the find-or-create flow)
  { ask: "update the customer's phone number in shopify", expect: { legId: 'shopify_update_customer' } },
  { ask: 'create a draft order for this customer with that valve', expect: { legId: 'shopify_create_order' } },
  // ── VendorSuite (trace-verbatim where live asks exist) ────────────────────────────────────────────────────
  { ask: 'show my vendorsuite state', expect: { legId: 'vs_state' } },
  { ask: 'what version is vendorsuite on', expect: { legId: 'vs_versions' } },
  { ask: 'get open warranty tasks', expect: { legId: 'vs_warranty_tasks' } },   // VERBATIM live (traces 164717/172653)
  { ask: 'open warranty task 4867009', expect: { legId: 'vs_warranty_task' }, accept: ['vs_warranty_tasks'], mintedAt: 'v2.74.1751' },   // run 1 correction: the catalog's OWN drill pattern routes a single task through the LIST leg's address param — either resolve is right
  { ask: 'who are the contacts on task 4867009', expect: { legId: 'vs_task_contacts' } },
  { ask: 'warranty task counts by status', expect: { legId: 'vs_warranty_stats' } },
  { ask: 'any vendor announcements?', expect: { legId: 'vs_announcements' } },
  // ── VendorSuite depth (v2.74.1860) — SHAPE-DERIVED then LIVE-RUN (gl 155750). Each entry below was typed at
  // the real site; the expectations are what the run PROVED, and the negatives are failures it caught. This is
  // the first tranche authored from leg shape rather than from a trace, and it found four defect classes.
  { ask: 'which division am I in right now', expect: { legId: 'vs_state' }, mintedAt: 'v2.74.1860' },              // routed ✓ (the ANSWER gap is a does-overclaim, tracked separately)
  { ask: 'what divisions do I have access to?', expect: { legId: 'vs_state' }, mintedAt: 'v2.74.1860' },           // live ✓ 121 divisions
  { ask: 'what are my permissions in vendorsuite?', expect: { legId: 'vs_state' }, mintedAt: 'v2.74.1860' },       // live ✓
  { ask: 'list the new warranty tasks in Atlanta West', expect: { legId: 'vs_warranty_tasks' }, mintedAt: 'v2.74.1860' },        // live ✓ division-by-NAME + non-default status
  { ask: "show me every division's open warranty tasks", expect: { legId: 'vs_warranty_tasks' }, mintedAt: 'v2.74.1860' },       // live ✓ each-mode over 121 divisions
  { ask: "what's the status of the warranty task at 409 Citron Street", expect: { legId: 'vs_warranty_tasks' }, mintedAt: 'v2.74.1860' },   // live ✓ the ADDRESS DRILL end-to-end (list+address → vs_warranty_task)
  // THE PARAM-KIND NEGATIVES (v1860): a number a person can SEE is a TicketId; this leg takes the internal
  // TaskId, and the site answers a bare http-500. Three live 500s minted these. The list+address door is the
  // only correct resolve for a user-named identifier.
  { ask: 'pull the full details for task id 4886921', expect: { legId: 'vs_warranty_tasks' }, mustNotResolve: ['vs_warranty_task'], mintedAt: 'v2.74.1860' },
  { ask: 'read warranty task 4867009', expect: { legId: 'vs_warranty_tasks' }, mustNotResolve: ['vs_warranty_task'], mintedAt: 'v2.74.1860' },
  // v2.74.1876 — the three phrasings that resolved to the right leg and still died (live 174833). `address` is a
  // DECLARED param whose hint already says "ANY identifier the user names — a STREET address, a TICKET number…",
  // so this is a binder defect, not a catalog gap; these entries are what make it visible to the scoreboard.
  { ask: 'warranty tasks on Misty Creek', expect: { legId: 'vs_warranty_tasks' }, expectParams: { address: 'Misty Creek' }, mustNotBindParams: ['divisionId'], mintedAt: 'v2.74.1876' },
  { ask: 'warranty tasks in Aberdeen', expect: { legId: 'vs_warranty_tasks' }, expectParams: { address: 'Aberdeen' }, mustNotBindParams: ['divisionId'], mintedAt: 'v2.74.1876' },
  { ask: 'warranty tasks for Collinswood', expect: { legId: 'vs_warranty_tasks' }, expectParams: { address: 'Collinswood' }, mintedAt: 'v2.74.1876' },
  // the CONTROL: a real division name MUST still bind divisionId — the repair must not swing the other way
  { ask: 'get open warranty tasks in Charlotte North', expect: { legId: 'vs_warranty_tasks' }, expectParams: { divisionId: 'Charlotte North' }, mintedAt: 'v2.74.1876' },
  // a by-number ask binds the row filter, never the division
  { ask: 'read warranty task 4886921', expect: { legId: 'vs_warranty_tasks' }, expectParams: { address: '4886921' }, mustNotBindParams: ['divisionId'], mintedAt: 'v2.74.1876' },
  { ask: "what's the homeowner's phone number on this task?", expect: { legId: 'vs_task_contacts' }, mintedAt: 'v2.74.1860' },   // the case-context path the does names
  // THE COUNT NEGATIVES (v1860): both pulled the LIST leg live — the second re-ran a 121-division sweep and
  // answered "how many" with a wall of rows. The contested pair since scoreboard run 1.
  { ask: 'how many warranty tasks are new in Raleigh?', expect: { legId: 'vs_warranty_stats' }, mustNotResolve: ['vs_warranty_tasks'], mintedAt: 'v2.74.1860' },
  { ask: 'how many open and fixed tasks do we have', expect: { legId: 'vs_warranty_stats' }, mustNotResolve: ['vs_warranty_tasks'], mintedAt: 'v2.74.1860' },
  { ask: 'give me the warranty dashboard numbers', expect: { legId: 'vs_warranty_stats' }, mintedAt: 'v2.74.1860' },             // live ✓ — the phrasing that already beats the list
  { ask: 'any new notices from the builder?', expect: { legId: 'vs_announcements' }, mintedAt: 'v2.74.1860' },                   // live ✓ — hits without ever saying "announcement"
  { ask: "read the vendor announcements for Atlanta West", expect: { legId: 'vs_announcements' }, mintedAt: 'v2.74.1860' },      // division-scoped, so vs_state's announcements overlap cannot bite
  // NOT MINTED YET — the three vs_versions asks all answered "no data" live and their trace lines were evicted
  // by the ring flood, so whether they even reached the leg is unproven. Minting an expectation on an unproven
  // resolve would freeze a guess as a fact; they land after the re-run (see findings 2026-07-28 15:57).
  // ── HubSpot ───────────────────────────────────────────────────────────────────────────────────────────────
  { ask: 'show my hubspot portal', expect: { legId: 'hubspot_me' } },
  { ask: 'list the hubspot teams', expect: { legId: 'hubspot_teams' } },
  { ask: 'look up jane@example.com in hubspot', expect: { legId: 'hubspot_contact' } },
  // ── Aircall ───────────────────────────────────────────────────────────────────────────────────────────────
  { ask: "who's available on the team right now", expect: { legId: 'aw_team_availability' } },
  { ask: 'am I set to available?', expect: { legId: 'aw_my_availability' } },
  { ask: 'show my aircall profile', expect: { legId: 'aw_my_agent' } },
  { ask: 'show the teammate roster', expect: { legId: 'aw_teammate_roster' } },
  { ask: 'find teammate Sarah', expect: { legId: 'aw_teammate_search' } },
  { ask: 'list the aircall teams', expect: { legId: 'aw_search_teams' } },
  { ask: 'show the missed calls', expect: { legId: 'aw_missed_calls' } },
  { ask: 'what conversations are open', expect: { legId: 'aw_open_conversations' } },
  { ask: 'how many unread conversations', expect: { legId: 'aw_unread_count' } },
  { ask: 'who is 206-555-0147', expect: { legId: 'aw_contact_by_phone' } },
  { ask: 'which lines can text 206-555-0147', expect: { legId: 'aw_authorized_lines' } },
  { ask: 'open the conversation with 206-555-0147', expect: { legId: 'aw_conversation_by_number' } },
  { ask: "what's my line", expect: { legId: 'aw_my_line' }, mustNotIntent: ['answer'], mintedAt: 'v2.74.1753' },   // run 2: drew answer@0.95 — prose about a line never fetched is fabrication
  { ask: 'call history for 206-555-0147', expect: { legId: 'aw_call_history' } },
  { ask: 'set me to away', expect: { legId: 'aw_set_availability' } },
  { ask: "text 206-555-0147 that we're on the way", expect: { legId: 'aw_send_sms' }, mustBeGated: true },
  { ask: 'close this conversation out', expect: { legId: 'aw_close_conversation' }, mustNotIntent: ['answer'], mintedAt: 'v2.74.1753' },   // run 1+2: the terse-ask→answer class, fenced
  // ── Builtin: browser ──────────────────────────────────────────────────────────────────────────────────────
  { ask: 'open youtube.com', expect: { legId: 'OPEN_URL' } },
  { ask: 'switch to the gmail tab', expect: { legId: 'FOCUS_TAB' } },
  { ask: 'close the other tabs', expect: { legId: 'CLOSE_TABS' } },
  { ask: 'what tabs are open', expect: { legId: 'LIST_TABS' } },
  // ── Builtin: self ─────────────────────────────────────────────────────────────────────────────────────────
  { ask: 'what can you do here', expect: { legId: 'LIST_CAPABILITIES' } },
  { ask: "what's running right now", expect: { legId: 'RUN_STATUS' } },
  { ask: 'start a dev conversation', expect: { legId: 'NEW_DEV_CONVERSATION' } },
  { ask: 'start a new conversation', expect: { legId: 'NEW_CONVERSATION' } },
  { ask: 'clear this chat', expect: { legId: 'CLEAR_CHAT' } },
  { ask: 'show my conversation history', expect: { legId: 'OPEN_HISTORY' } },
  { ask: 'delete all conversations', expect: { legId: 'DELETE_ALL_CONVERSATIONS' }, mustBeGated: true },
  { ask: 'open studio', expect: { legId: 'OPEN_STUDIO' } },
  { ask: 'open the ground panel', expect: { legId: 'OPEN_GROUND' } },
  { ask: 'hide the panel', expect: { legId: 'HIDE_PANEL' } },
  { ask: 'reload the extension', expect: { legId: 'RELOAD_EXTENSION' } },
  { ask: 'explore this page', expect: { legId: 'EXPLORE_PAGE' } },
  { ask: 'toggle interaction tracking', expect: { legId: 'TOGGLE_TRACKING' } },
  { ask: 'show my cases', expect: { legId: 'LIST_CASES' } },
  { ask: 'show my workflows', expect: { legId: 'OPEN_WORKFLOWS' } },
  { ask: 'close this case', expect: { legId: 'CLOSE_CASE' } },
  { ask: 'show this in the canvas', expect: { legId: 'DISPLAY' } },
  { ask: 'compose a summary in the canvas', expect: { legId: 'COMPOSE' } },
  // ── THE case→Zendesk canonical (the v1686 misroute, frozen as a negative forever) ────────────────────────
  { ask: 'open a case about the leaking dishwasher', expect: { legId: 'OPEN_CASE' }, mustNotResolve: ['create_ticket'] },
  // ── Count asks are never writes ───────────────────────────────────────────────────────────────────────────
  { ask: 'how many warranty tasks are open', expect: { legId: 'vs_warranty_stats' }, mustNotWrite: true },
  { ask: 'how many tickets are open', mustNotWrite: true },   // pure negative — either count leg is fine, a write never is
  // ── Per-item clause asks (the family this project bled on — ladder §6) ───────────────────────────────────
  { ask: 'which of those ask for a replacement?', expect: { intent: 'branch' } },
  { ask: 'read the vendor note on each one', expect: { intent: 'fieldread' } },
  { ask: 'open a case for each', expect: { intent: 'case' } },
  { ask: 'look each caller up in the CRM', expect: { intent: 'map' } },
  { ask: 'create a shopify profile for each homeowner that has none', expect: { intent: 'write' } },
  // run 1 additions (re-harvest ADDS, never replaces): the originals measure the context-free floor honestly
  // (3/5 clarified standalone); these context-BEARING twins measure the phrasing a real chain carries.
  { ask: 'we just pulled 8 warranty tasks — open a case for each of them', expect: { intent: 'case' }, mintedAt: 'v2.74.1751' },
  { ask: 'from that list of callers, look each one up in the CRM by email', expect: { intent: 'map' }, mintedAt: 'v2.74.1751' },
  { ask: 'for the homeowners we found with no profile, create a shopify profile for each', expect: { intent: 'write' }, mintedAt: 'v2.74.1751' },
  // run 1: the case→Zendesk CANONICAL's runnable twin — the original expects OPEN_CASE (a builtin, panel-scoped,
  // honestly skipped live), so the marquee fence never got live exercise. This PURE negative runs.
  { ask: 'open a case for the leaking dishwasher', mustNotResolve: ['create_ticket'], mintedAt: 'v2.74.1751' },
]));

/** The visible, shrinking waiver list (HANDOFF §4). v0 ships EMPTY — full coverage. An entry here needs {id, why}. */
export const WAIVED_LEGS = Object.freeze([]);

/** Leg ids the corpus covers with a positive expectation. PURE. */
export function coveredLegIds(entries = GOLDEN_ASKS) {
  return new Set(entries.filter((e) => e && e.expect && e.expect.legId).map((e) => e.expect.legId));
}

/** Corpus shape stats for a dashboard / log line. PURE. */
export function corpusStats(entries = GOLDEN_ASKS) {
  const legs = coveredLegIds(entries);
  return {
    entries: entries.length,
    legsCovered: legs.size,
    intents: entries.filter((e) => e.expect && e.expect.intent).length,
    negatives: entries.filter((e) => (e.mustNotResolve && e.mustNotResolve.length) || e.mustNotWrite).length,
    gated: entries.filter((e) => e.mustBeGated).length,
    waived: WAIVED_LEGS.length,
  };
}
