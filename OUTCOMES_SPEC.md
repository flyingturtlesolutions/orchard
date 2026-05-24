# OUTCOMES_SPEC — Provenance, Training Corpus & Usage Metrics

**Status:** Spec (clean-slate; **no migration**). v1 **stubs the corpus pipeline**
(schema + event hooks land; the labeled-corpus fill is a later slice — `GROUND_SPEC.md`
§ 0.17). Not yet built.
**Date:** 2026-05-24
**Relates to:** `GROUND_SPEC.md` (locked decisions § 0.13–0.17, conventions § 3,
landmark registry § 5, staleness § 8), `PAGEMODEL_SPEC.md` (Feature.provenance /
.health, Perspective.usage). Extends `AnthropicService.#audit` and the resolve-run
log (`_logResolveRun`), which are the seeds of this stream.

---

## 1. The core idea: close the loop

The substrate builds Locales by **LLM proposals → deterministic verification →
human adoption**. That is exactly the signal you want to keep — and today it is
discarded. One **unified, append-only stream** captures it once and serves three
masters:

- **Training data** (authoring-time): labeled `(context → proposal → verdict →
  human-final)` pairs.
- **Usage metrics** (runtime): activation/action outcomes per Perspective/Feature.
- **Health & conventions** (both): rollups that bias future resolve/locate and flag
  staleness.

Decision (`GROUND_SPEC.md` § 0.13): **one store, not two.** Artifacts carry only
small rollups derived from it.

## 2. What does NOT go in the artifacts

Artifacts (Ground / Locale / Feature / Perspective / Landmark) stay lean and
queryable. The stream holds the bulky, high-churn history. Artifacts hold:

- **Provenance** per Feature — *how* it came to be (small, immutable-ish).
- **Health / usage rollups** — *current* trust + recent outcomes (small, updated).
- A `corpusRef` linking to the full pair in the stream.

The full LLM input/output, rejected candidates, screenshots, and correction diffs
live only in the stream.

## 3. Provenance (on the Feature / Landmark)

```jsonc
Feature.provenance {
  proposedBy:   'enumeration'|'llm-resolve'|'llm-locate'|'human-pick',
  verifiedHow:  'querySelector'|'inspect'|'poke-reveal'|'vision-iou',
  correctedByHuman?: { from, to, at },   // STRONGEST training signal: the LLM was wrong here
  corpusRef?:   eventId                  // link to the full pair in the stream
}
```

`correctedByHuman` is the gold label — every human re-pick/override is an explicit
"proposed X, truth was Y." `corpusRef` is populated even when the corpus pipeline
is stubbed (the id is minted; the body is filled later).

## 4. Health & usage rollups

```jsonc
Feature.health   { lifecycle, lastVerifiedAt, resolveHits, resolveMisses, lastResolvedAt }
Landmark.health  { … same, registry-level, aggregated across Perspectives }
Perspective.usage{ activations, lastUsedAt, successRate, lastOutcome }
Locale.coverage  { fidelity, driftHash, lastExploredAt }    // PAGEMODEL_SPEC § 2
Ground.conventions { selectorTierHistogram, framework, modalCloseVia, recomputedAt }  // GROUND_SPEC § 2
```

All are **derived** from the stream — recomputed lazily, never authored directly.

## 5. The unified event

```jsonc
OutcomeEvent {                         // append-only
  id, ts,
  groundId, localeId?, perspectiveId?, featureId?,
  phase: 'author' | 'runtime',
  op:    'locate'|'resolve'|'poke'|'profile'|'activate'|'action',

  // proposal (authoring) — the training input/output
  input?:     { roleOrIntent, screenshotRef?, domHash?, contextRefs? },
  llmOutput?: { box?|selector?|goals?, confidence, model, operation },

  // verdict — the deterministic label
  verdict:    'verified'|'failed'|'abstained'|'corrected',
  humanFinal?: { selector?|box?|edit? },     // the correction, if any

  // runtime outcome — the usage signal
  outcome?:   'success'|'failure',
  detail?:    { matchedCount?, iou?, reason? }
}
```

- **Authoring events** (`phase:'author'`, op `locate`/`resolve`/`poke`/`profile`)
  → training pairs. `op:'poke'` is special: the reveal observation is a *free
  deterministic label* ("is this element a disclosure: yes/no").
- **Runtime events** (`phase:'runtime'`, op `activate`/`action`) → usage metrics.
- Either way, the rollups in § 4 are folded from these.

## 6. Conventions as a compounding, learned asset

`Ground.conventions.selectorTierHistogram` is **learned from the stream** across all
of the Ground's Locales: e.g. *"verified selectors here are 80% data-testid, 15%
hashed-class, 5% positional."* That histogram then **biases resolve/locate on the
next archetype** — each Locale built makes the next cheaper and more accurate
(`GROUND_SPEC.md` § 9 compounding). Recomputed lazily (`GROUND_SPEC.md` § 0.15),
not on every event.

## 7. Confidence decay & staleness (active-first)

Decision (`GROUND_SPEC.md` § 0.16): **active decay first.** A runtime/author
`verdict:'failed'` or `outcome:'failure'` bumps `Feature.health.resolveMisses`;
crossing a threshold lowers `confidence` and flips `lifecycle` toward
`stale-suspected` → the Feature is flagged for re-capture **without touching its
siblings** (`GROUND_SPEC.md` § 8 feature-drift). Age-based passive decay (unused +
known site redeploy) is a deferred refinement.

## 8. v1 scope (stub the pipeline)

- **Land now:** the `OutcomeEvent` schema; emit hooks at the existing call sites
  (`#audit` already fires for cost/latency — add the content fields); the rollup
  fields on artifacts; `corpusRef` minting; active confidence decay from
  resolve-misses; the conventions histogram rollup.
- **Defer:** the corpus *store/exporter* (persisting full inputs/outputs/screenshots
  for training), age-based decay, and any model-training consumer. The hooks make
  the schema forward-compatible so the fill is non-breaking.

## 9. Prior art to extend (not build cold)

- `AnthropicService.#audit` → operational telemetry; widen to carry content fields
  for `phase:'author'` events.
- `_logResolveRun` (locale-capture) → already records per-role resolve outcomes;
  becomes the resolve-op author events.
- Landmark `lifecycle` (fresh/verified/stale-*) → becomes `Landmark.health.lifecycle`,
  now fed by the stream rather than only by re-verify.
