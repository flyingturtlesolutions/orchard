# DESIGN — Intent Orchestration (ORCH)

> **Status:** design / not yet built. Captures the design conversation that followed OBS‑4c.
> **Namespace:** `ORCH`. **Artifact:** a compiled **Intent**.
> **One line:** a conversational assistant composes the three authoring substrates (record / pick / natural‑language) into a single, verifiable, replayable Tier‑2/Tier‑3 program — by *planning over grounded primitives it never has to invent*.

---

## 0. Why this exists — complementarity is the resolution

The three authoring paths were treated as competing alternatives. They aren't — each is *structurally* best at producing exactly one of the three Tier‑2 node families, and every blocker we hit was a **modality mismatch** (a path forced to produce a node type whose nature doesn't match the path's modality).

| Node family | Its nature | Matching modality | Path |
|---|---|---|---|
| **Fragment** | a *temporal* action sequence | capturing actions over time | **3 — Record** |
| **Observation** | a *spatial* element reference | pointing at elements | **1 — Pick** |
| **Analysis** | *symbolic* reasoning | expressing thought in language | **2 — NL** |

- NL hit the matcher‑nondeterminism ceiling because it was asked to **ground** (invent selectors / propose landmarks) — symbolic reaching into spatial/temporal.
- Recording couldn't surface analysis because analysis is **invisible cognition** — temporal capture can't record a thought.
- The picker was awkward as a *general* authoring path because it's a *spatial* instrument.

