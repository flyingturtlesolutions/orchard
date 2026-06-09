# Explore → Auto-Explore Roadmap

*Multi-session effort. Goal: make EXPLORE produce a trustworthy, complete-enough substrate, and make **auto-explore** (ask → auto-ground → auto-explore relevant page → auto-Locale → auto-build) safe + reliable **unattended**.*

> **⏸ PAUSED at v2.74.855** — EX-1..5,7 + EX-6a + the full G1 foundation shipped; **EX-6b (the unattended runner) is on hold**. Priority shifted to **grounding quality** (the demand-driven **G2** two-speed model) before automating. Consolidated record: `docs/automation-arc-status.md`.

Source: ultracode workflow `wf_8ffe1fd8-62b` — 8 Explore dimensions mapped, 41 improvements adversarially verified, **23 confirmed**, + a completeness critic. Builds on (assumes, doesn't restate) the shipped **GA-1..GA-8** authoring hardening and the **G1** grounding foundation (auto-ground entrypoint, identity-at-creation, Locale↔Ground binding, readiness gate).

---

## Headline — capture is solid; the gaps are SAFETY, HONESTY, and the missing ORCHESTRATION SHELL

The pipeline (`enumeratePage` → `mergeDepthFromControls` → `synthesizeGoals`/`deriveDisclosureGoals` → `buildLocale`) is well-factored and captures well. The gaps are *not* in what it sees — they're in:
- **(a) Safety** of running the poke sweep unattended,
- **(b) Honesty** about how complete a capture actually is,
- **(c)** the missing **orchestration shell** that makes `ask → ground → explore → build` run on its own.

> **The #1 finding (synth + critic converged independently): the poke sweep has no semantic destructive-action veto.** `isSafeToClick` (contentScript.js:4957-4970) is purely *structural* — it blocks form-submit + nav, nothing else. Any button labeled "Delete / Log out / Deactivate / Empty cart / Publish" passes and gets the full `pokeOpen` click. Worse, `AUTH_TRIGGER` (:4950) *actively opts in* to clicking sign-in/account/**log-out** controls. The swap-guard (:5294) only catches DOM-view-replacement, not a silent XHR `DELETE`. Proof it's an oversight: `DiscoveryService` already refuses to *follow* dangerous links (`DANGEROUS_LINK_TEXT`, DiscoveryService.js:49-52) — but the far more dangerous sweep that *activates* controls in a live session has no equivalent. **Until this exists, auto-explore is unsafe by construction and G1's readiness gate has nothing to gate on.**

---

## The 5 biggest wins

| # | Win | Lever | Dep |
|---|-----|-------|-----|
| **A** | **Destructive-action veto in the poke sweep** (SAFETY) | A shared `DESTRUCTIVE_LABEL` regex (centralize `DiscoveryService.DANGEROUS_LINK_TEXT`); veto in `isSafeToClick` *before* the disclosure/auth allowances (closes the `AUTH_TRIGGER` log-out hole); mirror into `planPageExploration` SKIP rules. Log every veto. | none — ship now |
| **B** | **Honest completeness signal** | `enumeratePage` truncates at `FEATURE_CAP=500` silently (7 sites); add a `capped` boolean to `meta` → `coverage.capped` in `buildLocale`. Pure observability — the "good-enough-to-build-on" gate's data source. | loose (G1 gate consumes it) |
| **C** | **Make `driftHash` an actual freshness check** | `driftHash` is computed in 2 places (locale.js:54, background.js:5299) but **never read** — write-only. Before the sweep, cheap-enumerate → hash → if it matches the cached Locale's `coverage.driftHash` and the cache is recent, **skip the sweep + LLM goal call**. Idempotence + drift detection for free. | skip-half none; stale-propagation needs G1 binding |
| **D** | **Stabilize feature ordering** | `buildIndex` (locale.js:63-73) pushes ids in unsorted iteration order → `synthesizeGoals` slices a non-deterministic catalog → different goals on the same page. One line: `for (const arr of Object.values(byKind)) arr.sort()`. Makes B + C honest (real drift vs order-noise). | none |
| **E** | **The auto-explore orchestrator shell** | The genuinely *missing subsystem*: relevance-pick (which page?) → idempotence gate (C) → safety arm (A) → existing `EXPLORE_PAGE_STRUCTURE` → good-enough gate (B). Assembly of A–D, not new capture. | **G1 auto-ground entrypoint** |

## The smallest end-to-end auto-explore slice (Win E)
```
ask → [G1] auto-ground → Ground + start URL
    → RELEVANCE PICK (score siteMap nodes by intent-token overlap; reuse Core/locale.js token helpers; ONE page, no crawl)
    → IDEMPOTENCE GATE (C: cheap enumerate→driftHash; match → return cached Locale, done)
    → SAFETY ARM (A: destructive veto ACTIVE; non-negotiable in unattended mode)
    → EXPLORE_PAGE_STRUCTURE (existing: L0 capped-honest → L1 vetoed poke → L2 deterministic goals → buildLocale+cache)
    → GOOD-ENOUGH GATE (B: PROCEED if !capped AND an intent-relevant goal exists; RETRY if capped; ABORT+REPORT if no relevant goal)
    → auto-build (GA-1..GA-8, assumed)
```
The three gates (safety / idempotence / good-enough) ARE the point of "unattended." Almost all of it reuses existing code; the only *new* code is the relevance scorer + the gate checks + the sequencer.

---

## Completeness-critic levers (the angles no finder took)
1. **Destructive-action veto** (= Win A) — the single biggest unattended risk.
2. **Relevance-targeted page selection** — nothing maps *ask → which page(s) to explore*; both entry points are intent-blind (current tab, or full-site crawl). A `pagesForAsk(siteMap, ask)` selector over the typed siteMap nodes.
3. **Locale-drift INVALIDATION + propagation** — freshness is TTL-only; on a `driftHash` change, *nothing* re-verifies the capabilities authored from the old Locale. Needs a Locale→capability dependency edge (recorded near the G1 groundId binding) → fire GA-3 `reverifyCapability`. *No backlog item covers this.*
4. **A Locale TRUST gate before authoring** — nothing scores the Locale *itself* (`aborted` recorded but never gates; null goals swallowed). A pure `localeTrust(model, structure)` from already-captured `structure.stats`. Auto-build on a half-explored page mints junk at scale.
5. **Cross-page LLM goal-synthesis cost** — 2 unconditional LLM calls per page, no archetype dedup or per-run budget; key goal-synthesis by `templatePattern` (one product page's goals ≈ all of them).
6. **Incremental / lazy explore** — all-or-nothing per page; explore only the region an ask needs (drive from `pathToGoal`); also shrinks the safety surface.
7. **Cross-archetype Locale reuse** — Locale cache keyed per-URL, siteMap per-archetype → every instance URL re-explores the same template. Key the Locale cache by `templatePattern`.
8. **SPA / infinite-scroll / auth-wall** — the nav-guard blackholes `pushState` (SPA depth invisible); fixed 16-step scroll truncates infinite feeds silently; a login wall gets modeled *as* the target archetype.

> **Cross-cutting:** levers 2, 5, 7 all want the same missing primitive — **the archetype as the unit of explore**. Levers 1 + 8 are the **safety floor**. Lever 4 is the **trust gate**, lever 3 the **invalidation loop**.

---

## Sequencing
- **Phase 0 — safety floor (ship first, no deps):** Win A (destructive veto + planner SKIP), Win D (one-line sort).
- **Phase 1 — honesty + freshness (no G1 dep; pure data):** Win B (capped flag), collection `medInteractive` passthrough, Win C (idempotence-skip half), 3 targeted `mergeDepthFromControls` tests.
- **Phase 2 — orchestrator shell (needs G1 + Phases 0–1):** Win E (relevance pick + 3 gates + sequencer; single page).
- **Phase 3 — scale + propagate (needs Phase 2 + G1 binding):** drift→dependent invalidation (critic #3), band-targeted re-explore, cross-archetype reuse + per-session LLM budget, auth-wall/infinite-scroll/SPA, Locale trust gate.

### De-scope / defer
- Shadow-DOM overlay-close piercing — instrument first (`'overlay-left-open'` exists), let live data decide.
- Downstream gates that *read* `coverage.capped` — dead code until Win E exists.
- Stale-propagation half of Win C — needs G1 binding (Phase 3).
- Generic crash tests for `mergeDepthFromControls` — replace with 3 production-risk tests (dedup merge, carousel filter, trigger-ID synth).

## File anchors
`ContentScripts/contentScript.js` (poke safety :4957, AUTH_TRIGGER :4950, pokeOpen :5016, swap-guard :5294, nav-guard :5101, scroll cap :5165, enumeratePage :3553 + FEATURE_CAP sites + meta :3832), `Core/locale.js` (buildLocale/coverage :31-60, buildIndex :63, driftHash :220, mergeDepthFromControls :258, dedupeOverlayLayers :356, deriveDisclosureGoals :445), `Services/DiscoveryService.js` (DANGEROUS_LINK_TEXT :49), `Services/AnthropicService.js` (synthesizeGoals :2308, planPageExploration SKIP :2206), `background.js` (EXPLORE_PAGE_STRUCTURE :5113, auto-build :5337, driftHash write :5299, _readLocaleCache :1270, siteMapFromLocale :5386), `Core/siteMap.js` (templatePattern), `Core/chromeHoist.js` (graftChromeDepth :195), `Core/locale.test.js` (test target).

## Status / backlog — EX-1 … EX-N
**Floor shipped — every auto-explore input now exists; EX-6 (orchestrator) is UNBLOCKED.**
- [x] **EX-1 / Win A** — destructive-action veto (SAFETY) — `63931a3` (v2.74.845)
- [x] **EX-2 / Win D** — `buildIndex` deterministic sort — `00d5e3d` (v2.74.846)
- [x] **EX-3 / Win B** — `capped` completeness signal — `00de0f8` (v2.74.847)
- [x] **EX-4 / Win C** — `driftHash` freshness-skip (`locale-fresh-skip`) — `c50b581` (v2.74.848)
- [x] **EX-5 / critic #4** — pure `localeTrust()` gate (stamped on `coverage.trust`) — `0dd6ad7` (v2.74.849)
- [x] **EX-6a / Win E (brain)** — pure `planAutoExplore` + `autoExploreVerdict` (`Core/autoExplore.js`) — `f5deedd` (v2.74.854)
- [ ] **EX-6b / Win E (glue)** — verify-live `AUTO_EXPLORE` handler: `ensureGroundForUrl` → `planAutoExplore` (read siteMap) → navigate tab → `EXPLORE_PAGE_STRUCTURE` → `autoExploreVerdict`. Needs a live browser run to verify (navigates the tab + runs the sweep unattended); requires making `EXPLORE_PAGE_STRUCTURE` internally callable.
- [x] **EX-7 / critic #2** — `pagesForAsk(siteMap, ask)` relevance selection — `0e01a44` (v2.74.850)
- [x] **G1-1** — `ensureGroundForUrl` auto-ground entrypoint (dedup-before-mint) — `2c101f9` (v2.74.851)
- [ ] **EX-8 / critic #5+#7** — archetype-keyed Locale + goal reuse / per-run LLM budget (Phase 3)
- [ ] **EX-9 / critic #3** — Locale-drift → dependent-capability re-verify (Phase 3, needs G1 binding)
- [ ] **EX-10 / critic #8** — SPA-route / infinite-scroll / auth-wall handling (Phase 3)
