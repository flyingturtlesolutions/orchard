# DESIGN — T3 Cross-Ground Comprehension (Workflows in chat)

> **Status:** design / research complete, not yet built. Output of a 4-agent codebase audit (v2.74.778).
> **Namespace:** `T3X`. **Builds on:** `DESIGN_intent_orchestration.md` (intents all the way down), `DESIGN_comprehension_split.md` (the scope-tiered slot), `DESIGN_tier2_lowering.md` (the T2 instance), `TIER_MODEL.md` (canonical tiers).
> **One line:** a **Workflow** comprehends a *cross-Ground* intent into sub-intents that bind to **Strategies**, by reusing the **exact same** `route→comprehend→bind` recursion a Strategy uses to bind Fragments — differing only in the `scope`/`ground` tags and the pool it binds against.

---

## 0. The thesis — the recursion is real

> *"It is intents all the way down: the top Intent orchestrates sub-intent fragments… The 'intent' verbiage is retained at every level. (LOCKED)"* — `DESIGN_intent_orchestration.md:46,273`

The same decomposition operates at every tier; only the **bind target** and the **scope** change:

| | decompose | bind each leaf to | atom | cross-boundary node | composes into |
|---|---|---|---|---|---|
| **NL intent model** | ask → sub-intents | — | — | — | — |
| **T2 Strategy** (exists) | intent → sub-goals | a **Fragment**/Feature (one Locale) | one **Locale** | `navigate` (cross-Locale) | **Strategy** (`fragmentSteps`) |
| **T3 Workflow** (this doc) | cross-Ground intent → sub-intents | a **Strategy** (one Ground) | one **Ground** | **cross-Ground hop** | **Workflow** (`steps`) |

A Strategy treats one Locale as the atom and crosses Locales with a `navigate` node *inside* its tree; **T3 treats one whole Strategy (a Ground) as the atom and crosses Grounds with the analogous hop one tier up** (`DESIGN_tier2_lowering.md:36‑37`; `TIER_MODEL.md:20‑24`).

---

## 1. What is already built (reuse, don't rebuild)

**The decomposition CORE is tier-agnostic and substrate-free.** `route→comprehend→bind` (`DESIGN_comprehension_split.md:24`):
- **`comprehend()`** (`Core/orchComprehend.js:114`) emits the slot IR from the **ask string alone** — no ground, no storage. Decomposes even on an empty ground (every slot born a gap). The IR already carries the T3 fields: `effect`/`role`/**`scope:'locale'|'ground'|'global'`**/**`ground?`**/`clause`/`outputType`/`predicate`/`bound`/`bindings` (`orchPlan.js:39‑47`).
- **The recursion** (`liftConditional`/`liftControlFlow`, `orchChain.js`; router re-routes sub-clauses, `orchRoute.js:10`) walks `body[]` trees; the validator, interpreter (`walkPlan`, `orchRun.js`), `_tag`, and `_bind` **all already recurse**. Nothing is flat.
- **The binder is injectable + artifact-agnostic.** `bindShape` (`orchBind.js:57`) picks a pool by `effect` and scores with an injected scorer; the richer matcher `rankAndDecide`/`toCandidate` (`orchMatch.js:49,154`) **normalizes *any* artifact to `{id, intent, aliases, effect, groundId, reversible, params}`** — a T2 composite already rides the same rails as a T1 capability. **Pointing it at Strategies needs only a different pool source.**

**The T2 decomposition is the working template** (`background/handlers/sg.js` RUN_SG_TRIAL): `comprehendIntent` (LLM, **page-independent**) produces the sub-goal DAG → `matchSubGoals` (LLM) binds → `lowerToTier2` builds the node tree → `buildTier2CapabilityRecords` emits Fragments + a chaining Strategy.
- **`comprehendIntent` is already cross-context** (`AnthropicService.js:2366`): it returns `{shape, target, constraints, dataNeeded, subGoals:[{id,label,shape,scope,dependsOn,successCondition}], successCondition, safety}` with **no locale shown** — "ORDERED phases, PAGE-INDEPENDENT." This call is reusable for T3 almost as-is (reframe "phases on one page" → "sub-intents across sites").
- **The atomicity invariant** (`matchSubGoals`, `:2601`): a commit must carry the phases it depends on. The T3 analog: a sub-intent consuming an upstream Ground's output must carry that upstream step.

**The T3 runtime EXISTS** (`Services/WorkflowExecutor.js`): a Workflow's `steps` compose `workflow` (=a Strategy invocation), `analysis`, and control flow (`foreach`/`detect`/`loop`/`try`/`wait`/`pause`), over a shared **`workflowScope` `{name→TaggedValue}`** that passes each step's `extractedValues` to later steps. Cross-step data flow already works: a downstream step reads an upstream output by name via `{kind:'scope_binding', name}`.

