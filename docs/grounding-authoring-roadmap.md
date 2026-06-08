# Grounding → Downstream Authoring Roadmap

*Multi-session effort. Goal: make grounding trustworthy enough to AUTOMATE (ask → auto-ground → auto-explore → auto-locale → auto-build T1/T2/T3 + substrate), and make the artifacts authored on that scaffold durable + trustworthy when **no human is curating**.*

Two reviews fed this doc:
- **Review A (grounding foundation)** → the **G1** primitives, tracked separately (see "G1" below).
- **Review B (this doc — downstream-authoring deep-dive)** → an ultracode workflow: 8 dimensions mapped, 40 improvements adversarially verified, **19 confirmed**, + a completeness critic. Run `wf_10003168-b45`.

---

## Headline finding — the post-accept lifecycle gap

The synthesizer **and** an independent completeness critic converged on the same root cause:

> **The trial is the only executable proof the system produces, and it runs exactly once.** `RUN_SG_TRIAL` (sg.js:281) → `buildAcceptance` (accept.js:520) → persist. Every capability is then born `healthStatus:'untested'`, `lastExecutedAt:null` (capabilitySynth.js:148-149,295) and **nothing ever advances those fields.** With a human in the loop, breakage is caught on next use. **Unattended, trust silently decays as the site drifts.**

The deeper pattern across all 19 wins — the scaffolding already *mints* rich proof/signal at create-time; the leverage is in three moves:
1. **Capture the one field that's null** (`hierarchicalContext`).
2. **Consult the classifiers/histograms that already exist** but aren't wired into the builders/Select.
3. **Re-run the one proof that runs only once.**

Levers 1, 2, 6 below form one missing subsystem: **the post-accept lifecycle** (re-prove → quarantine → migrate). That is the central thing to build for unattended authoring.

---

## The 5 biggest wins

| # | Win | Lever | Unlocks | Effort |
|---|-----|-------|---------|--------|
| **1** | Re-trial a capability (`reverifyCapability`) | `scoreTrial`/`classifyTrialSafety` (trialSynth.js:355,317) are already pure; re-run on the saved `binding` (accept.js `_leanBinding`:333), write verdict → `Fragment.healthStatus` + `lastVerifiedAt` | A live **trust score** per capability instead of a one-time accept stamp; library self-reports rot | Moderate |
| **2** | `pending-review` lifecycle for `authoredBy:'model'` caps | Add the state at mint (accept.js:445 mints `fresh` for everything); arm path (`buildTerminalDescriptor` accept.js:398) refuses an irreversible terminal from a quarantined cap | The **trust boundary** for unattended runs — a mis-grounded auto-build can't touch the real account until re-proven | Small (after #1) |
| **3** | Capture `hierarchicalContext` (+`aria-labelledby`) at enumerate | `_computeHierarchicalContext` exists (contentScript.js:911); call it in `enumeratePage` | `featureToProtoLandmark` (landmark.js:53) *reads* this but it's **always null** on the auto-build path → the recovery branch (contentScript.js:1631) is **dead code**. Lights up self-healing | **½ day** |
| **4** | Discriminator-strength floor on the selector builders | `computeUniqueSelector` (contentScript.js:166) + `computeArchetypeSelector` (:287) return *first-match*; `classifySelectorTier` (selectorStability.js:104) exists but neither consults it | Durable selectors **by default**; fixes the ORCH-L "1 vs 17 items" archetype flakiness; every artifact inherits the floor | Moderate |
| **5** | Conventions histogram → SG **Select** tie-breaker | `foldConventions`→`selectorTierHistogram` (outcomes.js:270) feeds resolve/locate but **not** `select.js` (grep-confirmed zero refs) | A Ground gets *better* at being authored with volume; additive tie-breaker only | Small |

