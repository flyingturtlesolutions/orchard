# DESIGN — Linked / Compound Perspectives

**Status:** Design note (not yet a spec section; nothing here is built except the
v2.74.351 stopgap in § 6). Captures a gap surfaced empirically by the
description-first proposal flow.
**Date:** 2026-05-23
**Relates to:** LOCALE_SPEC § 1, § 3, § 8, § 14; GROUND_SPEC (Inter-Locale
relationships); Workflow (Tier 2 operation).

---

## 1. The observation

The description-first proposal flow (`proposePerspectives`, LOCALE_SPEC § 13),
seeded with an intent like *"search for music and download a track"* on a
site's **homepage**, reliably proposes a *set* of perspectives that are not all
on the current page:

- `music-search-homepage` — the search entry point **on the homepage** (roles:
  search-input, search-submit, music-category-link, media-filter).
- `music-results-grid` — *"After searching… the results page showing individual
  tracks…"* — **a different page**, reached only after acting (roles:
  search-input, music-item, item-title, download-button, preview-button).

The LLM is reasoning about the **user's journey**, not the current page. It
decomposes the intent into a **sequence of page-class perspectives**, only the
first of which exists where the user currently stands. This is emergent and
arguably correct: an intent rarely lives on one page-class.

## 2. What is actually being surfaced

Two distinct things ride together in that output, and they belong in different
tiers:

1. **A structural link (affordance).** "`music-search-homepage` and
   `music-results-grid` are related; the second is reached *from* the first."
2. **A transition (operation).** The actual `TYPE query → CLICK search-submit →
   arrive at results`. This is a Fragment/Workflow concern, not an affordance.

"Linked / compound perspective" = the **affordance-side representation of a
cross-Locale flow**: a graph of perspectives connected by transitions.

## 3. Why the current model doesn't capture it

LOCALE_SPEC deliberately keeps Locales flat:

- § 1: *"NOT structurally hierarchical above other Locales. Locales don't
  compose other Locales."*
- § 3 models **within-perspective** flow only — `sequences` (ordered landmark
  steps) and `triggers` (one landmark's interaction affects others) — all
  *inside one* perspective.
- § 3 explicitly relocates the cross-cutting case: *"Cross-Locale relationships
  … live at the **Ground** level (per the Ground spec § Inter-Locale
  relationships)."*
- § 14 shows the unflagged gap: it lists *Search results / Product detail /
  Cart / Checkout* as four **independent** Locales — obviously a flow, modeled
  as if unrelated. The linkage is implicit (shared Ground + URL predicates) and
  only becomes explicit **operationally**, inside a **Workflow** (the Tier-2
  operation that traverses Locales at runtime).

So the affordance-side representation of a cross-Locale flow is **named but
undefined**. Adding links *into a Locale* is the wrong fix — it would break the
load-bearing "composition IS the perspective" identity (§ 1, § 3). The
disciplined home is **Tier 2 (Ground)**.

## 4. Candidate model (proposal — NOT built)

A Ground-level relation, fleshing out the spec's deferred "Inter-Locale
relationships":

```typescript
// On the Ground (Tier 2 affordance)
localeTransitions: [
  {
    from:  'loc_music_search_homepage',
    via:   { landmarkRef: 'lmk_search_submit', action: 'CLICK' },  // or TYPE+CLICK
    to:    'loc_music_results_grid',
    condition?: AssertionRef,   // optional gate (e.g. query non-empty)
    authoringMetadata: { capturedBy, userJudgment, ... }
  }
]
```

Properties:
- A directed graph over the Ground's Locales; nodes are perspectives, edges are
  transitions. The "compound perspective" is a connected subgraph.
- `via` references a landmark + an Action (Tier 0) — it is the *seam* between
  the affordance graph and the operation that executes it. A **Workflow** is
  the executor; the transition graph is the *map* a Workflow/Strategy plans
  over.
- Reference integrity: a transition is orphaned if either endpoint Locale or
  the `via` landmark is deleted (surface, don't auto-delete — mirrors § 11).
- Authoring metadata makes each edge an LLM-proposed / user-reviewed unit
  (consistent with the § 5 training-signal premise).

This is the architecturally-blessed shape; it is a **Ground-spec change**, not
a Locale-spec change.

## 5. Open questions

1. **Edge granularity.** Is `via` a single Action, or a Fragment (a multi-step
   transition)? Likely a Fragment ref once Fragments span the gap.
2. **Who authors the edge?** Proposed at description-first time (the LLM already
   knows the flow), or inferred from a recorded Workflow run, or both?
3. **Compound perspective as a first-class primitive?** A named "Journey" that
   *is* a subgraph — or is that just what a Workflow already is? Risk of
   duplicating Workflow. Leaning: the graph is affordance metadata; Workflow
   stays the operation. Don't add a third thing without a consumer.
4. **Runtime role.** Per LOCALE_SPEC § 9 the runtime is deliberately
   lightweight (per-Locale predicate eval + active set). Transitions are an
   *authoring/planning* structure; they should NOT add runtime state. A
   Workflow consumes them at plan time.
5. **Cycles & branches.** Flows branch (in-stock vs out-of-stock) and loop
   (paginated results). The graph must allow both; `condition` handles
   branches.

## 6. Current handling (built — v2.74.351, the pragmatic stopgap)

Until the model above is decided, the proposal flow simply **does not pretend a
downstream perspective is authorable here**:

- `proposePerspectives` now tags each option `onPage: boolean` (+ `reachedVia`
  for downstream ones — a short "how you get there" phrase, the seed of a future
  `via`). The LLM judges on-page vs downstream from the DOM/screenshot.
- locale-capture renders downstream options with a `⤳ downstream` badge and the
  `reachedVia` note, and **does not offer "Use this"** — their roles can't be
  picked on the current page. The hint says to navigate there and author it as
  its own Locale.
- Emergent nicety: navigate to the downstream page and re-propose — that
  perspective now comes back `onPage:true` and becomes fillable. Combined with
  the v2.74.350 sibling-Locale context, the second session already knows about
  the first, so the flow knowledge accumulates in the Ground's Locale set even
  without an explicit edge yet.

This keeps Locales flat and spec-conformant while preserving the LLM's useful
flow foresight as guidance — and leaves a clean path to § 4 when we choose to
build it.

## 7. Relationship to existing primitives

| Concept | Scope | Status |
|---|---|---|
| `sequences`, `triggers` | within ONE Locale | spec'd, partially built |
| `localeTransitions` (this note) | across Locales, on the Ground | **undefined** — § 4 proposal |
| Workflow | executes a traversal across Locales | spec'd (Tier 2 op) |
| Perspective templates | abstract templates over Locales | LOCALE_SPEC § 17 Q8, Phase 2+ |

The linked/compound perspective sits in the empty cell: the **affordance map**
that a Workflow executes over.