**The pre-wired seam:** `STEP_SCOPES` includes `'global'` and the validator accepts `ground` (`orchPlan.js:46,116`) — **but `_tag` hard-defaults `scope = scope || 'ground'` (`orchComprehend.js:78,84`) and the binder/`scopeAndPartition` never read scope/ground; off-Ground candidates are *dropped* (`orchMatch.js:84`).** The seam is built and tested, consumed by nothing.

---

## 2. The one inverted assumption — ground resolution

Today the Ground is resolved **from the tab**: `active tab → new URL(url).origin → getAllGrounds().find(origin===origin)` — one tab, one origin, one Ground (`sg.js:561‑564` and ~10 handlers). A single `groundId` is then threaded through every stage (`sg.js:95,266`; `capabilitySynth.js:280,301`), the Locale catalog is scoped to one page, and a **page-drift guard aborts on origin change** (`sg.js:242‑246`).

**T3 inverts this:** a cross-Ground intent has no single resolving ground; the *first* step of T3 comprehension is choosing the Ground(s) **from the intent**, per sub-intent. This is the central lift — everything else is additive.

---

## 3. The new substrate — the 4 named deltas (+ one unnamed)

`DESIGN_comprehension_split.md:92‑97` names four; the audit found a fifth (navigation) the design folded into (b):

| Δ | Name | Exists | Missing (the build) |
|---|---|---|---|
| **a** | **Ground resolution** (intent→site) | `getAllGrounds()`; per-Ground matchers (`matchSiteCapabilities`, `MATCH_CAPABILITIES`) | **A global catalog/matcher above the per-Ground one.** `Ground.description.siteGoals` is **spec'd but unimplemented** — only a flat `derivedDescription` string exists (`groundDerivation.js`); `orchMatch` *drops* off-Ground; Workflow `domains:[]` deferred. → **`matchGrounds(subIntent) → ranked Ground[]`** over `getAllGrounds × siteMap-capabilities × derivedDescription/siteGoals`, lexical floor + LLM. The #1 gap. |
| **(b′)** | **Cross-Ground navigation/execution** (unnamed) | tab/nav lives *inside* each Strategy | **`executeWorkflow` has no `navigate` step and a `workflow` step carries no `groundId`** — it assumes each Strategy self-drives its tab. A Workflow that must *land* on site B before Strategy B has no executor primitive. → add a per-step `groundId` + an executor open/navigate (the direct analog of the within-Strategy `navigate` node). |
| **b** | **Lazy per-Ground binding** | the warm/cold flywheel; the cross-Locale nav+synth runner | bind Ground B's slots only **after** navigating into B (interleave bind with nav). Reuses the runner one tier up. |
| **c** | **Cross-Ground data mapping** (A.out→B.in) | `workflowScope` transport; typed *inputs* (`normalizeStrategyParams`); `scope_binding` by name; `analysis` steps can transform | **No declared OUTPUT schema** (descriptors carry inputs only — outputs are runtime-discovered); the namespace is flat + name-collision-by-overwrite + lossy for `record`/image (`unwrapTagged`). → declared output schemas + an **LLM mapping** step (or a new mapping binding kind) between Strategies. "semantic → LLM." |
| **d** | **Distributed failure / saga** | checkpointed long-running execution (storage) | compensation for a step half-committed across Grounds. Deferrable. |

---

## 4. The artifact — Workflow vs Intent

