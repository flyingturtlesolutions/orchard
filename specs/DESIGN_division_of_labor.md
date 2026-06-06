# DESIGN — Division of Labor: what the architecture scaffolds (and what the frontier already does)

> **Status:** foundational thesis / north-star. Distilled from a full-transparency thread on native frontier-model
> capability vs. the project's primitives.
> **Builds on / informs:** `TIER_MODEL.md` (the composition hierarchy), `DESIGN_intent_orchestration.md`
> ("intents all the way down"), `DESIGN_comprehension_split.md`, `DESIGN_t3_cross_ground.md`, `GROUND_SPEC`.
> **One line:** a frontier model already supplies the **reasoning**; the architecture's job is **not** to make it
> reason better — it is to supply the **grounding, invariants, and persistence** that turn a reasoning *act* into a
> durable, composable, verifiable, **frontier-free** *asset*.

---

## 0. The thesis (LOCKED)

> *The largest value of the whole architecture — durability, determinism, cheap-and-frontier-free, accretion — is
> **orthogonal to inference quality entirely.** It is not that the primitives make the model infer better; the few
> that do (effect-signal, landmark, invariants) **sharpen and constrain** a thing the model can already do, and the
> rest make the result something the system can **keep, compose, verify, and re-run without the model.** We did not
> scaffold the reasoning — we scaffolded the **grounding, the invariants, and the persistence** the reasoning needs
> to become an asset.*

Everything below expands one clause of that paragraph. It exists so that, when deciding whether to build a
primitive, the question is never "does this help the model think?" (the model already thinks) but **"which of
{grounding, invariant, persistence, verification, economization} does this serve?"** — and if the honest answer is
"it helps the model think," the primitive is suspect.

---

## 1. Three orthogonal axes — never conflate them

The project's surface area splits cleanly into three concerns that are usually fused in conversation and must be
kept apart in design:

| Axis | The question it answers | Who supplies it |
|---|---|---|
| **Inference** | trace → intent (abduction); ask → plan (decomposition); action → meaning (grounding) | **The frontier model, natively.** A subset is *sharpened* by project primitives (§3). |
| **Execution** | act on the page (click, type, navigate, cross sites, carry data) | **The frontier model, natively.** The runtime re-does it deterministically once compiled. |
| **Durability** | keep / compose / verify / re-run the result **without a model in the loop** | **The architecture, entirely.** The model cannot persist or share an artifact. |

**The architecture's leverage is overwhelmingly on Durability, secondarily on a *subset* of Inference, and barely on
Execution.** A frontier model with browser tools executes natively and infers natively; what it cannot do is turn a
single expensive run into a cheap, deterministic, owned, self-improving capability. That gap — not the reasoning —
is the product.

**Corollary (design smell):** a primitive justified as "it helps the model figure out X" is almost always
mis-scoped. The model figures out X. The primitive's real job is to make X *grounded*, *checkable*, or *durable*.
Re-scope it accordingly or cut it.

---

## 2. The frontier is the reasoning engine (in your own two-axis vocabulary)

The word "tier" is used two ways in this codebase, and the distinction is the spine of this doc:

- **Composition tier** — *Fragment ⊂ Strategy ⊂ Workflow ⊂ Intent*, stratified by site scope (`TIER_MODEL.md`).
- **Decision / prediction path** — *cache (T1) → frontier (T3) → human (T4)*, stratified by who decides the next action.

**The frontier model IS the T3-decision path.** It can produce the frontier-path version of nearly any single task
the system performs: comprehend, ground, bind, execute, abduce. The entire architecture is a machine for **demoting**
work *off* the frontier path (expensive, slow, stochastic) *onto* the cache path (a compiled capability — cheap,
fast, deterministic), and **escalating** to human (T4) only when forced (CAPTCHA, credentials, irreversible commit —
boundaries the frontier model shares, not a place it is a superset).

