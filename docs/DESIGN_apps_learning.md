# DESIGN — The Apps Learning Model

> Status: **DESIGN — cemented 2026-06-24.** The learning model for the **apps layer**: how the agent inside an app
> learns and improves *toward the app's goal*. This is a **distinct layer above** the tooling/grounding substrate
> (`DESIGN_inference_layer.md`, the capability/landmark flywheel). The tooling layer learns *how to operate a site*;
> this layer learns *what is true about the work and how to pursue the goal better*. Sibling to
> `DESIGN_conversations.md` (the apps structure) — that doc's **history/experience** and **standing rules**
> dimensions are this model made rigorous.

**One line.** A stateless policy + an externalized, confidence-graded, tiered memory, closed by a write-back loop
that runs at two rates and promotes only what survives evidence — so *learning* reduces to disciplined curation of
what is remembered and what is loaded, with humans gating canonization and external effect.

**Three lenses on one pattern** (memory-augmented, error-corrected, retrieval-disciplined behaviour over a fixed
reasoner): a **cache hierarchy** (hot summary → cold canon → lazy detail); **biological consolidation** (fast
hippocampal trace → slow cortical integration); **control theory** (a plant with feedback).

---

## 1. The substrate

A **stateless reasoner** (fixed function: context → action) wrapped in a **persistent, structured memory** (mutable
store). **Learning is mutation of the store, never the function.** The agent's competence at time *t* is a property
of *what's been written* and *what gets loaded* — not of the reasoner changing.