- **Workflow** = the **T3 executable** that composes Strategies (one per Ground) and **anchors to an Intent** (`TIER_MODEL.md:13‑16`). Record (`workflows:<id>`, top-level, not Ground-scoped): `{id, name, description, steps:[…], params:[typed inputs], resultTemplate?, aliases?}`. A cross-site hop is a `{type:'workflow', workflowId:<Strategy on Ground X>, groundId, paramBindings}` step. This is what T3 comprehension **emits** — mirroring how `buildTier2CapabilityRecords` emits a Strategy chaining Fragments.
- **Intent** = the cross-Ground **goal/prior** that *composes Grounds* — the spec the Workflow runs against (`STORAGE_SCHEMA_REVISED.md:540‑542`; `DESIGN_user_intent_inference.md:130`). One tier above the Workflow. (Ignore the schema's inverted "Strategy (Tier 3)" label per `TIER_MODEL.md §3`.)

---

## 5. Build roadmap (slices)

The recursion makes most of this reuse. Slices, dependency-ordered:

- **T3X‑0 — the recursion harness (pure).** Let `_tag` emit `scope:'global'`+`ground` on cross-Ground sub-intents; give `scopeAndPartition` a **global** partition mode (no `currentGroundId` filter; rank cross-Ground instead of dropping). Pure + tested. *Unlocks the seam — Agent 1's "two changes."*
- **T3X‑1 — Ground catalog + resolution (Δa).** Implement `Ground.description.siteGoals` (or derive from `derivedDescription` + siteMap capabilities) → `matchGrounds(subIntent) → ranked Ground[]` (funnel step-0 lifted global). *The #1 new piece.*
- **T3X‑2 — cross-Ground comprehension (the recursion).** Reuse `comprehendIntent` for the cross-Ground sub-intent DAG; bind each sub-intent to a **Strategy** on its resolved Ground (global binder); emit a Workflow record (Strategy steps + cross-Ground hop). *The "ground-graph the design names."*
- **T3X‑3 — cross-Ground navigate execution (Δb′).** Per-step `groundId` + an executor navigate so `executeWorkflow` lands on each Ground before its Strategy. *Walking skeleton ends here:* "ask spanning 2 sites → a runnable Workflow", data flow limited to same-name `scope_binding`.
- **T3X‑4 — cross-Ground data mapping (Δc).** Declared Strategy output schemas + an LLM mapping step bridging A.out→B.in across schemas.
- **T3X‑5 — lazy bind + saga (Δb, Δd).** Interleave bind-with-nav; compensation over the checkpointed executor.

**Walking skeleton = T3X‑0 + 1 + 2 + 3** (defer mapping to same-name handoff). That's end-to-end "find a job on LinkedIn, save it to Notion" → a runnable cross-Ground Workflow.

---

## 6. Open questions / risks

1. **Ground resolution precision.** Wrong Ground = wrong site fired. Same precision-first discipline as the HIT/MISS gate (`intent_orchestration.md §4`): when uncertain, ask ("which site?"). Needs a confidence band + a disambiguation turn.
2. **`siteGoals` is unbuilt** — Δa depends on giving Grounds a structured intent surface (today only a flat string). May be a prerequisite slice (T3X‑1a) of its own.
3. **Reuse vs. fork of `comprehendIntent`.** It's page-independent already; does a small frame tweak suffice, or a sibling `comprehendCrossGround` prompt? Lean: one call, scope-parameterized prompt (keep the recursion literal).
4. **Cross-Ground data mapping is the genuinely hard, semantic part** (Δc) — defer behind same-name handoff until the skeleton runs.
5. **Safety:** cross-site flows touch more irreversible commits (apply/post/buy on multiple sites). Reversibility veto + commit-deferral per `intent_orchestration.md §4` apply at every Ground hop.

---

## 7. Build status (v2.74.779 — walking skeleton)

| Slice | What | Status |
|---|---|---|
| **T3X‑0** | recursion harness — `comprehend(ask,{defaultScope:'global'})` + `scopeAndPartition({crossGround})` | ✅ built + unit‑tested (additive; defaults unchanged) |
| **T3X‑1** | `Core/groundCatalog.js` — `buildGroundCatalog` / `matchGrounds` / `resolveGround` (intent → which site, precision‑first band) | ✅ built + unit‑tested |
| **T3X‑2** | `Core/tier3.js#buildWorkflowRecord` — resolved sub‑intents → a runnable Workflow (the T2 builder's analog one tier up) | ✅ built + unit‑tested |
| **T3X‑3** | cross‑Ground navigate | ✅ **no executor change needed** — `executeStrategy` (no `targetTabId`) already opens each step's *own* Ground tab (`ExecutionEngine.js:307`), and `workflowScope` carries data tab‑independently. A cross‑Ground Workflow self‑navigates on the existing runtime. |
| **integration** | `COMPREHEND_CROSS_GROUND` handler (`sg.js`): catalog → `comprehendIntent` → `resolveGround` → bind Strategy → `buildWorkflowRecord` → `saveWorkflow` | ◐ wired, syntax‑clean — **runtime‑unverified** (LLM/storage path; needs live test) |
| **T3X‑4 / ‑5** | typed cross‑schema data mapping · saga | ⏳ deferred (the hard semantic parts) |

**Pending wiring (next):** the chat UI sends `COMPREHEND_CROSS_GROUND` (the ORCH‑C trigger) + renders the proposed Workflow for review/run. A **T3‑framed `comprehendIntent` prompt** (sub‑intents that span *sites*, not within‑task phases) is the obvious refinement (§6.3). The deferred internal‑identifier rename (`TIER_MODEL.md §4`) would also rename the `workflow` step kind/messages.