**Completeness claim.** A web task decomposes into exactly three irreducible kinds of work — **act, read, reason** (navigate/wait fall out of recording's transitions for free). Three instruments, three node families, full coverage. That exhaustiveness is why this reads as "the true architecture": the paths stop being competing products and become the three axes of one space.

**Principle:** *grounding captures mechanism; the LLM captures meaning.* Demonstration kills the ceiling for the *where/what‑acted*; picking grounds the *where‑to‑read*; language supplies the *why/how‑to‑decide*. The LLM is lifted **out of grounding entirely** and confined to its home turf: reasoning over already‑grounded primitives.

---

## 1. The inversion — analysis is the backbone (LOCKED)

The analysis layer (the LLM) is not just another node type in a flat sequence — it is the **orchestrator / control flow**. Richer automations (goal‑directed, *not on rails*) are produced by analysis **freely composing fragments** toward a goal:

> Fragments are discrete ways of arriving at observations, which feed analysis, which composes other fragments toward a goal.

This re‑types the artifact. The on‑rails OBS‑4 artifact *is the sequence* (a fixed Strategy). The orchestrated artifact is a **goal + a grounded vocabulary + a policy that composes them** — the sequence is *emergent*, which is what "not on rails" means.

### The artifact is a program

| Role | Concept |
|---|---|
| control flow (`main()`) | **Analysis** |
| grounded procedures it calls (the verbs / toolset) | **Fragments** |
| grounded reads it branches on (the sensors) | **Observations** |
| the spec it runs against | **Intent / Goal** |

It is **intents all the way down**: the top Intent orchestrates sub‑intent fragments (each fragment already carries its own intent from `describeTrace`). The "intent" verbiage is retained at every level. (LOCKED: keep intent verbiage.)

### Surfaces — chat is the orchestration entry point (LOCKED)

Chat is **the entry point**, but as an orchestrator *over* the existing instruments, not a replacement.

- **Consumer‑only is not a stable design.** It assumes a complete library; the library is never complete (new sites, asks, goals), so a real consumer chat *will* hit misses. A miss has two responses — dead‑end (bad) or capture inline (the design). The HIT/MISS gate is the seam between consuming (hit→run) and authoring (miss→capture); **MISS is intrinsic, so a good consumer must be able to author.**
- **Two doors, one library.** Chat = the door for *getting a task done* (and building capability by doing). The existing direct flows (Explore→Locale, picker, OBS record, SG trial, Studio) persist as (a) the instruments chat reaches for during repair and (b) the deliberate **curation/seed** door (bulk pre‑seeding + cold‑start mitigation). Most users live in chat; power‑users/librarians use the direct flows. Maps onto today's structure: Studio = curation, sidepanel modes = instruments.
- **End‑state vs path.** Architecturally chat is the entry point; practically it is **grown consumer‑first** — day one a cold site is all "show me", so chat starts as a thin consumer with one repair path and the authoring/compiler capabilities grow into it as M/G/X land (this is the walking‑skeleton order).

### Compiler, not interpreter (LOCKED)

> **Decision:** analysis is a **compiler**, not a runtime interpreter.

- **Compiler (chosen):** analysis runs once, emits a *deterministic program* over grounded fragments (FOREACH over observed items, gates on observed predicates), which is trial‑proven and then replays with **no LLM in the runtime loop**. Cheap, verifiable, reuses the existing Strategy / FOREACH / ACTION_GATE runtime. "Free composition" happens at **compile time**.
- **Interpreter (escape hatch only):** LLM stays in the runtime loop, re‑deciding each step. Reserved for genuinely open‑ended control flow that depends on state unknowable until runtime ("keep going until you find a remote one"). Compile all structure you can; drop to runtime LLM only where you must.

This keeps determinism/cost/verifiability and means a compiled plan is something you can **show the user before it touches anything live** — which also keeps safety tractable.

---

## 2. The composition type system — pre/postconditions

For analysis to compose fragments toward a goal, each fragment must be a **typed tool**, not an opaque action blob:

```
fragment filterByPay
  requires:  on a results page          (precondition)
  params:    min: number
  achieves:  results constrained to ≥min (postcondition / effect)
```

Composition becomes planning: chain operators whose **effects** satisfy the next's **requirements** until the goal's postcondition holds. The LLM is the planner; pre/postconditions are the **type‑checker** that keeps it honest. A fragment without a declared effect is an untyped tool the planner can't safely chain — so the effect/postcondition work (SG‑T2‑2/9, PB‑8) is *the type system*, not a side feature.

**Two identities that fall out:**

1. **A fragment's effect *is* the observation it creates.** What `filterByPay` achieves (results ≥ min) is exactly what you'd `readResults()` to confirm. Sensor and verifier collapse into one act (SG‑T2‑9 already does the verifier half).
2. **Goals are bounded by observability.** You can only pursue a goal whose progress is *sensible*. The goal's success criteria must decompose into observation predicates ("5 applications submitted", "salary > $50k"). NL states the goal; the observation vocabulary makes it checkable and terminable. **No sensor, no goal** — the Pick instrument defines the space of attemptable goals.

---

## 3. Authoring UX — a conversational, gap‑driven assistant

The three paths disappear as *modes* and reappear as **repair mechanisms the orchestrator invokes on demand**. The user never thinks "now I'm recording." They converse; the assistant reaches for a grounded primitive; when one is missing it asks for *exactly* that, and *only* that:

- can't **act** → "show me" → **record** (Path 3)
- can't **read** → "where's that?" → **pick** (Path 1)
- needs to **decide** → it just reasons — it *is* the analysis layer (Path 2)

The substrate is invisible. Capture stops being authoring and becomes **teaching the assistant the one thing it's missing, mid‑task** — and each repair permanently widens what it can do.

### Canonical scenario

```
USER: I'd like to search for jobs.
LLM:  I don't know how to do that here — can you show me?      (fragment lookup → MISS)
USER: (demonstrates search — recorded)
LLM:  (replays it — verified; mints landmarks / fragment / perspective)   (OBS‑3 derive+replay)
USER: Only jobs posted today.
LLM:  okay.                                                    (filter fragment HIT → bind "today")
USER: Only jobs with "senior" in the title.
LLM:  Where would I find that?                                 (no fragment → observe route)
USER: (picks the title region — observation + analysis created)
LLM:  okay — I'll read each title and keep the "senior" ones. (8 of 23)
LLM:  Save this as a reusable intent? Next time say
      "architect roles posted this week" and I'll swap words + dates.
```

### Properties

- **Authoring is a live walk.** Each recorded fragment *executes* during authoring and lands you on a real page; that live page is where you pick the observation. Recording and observing are temporally coupled: **act → land → read**. The canvas builds the program as you walk, with the Intent at the root the whole time.
- **Every demonstration is verified immediately** (replay) → promoted to a proven, parameterized grounded verb (OBS‑3/4b/4c).
- **The library compounds.** Later turns *hit* primitives earlier turns (or prior sessions) minted. Over time: more "okay", fewer "show me".
- **The transcript *is* the capability's editable source.** Re‑running = the compiled program; editing = resuming the chat. The conversation compiles **continuously**; "save" freezes + parameterizes it.
- **Response vocabulary = honest confidence surface.** `okay` (high‑confidence hit) / `I think I can…, try?` (low‑confidence hit) / `show me` (action miss) / `where's that?` (observation miss). The matcher's internals are directly the UX copy.
- **Cold‑start curve (set expectations):** a new site is all misses → demo‑heavy first task → library fills → later tasks are conversation‑light. "Teaching a new site costs demos; reusing it is cheap."

---

## 4. The HIT/MISS gate — does the assistant already know how?

The single riskiest mechanic. A **wrong HIT fires the wrong fragment on a live page** (possibly irreversible); a **wrong MISS** costs only a redundant demo. So:

> **This is a precision problem, not a recall problem.** When uncertain, ask.

### The funnel — filter on grounding (hard) before ranking on meaning (fuzzy)

Avoid "embed ask, cosine over descriptions, top‑1" — that *is* the lossy comprehend. Instead:

0. **Scope → Ground/Locale** (deterministic, kills ~99%). Only this site's fragments; ones on *this* Locale run now, sibling‑Locale ones run after a navigate.
1. **Executability → preconditions** (deterministic). Evaluate against the *live* page (evaluator exists). Can't‑run‑here drops out — and that failure tells the orchestrator it must first *reach* that precondition (backward‑chaining).
2. **Meaning → intent + effect match** (now semantic, over the few survivors). Match on **effect**, not just words.

By the time semantics runs the choice set is tiny and every option is real — the only regime where LLM matching is trustworthy.

### Granularity & per‑sub‑intent

HIT/MISS runs **per sub‑intent**, not per intent — the conversation decomposes the goal turn by turn. A complex goal is a *mix* of hits and misses; a MISS is **surgical** (ask for the one missing verb). Conversation state (page, what's done, what's observed) is itself a grounding signal that shrinks the interpretation space before semantics runs.

### The three‑way gate (saves the flywheel)

Binary fire‑vs‑ask forces a bad trade (nag vs misfire). The middle band resolves it:

- **Auto‑fire** ("okay", silent) — strong grounding, clear winner, params resolve cleanly → then replay‑verify.
- **Propose** ("I think the search I learned covers this — try it?") — good but ambiguous, or params uncertain. *One‑word confirm.* Cheap + safe.
- **Ask** ("show me" / "where's that?") — no grounded candidate.

The propose band starts **wide** and **narrows as the fragment proves itself**.

### Confidence signals (set rank's gate band)

- **Grounding strength** — preconditions fully hold (runnable now) > needs navigation > partial.
- **Match margin** — top ≫ second (clear winner) vs two close (disambiguate).
- **Param resolvability** — can the ask's params bind to *real* values (see §6)?
- **Outcome health** — OUTCOMES stream: succeeded‑before + healthy landmarks > stale/failed.
- **Reversibility (hard veto)** — irreversible fragments (apply/submit/purchase) **never auto‑fire**, any confidence; they always propose/confirm. Safety overrides score.

### Learning — confirmations train the auto‑fire threshold

Bands aren't static. Each confirmed *propose* is a labeled positive for "this fragment, this ask" → OUTCOMES raises its confidence → it graduates propose → auto‑fire. The assistant **learns which hits are safe to fire silently** from your confirmations. (Promotion is per‑(fragment, ask‑pattern), graduated by confirmation count + recency, with the reversibility veto as a hard stop.)

### Two safety nets behind the gate

- **Replay‑verify (always on)** — even an auto‑fire runs + checks its postcondition. Fail → "that didn't work — show me again?" A wrong HIT on a *reversible* fragment is caught and repaired, not silently accepted.
- **Commit‑deferral (irreversible)** — the final irreversible step is gated/confirmed regardless. Damage from a wrong hit is bounded to reversible territory.

> The funnel order *is* the assistant's explanation order: "nothing for this site yet" (scope miss) / "I have a search but you need to be on results first" (precondition gap) / "did you mean date or pay?" (margin tie).

---

## 5. Matching internals — description + aliases + effect

Each fragment/observation carries a matchable surface. Their roles are **different types**, and they combine **lexicographically, not additively**.

### Description vs structure

- **Structure** (effect, params, locale, preconditions) = *denotation* — what it does, grounded, verifiable.
- **Description** (+ aliases) = *connotation* — what it's *for*; the semantic surface the ask compares against. Carries the **purpose the demonstration can't** (DOM events never say *why* an action was taken).

The description is **subordinate to structure**: when they disagree, structure wins. It is:

- **Generated *from* structure** (params + effect + actions), so it's a faithful projection — not a free‑floating guess that drifts. Overclaims (description asserts a capability the params/effect don't support) become *detectable inconsistencies*.
- **Validated by effect at runtime** — an overclaiming description that leads to a wrong fire is caught by the postcondition. Never trusted alone.
- **Enriched by use** — every confirmed (esp. ambiguous) match accretes the ask's phrasing into the fragment's **`aliases`** (the existing empty slot). Recall grows; the phrasing becomes an unambiguous hit next time; *and aliases‑coverage is part of what promotes propose → auto‑fire.* The description goes from one‑shot guess to **use‑shaped synonym set**.
- **Observations are described by their *output*** (field name + shape: scalar/list) — more structural than fragment descriptions; matching "data I need" to "data this provides."