### Verification notes (spot-checked against source)
- **Win 3 — CONFIRMED.** All four `enumeratePage` feature builders (collection 3630, form 3692, interactive 3747, region 3774) set no `hierarchicalContext`. `landmark.js:53` reads it; recovery (contentScript.js:1631-1640) compares only `ancestorRole`+`ancestorName` (so the costly `siblingPosition` scan can be skipped at enumerate). `buildLocale` (locale.js:34) stores features verbatim → no locale.js change needed.
- **Win 5 — CONFIRMED, with a precision.** `select.js` has **zero** conventions refs. But `foldConventions` *is* consumed by `background.js`+`AnthropicService.js` (resolve/locate, task #29) and viewed in `studio.js`. So the gap is **narrow**: the SG authoring **Select** stage specifically, not "zero consumers."

---

## Missing-subsystem levers (completeness critic)

1. **Re-trial / trust promotion** (= Win 1) — only single-landmark re-verify exists (`LandmarkVerifier`); no whole-capability re-proof.
2. **Human-confirmation queue** (= Win 2) — `authoredBy:'model'`/`synthesized:true` are stamped (accept.js:295,151) but **never read** to gate visibility/execution.
3. **Canonical intent naming** — the catalog's matchable surface is the raw LLM phrase (`c.intent||c.name`, sg.js→groundCatalog.js:38); no `{verb,object,qualifiers}` normalization at author time → "Search for jobs"/"Find jobs" author non-matching labels.
4. **Capability dedup** — only Grounds + Perspectives dedup; Strategies/Observations get fresh ids every time → reworded ask re-authors a twin over the same landmarks (bloat at auto-explore scale).
5. **Error-recovery authoring** — `compensateWith` is *consumed* by the executor (tier3.js:120,256) but **never authored** → irreversible cross-Ground workflows have no undo.
6. **Artifact versioning/migration** — no `siteRevision`/Locale-fingerprint on capabilities → can't tell stale-by-construction from valid when a site changes (`LandmarkReplacer` rewires one landmark, no transaction).
7. **Write-time referential integrity** — conditions can persist dangling `perspective_ref`/`landmarkExists(uid)`; `validateTranslatedTree` checks shape, not ref resolution → a dangling postcondition "looks broken on every re-trial for a reason no one diagnoses."
8. **Locale→capability coverage** — no "Ground X authored N of M reachable goals" → the unattended loop has **no stopping condition** (the per-Ground analog of the Explore coverage UI).

---

## Sequencing

- **Phase 0 — capture enrichment (cheap, no deps, do first):** Win 3 (`hierarchicalContext` at enumerate). Cheap Locale-quality halves (`containerRole`, `expectedValueType`-for-validation).
- **Phase 1 — selector durability (broad, isolated, parallel-able):** Win 4 (`selectMostDurableUnique` + tier floor).
- **Phase 2 — the trust spine (the keystone for unattended auto-build):** Win 1 + Win 2 together; then the deferred signals (selector-tier+verdict into the landmark profile; auditable recovery logging).
- **Phase 3 — close the loop + completeness (compounding, once auto-build volume is real):** Win 5; critic #8 coverage/"done" signal; critic #4 capability dedup; critic #3 canonical intent naming.
- **Phase 4 — T3 generalization + critic #5/#6 (versioning, compensation):** defer until single-Ground trust (Phases 0–2) is proven.

### Explicitly de-scoped (per synth)
- Full datatype **catalog** on every input — keep only the **validation** slice + an optional Select tie-breaker.
- Per-item collection control templates — defer until a batch-authoring capability needs them.
- Eager scheduled re-trial cron — start **lazy** (on first-use) + Studio-triggered (the `LandmarkVerifier` precedent).
- Speculative recovery tie-breakers — **log** ambiguous-candidate scores first; build the heuristic only if data shows a secondary signal wins >70%.
- Eager disclosure-goal re-derive on every Locale load — keep lazy + versioned.

---

## G1 foundation (Review A — assumed by this roadmap)
- `ensureGroundForUrl(url)` — the auto-ground entrypoint (today the no-Ground path dead-ends, sg.js:758).
- Identity-at-creation (dedup-before-mint; today create-then-merge).
- Bind the Locale to its Ground (today `buildLocale` carries no `groundId`).
- A Ground **readiness** gate (`empty|preparing|capable|rich`).

## File anchors
`Core/accept.js`, `Core/trialSynth.js`, `Core/capabilitySynth.js`, `Core/selectorStability.js`, `ContentScripts/contentScript.js` (`enumeratePage` + the two selector builders + `_computeHierarchicalContext`), `Core/landmark.js`, `Core/outcomes.js`, `Core/select.js`, `background/handlers/sg.js`.

## Status
- [x] **GA-1 / Win 3** — `hierarchicalContext` at enumerate — *built (v2.74.838); wants a live `gl` to confirm recovery improvement*
- [ ] GA-2 / Win 4 — selector durability floor
- [ ] GA-3 / Win 1 — `reverifyCapability` trust score
- [ ] GA-4 / Win 2 — `pending-review` lifecycle + arm guard
- [ ] GA-5 / Win 5 — conventions → SG Select tie-breaker
- [ ] GA-6 / critic #4 — capability structural dedup
- [ ] GA-7 / critic #8 — Locale→capability coverage signal
- [ ] GA-8 / critic #7 — write-time referential integrity
