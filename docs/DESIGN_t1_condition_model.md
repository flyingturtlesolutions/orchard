# DESIGN — Tier-1 condition model (substrate-grounded pre/postconditions)

**Status:** Design note. Reconciles the T1 (Fragment / Observation / Analysis) condition
model with the substrate layer (Perspective / Locale / Landmark) and the interaction monitor.
**Date:** 2026-06-04
**Relates to:** `../../schemas/orchard/DESIGN_interaction_monitoring.md` (the monitor this serves),
`Services/PerspectivePredicates.js`, `Services/TemplateWalker.js` (`checkConditions`, `perspective_ref`),
`Core/tier2Lower.js` (`deriveStructuralPostcondition`, `successToConditions`),
`Core/observedSegment.js` (`derivePhasePostcondition`, `reconcileObservedLandmarks`),
`Core/accept.js` (`mintLandmarkUid`, `buildPerspectiveRecord`), `Core/landmark.js` (`featureToProtoLandmark`).

---

## 1. Thesis

A **Tier-1 artifact is bounded by a single page-state** (a Fragment is gated by a page-state
change; an Observation reads a region of one state; an Analysis reasons over data). Its pre- and
postconditions are therefore assertions about **being in / having reached a state** — and a *state*
is exactly what a **Perspective** (intent-scoped landmark set) and a **Locale** (page-archetype
feature catalog) model.

A **URL is not a state — it is an address**, a coarse proxy that predates the substrate
abstractions. At T1 it is redundant at best and wrong at worst (SPA: same URL, different state;
or same state, different URL via query / i18n path / A/B bucket / session id).

> **Perspectives/Locales describe nodes. URLs describe edges. T1 lives on a node; T2+ traverses
> edges.** `url_matches` is an edge predicate that has been mis-applied as a node predicate.

This maps onto the monitor's own tiering: `DESIGN_interaction_monitoring.md` classifies a
`navigate` as `tier: 'browser'`, categorically **not** substrate (§6.3). The monitor already draws
the line this note formalizes.

## 2. Two condition planes (not one)

Conditions split by **what the primitive touches**, and neither plane is URL:

| T1 primitive | Touches | Plane | Evaluated by | Monitored by |
|---|---|---|---|---|
| **Fragment** (act) | the page | **substrate** — `perspective_ref` / `landmarkExists` / `visible` / `hasText` | `checkConditions` / `isPerspectiveActive` | InteractionMonitor (substrate) |
| **Observation** (read) | a page region | substrate (pre) + **data** (post: output non-empty) | both | substrate + runtime |
| **Analysis** (reason) | the **Scope**, not the page | **data** — `DataAssertion` (`field_*`) | `evaluateDataConditionList` | runtime / outcomes |

`url_matches` belongs to neither plane — it is a degenerate proxy on the *substrate* plane.
Analysis never wanted a URL (it is not on the page); Fragment/Observation want substrate, with URL
as the weak proxy.

## 3. The fallback ladder (cold states)

A perspective/locale may not be grounded at authoring time. The fallback already exists and is
ordered by **grounding maturity**, not preference:

```
urlMatches            (zero-cost bootstrap — always available, no substrate)
  ↓ as Explore/Resolve grounds the page
locale FEATURE selector   (deriveStructuralPostcondition — a Locale feature serving the submit goal)
  ↓ as the element is promoted to a registry Landmark
landmarkExists / perspective_ref   (fully grounded, self-healing, monitor-visible)
```

URL is the **bootstrap rung** — what you assert before substrate exists — and it is demoted *in
place* as grounding fills in. The NL/Resolve authoring path already auto-seeds a `urlMatches`
predicate on first Pick and lets substrate predicates accrete (perspective-capture.js); the legacy
top-level `urlPattern` field was removed (v2.74.275) in favor of a `urlMatches` *leaf in the
predicate tree*. Representational fix still owed: the structural floor should assert the feature/
landmark **ref**, not its `selector` snapshot.