### How the three combine into one rank (lexicographic)

1. **Effect = the qualifier (sets the ceiling).** *Can this candidate's effect plausibly achieve the ask?* "Posted today" wants *constrain‑by‑date* → the date filter qualifies; the pay filter is **out** no matter how similar the words; a date *sort* (reorders, doesn't constrain) is weak/out. Near‑binary — decides eligibility before similarity.
2. **Aliases = precision booster / short‑circuit.** Exact alias hit can short‑circuit before any LLM call; a close alias drives confidence toward auto‑fire. Doesn't qualify — sharpens.
3. **Description = soft recall net.** When no alias hit, ranks relevance *among the effect‑eligible*. Broadest, least precise.

Then **margin + param‑resolvability + outcome‑health + reversibility veto** set the *gate band*. Two outputs from one pass: *which* candidate (effect+alias+description) and *which band* (the rest).

### Decision: LLM‑only over the small set; embeddings are a scale‑fallback (LOCKED)

- A single embedding **flattens** effect/alias/description into one vector and loses the qualifier structure — you can't recover "effect gates, alias boosts, description fills" from a cosine, and the qualifier step (*does constrain‑by‑date achieve "posted today"?*) is reasoning embeddings can't do. The **heterogeneity of the signals** is the argument against embedding‑fusion.
- **Cheap paths need neither model:** zero candidates after scope/precondition → instant MISS; exact alias hit → instant HIT.
- **The ambiguous middle is the LLM's job** — one *structured* call over the survivors returns: chosen candidate, confidence, gate decision, param bindings, one‑line rationale (→ the propose/disambiguation copy). Prompted **conservative** (precision bias). Reversibility veto applied structurally after.
- **Embeddings only at scale** — if a rich Locale's *post‑filter* set is still large, embed the ask vs precomputed description+alias vectors to trim to top‑N, *then* LLM. Effect never goes through the embedding.

