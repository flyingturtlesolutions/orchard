# DESIGN — T3 cross-Ground DATA FLOW: the gap map (read → write)

> **Status:** gap analysis, verified against current source `file:line` (post `9ad8bc2`). The target capability:
> *"find a job on LinkedIn **and save it** to Notion"* — one value (`job_url`) emitted on Ground A, consumed on Ground B.
> **Builds on:** `TRACE_t3_example.md` (the Intent→DOM trace that first flagged the unwired seam), `DESIGN_t3_cross_ground.md`.
> **One line:** the runtime and the pure wiring are **already done**; the only gap is that the **binder never surfaces an upstream `outputs[]`**, so `wireCrossGroundData` has nothing to turn into a `scope_binding`.

---

## 0. The data path (what carries `job_url`)

Verified end-to-end against current code (the trace's §3, re-checked):

```
upstream EXTRACT → scope.set('job_url', …)                         [contentScript / TemplateWalker]
  → executeStrategy returns extractedValues = fullScope            [ExecutionEngine.js:472–484]   ✅ WORKS
  → workflowScope merge (last-write-wins)                          [WorkflowExecutor.js:~555]     ✅ WORKS
  → downstream URL = scope_binding('job_url') → resolveBinding     [WorkflowExecutor.js:162–192]  ✅ WORKS
  → executeStrategy(B) seeds scope.set('URL', …) → injectParams    [ExecutionEngine.js:260 / Injection] ✅ WORKS
```

And the **pure comprehension wiring** that produces the `scope_binding`:

```
si.outputs (upstream)  →  wireCrossGroundData  →  si.scopeReads[downstreamParam] = 'job_url'   [tier3.js:140–172]  ✅ DONE + TESTED
  →  buildWorkflowRecord _stepParamBindings  →  paramBindings.URL = {kind:'scope_binding', name:'job_url'}  [tier3.js:39–40]  ✅ DONE + TESTED
```
(`tier3.test.js`: "a downstream reference param binds to an upstream output (URL ← job_url)" + the end-to-end "wire → buildWorkflowRecord emits … scope_binding".)

**So the only thing missing is the FIRST token of that second chain: `si.outputs` is always empty.**

---

## 1. The root gap — the upstream never declares an output

`_bindStrategyOnGround` (`background/handlers/sg.js:47`) is where a sub-intent's `outputs` would come from. Today it yields **nothing**, three ways:

1. **Observations are excluded.** The candidate filter is `c.kind !== 'observation' && (c.strategyId || c.fragmentId)` (`sg.js:51`). But a **read** ("get the top job's link") is an *observation*, and an observation is the only capability that carries a declared output name — `.output` (`Core/observe.js:138`). So the binder filters out exactly the capabilities that produce data.
2. **Strategies don't declare outputs.** `_bindStrategyOnGround` reads `strat.outputs` (`sg.js:60`), but **nothing in the codebase ever sets `strategy.outputs`** (grep across `StrategyTree`, `capabilitySynth`, `tier2Lower` is empty). So a bound Strategy's `outputs` is always `[]`.
3. **Fragments have no outputs.** A bare T1 Fragment declares none.

⇒ every `resolved[].outputs` is `[]` ⇒ `wireCrossGroundData`'s `upstream` list is empty ⇒ no downstream param ever becomes a `scope_binding` ⇒ a `URL`/reference param falls to the else-branch and becomes a **Workflow input** (exactly the all-`strategy_param` records the live runs produced).

---

## 2. Change points (read → write, the recommended first cut)

Enumerated, smallest set that makes **"[read X on A] → [write it on B]"** real:

| # | Where | Change | Kind |
|---|---|---|---|
| **DF-1** | `_bindStrategyOnGround` (`sg.js:47`) | Make it **effect-aware**: a *read-shaped* sub-intent binds from the **observation** pool (`c.kind === 'observation'`) and returns `outputs:[cap.output]`; an *action-shaped* one binds strategy/fragment as today. | binder |
| **DF-2** | `COMPREHEND_CROSS_GROUND` (`sg.js:931`) | Determine each sub-intent's **effect** (read vs action) to pick the pool — `classifyReadAsk(clause)` (`Core/observe.js`) or an effect tag from `comprehendCrossGround`. | handler |
| **DF-3** | `WorkflowExecutor.executeWorkflowStep` (`:349`) | A step bound to an **observation** isn't a Strategy/Fragment — dispatch the read (the `REPLAY_SG_CAPABILITY` observation path / `OBSERVE_*`) so it EXTRACTs `cap.output` into scope. `capabilityKind:'observation'` flags it (sibling of the `'fragment'` wrap). | executor |
| DF-4 *(opt, later)* | `_bindStrategyOnGround` + synth | Auto-declare an **action** Strategy/Fragment's `EXTRACT` output names as its `outputs`, so an action upstream (search-then-extract) can also feed data — broadens beyond pure reads. | binder/synth |

**No change needed** in `wireCrossGroundData`, `buildWorkflowRecord`, `resolveBinding`, or the scope merge — all verified ready (§0).

The one subtlety for DF-1/DF-3: an observation is a **read** (no side effect), so as an *upstream* step it's safe and idempotent. The cross-Ground value flow is then: read-step EXTRACTs `cap.output` → fullScope → workflowScope → the write-step's reference param binds to it.

---

## 3. The contract the binder must satisfy (pinned by test)

The pure layer already enforces the downstream half; the new test (`tier3.test.js`, "DF read→write") pins the **whole contract DF-1 must feed**: an upstream entry whose only product is a declared `outputs:['job_url']` (no params — a pure read) + a downstream write with a reference param ⇒ the lowered Workflow must emit `paramBindings.URL = {kind:'scope_binding', name:'job_url'}` and surface **no** `URL` Workflow input. If DF-1 returns `outputs:[cap.output]` for a read, this is what the runtime receives.

---

## 4. Build order

1. **DF-1 + DF-2** (binder effect-aware + handler effect detection) — produces a Workflow whose write step has a real `scope_binding`. Previewable in the card immediately.
2. **DF-3** (execute a read step) — makes it actually run end-to-end.
3. **DF-4** (action-upstream EXTRACT outputs) — later; unlocks "search-then-extract" upstreams.

**Prerequisite to live-test:** a saved **read** capability on the source Ground (e.g. "get the top result's link"). DF-1/2/3 are otherwise inert against a search-only library — which is precisely why the live runs showed empty data flow.
