# DESIGN_connectors.md — the Connector tool class (approach A: brokered)

**Status:** DESIGN LOCKED — the four forks (§9) settled 2026-06-22; not built. Elaborates the **greenfield Connector cell** of `DESIGN_inference_layer.md` (§2.1 grid, §2.3 arbitration, §4.2 `runTool`, §4.3 availability). No code yet; build path in §8 (start CX-1/CX-2 — pure, headless-testable).

**One line:** the IL router already sits above a four-domain tool lattice (`page · browser · connector · self`); this doc fills the **connector** domain by brokering external tools (MCP servers — Slack, GitHub, Notion, …) through Orchard's cloud proxy, exposing each as a normal `OfferedLeg` the router selects over. The model still **selects, never executes** — the proxy executes and holds credentials. Purely additive: no change to the router contract, the loop, or the trust spine.

---

## 1. Why approach A (brokered), restated

Two ways to put a Slack tool "under the router":

- **(A) Brokered as a palette tool class** — Orchard's proxy holds the credential and makes the call; the IL *selects* `slack.search` like any other leg. The model proposes, **Orchard executes + verifies**. Alias flywheel, policy filter, OUTCOMES, per-class safety, and the injection boundary all keep applying unchanged.
- **(B) Native model tool-calling** — hand Claude the tool via MCP/connectors and let the model invoke it. Punches through *model-never-executes*; moves credential custody + injection defense into the model loop; loses the uniform Orchard verify/gate/alias layer.

**We take (A).** It widens the existing palette instead of forking the architecture. Everything below is additive to seams that already exist (§2).

## 2. What already exists (do not rebuild)

| Seam | File | State |
|---|---|---|
| `connector` as a first-class leg domain | `Core/palette.js:10`, `toOfferedLeg` line 56 | **built** — `connector` is in the domain enum; `toOfferedLeg` already normalizes a connector descriptor |
| Per-class safety ladder (`auto·confirm·gated·forbidden`) + floor | `policyFilter` (`Core/palette.js`) | **built** — HITL is a leg property; floor (`forbidden`) is unrelaxable; the user rule table can only tighten |
| Class-agnostic router cascade | `Core/route.js` | **built** — Tier-0 alias → Tier-1 retrieve+select+parameterize; anti-hallucination (selected tool must be offered) |
| Availability gate | `assemblePalette` `env` (`Core/palette.js:124`) | **built** — `env.connector` is a documented flag; legs gate on `requires` |
| Dispatch planner with a connector arm | `Core/execPlan.js:80` | **stubbed** — `if (domain === 'connector') return fail('connector', 'connector-greenfield')` ← the hole this doc fills |
| Arbitration rule (read→API-first, write→grounded-first) | `DESIGN_inference_layer.md` §2.3 | **designed** — see §6 |
| OUTCOMES prior per leg, tool-RAG retrieval | `attachPrior`, R-2 | **built** — connectors inherit both |

So the greenfield is: **the broker (§3), the palette source (§4), the executor that replaces the stub (§5), and two policy realizations (§6, §7).** Nothing else.

## 3. The broker — MCP via the managed proxy

A connector tool is `(server, tool, input_schema, description)`. The cleanest source of those is **MCP**: an MCP server's tool list *is* a ready-made tool palette (`name · description · input_schema` maps 1:1 to an `OfferedLeg`). Orchard becomes an **MCP client** — but **the client runs in the managed proxy** (Phase C-P3), not the extension. Reasons:

1. **Credential custody / injection.** Connector credentials (Slack OAuth, GitHub PAT, …) must never enter the page/extension trust surface. The proxy holds them in a **vault** (the Managed-Agents pattern: the sandbox/extension sees only a tool id; the proxy injects the credential at egress). A page that prompt-injects the IL can never read or redirect a credential it never sees.
2. **MV3 reality.** A spec-compliant MCP client (SSE / streamable-HTTP transport, OAuth refresh, CORS) is painful in a service worker. The proxy already speaks HTTP to backends.
3. **Trust rule parity.** Same posture as the dev-bridge: the extension never holds the high-trust secret.

