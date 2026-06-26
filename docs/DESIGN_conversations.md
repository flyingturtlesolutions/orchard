# DESIGN_conversations.md — conversations as apps

**Status:** DESIGN — **CV-1…6 BUILT** (v2.74.1160–1183: schema, seed→IL, accordion + gallery, sub-task spawn, custom apps, writePolicy). **Model ENRICHED 2026-06-24** (§6A): setup-for-**every**-app, capabilities-and-connectors-are-**global**, the **six app dimensions**, target≡connection, session-ride tooling, and the **goal-directed learning model** (`DESIGN_apps_learning.md`). The original §1–§13 are the shipped structure; §6A is the configured-app model layered on top (it supersedes "the prompt is the only variable" and "questionnaire only for custom apps"). Sibling to `DESIGN_connectors.md` (the tool lattice) + `DESIGN_apps_learning.md` (how an app learns toward its goal).

**One line:** every conversation is the one inference layer (IL) wearing a prompt; an **app** is that IL configured for a goal (a **seed prompt** + light config), picked from a gallery and kept as a **Rail** track (the Rail = the conversation-navigation pane; §7.1). The prompt is the only thing that varies — tools, router, and safety gates are uniform.

**Rejected (don't let it creep back):** a second "global/coordinator" engine, a fleet roster, per-conversation capability boundaries, authority envelopes, autonomy classes. All of that collapses into *the prompt* + the *uniform* gate. The model is deliberately flat.

---

## 1. The model — one shared substrate, the app's CONFIG is the variable

The IL is one shared engine (route → palette → judge → execute), and the **tools, capabilities, and connectors are a SHARED substrate** — *constant* across every conversation. A **conversation = the shared substrate + a per-conversation CONFIG.** The config creates identity, concern, behaviour; two conversations are the same engine + the same substrate, only the config differs.

This is *why* "an app is just the IL configured" holds: every app runs the same read → think → act loop over the same substrate; the config sets the goal, targets, behaviour, and emphasis.

> *2026-06-24 — this supersedes the original "the prompt is the only variable." The variable grew from a bare prompt into a small **config** (seed + bound site/shape + learned capabilities + standing rules + cadence + chat model — §6A; focus is learned at runtime, not set at setup), but the principle is unchanged: **one engine, one shared substrate; the app varies only the view.** Critically, **capabilities and connectors are GLOBAL** — the app is a lens, never a silo (§6A.1).*

## 2. Roles — Overview, apps, sub-tasks

| Role | What it is | Lifecycle |
|---|---|---|
| **Overview** | the canonical conversation — system-default prompt, editable; the general assistant + the home surface | always present; **cannot be created or deleted** (reserved) |
| **App** | a conversation configured for a goal (a seed + light config); the **parent** of its sub-tasks | `kind:'app'`; one app per concern; added from the gallery |
| **Sub-task** | a child conversation under an app — the app's concern parameterized (e.g. one per ticket) | a conversation with `parentId`; a **leaf** (no children — §5 cap) |

You chat at **any level** — Overview, an app, or one of its sub-tasks. All the **same IL**, just a different prompt (§6).

**Visual uniform, semantically split (don't conflate).** The **Rail** renders one **flush-left accordion** (§7): Overview, apps under it, sub-tasks under each app. But the two edges differ in kind:
- **app → sub-task = inheritance** — the sub-task's prompt *composes* the app's seed (§6); the app owns and can read across its children.
- **Overview → app = navigation only** — apps keep their own seeds and stay portable/shareable; the Overview neither seeds nor (in v1) coordinates them. "Overview = parent of apps" is true for *grouping*, false for *inheritance*.

Dev/design tracks (`kind:'dev'`) are a *separate* surface gated by the Studio "Enable dev mode" toggle (`settings:devMode`, v2.74.1160) — the precedent for the drawer's `kind`-filter.

## 3. Archetypes — descriptive, not enforced

The archetype names **which verb dominates** the loop — a vocabulary + a starting template, *not* a capability fence (same engine, all tools).

| Archetype | dominant verb | shape | builtins |
|---|---|---|---|
| **Operator** | operate a *queue* | read → enrich → act, per item | Inbox, Support, Recruiter |
| **Monitor** | watch *state* | watch → compute → notify | Financial, Price/Job watcher, Research digest |
| **Executor** | run a *task* | plan → act → commit (gated) | Shopper, Booking, Form-filler |

Archetypes are **soft**: a monitor can execute (watch-and-act is the *best* monitor — buy on a price drop, dispute a bad charge). The hard boundary is the **verb-gate** (§8), not the archetype — crossing watch→act trips the write gate, not an "archetype line." The Overview is the no-archetype base.

## 4. What makes an app useful

An app earns its place over *just chatting in the Overview* when it: **recurs/persists** (not a one-off) · has a **bounded, known surface** (a home it specializes to) · **offloads toil or vigilance** · has a **checkable goal** · is **mostly safe-autonomous with a thin human commit** · operates over a **set** (fan-out leverage). Anti-pattern — one-off, unbounded-surface, or all-gated-writes → that's the Overview, not an app.

## 5. Data model — `AppDefinition`, the app, the sub-task

Shapes:

```
AppDefinition (catalog entry — builtin | user | shared)
  { id, name, description, icon, archetype, seed, defaultConfig, version, source }

App (a conversation, extending the ConversationStore record — Services/ConversationStore.js:136)
  { ...conversation, kind:'app', seed (copied), config (copied + editable), appId, appVersion, icon }

Sub-task (a conversation, child of an app)
  { ...conversation, kind:'app', parentId:<app id>, seed (app-specialized), … }
```

- **Copy-on-add** (decision #4): the definition's `seed + config` are **copied** into the app; edits are local + **immediate** (decision #8). `appVersion` lets a newer builtin offer "re-pull."
- **`config` is tighten-only** (§8). **v1:** `{ writePolicy?: 'never' | 'gated' }`. **Deferred:** `allowedOrigins`, `schedule`. A sub-task **inherits its app's `config`** — a child can never be looser than its parent.
- **One-level cap (decision #9):** a sub-task is a **leaf** — no sub-sub-tasks. `parentId` always points at an app, never another sub-task. Depth is exactly Overview → app → sub-task; deeper nesting is the rejected fleet model.
- The **Overview** is a reserved conversation — fixed id, `kind:'agent'`, the system-default seed, delete-guarded; no `parentId`.
- Reuses `conv:index` (the summaries store) — each summary carries `kind + appId + parentId + icon` so the drawer builds the accordion (and an app reads *across* its children, §6) without loading bodies.

## 6. The IL-context contract — the one behavior change

Today the IL is **stateless per ask**: `_tryIlCommand` (`chat.js:3227`) strips the input to the bare ask; `runIlStandin` (`Core/ilStandin.js:64`) takes no conversation. So every turn is the general assistant re-grounding on the current tab — there's no "this conversation is about X."

**The change** (and the *only* one that makes an app behave differently): thread the current track's `{ seed, recentMessages }` into the IL call as `conversationContext`. The `seed` becomes the system-prompt preamble for that conversation's turns; the history is the running context. Tools, router, and palette are unchanged.

**Injection boundary** (`DESIGN_injection_boundary.md`): the `seed` is **trusted** (user/builtin authored); message history and any entity content the IL reads are **untrusted data** — escape-first, never instructions. The seed sets *focus*; it never widens tool access. No new mechanism — this is the standard boundary.

**Two levels, one mechanism — seed composition.** A sub-task's effective system prompt = **its app's seed (role/persona/policy) ∘ the sub-task's own seed (the specific item)** — e.g. the Support-agent instructions + "this is ticket #64222." The app inherits *down*; the sub-task specializes. At the **app level** the context is the app's own seed + its history (+ optionally a roll-up of its sub-tasks). Overview → app does **not** compose — apps are independent roots (§2).

**Bounded across.** Chatting at an app may reason over *its own* sub-tasks ("how many of my tickets are billing?") by reading `conv:index` filtered by `parentId`. This is the safe, scoped form of the rejected coordinator — bounded to one app's children, never global. (Overview → across *all apps* is the deferred portfolio, decision #5.)

## 6A. The configured app — setup · targets · tooling · learning (2026-06-24 enrichment)

CV-1…6 shipped the thin "seed + light config" app. This section folds in the model as sharpened over the
2026-06-24 design pass; it **supersedes** "the prompt is the only variable" (§1) and "questionnaire only for custom
apps" (§9 / decision #7). The CV build is the substrate it sits on.

### 6A.1 An app is a CONFIG over a SHARED substrate (capabilities + connectors are global)

The variable is the app's **config**, not just a prompt; the substrate is shared. **Six dimensions:**

| Dimension | What | Where |
|---|---|---|
| **Goal / context** | seed (role) + bound site / shape (from setup); focus is *learned*, not set | app config |
| **History / experience** | the typed, tiered **belief + behavior-delta learning store** (`DESIGN_apps_learning.md`) — *not* a chat log | app store |
| **Standing rules** | persistent *if-X-do-Y* (authored deltas; *learned* deltas from a mismatch) | app config |
| **Cadence** | *when* it runs | deferred (backend) |
| **Chat mental model** | the interaction / presentation most useful for *this* work | app config (latest to build) |
| **Tooling** | the shared `page · browser · connector · self` lattice — incl. **session-ride** | **SHARED** |

**Capabilities AND connectors are GLOBAL — the app is a lens, never a silo.** Teaching "get inbox contents" inside
the Inbox manager banks it on the **Gmail Ground** (or as a session-ride recipe) — globally; Overview and every
other app can call it. The app *authored* it; it does not *own* it. This preserves the founding principle: one IL,
one tool + capability substrate, constant — the app only varies the *view*.

### 6A.2 Every app has a setup step (not only custom) — but setup is LIGHT (the site, not a questionnaire)

A builtin is a **template**; **setup specializes it to the user** — but only just enough to start. On add, *every*
app runs a setup that binds **the site, and nothing more**:

- **Target (site)** — *where* it works → bound from the **live connection** (§6A.3), banked as a target ref. The one
  thing setup must capture (you can't ride a session without knowing which). REQUIRED.
- **Shape** — *how* it runs → the **archetype templates the default** (Operator → interactive · Monitor → watch ·
  Executor → run + sub-agents); **pre-bound, never prompted** — an override is an explicit edit (AS-3).

**Focus is NOT a setup slot** (2026-06-24 correction). A user shouldn't enumerate every workflow up front. What the
app DOES on the site **accretes at runtime**: you ask *"get my open emails"* in chat → a novel ask is authored via
the teach/trial flywheel → banked. Then the **learning scheme** (`DESIGN_apps_learning.md`) lets a later paraphrase
(*"how many open emails do I have"*) **recall** the taught capability — a goal-store belief (`intent → capability`)
that strengthens with use. So three layers carry what one questionnaire used to: **SEED = the goal/role · SETUP =
the site · CHAT + LEARNING = the capabilities.**

**Progressive** (bind the site, then let capabilities keep banking *as you use it*; the flywheel never stops) and
**reuse-then-teach** (reuse a capability already taught on that Ground; demonstrate fresh only if absent). Additional
sites accrete the same way (operate on a new origin → it joins `allowedOrigins`). The custom-card **questionnaire**
(§9) authors a *custom* app's seed; a builtin ships one.

### 6A.3 Targets bind from the live connection, not start-config (target ≡ connection)

An app's **role (seed) is target-agnostic**; its targets bind **lazily from your live session** — the open
authenticated tab (session-ride), the Ground you've taught (page caps), or the linked account (OAuth). Per
`DESIGN_connectors.md` ("identity binds at the connection, not the ask"): **the bound target and the session-ride
origin are the same thing** — binding "my tickets" to `deako.zendesk.com` says *where the app works* AND *which
session it rides*. "Which Zendesk" is never parsed from the ask. `allowedOrigins` (deferred config) is a **scope
limiter** (tighten-only security), distinct from target *discovery*.

### 6A.4 Tooling = the lattice, including session-ride (reads prefer it)

The app's tooling is the full `page · browser · connector · self` lattice, all **global**. The **connector** domain
— **session-ride** (primary; call the site's own endpoint from the authenticated tab, credential-free → structured
JSON) + **OAuth/MCP** (reach-extender) — is first-class app tooling. A **read** prefers **session-fetch →
network-harvest → dom-scrape** (CX-9). One demonstration banks BOTH a grounded cap AND a session-ride recipe
(learn-from-traffic, CX-8). Session-ride **reads** are ideal for the read-only monitors (Financial/Research);
session-ride **writes** are full-session blast-radius → gated harder (§8 / CV-6 / money-is-human-click).

### 6A.5 Standing rules + the learning loop

**Standing rules** (`if X do Y`) are the layer above the seed (the seed is the *role*; rules are conditional
automation). Authorable two ways — **in setup** and **in-chat** ("from now on, if X, do Y"). In v1 (no background)
they evaluate **when the app runs** (on read/load); autonomous firing waits for **cadence** (the backend stage,
decision #3). The **history/experience** dimension is the **goal-directed learning store** (`DESIGN_apps_learning.md`):
typed beliefs + behavior deltas, tiered promotion under the existing trial gate, dual-rate updating, context-scarce
learned retrieval, HITL at promotion + action (= Orchard's two gates). "Each app oriented toward learning" = that
closed loop turning on the app's targets.

### 6A.6 v1 vs the backend stage, and the build slices

- **v1 (buildable now):** setup-on-add for every app (bind target=connection · shape[archetype]; focus accretes at
  runtime via chat→teach→recall; progressive; reuse-then-teach); capabilities + connectors global; standing rules **on-run**; the goal learning
  store. Build: **AS-1** setup-spec schema (pure) → **AS-2** the guided bind flow → **AS-3** bank + edit; **AL-1…6**
  the learning model (`DESIGN_apps_learning.md`).
- **Backend stage (deferred, decision #3):** cadence / autonomous firing of standing rules; the richer
  task-tailored **chat mental model**; cross-app belief sharing.

## 7. UI — the flush-left accordion + gallery

- **Default = the Overview chat:** centered "How can I help you today?", bottom input, header unchanged. The current simple view; nothing new for a first-time user.
- **Rail** (`#rail`) = one **flush-left accordion, no indentation**: **Overview** at the root, **apps** under it, an app's **sub-tasks** under it; then a **New app** entry. Hierarchy is read *without indenting* — every label aligns at the same left edge — from: the **chevron** (Overview + apps expand; sub-tasks are chevron-less leaves), the **glyph** (home · archetype icon · dot), **weight**, and a **bounding box** around an expanded app.
- **Chat at any level by tapping its label** (Overview · app · sub-task); the chevron expands/collapses. The active row is highlighted; a count pill previews an app's sub-task load; a leaf can still flag status ("needs you").
- **New app → the gallery:** the main window shows cards — builtin apps + a blank **Custom** card — reusing the task-card component. Selecting → copy-on-add → a new app → Rail.
- **Fan-out is visible, not hidden:** "for each ticket…" produces the app's **sub-task rows** (the connector autonomous arc, `DESIGN_connectors.md` §13 / CX-4c), enterable — not a hidden internal loop and not a separate roster.
- **The IL drives all of it** (open gallery, create app, switch, expand) via self-domain ACT builtins (`Core/palette.js` — extends `NEW_CONVERSATION` / `OPEN_HISTORY`).
- **Edit the seed:** an identity affordance on the conversation; immediate effect (decision #8).

### 7.1 The three panes — Rail · Thread · Canvas

The conversation experience is three **panes** (the canonical UI names — *not* "surfaces"; that word is taken by `DESIGN_surfaces.md` for an agent's *altitude*):

| Pane | Anchor | Plane | Role (one verb) |
|---|---|---|---|
| **Rail** | `#rail` (was `#history-sidebar`) | control | **navigate** — the flush-left accordion (Overview · apps · sub-tasks) |
| **Thread** | `#thread` (was `#conversation`) | control | **converse** — the conversation transcript + input |
| **Canvas** | `canvas.html` | presentation | **present** — the app's optional rich render target (`DESIGN_canvas.md`) |

Flow: **navigate → converse → present** — pick a track in the **Rail**, drive its **Thread**, rich output renders to the **Canvas**. Rail + Thread live in the panel (the **control plane**); the Canvas is its own tab (the **presentation plane**). "Conversation" stays the *entity* (`ConversationStore`, `conversationId`); the **Thread** is only its *visible transcript*. *(Baked into code v2.74.1257: the `history-*` DOM/CSS family → `rail-*`, `#conversation` → `#thread`, `Core/drawerTree.js` → `Core/railTree.js` / `buildRailTree`. The "drawer" word now means only the **capability picker** + page disclosure-drawers — never this pane.)*

## 8. Safety — uniform gates, tighten-only config, soft archetype

- **One global gate set, uniform** across the Overview and every app: reads `auto`, writes `confirm`/`gated`, **money = human-click-only** (navigate-only), untrusted content = data not instructions. Identical to the connector lattice (`DESIGN_connectors.md` §9).
- **App config can only TIGHTEN, never loosen the floor** (decision #2). v1 enforcement: `writePolicy:'never'` (read-only app — e.g. a strict financial monitor) or `'gated'` (default), checked at the **write gate** (the executor consults the track's `config`). A per-app "strict security" that's only prose is *not* a boundary — `writePolicy` is the enforced version.
- **Archetype is soft** — not a boundary. A monitor that executes hits the same verb-gate any action hits.
- **No per-conversation authority classes / envelopes** (explicitly rejected). One safety model to reason about, not N.

## 9. Custom apps — the questionnaire + promote-to-app

Two creation paths (decision #7):
- **Questionnaire** — the blank **Custom** card opens an IL-driven Q&A that elicits goal / surface / archetype / config → produces a user `AppDefinition` → instantiates a track.
- **Promote-a-chat** — turn an existing free chat into a reusable app, mirroring **walk promotion** (the existing capture → name → generalize → save pattern): the IL distils the chat into a `seed + name + archetype` and saves an `AppDefinition`.

User `AppDefinition`s live in a **user catalog**, shown in the gallery under "Your apps" (decision: user catalog, so promote-to-app is reusable).

## 10. Decisions

1. **App = a parent conversation + its sub-tasks** (one level). Fan-out is *visible* as the app's sub-task children — not hidden inside a single track. *(Revised from the original "single track.")*
2. **Config is enforced, tighten-only.** Global gates uniform; an app can only narrow. v1 enforces `writePolicy`; origin-allowlist + schedule deferred.
3. **No background runtime in v1.** The extension is *just an interface* (this stage is a POC); apps act only when you're in them — a monitor is "check now," not "watch every 15m." Recurring/autonomous cadence + a future reporting surface (e.g. mobile) is the **next stage** (the interface→backend split).
4. **Copy-on-add**, accept-updates optional (`appVersion` → offer re-pull).
5. **Overview = the general assistant** (no cross-app/portfolio powers in v1).
6. **Builtin apps only in v1**; shared apps by demand (ride Phase-C publication / P2b; shared = untrusted authored content → gate harder).
7. **Custom apps via an IL questionnaire**; promote a free chat to an app (walk-promotion mirror); stored in a user catalog.
8. **Seed edits take effect immediately** — like editing an LLM system prompt.
9. **One-level nesting cap.** Overview → app → sub-task, full stop. A sub-task has no sub-sub-tasks; deeper nesting is the rejected fleet model. The drawer renders the same accordion at every level (visual uniform) but the edges differ — app→sub-task is inheritance, Overview→app is navigation (§2).
10. **Bounded across, not global.** An app may reason across *its own* sub-tasks (v1, `conv:index` by `parentId`). The Overview reasoning across *all apps* (the portfolio) stays deferred (decision #5).

## 11. Build path (CV-1…6 — ✅ BUILT v2.74.1160–1183)

> The CV-1…6 slices below all shipped. The §6A enrichment adds the next tranche: **AS-1…3** (setup-for-every-app:
> setup-spec schema → guided bind flow → bank + edit) and **AL-1…6** (the goal learning model, `DESIGN_apps_learning.md`).

Pure-first; each slice headless-testable except where marked **live** (panel UI / IL behavior can't be confirmed headless — `npm test` won't exercise it). Mirrors the connector spec's slicing.

1. **CV-1 — schema + Overview (pure).** `Core/appDef.js`: `AppDefinition` validate/normalize, copy-on-add (definition → app fields), the **sub-task shape** (`parentId`, inherited `config`, the leaf / one-level invariant), the reserved Overview, `config` tighten-only normalize. Tests. No I/O.
2. **CV-2 — IL `seed + history` threading + seed composition (live).** `_tryIlCommand` loads the current conversation's `seed + recentMessages` → `runIlStandin(conversationContext)`; seed → system preamble; a sub-task composes `app seed ∘ sub-task seed` (§6). The one real behavior change — the crux; needs a live eyeball.
3. **CV-3 — drawer accordion + gallery + Overview pin (live UI).** The flush-left accordion (§7) in `#history-sidebar` (reuse the dev-mode `kind`-filter + `conv:index` `parentId` grouping; chevron / glyph / weight / box, no indent); the gallery view (task-card component); Overview pinned + delete-guarded; the New-app self-domain action; chat-at-any-level wiring.
4. **CV-4 — app-spawns-sub-tasks + bounded across (live).** "for each <list> …" inside an app → one sub-task conversation per item (the connector autonomous arc, `DESIGN_connectors.md` CX-4c, scoped to the app) → the accordion fills; plus the app-over-its-sub-tasks read (`conv:index` by `parentId`, §6).
5. **CV-5 — custom-app questionnaire + promote-to-app** (mirror walk promotion; user catalog, §9).
6. **CV-6 — `writePolicy` enforcement** at the write gate (§8); a sub-task inherits its app's policy.

Builtin **seed-prompt content** (the starter catalog, §13) threads through CV-1/CV-3 — authored, not engineered. **Order rationale:** CV-1 is the safe pure foundation; CV-2 proves the *one* behavior change in isolation before any UI; CV-3 makes it visible; CV-4 turns on fan-out; CV-5/6 are additive (authoring + the safety tighten). Each slice is shippable — stop after any.

## 12. Deferred / open contracts

- **Background / cadence / triggers** (decision #3) — the recurring-monitor + autonomous-fire model + the interface→backend split. When this lands, the unattended-write question returns (queue, don't auto-commit) — kept out of v1 entirely.
- **Shared apps** (decision #6) — Phase-C publication plumbing; trust-tiering (builtin trusted; user/shared untrusted, gate harder — the connector "user-add untrusted" rule).
- **origin-allowlist** enforcement (deferred `config`).
- **accept-updates** — a newer builtin `appVersion` → "re-pull?" nudge (v1.x).
- **Overview cross-app visibility** — a later upgrade ("what are my apps doing"); v1 is a plain assistant.
- **Deeper nesting (depth > 1)** — sub-sub-tasks / the recursive fleet — explicitly out (decision #9); the cap is one level.

## 13. Starter catalog — abstract TYPES + the object model (OM refactor, v2.74.1198)

The defaults are **3 abstract, friendly TYPES** (what the gallery shows), each defined by an **object model** — the
thing it works on — *orthogonal* to its archetype (how it runs). Support and Email weren't two apps; they're the
**same type** (Inbox) with a different noun. The named apps become **presets** that bind the type's object model.

| Type (friendly) | Object model | Archetype | Default config |
|---|---|---|---|
| **Inbox** | a queue of **stateful objects** (emails, tickets, messages): view · act · **transition state** | Operator | `gated` |
| **Watcher** | a stream of **signals** (prices, balances, listings, sources): check · compare · **flag** | Monitor | `gated` (read-only presets pin `'never'`) |
| **Concierge** | a **goal** taken to the finish line (shop, book, fill): find · compare · prepare, **then STOP** | Executor | `gated` (money = human-click) |

**Object model** (`Core/appDef.normalizeObjectModel`): `{ noun, plural, states[], actions[], transitions:[{verb,to}] }`.
`states` are the lifecycle *and* the queue's views (`open tickets`); `actions` operate without changing state;
each `transition` (verb → target state) yields a **postcondition for free** — `close` must observably leave the
object `closed`, which the **trial gate** can verify.

**Presets** (`builtinPresets()` / `presetsForType()`): Support agent (Inbox · `ticket` · open→pending→solved→closed),
Inbox manager (Inbox · `email` · unread/read/archived/deleted), Financial monitor (Watcher · `account` · `'never'`),
Price/job watcher (Watcher · `listing`), Research digest (Watcher · `source` · `'never'`), Shopper (Concierge · `cart`).
A preset gives sensible defaults; **setup binds the site** and **use/learning refine** the noun + states at runtime
(§6A) — so the object model is a starting schema, not a cage.

**Why it earns its place:** the object model scopes both halves of §6A — setup binds the *source* of the objects, and
learning gets a real grid (capability = **operation × object**: `get open tickets` = view(ticket, open); `close #5` =
transition(ticket → closed)), so recall + the `memory` audit organize by schema, not free text, and transitions hand
the trial gate its postconditions. **Build:** ✅ schema + catalog (this slice). Next: thread the object model into the
seed/context, the learning grid, and trial postconditions (live slices). Names are easy to change — they're labels.
