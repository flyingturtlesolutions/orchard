# DESIGN_connectors.md — the Connector tool class

**Status:** DESIGN — **auth model revised 2026-06-22** (session-ride is now the primary implementation; decision #1 downgraded, see §11). Not built. Elaborates the greenfield Connector cell of `DESIGN_inference_layer.md` (§2.1 grid, §2.3 arbitration, §4.2 `runTool`, §4.3 availability). Build path in §10 (CX-1/CX-2 pure + headless; CX-3 is the first live connector and needs **no** cloud).

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
| Dispatch planner connector arm | `Core/execPlan.js:80` | **stubbed** — `fail('connector','connector-greenfield')` ← now needs **two** arms (§7) |
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
4. **CX-4 — palette + arbitration.** `retrieveConnectors` + the `env.connectors` set + the read preference (session→OAuth→scrape) into `routeAsk`; reserve the per-class retrieval slot.
5. **CX-5 — the broker (cloud).** MCP client + vault + `GET/POST` in the Phase C-P3 proxy; one OAuth read connector.
6. **CX-6 — writes + HITL.** A write connector through `confirm`/`gated` (both impls); the alias-collision demote.
7. **CX-7 — account/catalog UX.** Link OAuth, add user MCP URLs / recipes, SSO-for-teams; `env.connectors` reflects linked + logged-in state.

CX-1…3 ship a working read connector with **no cloud and no credential**. The broker (CX-5+) is where the live-only seam (proxy, vault, OAuth) needs an eyeball.

## 11. Decisions (revised 2026-06-22)

1. **Auth model — REVISED: two implementations, session-ride primary.** Connectors are **not** uniformly cloud-gated. **Session-ride** is client-side, credential-free, and **ungated by account** (works for solo/local users); the **OAuth/MCP-broker** is cloud-gated and adds official/scoped/team reach. (Supersedes the original "cloud-gated, full stop." The custody argument still holds — but only for the broker path, which is the only one that holds a secret.)
2. **Source — DECIDED: MCP for the broker path; curated recipes for session-ride.** Both via a **mixed catalog** (curated + user-add; user-added always untrusted).
3. **Retrieval — DECIDED: separate `retrieveConnectors` dep**, availability as a set, catalog cached. Unify into one tool-RAG index later only if warranted.
4. **Writes — DECIDED: `gated` until proven**, for *both* implementations — and especially session-ride (full-session blast radius). Loosen per-tool with explicit consent.

## 12. Open contracts (resolved direction; pin before the slice that needs them)

- **Param fidelity** *(CX-1)* — carry the pruned `inputSchema` (`paramSchema`) for binding, not just names. Negligible cost; `routeAsk` already speaks JSON Schema.
- **Session-ride cookie mechanics** *(CX-3, live-only)* — does a background `fetch` carry the host's cookies past SameSite, or must it run in the app's tab? What if no tab is open (open a hidden tab? offscreen?)? Verify live.
- **Session-ride recipe catalog** *(CX-3)* — curated `origin·endpoint·param-spec` per app; later learnable from observed traffic.
- **Result shape / limits** *(CX-3/5)* — **offload + preview** (dump big results to a scratch artifact, hand the AI a preview + reference — mirrors MCP's >100K offload and the page-EXTRACT path), with cap/paginate fallbacks.
- **Timeout / cancel** *(CX-3/5)* — per-invoke deadline → structured-failure; thread the existing CR-S abort signal into both invoke channels (+ MCP cancellation for the broker).
- **Per-user credential isolation + OAuth lifecycle** *(CX-5)* — every broker invoke resolves to the calling user's vault; per-provider OAuth dance, refresh, revoke; SSO-derived for teams.
- **Intent ≠ tool-success** *(CX-4)* — a 0-result read is structural success but answers nothing; add a connector-side "did this answer the ask?" check (the connector analog of PB-10).
- **Co-retrieval slot + overlap detection** *(CX-4/6)* — reserve a per-class candidate slot; detect alias/connector overlap conservatively (no false retirements).