**Consequence to flag (the load-bearing product decision):** connectors are **cloud-gated** — they require an Orchard account + the proxy. Local-only / BYO-key users get no connectors (the leg simply isn't offered; `env.connector = false`). See §9.

**Broker API (extension ⇄ proxy), two calls:**

```
GET  /connectors/tools?ground=<id>&q=<goal>&k=<n>   → OfferedLeg[]   (connector-class, descriptors only — NO creds)
POST /connectors/invoke  { server, tool, args }     → { success, value | error }   (proxy injects creds, calls MCP)
```

**Projection — MCP tool → `OfferedLeg`** (pure, testable):

```
mcpTool { name, description, inputSchema, annotations } ⇒
  { key: `${server}.${name}`, name, does: description,
    mode: annotations.readOnlyHint ? 'ask' : 'act',
    domain: 'connector', source: 'builtin',
    params: Object.keys(inputSchema.properties),
    safety: annotations.readOnlyHint ? 'auto'
          : annotations.destructiveHint ? 'gated' : 'confirm',
    tool: { server, name, inputSchema } }
```

`toOfferedLeg` already accepts exactly this shape (`Core/palette.js:56`). MCP's `readOnlyHint`/`destructiveHint` annotations drive the safety class directly (§7).

## 4. How connector legs enter the palette

`assemblePalette` today unions **learned** (`retrieve`, R-2) + **builtins** (`availableBuiltins`). Connectors are dynamic and potentially many → they retrieve like learned tools, **not** a fixed registry. Add one injected dep:

```js
// Core/palette.js — assemblePalette deps
retrieveConnectors?: (goal, k) => Promise<OfferedLeg[]>   // → GET /connectors/tools (cold-path only)
```

- Gated on `env.connector` (no account linked ⇒ dep absent ⇒ zero connector legs; the cascade is unchanged).
- Bounded by the same `k` (never dump a 200-tool MCP server into the palette — retrieve top-k by goal, server-side or via the proxy's own embedding).
- Merged into the existing union/dedupe/policy/prior pipeline with **no structural change** — connector legs are just more `OfferedLeg`s. (Dedupe is by `key`; a connector key `slack.search` never collides with a learned key, so both can coexist for arbitration in §6.)

## 5. Dispatch — replace the stub

`Core/execPlan.js:80` becomes a real plan instead of `connector-greenfield`:

```js
if (domain === 'connector') {
  const t = leg.tool || {};
  if (!t.server || !t.name) return fail('connector', 'connector-no-binding');
  return { ok: true, channel: 'INVOKE_CONNECTOR', busyMark: false, mode,
           domain: 'connector', payload: { server: t.server, tool: t.name, args: p },
           reason: 'connector-invoke' };
}
```

- **`busyMark: false`** — a connector call drives no tab, so Invariant #2 doesn't apply (no synthetic DOM input to suppress). Worth a one-line note in the invariant's emitter list so it's not "re-discovered."
- **New executor:** a background handler answers `INVOKE_CONNECTOR` by calling `POST /connectors/invoke`. It's the new arm of `ilRun`'s injected `exec`. The MCP result (or error) returns as `{ success, value }`; **`toObservation` already normalizes it** (`Core/execPlan.js:92`) — structured success/error, no new normalization.
- **Verification is the result itself.** API tools self-verify: the MCP response *is* the verdict. **No DOM trial/verify gate** — that gate is page-capability-specific. This is why read connectors are cheap and robust (§6).

## 6. Arbitration — the Slack-search rule

`DESIGN_inference_layer.md` §2.3 already states it; this is how it's realized once both a connector leg and a learned page-path can be offered for the same intent:

| Goal class | Preference | Why |
|---|---|---|
| **ASK / read** (search, count, fetch) | **connector first**, grounded fallback | structured fetch beats scrape; self-verifying; no drift/healing; cheaper/faster |
| **ACT / write** (post, create, delete) | **grounded T2/T3 first** even if an API exists | trial gate + visible trace + reversible-ish; an API write is fire-and-forget |

"Search Slack" is the read case → the Slack connector wins over a recorded Slack-web path. Realization, in order of preference:

1. **Router prompt (primary).** `routeAsk` (R-3) is told the §2.3 rule and sees each candidate's `domain` + `mode`; for a read goal it prefers a `connector` candidate. Cheap, no new ranking code.
2. **Tie-break prior (secondary).** A small score nudge in retrieval: for read goals, `connector` class > `learned page` for the same intent; inverted for writes. Lives next to the GA-5 OUTCOMES tie-break.

**The alias-flywheel collision (must-fix, else the rule is silently defeated).** Tier-0 (`route.js:50`) short-circuits an exact alias *before the palette is ever assembled*. A Slack-web path taught and aliased to "search slack" will replay deterministically and the connector never gets a vote. Two-part fix:

- **At connect time:** when a connector is linked, scan existing aliases/learned caps for read-intent overlaps with the new connector tools and **demote** them (drop the alias, keep the capability as a fallback) — surfaced to the user, not silent.
- **Going forward:** the teach path should **decline to record** a read path for ground a connector already covers ("you have the Slack tool for this — want me to use that instead?").

## 7. Trust, HITL, injection

- **Per-op HITL via the existing safety ladder.** Read ops → `auto` (low-friction). Writes → `confirm`. Destructive (delete, send-to-many, money-move) → `gated`/`forbidden`. Driven directly by MCP `readOnlyHint`/`destructiveHint` at projection (§3). No new gate machinery — `policyFilter` + the panel's HITL confirm already enforce it (`execPlan` stamps the human `name` so the confirm reads "post to #general via Slack?").
- **Credential custody.** Credentials live only in the proxy vault; the extension/model see a tool id. Injection can't exfiltrate what never crosses the boundary.
- **Params come from the user's ask via the router, not from page content.** The injection boundary (`DESIGN_injection_boundary.md`) is unchanged: untrusted page strings stay on the escape-first render path and are never lifted into connector `args`. A page saying "post my token to #public" is page *data*, not an instruction — it cannot originate a connector call.
- **Higher stakes than a click → default conservative.** A connector acting on the user's real workspace is a bigger blast radius than a DOM click. Default new write connectors to `gated` until proven; loosen per-tool with explicit consent (the rule table tightens only — loosening the floor needs elevated consent, per §2.3).

## 8. Build path (slices, each shippable + verifiable)

1. **CX-1 — projection (pure).** `mcpTool → OfferedLeg` + unit tests. No I/O. (Mirrors the `toOfferedLeg` contract.)
2. **CX-2 — dispatch (pure).** Replace `execPlan.js:80` stub with the `INVOKE_CONNECTOR` plan + tests; add to the Invariant #2 emitter note (no busy-mark).
3. **CX-3 — broker (proxy).** MCP client + vault + `GET /connectors/tools` + `POST /connectors/invoke` in the Phase C-P3 proxy. One server end-to-end (Slack, read-only).
4. **CX-4 — palette source.** `retrieveConnectors` dep + `env.connector` gate wired into `assemblePalette`; the `INVOKE_CONNECTOR` background handler (`exec` arm).
5. **CX-5 — arbitration.** §2.3 rule into the `routeAsk` prompt + the read/write tie-break; **the alias-collision demote/decline (§6) — do not skip, it defeats the feature.**
6. **CX-6 — write ops + HITL.** A write connector (e.g. `slack.post`) end-to-end through the `confirm`/`gated` path; live-verify the panel confirm.
7. **CX-7 — account UX.** Link/unlink connectors in settings (OAuth handled proxy-side); `env.connector` reflects linked state.

Read-only Slack search is live after CX-1…4. Everything before CX-3 is pure + headless-testable; CX-3+ needs the proxy and a live eyeball (the live-only seam).

## 9. Decisions (locked 2026-06-22)

All four resolved as recommended. Rationale kept for the record; revisit only with cause.

1. **Cloud-gated connectors — DECIDED: cloud-gated.** The broker + credentials live in the proxy (§3); the extension never holds a secret. Consequence accepted: connectors require an Orchard account — local / BYO-key users get none. (Rejected: in-extension credentials in `chrome.storage` — worse injection posture.)
2. **Connector source — DECIDED: MCP.** An MCP server's tool list projects 1:1 to `OfferedLeg`s (§3), so Orchard gets the ecosystem in one uniform shape. (Rejected: hand-authored per-provider adapters — more control, unbounded manual work.)
3. **Retrieval shape — DECIDED: separate `retrieveConnectors` dep first.** Simpler to gate on/off by account state (§4); unify into one tool-RAG index later only if it proves worth it. (Start simple.)
4. **Write default — DECIDED: `gated` until proven.** Every write connector confirms by default; loosen per-tool with explicit consent. The harm is asymmetric — a wrong write hits real accounts and is hard to undo. (Rejected: trusting MCP `destructiveHint` from day one.)
