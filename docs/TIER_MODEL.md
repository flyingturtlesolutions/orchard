# TIER_MODEL — canonical composition hierarchy (AUTHORITATIVE)

> **Status:** CANONICAL. The single source of truth for tier naming + composition in this codebase.
> **Upstream authority:** `schemas/orchard/DESIGN_tier2_lowering.md` (tier table § :29‑30; the `navigate`‑node rule § :36‑37). This file restates it **where the code lives** and carries the conformance worklist.
> **One line:** `Fragment ⊂ Strategy ⊂ Workflow ⊂ Intent` — stratified by **SITE SCOPE**, not by how many pages are visited.

---

## 1. The model

| Tier | Artifact | Composes | Scope | Shipped class — **CORRECT name** |
|---|---|---|---|---|
| **T1** | **Fragment** (act) · **Observation** (read) · **Analysis** (reason) | — (leaf over Landmarks) | one page / one **Locale** | `Fragment` / `Observation` / `Analysis` |
| **T2** | **Strategy** | Fragments | **within ONE Ground** — may span Locales via `navigate` nodes | `Strategy` (`StrategyTree`, `executeStrategy`) |
| **T3** | **Workflow** | **Strategies** | **cross‑Ground / cross‑site**, Intent‑anchored | `Workflow` (`WorkflowExecutor`) |
| — | **Intent** | Grounds | the top‑level goal | `Intent` |

## 2. The stratifier is SITE SCOPE, not page count

A Ground **is** many Locales, so `home → category → product → cart → checkout` is **one Strategy**. Crossing Locales is a `navigate` node *inside* the Strategy tree — **not** a promotion to a higher tier:

> "Crossing Locales on the same Ground is just a `navigate` node inside that Tier‑2 tree — not a Tier‑3 concern." — `DESIGN_tier2_lowering.md:36‑37`

A chain becomes a **Workflow** only when it composes **whole Strategies across different Grounds**. There is **no separate "journey" tier**; a multi‑locale chain does not get promoted out of Strategy merely for spanning pages.

**Scope‑tier alignment.** The comprehension‑split scope axis (`docs/DESIGN_comprehension_split.md` §4: `T1 locale / T2 ground / T3 global`) is the **same** stratification in a second vocabulary: T2 Strategy = ground scope; T3 Workflow = global / cross‑ground scope. One axis, two names.

## 3. The inversion — what's wrong, and where

The **shipped class names are correct** (`Strategy` = T2, `Workflow` = T3). A 7‑agent code audit (v2.74.778) established that the inversion is **narrower than first feared** — three findings:

1. **Storage keys + accessors were NEVER inverted** (the earlier "storage inverted" claim was refuted in code). `strategies:*` / `getStrategy` / `getAllStrategies` / `executeStrategy` = T2 (within‑Ground, `fragmentSteps`); `workflows:*` / `getWorkflow` / `listWorkflows` / `executeWorkflow` = T3 (cross‑Ground, `steps`). All correct per §1. **No data migration was ever needed**, and **sync is unaffected** (it keys on the storage prefix, not labels).
2. **The only real code inversion was `entityKind`** — a discriminator produced + read entirely inside `Services/CapabilityAPI.js` (zero external readers), tagging the T2 record `'workflow'` and the T3 record `'strategy'`. Fixed (v2.74.778): the 4 producers + the 1 routing reader flipped in lockstep, plus the user‑visible display fallbacks and the Studio site‑map picker labels.
3. **The revised schema's "canonical" name column** (`STORAGE_SCHEMA_REVISED.md`) relabels T2→"Workflow", T3→"Strategy" (rules read *"Strategies compose Workflows"*, lines 751/853). Self‑flagged in Appendix A as a pending‑migration inversion. **Do not adopt the schema name column.**

## 4. Conformance worklist — status

| # | Where | Problem | Status |
|---|---|---|---|
| 1 | `Core/workflows.js` noun "Workflow" (within‑Ground = a Strategy) | mislabel | **conceptual fix done** (v2.74.777 — header/comments → "Tier‑2 Strategy builder"); identifier/message rename → deferred debt below |
| 2 | `Core/workflows.js:142‑144` tier‑collapse (multi‑page path → ONE Fragment) | architecture defect | **parked** — separate slice (per‑page‑fragment Strategy tree); NOT terminology |
| 3 | storage kinds/accessors "inverted" | **FALSE ALARM** | storage keys + accessor names are correct; no migration, no sync impact (see §3.1) |
| 4 | `CapabilityAPI.js` `entityKind` + display labels + Studio site‑map picker | inverted discriminator + labels | ✅ **done** (v2.74.778) |
| 5 | `GROUND_SPEC.md` · `PAGEMODEL_SPEC.md` "Workflow (Tier‑2)" | name + tier‑number collision | ✅ **done** (v2.74.778) |
| 6 | `STORAGE_SCHEMA_REVISED.md` inverted name column | spec convention (self‑flagged Appendix A) | superseded by this doc — don't adopt |
| 7 | `SPEC_DEV.md` "no Workflow tier yet" / GROUND="Tier‑2" | stale changelog | superseded by this doc |

### Deferred — internal‑identifier debt (cosmetic, self‑consistent; no user impact, real churn/risk)
The system is correct and consistent without these; do as one coordinated pass when convenient:
- Message names `GET_WORKFLOWS` / `BUILD_WORKFLOW` (build T2 Strategies) → e.g. `*_STRATEGY_PATHS` / `BUILD_STRATEGY`; Studio `build-wf` / `wf-target` ids; `wfTargets`/`workflowsHtml` vars.
- `Core/workflows.js` function names (`buildWorkflowDraft`, `workflowFromPath`, `workflowsTo`).
- `CapabilityAPI.js` internal: vars `workflows = getAllStrategies()` / `strategies = listWorkflows()` (swapped); methods `#buildStrategyEntityDescriptor` (builds the **T3 Workflow** descriptor) / `#startStrategyInvocation` (runs `executeWorkflow`).
- `StorageManager` breakpoint accessors `getStrategyBreakpoints` / `saveStrategyBreakpoints` (keyed by a `workflowId`, used by the T3 debugger); `workflow-debug.js` `strategy_*` event names (shared "Bucket E" vocab).
- **Remote sync paths** (`StoragePaths.js`): a T2 `strategies:*` record writes to a `/workflows/` path and a T3 `workflows:*` to `workspace/strategies/` — internally consistent + round‑trips, but a future path rename would be a *remote* (Orchard) migration, distinct from local storage.

### Two axes of "tier" — both legitimate (confirmed)
"Tier" is used in **two independent ways**; do not conflate them (conflating them is what made the frontier label look inverted):
1. **Composition tier** (this doc) — groups *primitives* by what composes what: T1 Fragment/Observation/Analysis → T2 Strategy → T3 Workflow → Intent.
2. **Decision / prediction‑path tier** — how a capability's path was *produced* (its provenance/confidence): **T1 = cache** (hand‑authored, deterministic) · **T2 = (intermediate)** · **T3 = frontier** (composer / LLM‑built) · **T4 = human**.

So `Studio/StrategyForm.js:1505‑1506` "Frontier (Composer‑based, **T3**)" and `studio.html:286‑289` "T3 Strategies cannot run yet" are **correct** — that "T3" is the *decision‑path* axis (a frontier‑built Strategy), NOT the composition T3 (Workflow). Left as‑is, intentionally.

## 5. The one‑sentence test

> A cross‑locale journey **within a single Ground is a STRATEGY** (T2). It becomes a **WORKFLOW** (T3) only when it composes multiple Strategies **across different Grounds**.
