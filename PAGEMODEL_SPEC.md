# PAGEMODEL_SPEC — Locale as Page Capability Model

**Status:** BUILT (landed across the v2.74.x slices; this doc now reflects the
implementation). Defines the **Locale** (= PageModel) and the nodes below it:
**Feature**, **Layer**, **Goal**, **Perspective**, **Landmark**.
**Date:** 2026-05-24 · **Synced:** 2026-05-26
**Implemented in:** `Core/locale.js` (builder + query API + `localeEdges`/`edgesFrom`/
`edgesTo`/`edgesByKind`/`pathToGoal` + L1 depth merge + L2 goal attach),
`Core/capabilitySynth.js` (goal → runnable draft Fragment+Strategy),
`Core/graphLayout.js` (graph-viz layout), `ContentScripts/contentScript.js`
(`ENUMERATE_PAGE` L0 + poke→reveal L1), `background.js` (`BUILD_PAGEMODEL`,
`LOCALE_GRAPH`, `SYNTHESIZE_CAPABILITY`), `studio.js` (Locale graph viz + capability surfaces).
**Relates to:** `GROUND_SPEC.md` (site model, inheritance, siteMap, locked
decisions § 0), `OUTCOMES_SPEC.md` (provenance / health / training stream),
`DESIGN_resolve_roles.md` (resolve becomes catalog selection), `DESIGN_linked_perspectives.md`.

> Authoritative locked decisions live in `GROUND_SPEC.md` § 0. This spec details
> the page-archetype layer and below.

---

## 1. Concept

A **Locale** is the intent-independent **capability catalog of one page
archetype**: *what features the page offers, organized into layers, serving goals.*
"Superficial depth" (dropdowns / modals) is **one property a Feature can have**,
not the point. The artifact is a small graph:

- **Feature** nodes — units of capability.
- **Layer** nodes — the surface plus each revealed depth layer.
- **Goal** nodes — achievable outcomes (structured affordances).
- Edges: `reveals` (disclosure→layer), `contains` (layer→features, collection→
  members), `enables` (feature→goal), `leadsTo` (navigation→destination — also a
  `GROUND.siteMap` edge), `partOf` (composite flow).

Nobody walks the raw artifact — downstream **queries** it (§ 7). Resolve thereby
degrades from *search* to *selection* (`DESIGN_resolve_roles.md`).

> **Built:** the typed edge set is materialized by `Core/locale.js#localeEdges`
> (`reveals` / `contains` / `enables` / `leadsTo`), with `edgesFrom` / `edgesTo` /
> `edgesByKind` selectors and the depth-aware `pathToGoal` traversal; `studio.js`
> renders it as an SVG node-link graph (`LOCALE_GRAPH`). `leadsTo` reconciles to
> siteMap archetypes via `Core/siteMap.js#reconcileLeadsTo` (modeled / discovered /
> stub / unknown-gap / external). **`partOf` is realized cross-Locale as Workflows**
> (`Core/workflows.js`): ordered multi-page journeys over the siteMap, each step
> `partOf` the flow, runnable via `BUILD_WORKFLOW`. The within-Locale composite
> `parts` field is still unused (no enumerator emits composites yet).

## 2. Locale shape

```jsonc
Locale {
  id, groundId, urlPattern,          // the archetype's URL pattern (the siteMap node key)

  inherits {                         // by reference + version pin (GROUND_SPEC § 3)
    descriptionVersion,              // site-description version this was specialized against
    conventionsRef, chromeRef
  },
  description { pageDelta, goalsDelta },   // archetype specialization; composed with site on read

  features: { [id]: Feature },       // PAGE-SPECIFIC features (chrome referenced from Ground)
  chromeOverrides?: { [chromeFeatureId]: {…} },   // e.g. "header condensed here"
  layers:   { [id]: Layer },         // 'surface' always present + page-specific depth
  goals:    { [id]: Goal },          // specialization of site goals

  structure?: LandmarkNodeTree,      // FULL structural arrangement of this archetype (§ 5)

  index {                            // denormalized for cheap queries (§ 7)
    byKind:   { input:[id], action:[id], disclosure:[id], navigation:[id], collection:[id], region:[id], composite:[id] },
    byGoal:   { [goalId]: [featureId] },
    triggers: [ { featureId, revealsLayerId } ]
  },
  perspectives: { [perspectiveId]: Perspective },   // the purposes carved over this Locale (§ 6)

  coverage { fidelity, driftHash, lastExploredAt, bands, poked, skippedNavigators, aborted }
}
```

## 3. Feature

The unit of capability. Intent-independent. Discovered by Explore (§ 4).