So "how much can the model do natively?" ≈ "the frontier version of almost everything." The architecture's reason to
exist is precisely **to not need the frontier version each time.** Build for the demotion, not for the reasoning.

```
   ask / demonstration
        │
        ▼
  ┌─────────────┐   first time, novel, ambiguous      ┌──────────────┐
  │  FRONTIER   │ ─────────────────────────────────▶  │  reasoning    │  ← the model already has this
  │  (T3)       │                                      │  (free)       │
  └─────┬───────┘                                      └──────────────┘
        │ ground + verify + crystallize  ◀── the architecture's work
        ▼
  ┌─────────────┐   every subsequent time             ┌──────────────┐
  │  CACHE      │ ─────────────────────────────────▶  │  deterministic│  ← the architecture's payoff
  │  (T1)       │                                      │  frontier-free│
  └─────────────┘                                      └──────────────┘
```

---

## 3. What actually helps inference: input-priors vs. output-schema

Within the Inference axis, separate two roles a primitive can play. This is the cut that tells you which primitives
genuinely move abduction and which are (valuable) bookkeeping:

- **Input-side prior / signal** — it changes *what the model can figure out* from a trace. These are the only
  primitives that make the model infer **better**.
- **Output-side schema / context** — it changes *what the figured-out thing can become* (storable, composable,
  comparable, runnable). Enormous systemic value; negligible effect on the raw act of inferring.

| Primitive | Primary role | Effect on the *inference act* |
|---|---|---|
| **Postcondition / effect-boundary** | input signal | **High.** The disambiguating signal. |
| **Landmark (grounded reference)** | input signal | **High.** Makes a trace *resolvable at all*. |
| **Invariants** (§6) | input constraint | **High.** Prune wrong hypotheses the model would otherwise entertain. |
| **Ground** | output schema + persistent context | Low for one-shot; high for *systematic* inference. |
| **Locale / Perspective** | output schema + page context | Medium. Grounding context + a natural output shape. |
| **Tier ladder (Fragment/Strategy/Workflow)** | output schema (typed target) | Low-medium; mostly forced by the medium (§5). |

**Litmus test:** *"Would a frontier model holding a semantically-rich trace need this primitive to produce the
intent?"* If **no**, the primitive is output-schema or durability — keep it, but label it honestly and do not credit
it with inference quality. If **yes**, it is one of the three load-bearing signals above.

---

## 4. Primitive-by-primitive value, ranked by leverage on inference

Honest ranking. "Inference value" = how much it improves the *act* of abducing/grounding intent, **not** how much it
helps the system overall (where the order would invert).

1. **Postconditions / effect-boundaries — highest, most under-appreciated.**
   The most disambiguating signal for resolving an action to intent is not the click — it is the **effect**
   (`url gained ?order=trending`). It lets the model name "sort by trending" with confidence and reject wrong
   abstractions. Deriving success from a *state delta* is exactly the signal abduction wants. The corollary failure
   is real: the search-box-presence postcondition bug (a presence check standing in for an effect) directly degraded
   both replay *and* the honesty of the derived intent — see §6 (Observability) and the
   `v2.74.783` fix (`Core/postcondition.js dropWeakInputPresence`, `Core/observedSegment.js`).

2. **Landmarks — the grounding unit; the crux of resolvability.**
   A landmark is the bridge from *selector/pixels* to *"the Search button."* It is the semantic attachment that
   makes a trace resolvable. The **concept** (a durable semantic identity for an element) is essential — the model
   needs something isomorphic. The **schema** (role + accessible name + hierarchical context + stability predicate)
   is a good, fairly conventional encoding (it rhymes with ARIA + selector-stability), not unique, not arbitrary.
   *Concept essential; schema good.*

3. **Invariants — where the architect most matters (see §6).**
   Hard-won, domain-specific constraints that prune bad hypotheses and that the model would **not** reliably
   re-derive on every call. This is the real inferential contribution of a human architect: not vocabulary —
   constraints.