- **Reasoner = the IL / LLM.** Already fixed in Orchard (never fine-tuned; the standing thesis is "the LLM is the
  compiler"). No change.
- **Two distinct stores, two learnings.** The **tooling store** (Grounds, landmarks, capabilities, connectors —
  *how to operate sites*; global/shared; exists) vs. this **goal store** (*what the app knows/concludes about its
  work*; new). An app **uses** the first and **grows** the second. This doc is only about the second.

## 2. Core objects

- **Belief** — a fact/claim about the *work*, carrying three **orthogonal tags**: an **epistemic type** (observed
  fact vs. inferred claim), a **confidence**, and a **provenance** (where it came from). *Untyped knowledge is not
  admitted.* Goal-level, e.g.: `"Acme is on the enterprise plan"` (observed · 0.95 · ticket #6122);
  `"this ticket is probably a dup of #412"` (inferred · 0.6 · this thread).
- **Behavior delta ("lesson")** — *not* a fact about the world but a **rule about future action**, born from a
  **prediction↔ground-truth mismatch**. e.g. you predicted a draft was good, the user rewrote it to check the
  account first → the delta `"for refund tickets, verify payment status before drafting."`
- **Capability-association** — the most load-bearing belief in practice: `intent → capability`. When the user asks
  *"get my open emails"* and a novel capability is authored (the tooling flywheel) + banked, the goal store records
  the association; a later **paraphrase** (*"how many open emails do I have"*) **recalls** it instead of re-authoring.
  This is the **bridge** between the tooling flywheel (which learns *the capability*) and this layer (which learns
  *when to reach for it*) — and it's why setup needn't enumerate workflows (`DESIGN_conversations.md` §6A.2): the
  app's focus accretes *here*, as these associations bank with use. (Tool-RAG / aliases already do a shallow form;
  the goal store makes it app-scoped, confidence-graded, and tiered.)

*Orchard seeds, not yet first-class at the goal layer:* confidence exists (trust/trial scores); provenance exists
(`source`); epistemic type appears as verified-vs-proposed / stale-suspected-vs-confirmed. Behavior-delta seeds:
the conventions histogram, 👎-reject→retrain, OUTCOMES→resolve feedback, and **the app's standing rules**. **New:**
a *uniform typed-belief schema* and a *first-class behavior-delta* object, both at the goal/domain level.

## 3. The dynamics — a closed loop

1. **Act** — the reasoner consumes the assembled context, emits an action (triage, draft, read, …).
2. **Observe** — the outcome or an external correction arrives (the user edits the draft, the ticket reopens, "no,
   check X first").
3. **Write back** — the experience is re-encoded as a **belief** or a **behavior delta** and committed to the store.
   *This is the step that makes it a learning system rather than a stateless tool: outputs become future inputs.*
4. **Assemble** — on the next cycle a **retrieval policy** selects which beliefs/deltas enter the finite context.

*Orchard:* **Act** ✓ (interpret/run). **Observe** ✓ (trial/verify, OUTCOMES, postconditions, 👎). **Write back** ✓
for *capabilities* (accept banks one) — **⚠ thin** for goal-level beliefs/deltas. **Assemble** ✓ at the tooling
layer (tool-RAG, interpret context) — **new** at the goal layer.

## 4. Structural invariant (a) — tiered promotion under a confidence gate

Knowledge has a lifecycle — **observation → hypothesis → confirmed → canonical → summary** — and only moves up a
tier when evidence/confidence clears a threshold. A **ratchet**: cheap to record a hypothesis, deliberate (expensive)
to canonize it. It **bounds the cost of being wrong**.

*Orchard's strongest alignment:* the **trial/verify gate IS this ratchet** (proto-landmark → trial → accept →
promote; `localeTrust`; reverify trust). The same gate logic lifts a goal-level inference (`"Acme is churning"`)
from hypothesis to a confirmed customer profile (the *summary* tier) only on accumulated evidence.

## 5. Structural invariant (b) — dual-rate updating

Two clocks at once: a **fast path** where a behavior delta takes effect on the **very next cycle** (working-memory),
and a **slow path** that periodically **consolidates** accumulated deltas/observations into the canonical tier and
**compacts** the store (long-term consolidation). Fast → responsiveness; slow → coherence + bounded growth.

*Orchard:* fast seeds (alias-flywheel replay, standing rules, 👎 next-turn); slow seeds (OUTCOMES decay, structural
dedup, locale re-template heal). **New:** a *formal* periodic consolidation pass over the goal store.

## 6. Governing constraint — context is the scarce resource

The reasoner has finite attention, so **the retrieval policy is itself part of the learned system**: *always-load*
the distilled summary, *conditionally load* by task, *lazy-load* the rest. **Memorizing is cheap; surfacing the
right thing at the right moment is the hard part.** This is the load-bearing new work — the *Assemble* step (§3.4)
at the goal layer: an app's context window is budgeted as *seed + always-on app summary + task-conditional
beliefs/deltas (retrieved) + lazy detail on demand*. Tool-RAG (R-2) is the tooling-layer ancestor; the goal-belief
retrieval policy is new and is where most of the difficulty lives.

## 7. Governing constraint — effects are gated and asymmetric

Internal writes are reversible and cheap; external, world-changing actions require confirmation. **The loop is
human-in-the-loop at exactly the two highest-risk points: what becomes canon (promotion) and what touches the world
(action).**

*Orchard already enforces both:* **promotion** = the trial/verify → **accept** gate (a hypothesis canonizes only on
human-confirmed evidence); **action** = the **confirm-first / write-gate (`writePolicy`, CV-6) / money-is-human-click**
posture. The model's hardest safety requirement is **met by the existing two-gate architecture** — we reuse it,
we don't rebuild it.

## 8. Where it sits in the apps layer

- It **is** `DESIGN_conversations.md`'s **history/experience** dimension (the store, not a chat log) and the
  **standing rules** dimension (authored deltas; *learned* deltas from mismatch are the new part).
- The **tooling** (capabilities, connectors/session-ride) stays **global/shared** (the capabilities-are-global rule).
  Open question for the goal store: is a *belief* learned in one app (`"Acme is enterprise"`) visible to another app
  on the same data, or **sealed** to the app's goal-memory? (Lean: factual beliefs shareable per-data; behavior
  deltas — the *how* of pursuing this goal — app-scoped.)
- "Each app oriented toward learning" = this closed loop turning on the app's targets; its competence at *its* goal
  grows as the store fills and the retrieval policy sharpens.

## 9. Build path (pure-first, reuse the gates)

1. **AL-1 — typed-belief + behavior-delta schema (pure).** `{ id, kind:'belief'|'delta', epistemic, confidence,
   provenance, tier, body, ... }` + tier enum (observation→hypothesis→confirmed→canonical→summary) + the promotion
   predicate (clears-the-gate). Tests. No I/O. *(Mirrors `Core/appDef.js` / `outcomes.js`.)*
