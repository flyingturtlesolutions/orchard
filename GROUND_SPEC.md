# GROUND_SPEC — Ground as Site Model

**Status:** Spec (clean-slate architecture; **no migration** — supersedes the flat
Ground→Locale→Landmark model entirely). Not yet built.
**Date:** 2026-05-24
**Relates to:** `PAGEMODEL_SPEC.md` (Locale / Feature / Layer / Goal),
`OUTCOMES_SPEC.md` (provenance + training + usage stream), `DESIGN_linked_perspectives.md`
(cross-Locale flows — the gap it flagged is resolved by § 7 siteMap),
`DESIGN_resolve_roles.md`, `DESIGN_llm_roles.md`.

---

## 0. Locked decisions

This spec set is the authoritative design lock for the affordance hierarchy. Every
decision below was confirmed during design and is binding for the build.

**Hierarchy & entities**
1. The affordance hierarchy is **Ground → Locale → Perspective → Landmark**.
2. **Locale = PageModel**: an intent-independent *capability catalog* of one page
   archetype (its Features, Layers, Goals). It is descriptive, durable, and
   reusable. (Was: the per-page intent+landmark bundle.)
3. **Perspective = the former Locale**: a purpose-scoped, intent-driven *selection*
   of a Locale's Features bound to roles. Many Perspectives per Locale.
4. **Feature vs Landmark — keep both.** A **Feature** is the Locale's inventory
   entry (intent-independent: kind/selector/location/interaction). A **Landmark**
   is a Feature a Perspective has *put to work* — role-bound, profiled, and
   registered at Ground level by UID. Bridge: `Feature.id == Landmark.uid` (same
   deriver). Discovered (Feature) vs adopted (Landmark).
5. **Migration: none.** Clean slate. No back-compat shim, no data preservation.

**Inheritance (anti-redundancy)**
6. The Ground→Locale relationship is *"specialize the site model for this
   archetype."* It applies uniformly to **description**, **goals**, and
   **conventions**: Ground holds the canonical, Locale holds the **delta**,
   effective view = **composed on read** (site ⊕ page). Stored DRY, never copied.
7. Page description ⊂ site description (and page goals ⊂ site goals). The Locale
   **exposes** the composed view but **stores** only its delta + a **version pin**
   to the site description it was specialized against (drift detection).
8. **Chrome is hoisted to the Ground** (header / nav / footer / site-search /
   account / login & cart drawers / cookie banner), captured **once** and
   referenced by every Locale. Chrome detection is **provisional** on first
   capture (by region) and **promoted** to Ground chrome when a second Locale
   confirms the same UID. Locales carry small `chromeOverrides`, never recaptures.
9. The **canonical landmark registry stays Ground-level** (by UID), because a
   global element spans Locales. Features are Locale-scoped; Landmarks are
   Ground-scoped; they bridge by UID.
10. The **site map is a Ground structure** (§ 7). It **absorbs** the locale index
    (modeled nodes), navigation Features (edges), and cross-page flows (paths).

**Capture & process** (detail in `PAGEMODEL_SPEC.md`)
11. Capture is **tiered**: L0 enumerate (no clicks) / L1 probe depth (selective
    clicks) / L2 synthesize goals. A consumer declares the tier it needs.
12. **Bootstrapping:** the first Explore on a fresh Ground builds the Ground
    profile (chrome + conventions + description + siteMap skeleton) *and* the
    first Locale. Subsequent Locales inherit and capture only their delta.

**Observability** (detail in `OUTCOMES_SPEC.md`)
13. **One unified append-only stream** is both the training corpus and the usage
    metrics source. Artifacts carry only small **rollups** derived from it.
14. **Provenance** is per-Feature (proposedBy / verifiedHow / correctedByHuman +
    `corpusRef`). The full proposal→outcome→correction pairs live in the stream,
    not the artifact.
15. **Conventions** (selector-tier histogram, framework, modal-close idiom) are a
    **live rollup learned from the stream** across the Ground's Locales —
    recomputed lazily — and bias resolve/locate on every new archetype.
16. **Confidence decay is active first** (on observed resolve-misses); age-based
    decay deferred.
17. The labeled-corpus pipeline is **stubbed** in v1 (schema carries `corpusRef`
    and the event hooks fire) and filled in a later slice.

**Deferred (seams noted, not built)**
18. **Ground description** is machine-derived on bootstrap, **human-editable**
    (same pattern as the grounded-intent editable proposal).