4. **Grounds — high for *systematic* inference, low for one-shot.**
   Unneeded to abduce a single rich trace; decisive when inference must be *consistent across time and reusable*
   (bind "filter by trending" to *the* known sort affordance, dedup against existing capabilities, accrete). Also
   the **cross-site segmentation boundary**: the host change that says "two sub-intents" *is* the Ground boundary.

5. **Locale / Perspective — grounded page context + a natural output shape.**
   Locale = the page's affordance model (grounding context). A Perspective is *"a partial intent expressed as a
   landmark selection"* — close to the natural **output representation** of resolving actions→intent at page scope.

6. **Tier ladder — useful typed target, but largely forced by the medium (§5).**

---

## 5. "Each tier holds a partial intent" — the decomposition, honestly

The tiers form a **ladder of partial intents at rising scope**: a landmark is a *referent*; a Fragment a
*micro-intent* ("fill the search box"); a Strategy a *task-intent* ("search jobs, filtered"); a Workflow a
*journey-intent* ("A on site 1, then B on site 2"); the Intent the whole.

**Why this helps inference (the genuine, non-obvious benefit):** abduction is an under-determined inverse problem.
A typed ladder makes a hard *global* abduction **decomposable into a stack of locally-constrained ones** — resolve
referents → compose to micro-intents → compose to task-intents → compose to journeys, each level constraining the
next. It is a **curriculum for the inverse problem**, and curricula make induction tractable. This is real value to
inference, beyond execution.

**The hazard (equally LOCKED):** a *fixed* ladder **imposes its joints.** When a true intent does not factor cleanly
along the seams — a dependency that straddles a Fragment-and-a-half, a cross-ground data flow that ignores the tier
boundary — the scaffold **fights** the inference. That edge is exactly where the frontier earns its keep by
**overriding the schema.**

**The web mostly dictates these joints.** The ladder is nearly isomorphic to the substrate's own scope hierarchy:
*landmark ↔ DOM node, Fragment ↔ a coherent on-page interaction, Locale ↔ page, Ground ↔ origin, Workflow ↔
cross-origin journey.* The architect's contribution is making that hierarchy **explicit, typed, and composable** —
real and valuable — but the hierarchy itself is *given by the medium*, so a frontier model knows it implicitly and
will segment along it without the vocabulary. **Credit the schema, not a secret insight.**

> **Design rule (LOCKED):** the tier schema is a **strong default prior, never ground truth.** Every stage that
> consumes it must allow the frontier to **override the joints** when the trace argues for a different factoring.
> A schema that cannot be overridden is a bug, not a constraint.

---

## 6. The invariants — the architect's real inferential contribution

These are the hard-won, domain-specific constraints that *prune wrong inferences* and that a frontier model would
not reliably reproduce ad hoc on every call. This catalog — not the noun-vocabulary — is where human design moves
the inference needle. Treat it as the project's most valuable, most portable artifact.

1. **Observability & start/end gating** — *a success postcondition must be an observable effect, not a
   precondition-shaped presence; and it verifies at the END — it never gates the START.* "The search box exists" is
   true before and after; it is not success. Success is the *state delta* (URL gained a param, a results region
   appeared, a confirmation badge rendered).
   **The runtime corollary (LOCKED):** a **direct invocation runs iff (it was *called* ∧ its *preconditions* hold)**,
   and its postconditions are checked only *afterward*. Probing postconditions at the start to "skip when already
   done" conflates *"the effect is present"* with *"there is nothing to do"*, which makes a parameterized action (a
   re-search) un-repeatable — its results/input are present from a PRIOR run. **Idempotency is NOT a postcondition.**
   It has three legitimate homes, and a fourth for the unsafe case:
   - *nothing to act on* → a **precondition** (the target affordance is absent);
   - *resume within this invocation* → **`completedFragmentIds`** (a step that already ran this run is skipped);
   - *prerequisite satisfaction* ("don't re-login if logged in") → the **antecedent path** may skip-if-met; a direct
     call may not;
   - *a genuinely unsafe repeat* (double-submit) → an explicit **idempotency guard / effect-ledger** — its own
     first-class concept, never overloaded onto postconditions.
   *Known gap:* a failed **precondition currently HARD-FAILS** the fragment; a graceful "skip if the target is
   absent" **applicability guard** is a distinct, still-unbuilt concept — do not assume a precondition can express a
   soft skip. Violations make capabilities un-repeatable and intents dishonest.
   (Enforced: `Core/postcondition.js`, `Core/observedSegment.js` (delta-not-presence synthesis); runtime gating —
   `ExecutionEngine.#runFragmentStep` drops the start-skip entirely (`v2.74.785`); `TemplateWalker` keeps skip-if-met
   ONLY on the antecedent/prerequisite path.)

