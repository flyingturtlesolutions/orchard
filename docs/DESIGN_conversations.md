# DESIGN_conversations.md — conversations as apps

**Status:** DESIGN — model + decisions pinned, accordion/sub-task revision folded (2026-06-24). Not yet built. The chat surface exists today (`Services/ConversationStore.js`, the `#history-sidebar` drawer, the per-ask-stateless IL); this doc specifies the **apps** layer on top. Sibling to `DESIGN_connectors.md` — apps **select** the connector/tool lattice, they don't replace it.

**One line:** every conversation is the one inference layer (IL) wearing a prompt; an **app** is that IL configured for a goal (a **seed prompt** + light config), picked from a gallery and kept as a drawer track. The prompt is the only thing that varies — tools, router, and safety gates are uniform.

**Rejected (don't let it creep back):** a second "global/coordinator" engine, a fleet roster, per-conversation capability boundaries, authority envelopes, autonomy classes. All of that collapses into *the prompt* + the *uniform* gate. The model is deliberately flat.

---

## 1. The model — one IL, the prompt is the variable

The IL is one shared engine (route → palette → judge → execute, `Core/route.js`), with all tools, constant. A **conversation = the shared IL + a per-conversation prompt/context**. The prompt creates identity, persona, concern, role. Two conversations are the same engine — one seeded *"you are the customer of #64222,"* the other *"monitor these balances."* Nothing structural differs.

This is *why* "an app is just the IL with a prompt" holds: every app runs the same read → think → act loop; the seed sets the goal, surface, and emphasis.

## 2. Roles — Overview, apps, sub-tasks

| Role | What it is | Lifecycle |
|---|---|---|
| **Overview** | the canonical conversation — system-default prompt, editable; the general assistant + the home surface | always present; **cannot be created or deleted** (reserved) |
| **App** | a conversation configured for a goal (a seed + light config); the **parent** of its sub-tasks | `kind:'app'`; one app per concern; added from the gallery |
| **Sub-task** | a child conversation under an app — the app's concern parameterized (e.g. one per ticket) | a conversation with `parentId`; a **leaf** (no children — §5 cap) |

You chat at **any level** — Overview, an app, or one of its sub-tasks. All the **same IL**, just a different prompt (§6).

**Visual uniform, semantically split (don't conflate).** The drawer renders one **flush-left accordion** (§7): Overview, apps under it, sub-tasks under each app. But the two edges differ in kind:
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

## 7. UI — the flush-left accordion + gallery

- **Default = the Overview chat:** centered "How can I help you today?", bottom input, header unchanged. The current simple view; nothing new for a first-time user.
- **Drawer** (`#history-sidebar`) = one **flush-left accordion, no indentation**: **Overview** at the root, **apps** under it, an app's **sub-tasks** under it; then a **New app** entry. Hierarchy is read *without indenting* — every label aligns at the same left edge — from: the **chevron** (Overview + apps expand; sub-tasks are chevron-less leaves), the **glyph** (home · archetype icon · dot), **weight**, and a **bounding box** around an expanded app.
- **Chat at any level by tapping its label** (Overview · app · sub-task); the chevron expands/collapses. The active row is highlighted; a count pill previews an app's sub-task load; a leaf can still flag status ("needs you").
- **New app → the gallery:** the main window shows cards — builtin apps + a blank **Custom** card — reusing the task-card component. Selecting → copy-on-add → a new app → drawer.
- **Fan-out is visible, not hidden:** "for each ticket…" produces the app's **sub-task rows** (the connector autonomous arc, `DESIGN_connectors.md` §13 / CX-4c), enterable — not a hidden internal loop and not a separate roster.
- **The IL drives all of it** (open gallery, create app, switch, expand) via self-domain ACT builtins (`Core/palette.js` — extends `NEW_CONVERSATION` / `OPEN_HISTORY`).
- **Edit the seed:** an identity affordance on the conversation; immediate effect (decision #8).

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

## 11. Build path (CV-1…6)

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

## 13. Starter catalog (builtins)

| App | Archetype | Seed intent (authored in CV content) | Default config |
|---|---|---|---|
| **Inbox manager** | Operator | triage, draft, file email | `gated` |
| **Support agent** | Operator | research, triage, reply to tickets | `gated` |
| **Financial monitor** | Monitor | watch balances/rates, flag changes | `writePolicy:'never'` |
| **Price / job watcher** | Monitor | watch listings/prices, surface fits | `gated` |
| **Shopper** | Executor | fill an order; checkout = human | `gated` (money navigate-only) |
| **Research digest** | Monitor | watch sources on a topic, summarize | `writePolicy:'never'` |

Inbox is the highest-value universal one after the three originals — ubiquitous toil, a bounded surface, and ~90% (triage + draft) is safe-autonomous.