> The LLM here does **selection over a closed set of real options**, never **generation** of selectors/intents. That's the safe regime — the same reason the whole architecture works.

---

## 6. Param binding = routing (the compiler's front end)

> **Binding and routing are the same operation.** Each clause of the ask is triaged — *can a grounded param take this, or must analysis?* — and the captured vocabularies are the test that decides. Binding = *distributing the intent across the substrate.*

### Two param types, two mechanisms

- **Text params → open slot‑filling.** Extract the span/entity (param label/role guides it); default to the demonstrated value when unspecified. Low‑risk, self‑correcting (wrong span just shifts re‑observable results).
- **Option params → closed‑set classification.** Map the ask to a *member of the enumerated vocabulary*. The LLM **chooses a real label, never invents one** ("this morning" can't exist if not in the set); membership is then verified deterministically.

### The captured option vocabulary — load‑bearing, and a concrete build

OBS‑4c today stores only the *demonstrated* label + container. Safe option‑binding needs the **whole set**. Build: **at demo time, when an option is clicked, snapshot its siblings (the container's `role=option`/menuitem children) and store the enumeration on the param.** It buys three things:

1. Binder classifies against a **real** set (no hallucinated labels).
2. Validity is a deterministic membership check.
3. Replay's `CLICK_BY_LABEL` is **guaranteed** to find the label (it came from the page's own set).

### "A param the fragment can't take" — two flavors, both honest

- **Flavor A — param exists, no value satisfies (vocabulary gap).** Date param exists but "last hour" exceeds the finest option. Detectable → surfaced:
  - exact member → **auto‑fire**
  - defensible nearest, not exact → **propose the substitution** ("I'll use 'Last 7 days' for 'this week'")
  - finer/coarser than anything → **closest + refine via analysis** (filter to "Today", then read timestamps and keep < 1 hr) *if a sensor exists*, else **declare the limit**
- **Flavor B — dimension absent entirely.** "senior in title" maps to no fragment param → **route to observe + analyze** (the "where's that?" branch).

The vocabulary converts "silent wrong bind" into "honest branch."

### Fold binding into the HIT/MISS call

Selection and binding are **entangled** (a candidate you can't bind isn't a hit) → one structured call returns chosen candidate + bindings + per‑param confidence + gaps. Param‑resolvability feeds the gate band directly. Everything stays closed‑set selection — choose a fragment, choose a label, choose a route — never open generation.

### Binding‑as‑triage *is* how an ask becomes a compiled plan

```
"apply to senior software jobs posted today in minneapolis"

software        → KEYWORD            (text bind)
minneapolis     → LOCATION           (text bind)
posted today    → DATE = "Today"     (option bind, validated ∈ vocab)
senior in title → observe(title) ▷ filter(contains "senior")   (no param → analysis route)
apply           → applyFragment, per surviving result          (FOREACH domain)

⇒  search(software, minneapolis) → dateFilter(Today)
   → observe(titles) → keep senior → FOREACH apply
```

Each clause routed to the substrate that can ground it. That distribution **is** the program.

### Analysis → next fragment connection (two halves)

- **(a) Shape of the connection = the analysis output type** *(symbolic, LLM):* list → `FOREACH`; scalar/select → single param binding; predicate → `ACTION_GATE`; count → loop‑until + re‑observe.
- **(b) Grounding of the connection = the demonstration's spatial structure** *(structural, no LLM):* the next fragment is demonstrated **on an instance inside the observed set** (you click a job that's *in* the list you picked). DOM containment (clicked target ∈ observation region) tells the compiler this fragment is the **per‑item body** and the item→param binding is the **row → clicked‑element** relationship.