2. **AL-2 — the store (per-app goal memory).** Persist beliefs/deltas keyed by app; append-only + lazy rollups
   (mirror the OUTCOMES store). The global-vs-scoped split (§8) lands here.
3. **AL-3 — write-back hooks.** At observe-points (a 👎/edit/correction, a postcondition mismatch) re-encode → a
   belief or delta. The fast path: a new delta is loadable next cycle.
   - ✅ **AL-3e — the OUTCOME hook (v2.74.1251).** The act's RESULT is banked at its real verdict (`_orchRun`'s
     success/failure branches + the connector `_ilRunBuiltin` return), superseding the dispatch-time bank that fired
     before the run. SUCCESS → an `observed` intent→capability belief (0.7) — so a 2nd success ratchets it to
     `confirmed` (AL-5). FAILURE → a low-confidence (0.4) mismatch DELTA, keyed separately so it can't corroborate the
     positive (the store has no un-corroborate). The neutral `ran:false` / `ignoredKeys` paths bank nothing. The app
     now learns *what worked*, not just *what was asked*. (`Core/goalMemory.capabilityOutcomeItem`, pure + tested.)
   - ⚠ **Injection boundary (AL-3d).** Today's hooks bank only TRUSTED bodies — the user's own ask (capability-
     association) and authored `remember:` rules — so the `<LEARNED>` block (AL-4) is genuinely trusted. The
     moment AL-3d banks a **read-surfaced fact** (e.g. a value scraped from a ticket) the body is **untrusted page
     content**. Such beliefs must be tagged untrusted and rendered into `<LEARNED>` as **inert DATA, never as
     "trusted" / a standing rule** (DESIGN_injection_boundary.md §3) — a malicious page must not be able to plant a
     belief that steers the agent. Provenance already distinguishes them; the retrieval/render must honor it.
4. **AL-4 — the assemble/retrieval policy (the hard part, §6).** Budget the context: always-on app summary +
   task-conditional retrieval over beliefs/deltas + lazy detail. Feeds the interpret call's `conversationContext`.