19. **Auth/session chrome variants** (anonymous vs authenticated) — modeled as a
    future chrome dimension; not built in v1.
20. **Cross-Locale Workflows / Fragments** (the operational traversal of flows)
    remain a Tier-2 concern; the siteMap provides their affordance substrate.

---

## 1. The hierarchy

```
Ground        the territory — a site/domain. Site-wide model + a set of page archetypes.
  └ Locale    a place — one page archetype (PageModel): its Features, Layers, Goals.
      └ Perspective   a purpose — an intent-scoped selection of the Locale's Features, bound to roles.
          └ Landmark  a thing you use — an adopted Feature: role-bound, profiled, registered by UID.
```

The spatial metaphor is load-bearing, not decoration: *territory → place → a
traveler's purpose within the place → the notable things they navigate by.* If a
proposed change makes the metaphor read wrong, it is probably the wrong cut.

**One expensive description, many cheap purposes.** A Locale is built once by an
intensive Explore. Perspectives are thin lenses over it. This amortization is the
entire reason the Perspective layer exists: without it you would either re-derive
the page model per task (waste) or flatten all tasks into one bundle (no task
routing). See `PAGEMODEL_SPEC.md` § 2 for Perspective.

## 2. Ground shape

```jsonc
Ground {
  id, site, predicates,              // domain identity (e.g. host matches)

  // ── Inherited by every Locale (captured once; § 3) ──
  description {                      // SITE-level; the canonical of the layered description
    identity, category,              // "stock-photo site", "e-commerce", "SaaS docs"
    vocabulary,                      // domain terms ("collection" = curated photo set)
    siteGoals: [GoalRef],            // top-level user goals across the site
    version, capturedAt, authoredBy  // 'llm' | 'human' (machine-derived, human-editable)
  },
  conventions {                      // tech/selector fingerprint; LEARNED rollup (§ OUTCOMES)
    framework?, selectorStrategy,    // 'data-testid'|'aria'|'hashed-class'|'semantic'|'mixed'
    selectorTierHistogram,           // learned across Locales from the outcomes stream
    modalCloseVia, iframeUsage, authModel,
    recomputedAt
  },
  chrome {                           // site-wide Features + Layers, captured ONCE (§ 4)
    features: { [id]: Feature },     // header / nav / footer / search / account / login
    layers:   { [id]: Layer }        // global drawers/modals (login, cart, cookie)
  },

  landmarkRegistry: { [uid]: Landmark },   // canonical, spans Locales (§ 5)

  // ── The territory map (§ 7) ──
  siteMap {
    nodes: { [archetypeId]: { urlPattern, localeId?, name, goals[], status } },
    edges: [ { from, to, via, kind } ]
  },

  // ── Per-archetype ──
  locales: { [localeId]: Locale }    // each = a PageModel (PAGEMODEL_SPEC); references the above
}
```

`Feature`, `Layer`, `Goal`, `Landmark`, and `Locale` are defined in
`PAGEMODEL_SPEC.md`. This spec owns only the **Ground-level** members.

## 3. Inheritance — "specialize the site model"

Three facets inherit by the same mechanism: **description, goals, conventions.**

- **Canonical on the Ground.** The site-level value is the single source of truth.
- **Delta on the Locale.** The Locale stores only what is archetype-specific.
- **Composed on read.** A consumer asking for a Locale's description/goals gets
  `site ⊕ page` assembled at read time — never a stored copy.
- **Version-pinned.** The Locale records the `version` of the site value it was
  specialized against. If the Ground value is later re-profiled, the pin makes the
  Locale's delta detectably stale (§ 8).

Resolution order for any inherited facet: **Locale delta → Ground canonical.** For
Feature resolution specifically (used by Perspective authoring and runtime): **Locale
features → Ground chrome features → live resolve/locate** (and a live hit *enriches*
the Locale or chrome rather than being discarded).

When the LLM authors a page description/goals, it is **given** the site
description/goals and instructed to *specialize*, so the layers are coherent by
construction (no contradictory page vs site framing).

## 4. Chrome (hoisted global features)

Global chrome recurs on ~every archetype; capturing it per-Locale is the redundancy
this architecture exists to remove.

- **Captured once**, lives in `Ground.chrome`. Locales reference it; they do not
  recapture it.
- **Provisional → promoted.** On first capture an element in a header/nav/footer
  landmark region is *provisional* chrome (stored on that Locale, flagged). When a
  **second Locale** observes the **same UID**, it is **promoted** to `Ground.chrome`
  and both Locales drop their local copies in favor of the reference.