2. **Atomicity** — *a commit carries the inputs it depends on.* A "submit" sub-intent must pull in the fills it
   consumes; a downstream step consuming an upstream result must carry that upstream step. (Enforced:
   `matchSubGoals`, `wireCrossGroundData`.)

3. **Grounded reference** — *actions ground to recoverable landmarks, not coordinates.* A click is stored as a
   durable identity (role+name+context) with a probe-or-recover path, so it survives DOM drift. Coordinates are
   semantically and temporally fragile.

4. **Effect-boundary segmentation** — *cut the trace at observable boundaries* (Enter/submit, navigation, SPA swap,
   host change), not at arbitrary event counts. The host change is the Ground (cross-site) boundary.

5. **Precision-first** — *prefer a clean MISS to a confident wrong HIT.* A wrong match is one tap from correction;
   a silent wrong action on the page is not. The three-way gate (auto / propose / miss) encodes this.

6. **Values are examples, not constants** — *a demonstrated value is a parameter unless proven otherwise.*
   "minneapolis" / "Last 3 days" are bindings to generalize, never baked into the name/intent/aliases.

7. **Substrate is identity; label is volatile** — *a Perspective is its landmark selection, not its prose intent.*
   Two asks with the same landmark set are the same capability (dedup on substrate, not on the LLM's phrasing).

8. **Verification gates acceptance** — *a derived capability is a hypothesis until a trial re-runs it and its
   postconditions hold.* Inference proposes; execution proves; only then does it persist.

9. **Reversibility / safety classing** — *do not auto-fire an irreversible commit.* Deferred-terminal capture,
   trial as a non-committing probe, saga compensation for cross-ground journeys.

> Adding a primitive? First ask whether it **encodes or enforces an invariant.** If it does, it is high-value and
> portable (it would improve *any* reasoner, including a future cheaper one). If it merely "helps the model guess,"
> the model already guesses — re-scope or cut.

---

## 7. Capture: a trace is semantically thin (why grounding is at capture time)

Resolving actions → intent presupposes a trace, and **the trace's richness, not the model's reasoning, is the
binding constraint.**

- A **rich** trace — each action carrying *element identity + accessible name + text + state delta* — is trivially
  resolvable: `click select#order "Trending"` → "sort by trending" reads straight off the action.
- A **thin** trace — pixel/coordinate only — is an **under-determined inverse problem**: `click (840,210)` → "filter
  by trending" requires *re-grounding* (re-reading the page at that step to see what sat under the point). The
  frontier *can* re-ground, but it is expensive per action, fragile, and — the killer — **requires the page to still
  be in that exact state.** A trace from last week against a since-changed page is unrecoverable by re-grounding.

**Therefore the recorder's real job is not logging clicks — it is attaching grounded semantics to each action at the
moment it happens, and time-freezing them:** element identity/role/landmark, the *option vocabulary present right
then*, the URL/state delta. This converts an opaque, time-fragile click-stream into a **semantically-resolvable,
time-stable** trace, turning a hard inverse problem into a well-posed one.

> The native-capability boundary (full transparency): the model can **infer** intent from a rich trace, and can even
> infer from a thin one by re-grounding a live page — but it cannot natively be the **always-on sensor** that
> captures and time-freezes the demonstration. That sensor (+ its grounded capture) is project-only.

---

## 8. The economic thesis: demote, then distill

Two compounding payoffs, both orthogonal to inference quality:

1. **Demotion (amortization).** The first run pays frontier cost to comprehend/ground/verify; every subsequent run
   is a deterministic cache replay at near-zero marginal cost. 1,000 executions = 1 expensive derivation + 999 cheap
   replays, not 1,000 frontier sessions.

2. **Distillation.** The runtime archive + managed-LLM-proxy + training pipeline exist to capture frontier-quality
   executions and **train cheaper models to occupy the hot path** — i.e., to compile the frontier *out* over time.
   This is the opposite of "do what the model does"; it is "capture model-grade behavior so model-grade compute is no
   longer needed at runtime." The invariants (§6) are what make the archived traces *trustworthy* training signal.

---

## 9. Design consequences (the actionable part)

**Invest here (the architecture's true surface):**
- **Grounding fidelity** — richer, more stable landmark capture; option-vocabulary snapshots; state-delta detection.
  Every point of capture richness directly widens the set of traces that are resolvable *and* time-stable.
- **The invariant catalog (§6)** — make invariants explicit, enforced, and testable. They are the most portable
  asset and improve *any* reasoner, present or future.
- **Persistence & accretion** — dedup, versioning, sync, the outcomes flywheel. This is what the model structurally
  cannot do.
- **Verification (trial-as-proof)** — the gate that turns an inferred hypothesis into a trusted, storable artifact.

**Do not invest here:**
- **Re-implementing reasoning the frontier already does** — comprehension, decomposition, binding, naming. Where a
  cheap deterministic floor is worth having for *cost* (not capability), build it as an *economization* and label it
  so — never mistake it for "the model couldn't do this."
- **Rigid schemas the frontier can't override** — see §5. The ladder is a prior; preserve an override seam at every
  consumer.

**Keep the frontier at the edges, compiled out of the core:**
- *Edges* (novel site, ambiguous demo, drift, a factoring the schema fights) → call the frontier; it reasons.
- *Core* (the repeat, the known site, the verified capability) → run the cache; never call the frontier.

**One-line justification rule (LOCKED):** every primitive must be defensible as exactly one of
**{grounding, invariant, persistence, verification, economization}.** If its honest justification is
*"it helps the model reason,"* question it — the model reasons; the primitive's real job lies elsewhere.

---

## 10. Worked check — the Indeed→Pixabay trace

Concrete grounding for the whole doc. Given a rich recorder trace of *"search jobs on a job board and filter, then
search flying turtles on an image site and sort by trending"*:

- **Inference (frontier, native):** segment at the host change (→ two Ground sub-intents); abstract each
  search+filter; generalize `"writer"`/`"flying turtles"` → KEYWORD; read success from URL deltas
  (`&fromage=3`, `?order=trending`) — *not* the search box. The model produces the compound cross-ground intent
  unaided. **No primitive made it infer better.**
- **What the primitives added:** the *landmark + option-vocabulary capture* made each action resolvable and
  time-stable (§7); the *effect-boundary invariant* made the model read URL deltas as success, not box-presence (§6
  #1 — the very bug fixed at `v2.74.783`); the *Ground boundary* gave the cross-site segmentation cleanly; the *tier
  schema* gave a typed target so the two sub-intents compose into a runnable Workflow; *persistence + trial* turned
  the hypothesis into a verified, re-runnable, frontier-free capability.

That is the division of labor in one example: **the reasoning was free; the grounding, the invariants, and the
persistence were the architecture — and they are what made a one-shot inference into an asset.**