The compiler fuses: analysis supplies the **quantifier/filter/limit**; the demonstration supplies the **grounding**. **Demonstrate one pass; analysis generalizes it** — the demo is the *sample*, the analysis is the *quantifier*, the compiler is the *fusion*. This resolves the single‑trace‑vs‑loops tension: you never demonstrate the loop, you demonstrate its body and *describe* its extent. The binding inference is **proposed on the canvas for confirmation**, never fabricated — keeping uncertainty at author time, out of the runtime.

---

## 7. Locked decisions

1. Complementarity → completeness: three instruments, three node families (act/read/reason), full coverage.
2. **Analysis is the backbone/orchestrator.**
3. **Compiler, not interpreter** (interpreter is the escape hatch for genuinely runtime‑dependent control flow).
4. **Keep "intent" verbiage** at every level (intents all the way down).
5. Authoring is **conversational**; the three paths are **gap‑driven repair mechanisms**.
6. HIT/MISS is **precision‑first**: grounded funnel → three‑way gate (auto‑fire / propose / ask).
7. Matching combines **lexicographically** (effect qualifies → alias boosts → description fills → margin/health/params/reversibility set the band).
8. **LLM‑only over the small grounded set** is the decider; embeddings are a scale‑only narrowing fallback.
9. Binding = routing/triage; **closed‑set classification** for options against a **captured vocabulary**; never open generation.
10. Safety: replay‑verify (reversible) + commit‑deferral & confirmation (irreversible) behind the gate, always.
11. **Chat is the orchestration entry point** over the existing instruments (not consumer‑only, not a replacement); consume‑vs‑author is unified by the HIT/MISS seam; direct flows persist as the curation door; grow chat consumer‑first.

