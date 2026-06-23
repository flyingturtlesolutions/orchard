# DESIGN_connectors.md — the Connector tool class

**Status:** BUILDING — **session-ride proven LIVE 2026-06-23** (a Zendesk ticket read rode the user's login). CX-1/CX-2/CX-3 landed (v2.74.1150–1152); the §12 cookie contract is resolved. Next: CX-4 (feed connectors into the palette so `il:` selects them). Auth model revised 2026-06-22 (session-ride primary, #1 downgraded — §11). Elaborates the Connector cell of `DESIGN_inference_layer.md` (§2.1 grid, §2.3 arbitration, §4.2 `runTool`, §4.3 availability).

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
- `INVOKE_SESSION` → a background/content-script handler that fetches from the app's authenticated origin. `INVOKE_CONNECTOR` → the proxy broker. Both `busyMark:false`; both normalize through `toObservation` (`Core/execPlan.js:92`) — structured success/error, no new normalization. Add both to the Invariant #2 emitter note (no busy-mark — they drive no tab).

## 8. Arbitration

`DESIGN_inference_layer.md` §2.3, now with two API options to rank against scraping:

| Goal | Preference | Why |
|---|---|---|
| **ASK / read** | **session-ride → OAuth/MCP → scrape** | session-ride is free + on-thesis; OAuth where the session can't reach; scrape last |
| **ACT / write** | **grounded T2/T3 → OAuth/MCP → session-ride** | trial gate + visible trace first; among APIs prefer **scoped** OAuth over **full-session** session-ride |

Reads favor the credential-free path; writes favor the *scoped, governable* path. Realized in the `routeAsk` prompt (it sees each candidate's `domain`/`mode`/`impl`) + a read/write tie-break next to GA-5.

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
7. **CX-7 — the connection layer + catalog UX.** A "connection" is *which instance · which role · which host*, beyond the open tab: **disambiguate** multiple open `*.appHost` tabs (prefer the active / most-recently-used — shipped in CX-4a.2), **remember the instance** for the cold-start "open a tab" (§14) when none is open, and pick the **agent vs end-user** recipe by role. Plus OAuth link / user recipes / SSO-for-teams; `env.connectors` reflects linked + logged-in state.

CX-1…3 ship a working read connector with **no cloud and no credential**. The broker (CX-5+) is where the live-only seam (proxy, vault, OAuth) needs an eyeball.

## 11. Decisions (revised 2026-06-22)

1. **Auth model — REVISED: two implementations, session-ride primary.** Connectors are **not** uniformly cloud-gated. **Session-ride** is client-side, credential-free, and **ungated by account** (works for solo/local users); the **OAuth/MCP-broker** is cloud-gated and adds official/scoped/team reach. (Supersedes the original "cloud-gated, full stop." The custody argument still holds — but only for the broker path, which is the only one that holds a secret.)
2. **Source — DECIDED: MCP for the broker path; curated recipes for session-ride.** Both via a **mixed catalog** (curated + user-add; user-added always untrusted).
3. **Retrieval — DECIDED: separate `retrieveConnectors` dep**, availability as a set, catalog cached. Unify into one tool-RAG index later only if warranted.
4. **Writes — DECIDED: `gated` until proven**, for *both* implementations — and especially session-ride (full-session blast radius). Loosen per-tool with explicit consent.

## 12. Open contracts (resolved direction; pin before the slice that needs them)

- **Param fidelity** *(CX-1)* — carry the pruned `inputSchema` (`paramSchema`) for binding, not just names. Negligible cost; `routeAsk` already speaks JSON Schema.
- **Session-ride cookie mechanics** *(CX-3 — RESOLVED 2026-06-23)* — a content-script fetch from the app's origin tab carries the SameSite login cookie: **proven live** (Zendesk `/api/v2/tickets/{id}.json` returned the ticket JSON riding the user's session, v2.74.1151). Must run in the origin tab (a background cross-site fetch would not); a stale/missing content script is auto-healed via `_ensureContentScript` (v2.74.1152). **No-open-tab → open a tab to the origin** (the real browser is/may-be logged in) — Orchard's in-browser locus needs no profile replay (§14).
- **Session-ride recipe catalog** *(CX-3)* — curated `origin·endpoint·param-spec` per app; later learnable from observed traffic.
- **Result shape / limits** *(CX-3/5)* — **offload + preview** (dump big results to a scratch artifact, hand the AI a preview + reference — mirrors MCP's >100K offload and the page-EXTRACT path), with cap/paginate fallbacks.
- **Timeout / cancel** *(CX-3/5)* — per-invoke deadline → structured-failure; thread the existing CR-S abort signal into both invoke channels (+ MCP cancellation for the broker).
- **Per-user credential isolation + OAuth lifecycle** *(CX-5)* — every broker invoke resolves to the calling user's vault; per-provider OAuth dance, refresh, revoke; SSO-derived for teams.
- **Intent ≠ tool-success** *(CX-4)* — a 0-result read is structural success but answers nothing; add a connector-side "did this answer the ask?" check (the connector analog of PB-10).
- **Co-retrieval slot + overlap detection** *(CX-4b/6)* — reserve a per-class candidate slot; detect alias/connector overlap conservatively (no false retirements).
- **Generalization across users/instances** *(CX-7)* — `appHost` + identity-from-the-open-tab is per-user/per-instance correct with **zero config** (another agent or a different Zendesk → *their* tickets; nothing hardcoded — proven `n:11`). Open: multiple open instances (**disambiguate** — active-tab pref shipped CX-4a.2), **no-tab cold start** (needs the remembered instance to open one — §14), **agent vs end-user** surface (`/api/v2/search` vs `/api/v2/requests` — a per-role recipe), and **host-mapped** Zendesk (`support.acme.com` ∉ `*.zendesk.com` — needs the real host on the connection).

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
