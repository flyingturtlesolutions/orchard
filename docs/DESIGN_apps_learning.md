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
6. **AL-6 — slow consolidation (§5).** A periodic pass: consolidate confirmed→canonical, roll up summaries, compact.
7. **Deferred / backend:** autonomous firing of standing-rule deltas on a **cadence** (the interface→backend split,
   `DESIGN_conversations.md` decision #3); cross-app belief sharing.

Each slice is shippable; AL-1/2 are the pure foundation, AL-4 is the load-bearing one, AL-5 reuses the existing gate.