```jsonc
Feature {
  id,                                // == future Landmark.uid (a11y-profile deriver) — the bridge
  kind: 'input'|'action'|'disclosure'|'navigation'|'collection'|'region'|'composite',
  label, a11yRole,
  selector, frameUrl?,
  selectorKind: 'id'|'data'|'aria'|'semantic'|'class'|'positional',   // stability tier
  selectorVerified: bool,            // querySelector-confirmed; disclosures also reveal-confirmed

  location {
    band,                            // scroll band index (0 = top)
    absRect { x, y, w, h },          // ABSOLUTE page coords
    visibleAtRest,                   // in the at-rest viewport without scrolling?
    scrollToY                        // offset to bring it into view  ← kills "viewport = canonical"
  },
  interaction {
    pattern: 'type'|'click'|'hover'|'select'|'scroll'|'none',
    effect:  'reveal'|'navigate'|'submit'|'filter'|'select'|'expand'|'none'
  },

  // kind-specific
  reveals?:     layerId,                                   // disclosure → opened layer
  members?:     { itemSelector, count, sampleLabels[] },   // collection (the v2.74.395 blocks)
  destination?: { url, sameOrigin },                       // navigation → siteMap edge target
  parts?:       [featureId],                               // composite (search = [input, submit])

  goals?: [goalId],
  confidence,
  provenance { … },                  // OUTCOMES_SPEC § (proposedBy / verifiedHow / correctedByHuman / corpusRef)
  health     { … },                  // OUTCOMES_SPEC § (lifecycle / lastVerifiedAt / resolveHits / resolveMisses)
  evidence   { method:'enumeration'|'poke'|'inspect'|'vision', observedAt, screenshotRef? }
}
```

`location.scrollToY` + `visibleAtRest` are the structural answer to the
"current-viewport-assumed-canonical" bug: the Locale captures the whole page, so a
top-of-page search box is modeled even when the author was scrolled away.

## 4. Layer

```jsonc
Layer {
  id,
  kind: 'surface'|'modal'|'dropdown'|'drawer'|'tab-panel'|'accordion'|'carousel-slide'|'popover',
  openedBy?: featureId,              // null for the surface layer
  overlay:   bool,                   // modal-like (blocks page) vs in-place
  features:  [featureId],            // what lives in this layer
  close?:    { selector, method:'button'|'escape'|'backdrop' }   // fixes "modal left open" class
}
```

## 5. Goal

```jsonc
Goal {
  id, label,                         // "search for media", "sign in", "filter by media type"
  description,
  achievableVia: [featureId],        // the Features that realize it
  confidence
}
```

Structured, not prose — `groundIntent` and perspective-proposal reason over goals.
A Locale's goals are a specialization of `Ground.description.siteGoals`
(`GROUND_SPEC.md` § 6); the composed read yields "site goal, narrowed here, with
the concrete affordances."

## 5b. Structure (LandmarkNodeTree)

The **full** structural arrangement of the archetype (containers, virtual
containers, repeated regions) lives on the **Locale** — it is intent-independent
(the page *has* this structure). A Perspective stores a **projection** of it (§ 6).
Structure discovery (formerly "Structure with Claude") becomes part of building the
Locale at L1/L2, not part of authoring a Perspective.

## 6. Perspective

A **purpose** over a Locale: an intent-scoped selection of Features bound to roles.
This is the entity an author works in and the runtime activates. (It is what the
old "Locale" was, minus page-identity/structure-discovery, which moved up.)

```jsonc
Perspective {
  id, localeId,
  name,
  intent,                            // the purpose (was Locale.description)
  groundedIntent?, achievable?,      // intent grounded vs Locale goals (the C-arch grounding)
  predicateRefinement?,              // optional narrowing under the Locale's urlPattern (inherits otherwise)

  roles: [ {
    role,                            // 'search-input', 'result-item', …
    featureId?,                      // the adopted Feature (→ becomes a Landmark on bind)
    landmarkUid?,                    // == featureId; registered in Ground.landmarkRegistry
    multiplicity: 'one'|'optional'|'many',
    hidden?, revealedBy?             // role in a depth layer (Layer.openedBy)
  } ],
  structureProjection?,              // subset/arrangement of Locale.structure relevant to this purpose
  usage { … }                        // OUTCOMES_SPEC § (activations / lastUsedAt / successRate)
}
```

**Authoring a Perspective** (the convergence of everything built so far):
1. Pick/parent a **Locale** (Explore it, or synthesize a thin one bottom-up from
   hand-picked landmarks; `GROUND_SPEC.md` § 9 bootstrapping).
2. Write **intent** → ground it against `Locale.goals` (composed; intent grounding).
3. The system **selects candidate Features** from the catalog and proposes roles —
   *selection over the catalog*, not blind live-DOM search.
4. Bind Feature→role → the Feature is **adopted as a Landmark** (role-bound +
   profiled + registered by UID).
5. The structure projection comes from `Locale.structure`.

A **default "full" Perspective** is auto-available so single-task pages need no
explicit perspective ceremony (`GROUND_SPEC.md` § 0.20 mitigation).