5. **AL-5 — tiered promotion (reuse §4's gate).** Route promotion through the existing trial/accept confidence gate;
   HITL at canonization (constraint §7).
   - ✅ **Write-time ratchet (v2.74.1251).** The promotion gate was *defined but never called* — every belief sat at
     `observation` forever, accruing evidence that drove nothing. `recordGoalItem` now SETTLES the just-corroborated
     item up the gates it clears (`Core/goalStore.settleItemInList`), stopping before the HITL `canonical` step. So a
     2nd corroboration (evidence ≥2 ∧ confidence ≥0.7) graduates `hypothesis → confirmed` automatically, and recall
     (tier-ranked) surfaces confirmed associations first — for free, no retrieval change. Canonization stays HITL.
6. **AL-6 — slow consolidation (§5).** A periodic pass: consolidate confirmed→canonical, roll up summaries, compact.
7. **Deferred / backend:** autonomous firing of standing-rule deltas on a **cadence** (the interface→backend split,
   `DESIGN_conversations.md` decision #3); cross-app belief sharing.

Each slice is shippable; AL-1/2 are the pure foundation, AL-4 is the load-bearing one, AL-5 reuses the existing gate.

## 10. Two-tier learning — instance memory + preset memory (v2.74.1210)

The §2 store is **per-instance**, but learning rises a level too. Two stores of goalMemory items:
- **Instance memory** (per configured app, private): the specifics — facts about *this* app's KB/site. Local.
- **Preset memory** (per type, the shared template): generalizable behavior rules — *how to be a good `<type>`* — seeded into every new instance and accrued across them, so a day-100 preset instantiates smarter than a day-1 one.

**The split rides the belief/delta line (§2):** a **belief is a fact** (instance-private — "Acme is enterprise"); a **delta is a behavior rule** (generalizable — "confirm resolution before closing"). So **only deltas rise**, and only at the **`canonical`** tier (HITL-confirmed, §7) — the §4 gate, now applied to crossing the instance→preset boundary. Facts never leave their instance.

Two flows — `Core/presetMemory.js` (pure; `isPromotableToPreset` / `promotableToPreset` / `seedInstanceFromPreset`):
- **10.1 Seed down (instantiate). _(BUILT v2.74.1215.)_** A new instance copies the preset's accrued rules + the preset's hand-authored **baseline** as starting deltas (tier `confirmed`, provenance `preset-baseline`, de-duped). It then specializes its own memory — Acme-support and Beta-support never touch. _Wired: `chat.js _seedInstanceMemory(instanceId, presetId)` runs at instance creation, **seed-if-empty** (so a re-created configured app keeps its specialized learning, AP-3); reads `builtinApp(presetId).baseline` (a `baseline: []` field on the def, §appDef) + the preset store `goalMemory:preset:<presetId>`. The `support` preset ships the first two baseline rules._
- **10.2 Distill up (periodic). _(Deferred — backend: needs the LLM abstraction pass + a cadence trigger; the pure eligibility + the `goalMemory:preset:<presetId>` keyspace are ready.)_** Select an instance's canonical deltas → an LLM **abstraction** step strips specifics ("verify the refund window" kept; "Acme's window is 30 days" dropped) → merge into the preset store. **HITL-gated**: crossing into the shared preset is a promotion, so it carries the §7 human gate. Beliefs (facts) NEVER rise.
- **10.3 Local now, federation-ready.** The preset store keys `goalMemory:preset:<presetId>` — per-USER + local today. The logic is **identical** for a GLOBAL (federated, cross-user) preset; federation is only whether that keyspace **syncs** (the SyncBridge filter-gate, exactly like `goalMemory`). Build local; the federal seam is an additive sync registration. A global preset raises a cross-tenant privacy bar — only abstracted, confirmed deltas cross, never raw memory.

The abstraction step + the belief/delta line **are** the privacy boundary: instance KB/PII (beliefs) is structurally barred from rising.

## 11. App persistence & per-instance identity (the durable-apps arc)

Painpoints: re-personalizing every new app, content lost on delete, long-running cases rebuilt from scratch. The fix is durable, identity-bearing app instances.

- **AP-0 — per-instance identity (the foundation).** A configured app gets its OWN id (`appId` = a unique instance id, **not** the preset's type id) + a `presetId` pointing back at its generic template. **Goal memory keys by the instance id**, so two configs of the same preset don't collide (the bug §10 fixes — today every builtin-preset instance shares `goalMemory:<presetId>`). Object-model / canvas resolution (`builtinApp(appId)`) falls back through the catalog via `presetId`.
- **AP-1 — pin.** `pinned` on the conv record (index-mirrored); auto-pin on setup-complete; `Core/drawerTree.js` sorts pinned-first.
- **AP-2 — sub-conversations, first-class.** A "+" ICON on the app / drawer-row → `subTaskFromApp` (the `subtasks:` fan-out, surfaced).
- **AP-3 — cascade delete.** `ConversationStore.delete` removes `parentId` children too (confirm-first). Goal memory is KEPT (a re-created instance stays smart).
- **AP-4 — durable configured app.** Setup-complete mints a config-carrying user definition (an automatic, enhanced `save as app`); it shows in its category's choose-preset menu; re-selecting it opens **pre-configured, no setup**. The builtin preset always remains too.

AP-0 is the prerequisite for §10 (instances need their own identity before learning can distill up). Build order: **AP-0 → AP-1..4 → §10 wiring**.

## 12. Memory transparency & authoring (SPEC — not built, v2.74.1251)

The goal store (§1–9) is structured + opaque: typed beliefs/deltas in chrome.storage, projected into the prompt's `<LEARNED>` block. Three authoring/visibility gaps, most→least scoped. All DEFERRED; this is the spec.

### 12.1 `memory.md` — a readable/editable projection (export ⇄ edit ⇄ import)

The transparency + portability + bulk-edit layer ("can't it just be a memory.md?"). It round-trips **THROUGH** the typed schema, never replacing it — so the tiers / confidence / ratchet (§4) / injection boundary (AL-3d) all survive.

**Pure cores (testable, no I/O):**
- `goalMemoryToMarkdown(items) → string` — project to markdown: **Standing rules** (deltas) + **Learned** (beliefs), grouped by tier. Body per line; metadata (`tier · confidence · evidence · provenance`) rides as a trailing annotation / HTML comment so it survives a round-trip. Untrusted (read-surfaced) beliefs marked as data, never rules.
- `markdownToGoalItems(md) → { items, dropped }` — parse back, EACH line through `normalizeMemoryItem` (so an untyped line is **dropped, not admitted** — §2). Returns the items + a dropped-count (honest; no silent loss).

**The reconcile (the one live store op):**
- `reconcileGoalMemory(current, imported) → next` — match by content-id: unchanged → **keep its earned store fields** (`evidence`, the ratcheted `tier`); changed/new → take imported, `provenance:'user-edit'`; in current but absent from the doc → **removed** (the doc is authoritative). Confirm + one-step undo backup before the destructive replace.

**Safety (the crux — why round-trip-through-schema):** no freeform text becomes a rule without passing `normalizeDelta`/`normalizeBelief`; the import is a HITL act (the USER types/approves the doc → trusted `user-edit`; a page cannot write it, so the boundary holds); confidence/tier clamp on import (no forging `canonical`); store-cap bounded.

**Entry point:** extend the read-only `memory` view → **Export** + **Edit** (textarea) + **Import** (paste → reconcile + confirm). Instance memory first; the shared preset memory (§10) is a later, separate export.

**Open decisions:** (1) metadata rendering — inline vs HTML-comment vs footer table (fidelity ⇄ readability); (2) import = replace-with-id-preservation + backup (over merge); (3) a user-edit may set tier up to `confirmed`, never `canonical` (canonization stays the runtime HITL path); (4) instance-only first.

### 12.2 Natural-language rule capture (the "keep replies terse" gap)

Today ONLY the `remember:` prefix persists a rule; a plain behavioral directive in chat ("keep replies terse") is `answer`'d and **lost**. Spec: add a `remember` intent to the interpret front door (or have the `answer` path OFFER *"Want me to remember that?"* when it detects a standing preference) → route to the same `standingRuleFromText` → store. Makes the prefix optional. Input-side; composes with 12.1 but ships independently.

### 12.3 Soft rules vs structured workflows (the spectrum — what `remember:` is and isn't)

`remember: when I say "get tickets" I mean get my open tickets, open each in a new conversation and summarize` IS stored — but as a **soft, always-on prose rule**: a delta the `<LEARNED>` block carries every pass. (The `standingRuleFromText` parser only splits `if X, Y` / `if X then Y` into trigger→body; it does **not** recognize `when I say X, I mean Y`, so the phrase-keying lives in the PROSE the LLM reads, not the store's `trigger` field — the rule is loaded always, not phrase-scoped.)

It **works loosely** — the IL reads the rule and expands "get tickets" into the workflow — but it is **LLM-re-interpreted every time**: re-decomposed, re-run from scratch, subject to judgment, and still bounded by the autonomous-workflow gaps (the fanout/map confirms, no deterministic replay, not a saved composite capability).

The **robust** form — a phrase keyed to a *structured, recallable* workflow (the alias flywheel for autonomous compounds) — is the **bank → recall → suggest-and-confirm** arc (the connector-workflow gap noted at §9's outcome-hook lessons). `remember:` is the poor-man's version; the structured one is the real target. **Cheap intermediate:** teach `standingRuleFromText` the `when I say X, I mean Y` form → `trigger = X` (phrase-scoped, no longer always-on) + `body = Y`, so at least the keying becomes structural.

- ✅ **WF-1 — the structured workflow flywheel, slice 1 (v2.74.1252).** A clean AUTONOMOUS compound (a connector read / fan-out chain — what the Ground-composite saver can't hold, no Ground) offers **"💾 Remember this workflow"** at the chain's end → bank `{ask, subAsks}` per-instance (`Services/Storage/WorkflowStore.js`). RECALL: at `_tryInterpret`'s top, `workflowMatch` (`Core/workflowMemory.js`, pure+tested — overlap-coefficient, so a short re-ask "get tickets" matches a long saved workflow; precision-biased) finds the saved workflow. SUGGEST-and-confirm: a strong match → a "🔁 …Run it?" card (never silent — autonomous + side-effectful). REPLAY: re-dispatch the subAsks through the SAME chain runner (`_orchRunChain`), so the inner map/fan-out/write gates still apply; bumps a run-count (corroboration + the match tie-break). **Deferred:** naming/aliasing, LLM-semantic match, a manage-workflows view (`deleteWorkflow` exists, unwired), a run-count suggestion threshold, and `<LEARNED>`-block awareness (kept out so the IL can't try to "act" on a non-tool ref).