## 4. The convergence — one predicate, three consumers

A Perspective already **is** a condition: it carries a fail-closed `predicates` and/or tree over
substrate leaves (`urlMatches | visible | hasText | attributeEquals | landmarkExists | iframeLoaded`),
evaluated by `isPerspectiveActive` and listed by `listActivePerspectives`. So a single grounded
predicate per page-touching T1:

```js
and(
  urlMatches(localeUrlPattern, 'contains'),   // bootstrap scope rung — cheap pre-filter
  landmarkExists(successStateLandmarkUid),     // substrate truth — the success state
  ... k_of_n over operative landmarks          // graded, drift-tolerant
)
```

is consumed **unchanged** by three subsystems that today each invent their own check:

1. **Replay gate** — `PreconditionGate` / `checkConditions` via `perspective_ref`.
2. **Postcondition** — the Fragment's success assertion *is* this tree
   (`"perspective active" ≡ "the fragment succeeded"` when the success-state landmark is a leaf).
3. **Monitor** — `isPerspectiveActive` / `listActivePerspectives` → the InteractionMonitor's
   `activePerspectiveIds` and demand set.

Author once at accept; gate, postcondition, and monitor all read it. A perspective-postconditioned
capability is **monitorable for free** (the monitor already maintains `activePerspectiveIds` over a
*demand-driven* set of accepted perspectives); a URL-postconditioned capability is invisible to the
substrate pipeline.

## 5. The reuse / merge invariant (prerequisite)

The condition model above is durable **only if authoring reuses and merges substrate instead of
rebuilding and clobbering it.** Two seams in the current code violate this:

1. **Observed-path duplication (path-specific).** The SG-trial/NL path sources landmark identity
   from the **Locale** (`bind.js` → `featureToProtoLandmark`), so capabilities binding the same
   feature share a `lmk_sg_` uid (the Locale is the dedup anchor). The **observed/chat path
   (`DERIVE_OBSERVED`) sources identity from the raw demonstration** (recorder selector + captured
   role/name) with **no Locale read** — so a selector that differs from Explore's mints a *duplicate*
   landmark for one element. `mintLandmarkUid` hashing the volatile `selector` makes this worse.
   - **Fix (slice b1, landed v2.74.764):** `reconcileObservedLandmarks(phases, locales)` —
     reconcile-before-mint. For each demonstrated landmark that matches a grounded feature on the
     *same page* (selector-exact, then role+name), adopt the feature's canonical identity and stamp
     `featureId`, so downstream uid minting collides with the catalog. This is PB-2 *resolve-by-reuse*
     applied to the demonstration path.

2. **Clobber-on-save (path-independent).** `saveLandmark` merges as `{ ...new, createdAt: existing.createdAt }`
   and `savePerspective` as `{ ...new, ... }` — both spread only the **new** record, so accrued state
   the new record omits (profile, `verifiedAt`, effects, and — critically — `perspective.predicates`)
   is wiped on re-author. Synthesizing predicates at accept is therefore unstable: a second
   demonstration of the same intent erases them.
   - **Fix (slice b2, landed v2.74.765):** merge-on-save — `saveLandmark`/`savePerspective` spread `...existing`
     first so accrued state the new record omits (profile, `verifiedAt`, effects, predicates) survives a
     re-author. Two guards protect manual authoring: a model re-accept never downgrades `authoredBy` human→model,
     and never overwrites HUMAN-authored `predicates` with auto-synthesized ones.

Flagged for later: `mintLandmarkUid` keys on the *recoverable* `selector` (identity should be
role + accessibleName + hierarchicalContext; selector is the mutable part). And the manual Pick path
mints a third id scheme (`lmk_local_` random) distinct from `lmk_sg_` — its own reconciliation
question.

## 6. Implementation slices

