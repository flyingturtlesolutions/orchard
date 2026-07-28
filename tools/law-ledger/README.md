# law-ledger — the pre-registered falsification protocol (v2.74.1855)

Two empirical laws were read off the project record (findings.md, 2026-07-28 session):

- **Law 1 — complexity predicts failure *frequency*.** Stages ranked by structural complexity align with
  live-incident rates (5 of 8 stages sat exactly on the inverse diagonal).
- **Law 2 — observability predicts failure *lifetime*, not failure rate.** Failures in instrumented stages die
  in ~1 diagnosis pass; failures in silent stages historically took 3–8.

This directory is the measurement instrument plus the **pre-registered predictions** for three interventions
designed to put the laws at risk. Registered BEFORE the interventions' outcomes are known; thresholds are
formulas over `baseline.csv`, so disputing a baseline row moves a threshold mechanically, never rhetorically.

## The instrument

- **`INCIDENT[...]` tags** in findings entries (same grammar family as `LESSON[...]`):
  `INCIDENT[stage=receipts class=silent-exit sev=live status=open vfirst=1853]` …
  `INCIDENT[class=silent-exit status=closed vclosed=1855 passes=3]`
  An *episode* = tag lines sharing `class` until a `status=closed` line. Lifetime = `passes` (or line count).
  `sev=live` requires a user-visible wrong outcome / dead end / no-reply / corrupted state — not a latent find.
- **`baseline.csv`** — the frozen historical episodes, one row each, anchored to their findings entries.
  Human-coded once (2026-07-28), disputable by anchor, `label_confidence` marked per row.
- **`ledger.cjs`** — parses both, computes per-stage rates (per 100 versions) and median lifetimes, and prints
  the experiment verdicts with Poisson p-values. `--json` for machine output. Self-test: `ledger.test.cjs`.

Run: `node tools/law-ledger/ledger.cjs`

## Pre-registered predictions (frozen 2026-07-28, v2.74.1855)

All λ₀ values below are **the ledger's computed outputs over baseline.csv** (first run, 2026-07-28) — the tool
is authoritative; if a baseline row is corrected, rerun and these move mechanically. Notably the tool already
corrected the registrant's prose estimates twice before the first experiment started (claiming 2.2→1.87;
hop-drop 1.8→2.22) and exposed that receipts' overall median lifetime is 1 pass — the multi-pass claim holds
only for `sev=live` episodes, so Experiment B is scoped accordingly.

**Experiment C — hop seal** (`Core/hopSeal.test.js`, LANDED v1855).
λ₀(hop-drop) = **2.22/100v** (6 episodes, span v1420–1690).
- Prediction: λ₁ = **0**, structurally. **Any single new hop-drop episode falsifies immediately** — no
  statistics needed against a zero-prediction.
- Confirmation: a 400-version zero-count has p ≈ 1.4×10⁻⁴ under no-change (expected ≈ 8.9).
- Day-one census (quantified): 60 entries × 2 paths × ~30 fields ≈ 2,000 comparisons in 123 tests; **1 latent
  drop-class found and fixed same-commit** (`appHost` — absent on all 60 seeded projections); 1 undeclared
  entry field (`console`) mapped to its named consumer; both red-proof directions seen red before green.

**Experiment B — logbook glass** (LEARNED write-side lines + trace-lint + the RIDE_EACH receipt; NOT YET LANDED).
- Prediction 1 (lifetime, `sev=live` episodes only): ≥4 of the next 5 live `stage=receipts` episodes close with
  `passes=1`. Historical P(one-pass | live) = 1/4 → observing ≥4/5 has p ≈ 0.016 under no-change.
  **Falsified if ≤2 of 5** are one-pass (if the law were true at p₁≈0.8, P(≤2/5) ≈ 0.06 — an unlikely miss).
- Prediction 2 (rate must NOT move): live receipts-rate stays within [0.5×, 2×] of its baseline.
  **Law 2 falsified from the other side if** the rate drops below ⅓× with p < 0.05 — that would mean
  observability *prevents* rather than shortens.
- Detection-bias control: prediction 2 counts `sev=live` only (the lint finding more *silent* defects is the
  tool working, not the law failing).

**Experiment A — door registry** (`Core/doorRegistry.js` + order seal + claim corpus; NOT YET LANDED).
λ₀(claiming) = **1.87/100v** (9 episodes, span v1370–1851).
- Prediction: λ₁ ≤ λ₀/3 over a ≥300-version window. No-change expects ≈ 5.6; the law predicts ≤1.9.
  Confirmed at k ≤ 1 (p ≈ 0.024 under no-change).
- **Falsified if k ≥ 4** in the window (λ̂ ≥ 1.33/100v — no meaningful improvement over λ₀).
- k = 2–3 → extend the window; the pre-registration forbids calling either way early.
- Power floor: the window must reach ≥250 versions before a null result means anything — a quiet month is not
  a verdict.

## Honesty box

n is small everywhere — every threshold is event-count statistics (Poisson/binomial), never a percentage of a
tiny sample. The baseline labels are one person's coding, frozen and anchored — standard for defect-classification
studies, and the disputable-by-anchor rule is the audit path. The two laws were *derived from* the same record
the baseline encodes; these experiments are the out-of-sample test — only post-registration episodes count.
