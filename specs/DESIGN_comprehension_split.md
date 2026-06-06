# DESIGN — Comprehension / Binding split (ORCH-CB)

> **Status:** design / building (slice 1 in progress).
> **Namespace:** `ORCH-CB`. **Builds on:** `DESIGN_intent_orchestration.md` (the locked ORCH model).
> **One line:** separate *comprehending the shape of an intent* from *binding it to substrates*, so an ask always decomposes — independent of what's recorded, what page you're on, or which ground you're in.

---

## 0. Why this exists — comprehension is fused with binding

Today the chat does both jobs in one shot. `ORCH_PLAN` asks the LLM to **decompose AND route** the ask over the current ground's capabilities; the control-flow lifts (`liftConditional`, `liftControlFlow`) then *restructure the already-bound steps*. Three failures fall out of that fusion:

1. **Mixed-effect intents mis-route.** "if there are any jobs, sort by date" is a *read* (the condition) feeding an *act* (the consequent). Classifying the **whole ask** by effect lets the noun "jobs" pull the search action. Effect is a property of a **step**, not an intent.
2. **The monolith regresses under its own generality.** Teaching one planner prompt about conditionals broke the plain-action case (it dropped an explicit "search"). One prompt doing every shape means every new rule interferes with the others.
3. **An empty ground doesn't decompose at all.** With no substrates, binding has nothing to route to, so the ask collapses to one unmatched blob — the *structure* (search → if(jobs) → sort) never surfaces.

All three are the same root cause: **the shape of an intent is being derived from the substrates instead of from the ask.**

---

## 1. The inversion — comprehend the shape, then bind

```
ask ─▶ ROUTE ─▶ COMPREHEND ─▶ BIND ─▶ validate ─▶ confirm ─▶ run
        (det.)    (shape)        (substrates)
```

- **Route** *(deterministic):* pick a comprehension strategy from shape signals (`classifyReadAsk`, `isForeachAsk`, `isConditionalAsk`, `decomposeAsk`).
- **Comprehend** *(per-shape, recursive):* emit a **PlanShape** — the IR with **unbound, effect-tagged slots**. Touches **no** substrates.
- **Bind** *(per-slot):* resolve each slot against **effect- and scope-matched** substrates via the existing matcher; unfilled slots are **gaps**.

Today's order is *bind-then-restructure*. The new order is *comprehend(shape)-then-bind*. The shape exists before, and independent of, any substrate — which is exactly why an empty ground still decomposes (every slot just becomes a gap).

---

## 2. The slot — where the tags live

A pre-binding leaf is a **Slot**. Comprehension sets `effect`, `role`, `scope`; binding fills `bound` + `bindings` (or leaves them null → a gap). One IR, two phases — no separate "shape" vs "plan" type to keep in sync.

```js
// LEAF slot (unbound) — what COMPREHEND emits
{ kind:'observe'|'fragment'|'analyze', id,
  effect:'read'|'act'|'reason',          // the irreducible work-kind (= Observation / Fragment / Analysis)
  role:'head'|'driver'|'condition'|'consequent'|'body'|'step',
  scope:'locale'|'ground'|'global',      // how WIDE to bind (= the tier; see §4)
  ground?:'<origin>',                    // GLOBAL scope only — the ground to resolve/navigate to
  clause:'<the NL this slot covers>',
  outputType?:'scalar'|'list'|'count'|'predicate',   // reads
  predicate?:{op,value,...},                          // analyze (parsePredicate floor)
  bound:null, bindings:null }            // BIND fills these; still null ⇒ gap

// CONTROL-FLOW node — holds slots (unchanged shape)
{ kind:'foreach'|'gate'|'loop', id, over, collect?, body:[Slot…] }
```

**Completeness (from the locked design):** every leaf is one of **act / read / reason** — Fragment, Observation, Analysis. `navigate`/`wait` fall out of transitions. So `effect` is total over the work-kinds.

---

## 3. The LLM is not a fallback — it owns *meaning*, the floor owns *shape*

The apparent contradiction ("intent-driven made the LLM first; here it's an escalation") dissolves once you split **comprehension** into two layers:

| Layer | Nature | Owner |
|---|---|---|
| **SHAPE** — read? loop? conditional? how many clauses? | syntactic, **stable** | deterministic floor (regex/lexical); LLM only arbitrates ambiguity |
| **MEANING** — what does "the cheapest that ships free" pick? what sub-goals does "apply to senior remote roles" entail? which affordance satisfies it? | semantic, **novel** | **LLM-first** (= the intent-driven propose/resolve/trial pipeline) |

And the balance is a **gradient on ground maturity** — the flywheel:

```
COLD ground → meaning is novel → LLM-first   (propose → trial → accept; a gap fills here)
WARM ground → meaning is known → deterministic cache hit (alias-exact 0.95, composite T2; no LLM)
```

