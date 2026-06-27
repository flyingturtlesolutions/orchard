# DESIGN_connectors.md — the Connector tool class

**Status:** BUILDING — **session-ride proven LIVE (read + write) 2026-06-23** (a Zendesk ticket read rode the user's login; an internal-note write authenticated via the page's CSRF token). CX-1…CX-4b + CX-6a landed (v2.74.1150–1157); the §12 cookie contract is resolved. **CX-9 (hybrid read-legs — the lattice per *step*) designed 2026-06-23 (§15).** Next live: CX-6b (`il:` write flow — binder + dry-run/confirm UI). Auth model revised 2026-06-22 (session-ride primary, #1 downgraded — §11). Elaborates the Connector cell of `DESIGN_inference_layer.md` (§2.1 grid, §2.3 arbitration, §4.2 `runTool`, §4.3 availability).

**One line:** the IL router sits above a four-domain tool lattice (`page · browser · connector · self`); this doc fills the **connector** domain with two execution implementations — **session-ride** (call the app's own endpoint from inside the already-authenticated browser, like the grounded caps already do — *primary*) and **OAuth/MCP-broker** (the cloud proxy reaches official/scoped APIs the session can't — *reach-extender*). The model **selects, never executes** in either case.

---

## 1. Connectors are a tool class with two implementations

Two ways to put a Slack/Gmail tool "under the router":

- **(A) Orchard executes, model selects** — the IL picks `gmail.search` like any other leg; Orchard runs it and verifies. Alias flywheel, policy filter, OUTCOMES, per-class safety, injection boundary all keep applying. ← **we take this.**
- **(B) Native model tool-calling** — hand Claude the tool and let the model invoke it. Punches through *model-never-executes*; moves credential custody + injection defense into the model loop. ← **rejected.**

Within (A), "Orchard executes" has **two implementations**, and the split is the heart of this design:

| Implementation | Where the call runs | Credential | Reaches | Best for |
|---|---|---|---|---|
| **Session-ride** (primary) | **client-side** — inside the app's authenticated origin in the browser | **none** — rides the cookies already there | the app's *own/internal* endpoints | reads on apps you're logged into; solo/local users |
| **OAuth/MCP-broker** (reach-extender) | **cloud** — the proxy | OAuth token in a vault | official, *scoped*, stable APIs + MCP servers | writes, scoped access, team governance, apps you're not logged into, headless |

Session-ride is **why Orchard is a browser extension at all** (§3); the broker is what it reaches for when the session can't deliver.

## 2. What already exists (do not rebuild)

| Seam | File | State |
|---|---|---|
| `connector` as a first-class leg domain | `Core/palette.js:10`, `toOfferedLeg` :56 | **built** |
| Per-class safety ladder (`auto·confirm·gated·forbidden`) + floor | `policyFilter` | **built** — HITL is a leg property; the floor is unrelaxable; the rule table can only tighten |
| Class-agnostic router cascade | `Core/route.js` | **built** — Tier-0 alias → Tier-1 retrieve+select; anti-hallucination |
| Availability gate | `assemblePalette` `env` (:124) | **built** — `env.connector` documented |
| Dispatch planner connector arm | `Core/execPlan.js` | **built (CX-2)** — two arms: `INVOKE_SESSION` (session-ride) + `INVOKE_CONNECTOR` (broker) (§7) |
| Leg projection — recipe + MCP tool → `OfferedLeg` | `Core/connectorLeg.js` | **built (CX-1)** — `paramSchema`, `impl`, account-namespaced key, escalate-only `hintToSafety` (§9) |
| Arbitration rule (read→API-first, write→grounded-first) | `DESIGN_inference_layer.md` §2.3 | **designed** (§8) |
| OUTCOMES prior, tool-RAG retrieval | `attachPrior`, R-2 | **built** — connectors inherit both |

## 3. The three auth modes

| Mode | Identity / secret | Runs | Official/scoped? | Who |
|---|---|---|---|---|
| **(C) Session-ride** — *primary* | none (browser session) | client | no / no (full session) | everyone, incl. solo/local |
| **(A) OAuth/MCP-broker** | OAuth token, proxy vault | cloud | yes / yes | account-holders |
| **(B) SSO-derived** | org IDP (OIDC/SAML) → app auth | cloud | yes / yes + governance | teams/enterprise |

**Why session-ride is primary.** The grounded capabilities *already* ride the browser session — driving a logged-in Gmail page **is** riding the session; there was never a credential, because the page is already you. A session-ride connector is that same move one level up: **call the endpoint the page's own frontend calls**, instead of clicking the DOM. So it inherits Orchard's core advantage — credential-free, works for solo/local users, and the credential-custody worry that justified cloud-gating mostly **evaporates** (there is no stored secret to leak).

**The honest limits of session-ride** (why the broker still earns its place):
- **Client-side only.** Cookies live in the browser, so the call must originate there — **not** the cloud proxy. (This is what flips decision #1.)
- **Internal endpoints.** You hit the app's *own* frontend endpoints — undocumented, can change without notice, often ToS-gray. The trade vs OAuth's official, stable, sanctioned API.
- **SameSite / CSRF friction**, especially writes (need the page's CSRF token; `SameSite=Strict` cookies may not ride a background request) — see the open contract in §12.
- **No scoping.** A session is your *full* account; an OAuth token can be read-only / one-channel. So a session-ride **write** is higher blast-radius → gate it *harder* (§9).
- **Nothing to ride** if you're logged out or the service has no web session → fall to the broker.

**The reach-extender (A/B)** earns its keep precisely where (C) can't: official scoped APIs, MCP servers, team/SSO governance, not-logged-in, headless.

## 4. Session-ride implementation (primary)

- **How:** issue the call from an **authenticated context for the app's origin** — its open tab (a content-script `fetch`, which carries that origin's cookies) or a background request carrying the host's cookies via host permission — hitting the app's frontend endpoint; for a write, lift the CSRF token from the page. (Exact cookie/SameSite/no-open-tab mechanics are an open contract — §12.)
- **The leg comes from a recipe, not free.** Session-ride isn't catalog-free: it trades the OAuth catalog for a **per-app endpoint recipe** (`origin · endpoint · param-spec`, e.g. "Gmail search → `GET /sync/.../search?q=…`"). Recipes are **curated** (the session-ride analog of a vetted MCP catalog) and can later be *learned* from observed page traffic. This is the session-ride counterpart of the grounded capability — same "earned, then reused" shape, one layer up from the DOM.
- **Dispatch:** a client-side channel (`INVOKE_SESSION`, §7); `busyMark:false` (no synthetic DOM input → nothing for the interaction monitor to drop).
- **Verification:** the endpoint's structured response **is** the verdict (`toObservation` normalizes it). No DOM trial gate.

## 5. OAuth/MCP-broker implementation (reach-extender)

MCP is the source for this path: an MCP server's tool list *is* a ready-made palette (`name · description · input_schema` → `OfferedLeg`, 1:1). The MCP **client runs in the proxy** (Phase C-P3), never the extension, because it holds OAuth credentials in a **vault** (the Managed-Agents pattern — the extension sees a tool id, the proxy injects the secret at egress).

**Broker API (extension ⇄ proxy):**
```
GET  /connectors/tools?q=<goal>&k=<n>   → OfferedLeg[]   (descriptors only, NO creds)
POST /connectors/invoke { server, tool, args }  → { success, value | error }
```

**Projection — MCP tool → `OfferedLeg`** (pure; `toOfferedLeg` already accepts this shape):
```
mcpTool { name, description, inputSchema, annotations } ⇒
  { key: `${account}.${server}.${name}`, name, does: description,
    mode: annotations.readOnlyHint ? 'ask' : 'act', domain: 'connector', source: 'builtin',
    params: Object.keys(inputSchema.properties),
    paramSchema: prune(inputSchema),                 // §12 fix: carry the schema, not just names
    safety: hintToSafety(annotations),               // §9: hints may only RAISE caution
    tool: { impl: 'oauth', account, server, name } }
```

- **Catalog = curated + user-add (mixed).** Ship a vetted catalog (servers + recipes) → eligible for the read-trust allowlist; let users add their own MCP server URLs / recipes → **always untrusted** (every tool `confirm`/`gated`, never on the allowlist). Available registries to seed the curated set: the official MCP Registry, Anthropic's connectors directory, Docker's MCP Catalog, community aggregators (Smithery, mcp.so, Glama, PulseMCP).
- **SSO for teams (mode B).** Identity via the org IDP; derive app auth via OAuth Token Exchange (RFC 8693) / IDP federation where the app supports it, SSO-gated per-app OAuth otherwise. Maps onto the existing Phase C workspace/ACL model. Individuals (no IDP) use plain per-app OAuth; the broker resolves every invoke to the **calling user's** vault (§12).

## 6. Palette source & availability

`assemblePalette` unions **learned** (`retrieve`, R-2) + **builtins**. Add connectors via one injected dep:
```js
retrieveConnectors?: (goal, k, linked) => Promise<OfferedLeg[]>   // session-ride recipes + linked OAuth tools
```
- **Availability is a set, not a boolean** — `env.connectors = { sessionRideable: Set<app>, oauthLinked: Set<provider> }`. Retrieval only returns tools whose app is reachable (logged-in/recipe-known for session-ride; linked for OAuth). A single `env.connector` flag can't say "Slack yes, GitHub no."
- **Connectors are ground-independent** — not scoped to the current page's Ground (unlike page caps), so retrieval doesn't filter by current Ground.
- Bounded by `k` (never dump a 200-tool server); cached catalog (don't re-fetch per ask — §12).

## 7. Dispatch — replace the stub with two arms

`Core/execPlan.js:80`:
```js
if (domain === 'connector') {
  const t = leg.tool || {};
  if (t.impl === 'session') {
    if (!t.origin || !t.endpoint) return fail('connector', 'session-no-recipe');
    return { ok: true, channel: 'INVOKE_SESSION', busyMark: false, mode, domain: 'connector',
             payload: { origin: t.origin, endpoint: t.endpoint, args: p }, reason: 'session-ride' };
  }
  if (!t.server || !t.name) return fail('connector', 'connector-no-binding');     // oauth / mcp
  return { ok: true, channel: 'INVOKE_CONNECTOR', busyMark: false, mode, domain: 'connector',
           payload: { server: t.server, tool: t.name, args: p }, reason: 'connector-invoke' };
}
```
- `INVOKE_SESSION` → a background/content-script handler that fetches from the app's authenticated origin. `INVOKE_CONNECTOR` → the proxy broker. Both `busyMark:false`; both normalize through `toObservation` (`Core/execPlan.js:92`) — structured success/error, no new normalization. Add both to the Invariant #2 emitter note (no busy-mark — they drive no tab). Tab-resolution prefers an open logged-in tab and **falls back to an ephemeral managed tab** (open→fetch→close, with re-auth focus) when none is open — §16.

## 8. Arbitration

`DESIGN_inference_layer.md` §2.3, now with two API options to rank against scraping:

| Goal | Preference | Why |
|---|---|---|
| **ASK / read** | **session-ride → OAuth/MCP → scrape** | session-ride is free + on-thesis; OAuth where the session can't reach; scrape last |
| **ACT / write** | **grounded T2/T3 → OAuth/MCP → session-ride** | trial gate + visible trace first; among APIs prefer **scoped** OAuth over **full-session** session-ride |

Reads favor the credential-free path; writes favor the *scoped, governable* path. Realized in the `routeAsk` prompt (it sees each candidate's `domain`/`mode`/`impl`) + a read/write tie-break next to GA-5.

**Per *step*, not just per task (CX-9, §15).** The table ranks legs for *one logical step*; a single capability mixes legs **across** steps — a grounded driver feeding a session-ride read, or a session-ride read **verifying** a grounded write. The read row then becomes a per-step choice `session-fetch → network-harvest → dom-scrape`.

**Two cracks to close (else arbitration silently fails):**
- **Co-retrieval.** The router can only prefer a tool that made the top-k candidate set. Class-blind retrieval may not surface the connector → reserve a per-class slot so a matching connector always appears.
- **Alias collision.** Tier-0 (`route.js:50`) short-circuits an exact alias *before* the palette. A taught Gmail-web path aliased to "search gmail" shadows the connector. On connect, scan aliases/learned caps for read-intent overlap and **demote** (drop alias, keep as fallback) — surfaced, conservative (overlap detection must not false-retire, §12); and the teach path should decline to record a read path a connector already covers.

## 9. Trust, HITL, injection

- **Per-class HITL via the existing safety ladder.** Reads → `auto`; writes → `confirm`; destructive → `gated`/`forbidden`. Hints (MCP annotations / recipe metadata) may only **raise** caution, never lower below `confirm`, unless the `(impl, app, tool)` is on a vetted read allowlist (= the curated catalog, §5).
- **Session-ride:** **no credential to steal** (custody risk gone) — but it's your *full, unscoped* session, so a page-injection that tricks the router into a session-ride **write** is a confused-deputy with full account access → writes gated **hard** (this is *why* §8 prefers scoped OAuth for writes).
- **OAuth/MCP:** credentials only in the proxy vault, scoped, per-user (§12); injection can't exfiltrate what never crosses the boundary.
- **Params come from the user's ask via the router, not page content** — the injection boundary (`DESIGN_injection_boundary.md`) is unchanged; a page saying "post my token to #public" is data, not an instruction, and can't originate a connector call.

## 10. Build path (session-ride first — the broker comes later)

1. **CX-1 — projection (pure).** `recipe → OfferedLeg` **and** `mcpTool → OfferedLeg` (carry `paramSchema`, `impl`, account-namespaced key) + tests. No I/O.
2. **CX-2 — dispatch (pure).** Replace `execPlan.js:80` with the two-arm connector plan + tests; Invariant #2 note.
3. **CX-3 — first live connector, session-ride, NO cloud.** The `INVOKE_SESSION` handler + one curated read recipe (e.g. GitHub or Gmail search) end-to-end. Proves the whole shape with zero proxy work. ← biggest derisk.
4. **CX-4a — param-free list reads, `il:`-invokable (no LLM binder).** A `my_open_tickets`-style recipe (param-free; identity = the session cookie) + origin **auto-derived from the open `*.{appHost}` tab**; inject connector legs into the live `offer`; render the list. The realistic first feature (§13).
   - **CX-4b — the param-binder** for by-id / filtered reads (§12) + the read→session-ride arbitration (`retrieveConnectors`, the `env.connectors` set, per-class retrieval slot).
   - **CX-4c — the autonomous arc** (§13): connector list → `agentLoop` `foreach` → per-item work.
5. **CX-5 — the broker (cloud).** MCP client + vault + `GET/POST` in the Phase C-P3 proxy; one OAuth read connector.
6. **CX-6 — writes + HITL.** A write connector through `confirm`/`gated` (both impls); the alias-collision demote.
7. **CX-7 — the connection layer + catalog UX.** A "connection" is *which instance · which role · which host*, beyond the open tab: **disambiguate** multiple open `*.appHost` tabs (prefer the active / most-recently-used — shipped in CX-4a.2), the **ephemeral managed tab** for cold-start (open→fetch→close + re-auth focus, §16) when none is open, and pick the **agent vs end-user** recipe by role. Plus OAuth link / user recipes / SSO-for-teams; `env.connectors` reflects linked + logged-in state.
8. **CX-8 — learn-from-traffic authoring.** One demonstration captures DOM actions **and** the page's network calls (a MAIN-world `fetch`/`XHR` tee) → emits the grounded fragments **and** a session-ride recipe per observed read/write, bound to the same step as an alternative leg (the "learnable from traffic" hook in §4/§12). The multiplier that makes hybrid legs (CX-9) *automatic* instead of hand-authored.
9. **CX-9 — hybrid read-legs (the lattice per *step*).** The `read-leg` kind on the Observation node (`dom-scrape | session-fetch | network-harvest`) + the **network-harvest executor** (A2 — MAIN-world tee; `chrome.debugger` Network as the heavyweight fallback) + the per-step read arbitration (§8). A1 (`session-fetch`) is nearly free — bind a connector recipe as a leg of a learnt step. **Pattern C** (session-ride read *verifies* a grounded write) is the write-side safety multiplier. Provable on a real search (Zendesk / the vendor portal); CX-8 makes it scale. (§15)

CX-1…3 ship a working read connector with **no cloud and no credential**. The broker (CX-5+) is where the live-only seam (proxy, vault, OAuth) needs an eyeball.

## 11. Decisions (revised 2026-06-22)

1. **Auth model — REVISED: two implementations, session-ride primary.** Connectors are **not** uniformly cloud-gated. **Session-ride** is client-side, credential-free, and **ungated by account** (works for solo/local users); the **OAuth/MCP-broker** is cloud-gated and adds official/scoped/team reach. (Supersedes the original "cloud-gated, full stop." The custody argument still holds — but only for the broker path, which is the only one that holds a secret.)
2. **Source — DECIDED: MCP for the broker path; curated recipes for session-ride.** Both via a **mixed catalog** (curated + user-add; user-added always untrusted).
3. **Retrieval — DECIDED: separate `retrieveConnectors` dep**, availability as a set, catalog cached. Unify into one tool-RAG index later only if warranted.
4. **Writes — DECIDED: `gated` until proven**, for *both* implementations — and especially session-ride (full-session blast radius). Loosen per-tool with explicit consent.

## 12. Open contracts (resolved direction; pin before the slice that needs them)

- **Param fidelity** *(CX-1)* — carry the pruned `inputSchema` (`paramSchema`) for binding, not just names. Negligible cost; `routeAsk` already speaks JSON Schema.
- **Session-ride cookie mechanics** *(CX-3 — RESOLVED 2026-06-23)* — a content-script fetch from the app's origin tab carries the SameSite login cookie: **proven live** (Zendesk `/api/v2/tickets/{id}.json` returned the ticket JSON riding the user's session, v2.74.1151). Must run in the origin tab (a background cross-site fetch would not); a stale/missing content script is auto-healed via `_ensureContentScript` (v2.74.1152). **No-open-tab → the ephemeral managed tab** (open→fetch→close; specced §16) — the real browser is/may-be logged in, so Orchard's in-browser locus needs no profile replay (§14).
- **Session-ride recipe catalog** *(CX-3)* — curated `origin·endpoint·param-spec` per app; later learnable from observed traffic.
- **Result shape / limits** *(CX-3/5)* — **offload + preview** (dump big results to a scratch artifact, hand the AI a preview + reference — mirrors MCP's >100K offload and the page-EXTRACT path), with cap/paginate fallbacks.
- **Timeout / cancel** *(CX-3/5)* — per-invoke deadline → structured-failure; thread the existing CR-S abort signal into both invoke channels (+ MCP cancellation for the broker).
- **Per-user credential isolation + OAuth lifecycle** *(CX-5)* — every broker invoke resolves to the calling user's vault; per-provider OAuth dance, refresh, revoke; SSO-derived for teams.
- **Intent ≠ tool-success** *(CX-4)* — a 0-result read is structural success but answers nothing; add a connector-side "did this answer the ask?" check (the connector analog of PB-10).
- **Co-retrieval slot + overlap detection** *(CX-4b/6)* — reserve a per-class candidate slot; detect alias/connector overlap conservatively (no false retirements).
- **Generalization across users/instances** *(CX-7)* — `appHost` + identity-from-the-open-tab is per-user/per-instance correct with **zero config** (another agent or a different Zendesk → *their* tickets; nothing hardcoded — proven `n:11`). Open: multiple open instances (**disambiguate** — active-tab pref shipped CX-4a.2), **no-tab cold start** (**specced — the ephemeral managed tab, §16**), **agent vs end-user** surface (`/api/v2/search` vs `/api/v2/requests` — a per-role recipe), and **host-mapped** Zendesk (`support.acme.com` ∉ `*.zendesk.com` — needs the real host on the connection).

## 13. Usage shapes & identity (2026-06-23 reframe)

Real asks carry neither identity nor ids — **"get my open tickets"**, not "read deako ticket 64222". Two consequences that *de-risk* CX-4:

- **Identity binds at the connection, not the ask.** *Which* Zendesk (`deako`) is a property of the user's connection, set once — never parsed from the ask. For **session-ride, the open logged-in tab IS the connection**: resolve the origin from the open `*.{appHost}` tab (`deako.zendesk.com`). So "get my open tickets" carries nothing identity-shaped. (For the OAuth/broker path, identity is the linked account; same idea, different source.)
- **Primary reads are LIST/SEARCH and param-free.** "My open tickets" is a search/view whose `me` resolves **server-side from the session cookie** — zero ask-params to bind. The dominant read needs **no LLM binder**; the router only maps intent → recipe (JUDGE already does that), dispatched through the existing `{}`-param builtin path. The **by-id / filtered** shape ("ticket 64222", "tickets about X") is *secondary* and is where the param-binder (§12) earns its place — deferred to CX-4b.

This collapses the CX-4 risk I flagged: the realistic first connector (`my_open_tickets`) is a param-free read with a tab-derived origin — no LLM binder, no `decision.params` threading.

**The autonomous arc (the bigger vision).** "Auto: grab all my open Zendesk tickets and, for each, open a conversation and research it" is the connector as a **data source feeding the multi-step loop**: one session-ride list read → `agentLoop` `foreach` over the results → per-item work (spawn a conversation, research, …). The same loop that runs single-shot today, at `maxSteps > 1`, with the connector list as the iteration source. The target (CX-4c), not the first slice.

## 14. Lessons from CS Tools (what transfers — 2026-06-23)

CS Tools — the operator's **in-use** Deako CS toolset ([[reference_cs_tools]]) — is the production proof of this design's session-replay philosophy. Direction: **learn from it.** It runs on the Claude Code terminal via Playwright; Orchard is an extension riding the *live* browser. So the lessons about **response semantics** and **the write gate** transfer; the **credential machinery** does not.

**Transfers (fold into the build):**
- **Health = a live identity probe, never status/cookie** *(CX-4a render + CX-3)* — Zendesk returns **HTTP 200 + an anonymous sentinel user when logged out**, and `cf_clearance` churns while the real session lasts hours. `SESSION_FETCH` checking only `res.ok` is a false-positive risk: inspect the *returned identity* (an empty/anonymous list ≠ "0 results"; it means logged out). The connector face of §12's intent≠success.
- **CSRF writes** *(CX-6)* — read the token straight off the live page's `meta[name="csrf-token"]` (Orchard's content script is already on the page — no headless load), PUT/POST with `X-CSRF-Token`, self-heal once on 401/403.
- **Money/inventory = navigate-only, human-clicks** *(§9)* — never session-ride a refund/return/transfer. Use the **grounded page path**: navigate the tab to the admin page, the human clicks. The tool can't move money on its own. (Above `gated`.)
- **Self-heal once → a clear surface** *(CX-3/6)* — after the one heal fails, say exactly what to do. For Orchard that's "open `<app>` and sign in" — a tab, not a profile re-capture.
- **Composability** *(CX-4c)* — a read's output feeds the next step (their `search_customer → mezmo_query → fetch_logs`). The autonomous arc.

**Does NOT transfer (CS-Tools-specific; Orchard's in-browser locus removes the need):** durable browser profiles, `storageState` snapshots, headless Okta re-warm, `save-*-session` capture, the keepalive, Playwright. Orchard rides the user's *actual* logged-in tab; the no-open-tab case is **open a tab to the origin** (§12), not replay a stored profile.

## 15. Hybrid read-legs — the lattice per *step* (CX-9, designed 2026-06-23)

Arbitration so far (§8) picks a tool **per task**. The deeper move: a learnt path and a session-ride leg compose **inside one capability**, at **per-step** granularity. The unit of choice drops from "this task uses `page` *or* `connector`" to: each logical **step** (a read, a write, a navigate) carries one or more **legs** across classes; the router picks the best-feasible leg per step; and a single demonstration (CX-8) populates multiple legs. A grounded path can *drive* the UI while a session-ride leg *serves the read* — the motivating case: **drive a search via the learnt path, take the results JSON instead of scraping the render.**

**Three read legs for one logical step** (decreasing preference, health-gated):

| Leg | Mechanism | Wins when |
|---|---|---|
| **`session-fetch`** (A1) | skip the UI — call the search endpoint directly with the query as a param (the existing `INVOKE_SESSION`) | the read is *self-contained*: all inputs expressible as endpoint params, no hidden UI state. Fastest, most stable, no driving. |
| **`network-harvest`** (A2) | drive the UI step via the learnt path, but **tee the in-flight JSON response** instead of scraping the render ("before it populates the UI") | the request is *hard to replicate* — UI-set filters, signed params, opaque cursors, CSRF nonces. The page builds the perfect request; you read its response. |
| **`dom-scrape`** (today) | read the rendered DOM (Observation node) | no clean JSON — server-rendered HTML, opaque GraphQL batching, or data computed client-side post-render. The fallback. |

**Why A2 ≠ "A1 but worse."** It sidesteps request signing / CSRF / filter-state replication — the page constructs a valid request with all its context; you only read the response. And on **completeness**: virtualized / infinite-scroll lists only ever hold the *visible window* in the DOM — scraping loses off-screen rows and forces a scroll-to-load loop, while the JSON response carries the **full result set**. So A2 is more complete, more stable, *and* faster (no render wait).

**Mechanics (MV3-real):**
- **A2 interception** — a **MAIN-world `fetch`/`XHR` tee** (the same machinery as CX-8 authoring capture) that `postMessage`s responses to the content script; or **`chrome.debugger` Network** (the `debugger` permission is already held — `manifest.json`) as the heavyweight option. MV3 `webRequest` can't read response bodies → it's these two.
- **Sequencing is strict** — *arm interceptor → run the grounded step → await the matching response* (timeout → fall back to `dom-scrape`). Arm **before** the action fires.
- **Correlation** — a submit fires several XHRs (analytics, autocomplete, the search, lazy sub-fetches). Match the result-bearing one by endpoint shape + params-contains-the-query + timing. The recipe **records which endpoint is "the result."**

**Invariants this touches (don't relearn):**
- **Harvested JSON is untrusted page-origin data** — escape-first injection boundary, identical to scraped DOM. Data, never instructions (§9, `DESIGN_injection_boundary.md`).
- **Busy-mark with a twist (Invariant #2).** The driven span busy-marks (engine clicks are noise) — but the network harvester is the *intended* signal. Suppress the *interaction monitor*; **enable** the harvester. Same shape as the OBS exception: suppress synthesized clicks, keep the capture.
- **Two-leg health, not blind preference.** APIs drift too (versioned endpoints, param changes). A GA-3-style trust score gates which leg the router prefers per step, with fallback to the other — not "session-ride always wins."
- **Semantics drift.** The rendered view sometimes ≠ the raw response (client-side filter/sort/format). The trial gate must confirm the JSON read satisfies the *same intent* as the DOM read it replaces — not just "returns rows."

**Pattern C — session-ride as the *verifier* of a grounded write.** The inverse composition, and the highest-safety one: a learnt path does the gated/irreversible **write** (the API write is forbidden or absent), and a session-ride **read** confirms the effect — replacing the fragile "look for a success toast" postcondition with "re-fetch the record's JSON, assert the field changed." Hardens the trial/verify gate directly (the connector face of PB-8 effect reconciliation). Arguably higher-leverage than the read-easing case: it strengthens the safety net rather than speeding a read.

**Maps onto what exists (small):**
- A **read-leg kind on the Observation node**: `dom-scrape | session-fetch | network-harvest`. Same logical step, preferred leg + fallbacks. `OfferedLeg` already carries `page` + `connector` domains — this lets *one step* hold both.
- **Authoring (CX-8) is the multiplier** — one demonstration captures DOM actions **and** network calls → grounded fragments **and** a session-ride recipe per read, bound to the same step as alternative legs. The combination becomes *automatic*, not hand-wired.
- **Arbitration (§8)** — the read row already prefers `session-ride → … → scrape`; CX-9 makes that a *per-step* choice with `network-harvest` sitting between direct fetch and scrape.

**Build order if taken:** (1) the `read-leg` abstraction on Observation (pure) — **LANDED `Core/readLeg.js` v2.74.1158** (constructors · `normalizeExtract` back-compat · `legFeasible`/`selectReadLeg` per-step arbitration; `shape` is extract-level, legs are pure mechanism); (2) the `network-harvest` executor (A2) — **pure correlation core LANDED `Core/harvest.js` v2.74.1159** (`jsonPath` · `callMatchesLeg` · `matchHarvest`: pick the result-bearing call out of the XHR noise by match+method+2xx+JSON, prefer the query-carrying request, tie-break rows→recency, extract via the `result` path); the **live MAIN-world tee + the ObservationExecutor dispatch branch remain** (impure — needs an eyeball on a real search); (3) bind A1 (`session-fetch`) as a leg of a learnt step (nearly free — route the leg's `tool` through `INVOKE_SESSION`); (4) Pattern C for the write side. CX-8 (dual capture) is what makes legs accrue without hand-authoring.

## 16. Cold-start ride — the ephemeral managed tab (CX-7)

Resolves the §12 *no-open-tab* contract. `ride` reaches an endpoint by riding a same-origin tab's cookies, so today "no logged-in tab on the origin" → `no-authenticated-tab` and the ride dies. But the real requirement is a **live session cookie, not a *kept-open* tab** — cookies live in the browser's shared per-origin jar, so a tab Orchard opens itself **inherits** the existing login. The ephemeral managed tab supplies the missing same-origin context on demand. It is an **acceptable headless** — background, transient, no babysitting — *within* ride's envelope (still browser-bound + session-lifetime-bounded; true headless/cron is `broker`/managed-replay, §14).

**Not the default — a fallback.** `INVOKE_SESSION` tab-resolution (§7) order:
1. an already-open, live, logged-in tab on the origin — **preferred** (zero side-effects, the user's real context; active/MRU disambiguation, CX-4a.2);
2. **the ephemeral managed tab** — only when (1) finds none. The default path is unchanged; this is the cold-start arm for *"the resource isn't open."*

**Lifecycle — open → ensure → fetch → close.**
1. `chrome.tabs.create({ url: 'https://<origin>/', active: false })` — a **background** tab (no focus steal). The fresh tab inherits the cookie jar; for a Cloudflare/Okta app the navigation itself clears the challenge and warms `cf_clearance` (the open *is* the warm-up).
2. `ensureContentScript(tabId)`; for a **write**, wait for `meta[name="csrf-token"]` to render — a **read** fires as soon as the content script is live (document_start).
3. identity probe (if `verifyIdentity`) → `SESSION_FETCH`.
4. `chrome.tabs.remove(tabId)` on completion.

**Reuse, don't churn.** A managed tab is tracked **per-origin** with an **idle-TTL**: a burst (a `foreach` over a list read) shares one tab and closes it after N s idle / at run-end — open-per-request only for a lone call. Concurrent rides to one origin share the tab.

**Re-auth — focus the tab for sign-in (don't close it).** Opening a tab *inherits* auth; it cannot *create* it. If the ephemeral tab is unauthenticated — the identity probe returns anon, or the navigation lands on a login/SSO page — **do not close it**:
1. **promote it to the foreground** — `chrome.tabs.update(tabId, { active: true })` + focus its window — so the user lands on the app's real login page;
2. surface *"sign in to `<app>` to continue — your `<ride>` is waiting"*;
3. **watch for sign-in** (`webNavigation` + re-probe); when the identity probe passes, **resume the pending ride** on the now-authenticated tab, then apply the normal close/idle policy.

Orchard never types the credentials (the injection boundary, §9) — it only brings the user to the login surface and resumes. A `confirm`/`gated` ride still passes its own HITL gate after re-auth.

**`Connection` guards compose here** (the pure-core slice):
- **wrong-account** — the probed identity must match the leg's `account` namespace; a mismatch → `wrong-account` (never act as the wrong principal), surfaced like expiry (focus the tab so the user can switch login).
- **freshness** — the probe + `lastVerifiedAt` set `Connection.status` (`unknown` until probed → `fresh` after → `signed-out`/`wrong-account` on the guard paths).

**Caveats (behavioral).** inherits-not-creates auth (above); writes wait for the CSRF meta, reads don't; Cloudflare apps pay a one-time challenge-clear on a cold open (then `cf_clearance` persists); a background tab briefly shows in the tab strip (a minimized helper window hides it if it ever matters); still browser-bound + session-lifetime-bounded.

**Safety.** Unchanged trust posture — a full-session ride (writes `gated`/`confirm`). The open/close is a benign tab op needing **no new permission** (`tabs` + `<all_urls>` already held). The one new user-facing act is *focusing a tab so the human can sign in*, which is on the right side of the injection boundary (the user acts; Orchard enters nothing).

**Build (pure-first; live edge flagged).**
1. `Core/connection.js` **(pure)** — **BUILT v2.74.1238** — `assessProbe`/`rideAction` (the anon-sentinel + wrong-account verdict → proceed | reauth-focus), `connectionFromProbe`/`connectionFreshness` (TTL), `pickRideTab` (live, active-then-MRU). 17 tests.
2. `INVOKE_SESSION` glue **(impure — eyeball pending)** — **BUILT v2.74.1239** — `pickRideTab` → ephemeral `tabs.create({active:false})` → `_waitTabComplete` → `ensureContentScript` → ride → idle-`tabs.remove`; per-origin managed-tab registry (reuse + idle-TTL + `onRemoved` cleanup) + a `lastOriginByAppHost` memory for cold-start. `account` threaded → the wrong-account guard is live-capable.
3. re-auth focus + resume **(impure — eyeball pending)** — **BUILT v2.74.1240** — `_focusTab` + `_waitForReauth` (`webNavigation`-driven re-probe on each settled nav, tab-closed cancel, 90 s deadline) → resume the pending invoke; the focused tab is promoted out of the disposable registry. **Caveat:** a long idle wait can outlive the MV3 SW — the robust form (chrome.alarms + a persisted continuation + out-of-band delivery, the `alarms` permission is already held) is the hardening follow-up.

## 17. Recipe definition at scale — Explore harvests reads, demonstrate-once for writes (designed 2026-06-27)

**The problem.** The curated `CONNECTOR_RECIPES` catalog (`Core/connectorRecipes.js`) is hand-authored — one engineer per API, Zendesk-only today. It does not scale to the long tail of apps a user actually runs. "How else can a recipe be defined?"

**The thesis.** A ride recipe is the **network twin of a DOM capability** — its own definition is *"the same request the app's own UI button fires."* So it is *learned*, the way Orchard learns DOM capabilities (OBS-1..4: observe → generalize → trial → bank), pointed at the network layer. **The capture machinery already exists** — §15's `network-harvest` (A2: a MAIN-world `fetch`/XHR tee or `chrome.debugger`), `Core/harvest.js` correlation, and CX-8 dual-capture. §17 adds the one missing *source*: **autonomous breadth** — a whole app's read catalog harvested *without the user performing each task*.

**Two definition paths, one gate.**

| | Driver | Cost to user | Why safe |
|---|---|---|---|
| **Reads** | **Explore (engine)** — the templated crawl already navigates the app autonomously; each page load fires the app's read APIs → harvest them | **zero** — no task performed | EX-1 destructive-veto keeps the crawl read-only *by construction* |
| **Writes** | **the user (once)** — demonstrate only the writes worth teaching; CX-8 captures the request | one demo per write | fail-closed HITL forever (§9); **never** engine-fired |

Both proto-recipes pass **generalize → trial-verify → bank** (the OBS flywheel; the trial gate closes the staleness/hallucination hole). Banked recipes land in the same origin-keyed palette the hand catalog feeds (`connectorLegsForConnections`/`recipeForOrigin`).

**The crawl IS the generalizer (the unique win over §15/CX-8).** A single demonstration can't turn `64863 → {id}` without a guess. The Explore crawl visits **many** instances of a page type (ticket #1, #2, #3 — id-segment templating + sitemap ingestion, both built) → **multiple captures of the same endpoint with different ids → diff them → the varying segment collapses to `{param}` deterministically.** Breadth is the generalization signal; the LLM is only the fallback for the single-sample case, plus naming + `does` + intent. The identity call (`/users/me`) fires on the first authenticated load → `{me}` solved for free.

**The ladder (where a recipe can come from).** Hand-authored (today; precise, doesn't scale) · **Explore-harvest (primary — autonomous reads)** · CX-8 demonstrate (writes + the read tail the crawl doesn't exercise — interaction-gated searches) · OpenAPI/GraphQL-introspection + LLM-synthesis (cold-start *accelerants*: propose a candidate catalog, but feed the **same** trial-verify gate — never trusted unverified, because the published/official API ≠ the frontend API the session rides) · user/community declarative + federation (the crowd play, over the P2b sync).

**Maps onto what exists (small).**
- **Capture** — ⚠ **CORRECTION (v2.74.1274):** §15's live tee was **never built** — `Core/harvest.js` is only the pure `matchHarvest` correlation algorithm (its header calls the live tee "the next slice"), with no live consumer and no `canHarvest` producer. So §17 capture is a **new** surface, NOT a reuse. Built: a **body-blind MAIN-world fetch/XHR tee** (`_harvestTeeFunc` in `background/handlers/sg.js`) that records **only `{method, url, status}` for same-site calls — it never reads a response body**, so it's strictly *narrower + safer* than §15's A2 tee (which needs bodies to extract rows). Consent-gated on the C6 Track toggle; armed/drained by `ARM_HARVEST_TEE` / `DRAIN_HARVEST_TEE` (the latter banks via the shared `_bankHarvested`). The `matchHarvest` row-extractor is a *separate* (still-unbuilt) §15/A2 concern — recipe-harvest needs only the endpoint shape, not the rows.
- **Driver** — reuse the Explore templated crawl (Completeness slices, built) + EX-6 auto-explore. The harvester rides the crawl; the crawl already enumerates the read surface.
- **Verify** — reuse the trial gate (`RUN_SG_TRIAL` / PB-*): probe the harvested endpoint, confirm the response shape + *same intent* (not just "returns rows" — §15's semantics-drift caveat).
- **Bank** — a harvested recipe is a `CONNECTOR_RECIPES`-shaped record matched by origin; no new palette path.

**Invariants this touches (don't relearn).**
- **Method IS the safety class.** GET → read (`auto`); non-GET → write (`gated`, fail-closed HITL); DELETE/merge/`mark_as_spam` → `destructive`. The classifier is the HTTP method; a harvested recipe is **never** auto-armed for writes regardless of how it was born (§9). Money/inventory stays navigate-only (§14) even if a write endpoint is observed.
- **Harvested JSON is untrusted page-origin data** — escape-first, never instructions (§9, identical to §15).
- **Busy-mark with the §15 twist** — the crawl's engine clicks busy-mark the *interaction monitor* (noise), but the harvester is the *intended* signal: suppress the monitor, **enable** the harvest (same shape as the OBS exception, Invariant #2).
- **Verify identity, not status** (§14) — a harvested read against a logged-out crawl returns 200 + an anonymous sentinel → a *false* recipe. Gate harvest on a passing identity probe.

**Why this may beat passive DOM-synth.** [[passive_synthesis_parked]] parked PS-3/4 (synth-from-harvest) because DOM identity is toggle/state-coupled with **no postcondition**. A recipe dodges both: an **endpoint+method is a stable identity** (not coupled to render state), and the **response shape is a real postcondition** the trial gate can assert. So the wall that stopped passive DOM-synthesis likely does not block network-recipe harvest — PS-0/1/2's "harvest stays a cheap source" extends cleanly to the network layer.

**Build order (pure-first; reuses landed cores).**
1. **Capture surface** *(impure — the one real new surface)* — ✅ **BUILT (v2.74.1274–1275):** the body-blind tee lives in `ContentScripts/harvestTee.js` (records `{method, url, status}` only — NOT body/query). Two injection paths: **single-page** `ARM_HARVEST_TEE`/`DRAIN_HARVEST_TEE` (executeScript post-load), and a **harvest SESSION** `START_HARVEST_SESSION`/`STOP_HARVEST_SESSION` (1275) that registers the tee at **document_start** (`registerContentScripts`, MAIN world, scoped to the Ground host) — the only way to catch a page's *initial* data-load fetches — accumulating across same-origin navs in `sessionStorage`, then unregister + `_bankHarvested` on stop. All consent-gated (C6 Track). ✅ **AUTONOMOUS (v2.74.1276):** the architecture crawl (`START_DISCOVERY` → `DiscoveryService.discover`) now arms a harvest session before the crawl and banks on every exit (its `finally`). `bankHarvested`/`startHarvestSession`/`stopHarvestSession` lifted to module-level exports in sg.js so the crawl drives them directly; consent-gated, and gated on `existingTabId` (the durable Ground-panel tab we can drain — the dedicated-tab crawl closes its own tab, so that path is skipped until a postMessage relay replaces the sessionStorage drain). **Live-UNVERIFIED.**
2. **`Core/recipeFromHarvest.js` (pure + tested)** — ✅ **BUILT (v2.74.1272).** group captures by endpoint; **diff multi-instance captures → `{param}` templating**; classify read/write/destructive by method; detect the identity call; emit a proto-`CONNECTOR_RECIPES` record. The crawl-as-generalizer core.
3. **LLM polish** *(cheap tier)* — ✅ **BUILT (v2.74.1273):** `Core/recipePolishPrompt.js` + `AnthropicService.polishRecipe` (structure-only input; safe relabel via `applyPolish`). The OBS-4 analog. *(Single-sample generalization fallback already lives in `templatePath`.)*
4. **Bank** — ✅ **BUILT (v2.74.1273):** `_bankHarvested` → `mergeRecipes` into the per-Ground §18 collection, landing **`pending`** behind the arm guard (human review in Studio IS the verify gate). **Pending:** an *optional* auto-trial-probe (same-intent gate) before bank — an enhancement, since pending + HITL-accept already gates.
5. **CX-8 write capture** — the demonstrate-once path for writes (already the §15 multiplier; surface it as "teach this write"). *(Pending.)*

**~~Open decision~~ RESOLVED (v2.74.1274):** **MAIN-world `fetch`/XHR tee**, body-blind — chosen over CDP (`debugger`) to avoid the "started debugging this browser" infobar for a whole crawl. The fragility tradeoff (misses pre-injection calls; a page could override the patch) is accepted; the crawl re-arms per navigation. CDP stays the fallback if a target app proves to defeat the MAIN-world patch.

## 18. Per-Ground tool surface — Drive / Ride / Broker observability (designed 2026-06-27)

**Why this comes before §17.** A harvested recipe must land in a surface that can DISPLAY + EDIT it — you cannot bank into a view that can't show or correct it (the `_DECISION_RE` lesson, generalized to a whole tool class). And the review/edit surface IS the **human gate** for the harvest: a harvested write lands `pending` + `gated` and is un-armable until a human accepts it here. So observability precedes the flywheel — and forces the data-model question now.

**The hierarchy — two tiers.** A Ground's tools group by **class** (HOW it executes), then by **substrate type** (WHAT kind, within the class). **Ride is a peer of Drive (the class level), NOT of fragments** (a substrate type *inside* Drive):

```
Ground
├─ DRIVE   (grounded page execution)   Fragments · Perspectives · Assertions · Locales · Landmarks · Strategies/Workflows
├─ RIDE    (session-ride, §4)          Recipes (reads + writes, safety-badged)
└─ BROKER  (OAuth/MCP, §5 — later)     (placeholder)
```

Matches §1 (connectors are a tool class) + the [tool lattice](project_router_over_tools.md): the router selects *across* classes, so the surface must make the classes visible, not flatten substrate types up to the class level. Studio's existing flat `ground-section-row`s (Fragments/Perspectives/Assertions/Locales) **re-parent under a Drive group**; Ride + Broker are new *sibling class groups*; `Recipes` sits inside Ride exactly as `Fragments` sits inside Drive.

**The data-model shift (the crux — the UI is downstream).** Ride recipes are GLOBAL today: `CONNECTOR_RECIPES` is one static catalog matched to a Ground by origin at runtime (`connectorLegsForConnections`). For per-Ground display/edit AND to have somewhere to bank harvested entries, they become a **per-Ground collection** — the shape `sgCapabilities` already has. A Ground's recipes = the curated catalog (seeded by origin) ∪ its harvested/demonstrated ones, each carrying:
`{ provenance: curated|harvested|demonstrated, safetyClass: auto|gated|destructive (method-derived, §9), trust (GA-3), enabled, reviewState: pending|accepted }`.

**The arm guard (the teeth).** `armable(recipe) = enabled ∧ reviewState==='accepted' ∧ safety-gates-pass`. Enforced at the connector **dispatch** (not just the UI): a `pending` harvested write is never executed. This is **GA-4** (pending-review + arm guard) generalized from capabilities to the ride class — the harvest's safety net.

**Build path (pure-first; each slice independently valuable + testable).**
1. **`Core/rideRecipe.js` (pure + tested)** — the per-Ground record + collection ops: `safetyClassForMethod` (the §9 classifier) · `seedFromCatalog(origin)` (curated `CONNECTOR_RECIPES` → per-Ground records) · `mergeRecipes` (re-seed + harvested, preserving user edits) · edit transforms (`setEnabled` · `review` accept/reject · `downgradeSafety` — gated-only, **never** promote a write to auto · `editMeta`) · `armable`. **The data-model shift; everything else renders it.**
2. **Per-Ground storage + handlers (impure)** — read/write the collection by `groundId` (mirror `sgCapabilities`), seed-on-first-access; `GET / SAVE / REVIEW_RIDE_RECIPE`.
3. **`Core/groundToolSurface.js` (pure + tested)** — `(ground, recipes, broker) → { drive:[{type,count,entries}], ride:[…], broker:[…] }`. The ONE tri-class model BOTH surfaces render — the hierarchy becomes a tested contract, not ad-hoc UI nesting.
4. **Studio class-tier refactor (impure — eyeball)** — re-parent drive sections under a Drive group; add Ride (Recipes rows: name · `does` · method+endpoint · params · safety badge · provenance · health · enabled) + a Broker placeholder; edit ops (toggle · edit · downgrade · delete · re-verify · review→accept/reject). Renders `groundToolSurface`.
5. **Ground-panel tri-class cards (impure)** — Drive/Ride/Broker cards in `Sidepanel/modes/ground-view.js`; the Ride card glances recipes (safety badge · health dot · toggle) + a "N pending review" deep-link to Studio.
6. **Arm guard + review lifecycle wired (impure)** — enforce `armable` at the connector dispatch; the pending→accept/reject transitions surfaced in both views. GA-4 for the ride class.

→ **Then** §17's harvest banks into this collection (`provenance: harvested`, `reviewState: pending`), and the human reviews it here before it is armable.

**Reuse (not net-new machinery):** the `sgCapabilities` per-Ground shape · GA-4 review-lifecycle + arm-guard · GA-3 trust/health · the Studio `ground-section` pattern · §9 method=safety-class. The genuinely new code is `rideRecipe.js` + `groundToolSurface.js` (both pure) + the two render surfaces.