## 6b. Landmark

The leaf. A **Feature adopted into a Perspective** — role-bound, profiled
(description / aliases / operationsCommon / pitfalls / expectedContent / effect /
interactionPattern), and registered in `Ground.landmarkRegistry` by UID. Identity:
`Landmark.uid == Feature.id`. The same Landmark may be referenced by multiple
Perspectives (and Locales, for chrome) with different roles/aliases. Profiles and
lifecycle are unchanged from today; what changes is the *source* — landmarks are
minted from catalog Features, not searched for from scratch.

## 7. Query contract (`Core/pageModel.js`)

Downstream selects from the catalog; it never walks the raw artifact. Resolution
order honors inheritance (`GROUND_SPEC.md` § 3): Locale → Ground chrome → live.

| Consumer | Query | Returns |
|---|---|---|
| Resolve (selection) | `featuresForRole(model, role, {kind})` | ranked `{selector, location, scrollToY, verified}` |
| Resolve (back-compat) | `knownSelectors(model)` | flat verified selectors, **whole page** (not just poked) |
| Resolve (scroll) | `scrollTargetFor(model, featureId)` | `scrollToY` |
| Reveal-resolve | `disclosureFor(model, triggerLabel)` | `{trigger, layer, close}` |
| Resolve (content) | `collections(model)` | collection Features |
| Intent grounding | `goals(model)` (composed) | structured Goals |
| Perspective propose | `byKind` / `featuresForRole` | seed roles **from the page**, not guessed |
| Workflow (Tier-2) | `flowFor(ground, goalId)` | path through `siteMap` + per-node Features |

## 8. Capture tiers & the Explore process

Explore stops being one heavy pass. It produces the Locale at the **fidelity the
consumer asked for**; you pay only for what you need.

- **L0 — Enumerate (no clicks).** Scroll the bands once (reuse the existing band
  machinery); per band collect interactive elements (input/action/navigation),
  content collections (reuse `detectRepeatingContentBlocks`), and regions
  (header/nav/main/footer). Assign id (a11y deriver) + selector + `location` +
  `interaction`. Flag disclosure *candidates* (broad net) **without poking**. Dedup
  by id across bands. **Output: whole-page Feature catalog + surface layer + the
  scroll fix, for zero interaction cost.**
- **L1 — Probe depth (selective clicks).** The planner (existing
  `planPageExploration`) picks the high-value disclosure candidates (skip
  navigators — record them as siteMap edges instead). Poke **only those** →
  capture revealed `Layer`s + their inner Features + the `close` affordance.
  Far fewer clicks than today's broad poke.
- **L2 — Synthesize goals (one LLM call).** Map Features → structured `Goal`s
  (evolves `describePageAffordances` into structured output); on a fresh Ground,
  also emit the site-level description/goals (`GROUND_SPEC.md` § 9).

```
A. Enumerate   bands top→bottom, READ-ONLY → features + surface + collections   [L0]
B. Plan        LLM + per-band screenshots → which disclosures to poke           [→L1]
C. Probe       poke only the planned set → layers + inner features + close       [L1]
D. Synthesize  LLM → goals (+ site profile on bootstrap)                          [L2]
E. Assemble    Locale + index + driftHash; record nav edges into Ground.siteMap; cache
```

Re-Explore can **upgrade** a cached L0 to L1/L2 without redoing L0, and **diff**
feature ids for drift (`GROUND_SPEC.md` § 8).

## 9. What this subsumes

These shipped/experimental items become *features of the architecture*:

- **Intent grounding (C-arch)** → `Perspective.intent` grounded vs composed
  `Locale.goals`.
- **Repeating-content-block pass (v2.74.395)** → `Feature{kind:'collection'}`.
- **Path C visual tier (v2.74.396)** → "select from catalog; visually locate only
  to **enrich the Locale** when a Feature is missing" — locate writes a Feature,
  not just a one-off landmark.
- **Scroll / whole-page** → the Locale *is* the whole page; every Feature has
  `scrollToY`. The "viewport canonical" bug cannot recur.
- **Auto-profile / auto-structure after Resolve** → adoption (Feature→Landmark) +
  the Locale's structure projection.

## 10. Build order (off the specs)

1. **Locale entity + L0 enumerate + the query API** (`Core/pageModel.js`). Delivers
   the whole-page catalog + scroll fix; nothing downstream disturbed yet.
2. **Re-label**: current "locales" become **Perspectives** referencing a Locale.
3. **Move** intent/grounding onto Perspective; description/goals/conventions/chrome
   onto Ground with composed-read inheritance; siteMap assembly from nav Features.
4. **Resolve = catalog selection**; visual-locate becomes Locale enrichment.
5. L1/L2 depth + goals; OUTCOMES stream rollups + provenance hooks (stubbed corpus).