---

## 8. Open questions

- **Auto‑fire ↔ propose boundary:** exact evidence that promotes a fragment to silent auto‑fire (confirmation count + recency + alias coverage). Is the dial user‑settable ("always ask before acting" vs "just do it")?
- **Refine‑via‑analysis hybrid (Flavor A):** the first case of a *single* constraint split across a fragment (coarsest page filter) **and** analysis (compute the rest). Mechanics + how it's surfaced.
- **Loop boundary / termination gesture:** demonstrate‑one‑iteration‑and‑mark‑repeat vs let the **intent's** count close it (re‑observe → check `count == 5` → continue/paginate/stop). Lean: the latter (termination already lives in the intent), which requires "re‑observe between iterations" to be first‑class.
- **Act‑vs‑observe click** during a live demo — modifier? recorder toggle? overlay? The single most important interaction detail; resurfaces when a click is *both* an action and the thing that reveals a per‑item binding.
- **Conductor:** always recording‑led spine, or allow intent‑first (NL proposes a skeleton, recording fills grounded parts)? Default recording‑led; canvas should allow entry from any instrument.
- **Re‑grounded `describeTrace`:** respec from trace‑summary → structure‑derived (params + effect + actions) with the consistency check.

---

## 9. Build roadmap (indicative slices)

What **exists** (reused, not rebuilt): grounded fragments + landmarks + perspectives (SG/OBS), parameterization + `CLICK_BY_LABEL` (OBS‑4b/4c), pre/postconditions + effect verify (SG‑T2‑2/9), Strategy runtime with FOREACH / `iteration_variable` / `ACTION_GATE` / param bindings, the OUTCOMES stream, the precondition evaluator (`TemplateWalker.checkConditions`), `executeStrategy({strategyParamValues})`.

What is **new** (this spec):

- **ORCH‑V (prereq):** capture the **option vocabulary** at demo time (enumerate the open dropdown's `role=option` siblings → the param's closed set). Unlocks safe option‑binding + guaranteed `CLICK_BY_LABEL`.
- **ORCH‑D:** re‑grounded `describeTrace` (structure → description) + the description/structure consistency check; `aliases` slot wired for accretion.
- **ORCH‑M:** the HIT/MISS matcher — grounded funnel (scope → preconditions → effect/intent rank) + the single structured LLM select+bind call returning {candidate, bindings, confidence, gate, rationale}; reversibility veto; embedding narrowing behind a scale flag only.
- **ORCH‑G:** the three‑way gate + OUTCOMES‑driven propose→auto‑fire promotion (per fragment, ask‑pattern).
- **ORCH‑C:** the conversational side panel — the chat that *is* the intent; capability‑gap → record/pick repair invocations; the live canvas (growing Tier‑2 DAG); save = freeze + parameterize.
- **ORCH‑X:** the compiler — ask → plan over grounded primitives (binding‑as‑triage), emitting deterministic Strategy constructs (FOREACH / gates / bindings); analysis→fragment connection via output‑type × demonstrated‑containment; canvas confirmation of inferred wiring.
- **ORCH‑L:** loop/termination from the intent's observable success criteria + re‑observe‑between‑iterations as a first‑class step.

Suggested order: **ORCH‑V → ORCH‑D → ORCH‑M/G → ORCH‑C → ORCH‑X → ORCH‑L**, since matching + binding (M/G) presuppose vocabulary + descriptions (V/D), and the conversational shell (C) is where the compiler (X) becomes visible.

---

## 10. The thesis, restated

The system finally employs **all** its substrates to reach a goal: landmarks + fragments (grounded verbs), perspectives + observations (grounded reads), analysis (the planner), intents (the spec). The earlier paths stop being three ways to make three kinds of artifact and become **one goal‑seeker orchestrating a standard library it built from demonstrations and picks.** Nothing prior is stranded — it's the vocabulary. The LLM is never asked to invent, only to *choose among grounded things and say how sure it is.*