- **Override, don't recapture.** If chrome differs on an archetype (condensed
  header, search collapsed until scroll-top), the Locale stores a tiny
  `chromeOverrides` annotation keyed by chrome Feature id.
- **Bootstraps the siteMap.** Chrome nav Features are the map's first edges (§ 7).

## 5. Canonical landmark registry

- Keyed by **UID** (the existing accessibility-profile deriver). Spans all Locales
  of the Ground — a global element resolves to one Landmark, referenced by many
  Perspectives across many Locales.
- **Feature ⇄ Landmark:** `Feature.id == Landmark.uid`. A Feature is the discovered
  inventory entry (Locale-scoped); a Landmark is the adopted, profiled, registered
  entity (Ground-scoped). Adoption happens when a Perspective binds a Feature to a
  role (`PAGEMODEL_SPEC.md` § 2, § 6).
- Lifecycle (`fresh`/`verified`/`stale-suspected`/`stale-confirmed`/`deprecated`)
  and `health` rollups live here, fed by the outcomes stream (`OUTCOMES_SPEC.md`).

## 6. Goals at two scopes

`Ground.description.siteGoals` are the top-level outcomes a user comes to the site
for. A Locale's `goals` (`PAGEMODEL_SPEC.md` § 3) are a **specialization** — the
subset/refinement achievable on that archetype, each linking to the Features that
realize it. The composed read gives "site goals, narrowed to this page, with the
concrete affordances." `groundIntent` (intent grounding) reasons over the composed
goals, not free text.

## 7. The site map

The navigation graph of the territory. It **subsumes** three things that would
otherwise scatter: the locale index, navigation observations, and cross-page flows.

```jsonc
siteMap {
  nodes: { [archetypeId]: {
    urlPattern,
    localeId?,                       // null until the archetype is modeled
    name, goals[],
    status: 'modeled' | 'discovered' | 'stub'
  }},
  edges: [ { from: archetypeId, to: archetypeId | urlPattern,
             via: featureId,        // the navigation Feature that is this edge
             kind: 'link' | 'redirect' | 'flow-step' } ]
}
```

- **Locale index = the `modeled` nodes.** There is no separate index; query the map.
- **Navigation Features are edges.** Explore’s historical *navigation guard*
  becomes *navigation recording*: it still does not follow a nav link, but it
  **records the destination** as a map edge (and a `discovered`/`stub` node). The
  behavior Explore used to fight becomes the map's primary data source.
- **Chrome bootstraps the skeleton for free.** The global nav captured once (§ 4)
  yields the site's first edges and node stubs *before any of those pages are
  Explored*. One capture, two payoffs.
- **Cross-page flows are paths.** `search → results → detail → checkout` is a
  sequence of nodes connected by edges; Workflows (Tier-2) traverse these at
  runtime. This resolves the gap in `DESIGN_linked_perspectives.md`.
- **Node status drives coverage + exploration:** `modeled` (has a Locale),
  `discovered` (an edge points there, not yet Explored), `stub` (known from nav /
  `sitemap.xml`, not visited). "Modeled 3 of 11 discovered archetypes" → tells the
  author/agent what to Explore next.

## 8. Layered staleness

Drift is detected at the layer that owns the changed data, so a single-page change
never re-profiles the site:

- **Ground drift** (site redesign): chrome UIDs miss across multiple Locales, or
  the conventions histogram shifts sharply → re-profile chrome/conventions/site
  description **once**. Version bumps invalidate Locale deltas pinned to the old
  version (§ 3).
- **Locale drift** (one archetype changes): that Locale's `driftHash` changes →
  re-Explore only that Locale (cheap at L0).
- **Feature drift** (one element moves/disappears): the outcomes stream bumps
  `resolveMisses` → active confidence decay (§ OUTCOMES) → the Feature is flagged
  for re-capture without touching its siblings.

## 9. Bootstrapping a fresh Ground

The first one pays; the rest are cheap.

1. First visit to a new site → Explore does **double duty**: it builds the Ground
   profile (chrome + conventions + description + siteMap skeleton from chrome nav)
   **and** the first Locale (the current archetype).
2. Every subsequent Locale **inherits** description/goals/conventions/chrome and
   captures only its page-specific delta. The conventions histogram and siteMap get
   richer with each Locale (compounding asset, § OUTCOMES).