The intent-driven work described the **cold-start**; this split describes the **warm state**. A slot with **no matching substrate is a gap, and filling a gap routes to the full LLM intent-driven comprehension.** So: deterministic router → cached bind (warm) ⟂ LLM comprehend+ground (cold). *Grounding captures mechanism; the LLM captures meaning* — unchanged.

---

## 4. Scope is tiered — T1 Locale, T2 Ground, T3 Global

Binding scope is itself a tier property; the comprehender sets it on the plan, and the binder honors it:

| Tier | `scope` | Binds against | Navigation *within* it |
|---|---|---|---|
| **T1** | `locale` | substrates on the current **page** | none |
| **T2** | `ground` | substrates across the **site** (any locale) | Locale→Locale *within* the ground (search page → detail page) — substrates stay in scope |
| **T3** | `global` | substrates across **grounds** | Ground→Ground (site → site) — scope **moves**, must be re-resolved |

`scopeAndPartition` already has the primitives: `currentLocaleUrl` + `sameLocale` (T1), `currentGroundId` (T2), no filter (T3). **T1↔T2 is "how wide is the current scope"; T2↔T3 is "the scope itself moves."** That second jump is where the new machinery lives.

### T3 deltas — what this split sets up but does NOT solve
1. **Ground resolution** — intent → *which site*: a matcher over a **global** catalog, above the per-ground one.
2. **Lazy per-ground binding** — bind Ground B's slots only after navigating into B's scope (interleave bind with nav).
3. **Cross-Ground data mapping** — typed output on A → typed input on B across **different schemas** (semantic → LLM).
4. **Distributed failure** — a step half-committed across grounds (compensation/saga).

The existing cross-Locale **Workflow** runner (nav + per-step synth) is the execution substrate for T3; the gap is the *comprehension* that emits a ground-graph. Designing the slot with `scope` (+ `ground` at global) from day one makes T3 an extension, not a rewrite.

---

## 5. The pieces (mapped to modules)

| Piece | Module | New / refactor / reuse |
|---|---|---|
| Router | `Core/orchRoute.js` *(new)* | composes existing classifiers → a strategy |
| Comprehenders | `Core/orchChain.js` *(refactor)* | `liftConditional`/`liftControlFlow` take **clauses**, emit **slot shapes**; recursive via the router (hybrids compose) |
| Predicate / read floors | `orchAnalyze.js`, `observe.js` *(reuse)* | `parsePredicate`, `classifyReadAsk` — the deterministic meaning-floor |
| Slot IR (effect/role/scope) | `Core/orchPlan.js` *(extend)* | **slice 1** |
| Binder | `ORCH_COMPREHEND` + `ORCH_BIND` handlers *(new; split out of ORCH_PLAN)* | per-slot `rankAndDecide`, effect+scope scoped |
| Per-shape escalation prompts | `AnthropicService` *(new, small)* | only where a floor is uncertain |

### Worked example — same comprehension, two grounds
`"search for jobs and if there are any jobs, sort by date"`

**Comprehend (substrate-free):**
```
fragment(head,       act,  scope:ground, "search for jobs")
observe (cond,       read, scope:ground, list, "there are any jobs")
analyze (pred,       reason, predicate=exists, over=cond)
gate    (over=pred){ fragment(consequent, act, scope:ground, "sort by date") }
```
**Bind — full ground:** head→search ✓ · cond→jobs-list obs ✓ · consequent→sort ✓ → 0 gaps → runs.
**Bind — empty ground:** every slot `bound:null` → the **shape still renders**, 3 gaps → "teach me each / try from page."

---

## 6. Build order (each a tested slice)

1. ✅ **Slot tags in the IR** — `effect` / `role` / `scope` / `ground` on the orchPlan leaf + `effectForKind` + validator tolerance. *(pure)*
2. ✅ `Core/orchRoute.js` — the deterministic shape router (`routeShape`). *(pure)*
3. ✅ `Core/orchComprehend.js` — per-shape comprehenders over **clauses**, reusing `liftConditional`; `foreach` escalates. *(pure)*
4. ✅ `Core/orchBind.js` — `bindShape`: per-slot effect-scoped matching (injectable scorer; default lexical). *(pure)*
5. ◐ **Escalation seam** — `comprehend()` returns `escalate:true` for shapes whose MEANING is semantic (foreach body split). The full per-shape escalation *prompts* are deferred; the warm path still uses the existing `ORCH_PLAN` for semantic binding.
6. ✅ **Chat wiring (cold-ground fallback)** — when `ORCH_PLAN` binds nothing for a structured ask, `comprehend()` renders the shape as a plan-to-learn (every part a gap) → try-from-page / show-me. **Additive**: the warm `ORCH_PLAN`/lift path is untouched; this only intercepts the previous "one unmatched blob" miss.

> **Status after this batch:** slices 1–4 + 6 shipped (101 pure tests). Slice 5's escalation *seam* exists; specialized prompts + a full `route→comprehend→bind` replacement of `ORCH_PLAN` (retiring the lifts) is the next arc. The empty-ground decompose bug — *"with every substrate deleted the ask doesn't decompose"* — is fixed by the slice-6 fallback.