| Slice | Deliverable | Status |
|---|---|---|
| **b1** | `reconcileObservedLandmarks` — observed-accept reconciles to the Locale (no off-catalog dupes) | **landed** v2.74.764 |
| **b2** | Merge-on-save for perspectives + landmarks — predicates/profile/effects survive re-author | **landed** v2.74.765 |
| **b3** | Synthesize `perspective.predicates` (`buildPerspectivePredicates`) from grounded landmarks → the perspective is a real (monitorable) condition via `isPerspectiveActive` | **landed** v2.74.765 |
| **b4** | T1 fragment gate via `perspective_ref(P)` | **prototyped + backed out** — see note |
| **b5a** | Promote the SPA settle-region to a **verified outcome Landmark** in the Perspective (`buildResultsLandmarkRecord`) — success state is now tracked substrate (monitor-visible), no fatal-condition change | **landed** v2.74.766 |
| **b5b** | Recorder captures the swap region's **identity** (role + accessibleName + text, via `_obsExtract`), threaded through `node.settle`/`settleLandmark` → the outcome Landmark is **recoverable** (probe-or-recover by role+name), not selector-only | **landed** v2.74.767 |
| **b5c** | A SAFE T1 substrate gate (non-fatal, or anchor-landmark); a postcondition → a distinct **outcome Perspective** (per SPA phase — the operative one is a snapshot); route the nav-URL edge to the owning T2 | pending |

> **Why postconditions can't just become `perspective_ref`:** a failed postcondition is also FATAL
> (`ExecutionEngine` "fail the whole Strategy if any fragment's postconditions fail"), and `perspective_ref`
> = *all* the perspective's landmarks present. The **operative** perspective is a snapshot of the controls — on a
> nav fragment those controls are gone post-navigation, so `perspective_ref` would fail. The post-state needs a
> **separate outcome perspective** (the results-state landmarks), which is why b5a only *registers* the outcome
> landmark and b5b (the outcome-perspective postcondition) waits on recorder identity-capture.

### b4 backout note (bug pass, v2.74.765)

b4 prototyped an entry-fragment precondition `[{type:'perspective_ref', perspectiveId}]`, then **backed it out**.
Two facts make it unsafe as a *fatal* gate:

1. `perspective_ref` expands (Assertion.js) to "**all** the perspective's landmarks present" (requires `match:'all'`).
2. `PreconditionGate` failure is **fatal** — `ExecutionEngine` returns `{status:'failed'}` and emits `fragment_failed`.

So the gate would block any **multi-fragment** capability (its perspective's landmarks span pages, so "all present"
can never hold on the entry page) and any **render-on-open reveal** (the option isn't in the DOM until opened) —
converting working capabilities into gate failures. Since preconditions were empty before, shipping it is a net
regression. The perspective is *still* the monitorable condition (b3, via `isPerspectiveActive`, which is read-only
with graceful fallbacks — over-strictness there is harmless); only the **fatal fragment gate** is deferred.

**b5** should wire the gate with the right semantics: a **non-fatal** advisory check, OR reference only the
fragment's **anchor** landmark (present before acting) rather than all of them — and add the postcondition→OUTCOME-
perspective half (results region promoted to a registry landmark; the nav-URL edge fact routed to the owning T2).

## 7. Open decisions

1. **One perspective or two** — fold the success-state into the *operative* perspective's predicate
   (simpler; "active ≡ succeeded"), or mint a distinct **outcome perspective** (cleaner, but two
   artifacts + a join). Leaning: one, with the results landmark as a leaf.
2. **`urlMatches` leaf** — keep as the cheap scope pre-filter (an AND of `urlMatches ∧ landmarkExists`
   is strictly better than either alone), or drop once ≥1 substrate leaf exists. Leaning: keep.
3. **Nav postcondition tier** — confirm the strong rule: a cross-locale (URL) assertion is
   *intrinsically* T2 (an edge), never a T1 node postcondition. The monitor already tiers `navigate`
   as `browser`, which supports it.
