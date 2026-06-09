# Automation Arc — Status at Pause

*Snapshot of the **ask → auto-ground → auto-explore → author** arc as of **v2.74.855** (2026-06-08).*

**State: PAUSED before wiring the unattended runner.** Every primitive the auto-explore orchestrator needs is built + tested; the decision was to **improve grounding quality first** (speed, dedup, a leaner demand-driven model) before turning on the unattended pipeline. Companion docs: `docs/grounding-authoring-roadmap.md` (GA + G1), `docs/explore-autoexplore-roadmap.md` (EX), `logs/run/findings.md` (live traces).

---

## ✅ Completed (shipped + pushed; Core suite 471 → 545, all green)

### Grounding-authoring floor (GA) — 7 of 8
| Slice | What | Commit · ver |
|---|---|---|
| GA-1 | `hierarchicalContext` captured at enumerate | `7c59dcb` · .838 |
| GA-2 | selector durability floor (`selectMostDurableUnique`) | `365434a` · .839 |
| GA-3 | `REVERIFY_SG_CAPABILITY` — re-trial trust score | `5954cdd` · .840 |
| GA-5 | conventions histogram → SG Select tie-break | `3a122cb` · .841 |
| GA-8 | write-time referential-integrity diagnostic | `6cda6d1` · .842 |
| GA-7 | Locale→capability authoring-coverage signal | `e852b1e` · .843 |
| GA-6 | structural-twin capability dedup (detection) | `ef04a39` · .844 |

### Explore floor (EX) — 1,2,3,4,5,7 + 6a
| Slice | What | Commit · ver |
|---|---|---|
| EX-1 | destructive-action veto in the poke sweep **[SAFETY]** | `63931a3` · .845 |
| EX-2 | deterministic feature ordering in `buildIndex` | `00d5e3d` · .846 |
| EX-3 | honest `capped` completeness signal | `00de0f8` · .847 |
| EX-4 | `driftHash` freshness-skip (`locale-fresh-skip`) | `c50b581` · .848 |
| EX-5 | pure `localeTrust()` authoring gate (`coverage.trust`) | `0dd6ad7` · .849 |
| EX-7 | `pagesForAsk(siteMap, ask)` relevance selector | `0e01a44` · .850 |
| EX-6a | pure orchestrator brain: `planAutoExplore` + `autoExploreVerdict` | `f5deedd` · .854 |

### G1 grounding foundation — COMPLETE
| Slice | What | Commit · ver |
|---|---|---|
| G1-1 | `ensureGroundForUrl` auto-ground entrypoint (dedup-before-mint) + `ENSURE_GROUND_FOR_URL` | `2c101f9` · .851 |
| G1-2 | bind Locale↔Ground (`buildLocale` stamps `groundId`) | `b4a5f3b` · .852 |
| G1-3 | Ground readiness gate (`empty\|preparing\|capable\|rich`) + `GET_GROUND_READINESS` | `a085569` · .853 |

### Grounding-quality fix
| | What | Commit · ver |
|---|---|---|
| — | `siteMapFromLocale` self-derives `{locale}` rules → multi-language dedup + fewer Explores | `2f34f5a` · .855 |

**Net:** the orchestrator has every input it needs — auto-ground (G1-1), relevance pick (EX-7), idempotence gate (EX-4), safety arm (EX-1), good-enough gate (EX-3/EX-5), and the pure decision brain (EX-6a). What's missing is only the verify-live glue (EX-6b).

---

## ⏸ Outstanding

### Paused — automation (resume AFTER grounding-quality)
- **EX-6b — verify-live `AUTO_EXPLORE` handler** (Task #162). The I/O glue over EX-6a: `ensureGroundForUrl` → read siteMap → `planAutoExplore` → navigate tab → `EXPLORE_PAGE_STRUCTURE` → `autoExploreVerdict`. Needs a **live browser run** to verify; requires extracting `EXPLORE_PAGE_STRUCTURE`'s body into an internally-callable fn. **Open scope decision:** stop-at-verdict vs auto-reexplore-on-insufficient vs chain into auto-authoring.

### New priority — grounding quality (from the "before automating, make this better" discussion)
- **G2 — two-speed / demand-driven grounding** (Task created). The model the user's 3 claims imply, *not yet built*:
  - **Cheap eager BREADTH** — sitemap.xml + link map, archetype-collapsed, **no Explore** — for routing + a completeness hedge.
  - **Lazy expensive DEPTH** — Explore + capture — only along archetypes a real ask touches.
  - **Hotpath = archetypes realized asks land on** (derive from asks + terminal value, *not* a fixed list).
  - **Capability surface = two tiers:** *verified* (captured intents) over *proposed* (locale goals), always carrying "unmapped ⇒ unknown, not impossible."
  - *The shared counter-argument to all three claims is cold-start/routing/completeness — a purely lazy ground can't route or answer "what's possible" until it has seen something, so the cheap-breadth layer is the non-optional half.*
- **Locale re-template heal** (Task created). Today's `.855` fix collapses languages going forward, but a `{locale}` rule that emerges *after* a node was already modeled doesn't re-key the earlier split node → existing duplicated grounds don't self-heal (re-Exploring fixes them). Needs a re-template/re-key pass in `mergeSiteMap`.

### Observability (from `gl`)
- **`_DECISION_RE` blind to this arc** (Task created). The Decisions log download (`studio.js` `_DECISION_RE`) matches none of the new markers (`locale-fresh-skip`, `locale-trust`, `EXPLORE_PAGE_STRUCTURE`, `ensureGroundForUrl`, `GET_GROUND_READINESS`) → a `-decisions-` `gl` can't see EX/G1 behavior at all. ~1-line fix; do before the next test pass.

### Deferred / backlog (recorded in the roadmaps)
- **GA-4** — pending-review lifecycle + arm guard (Task #146). Deferred: the terminal descriptor is data-only (`armed:false`, no terminal-fire path to guard) — build alongside the irreversible-terminal arming feature.
- **EX-8** — archetype-keyed Locale + goal reuse + per-run LLM budget (cost; Phase 3). *Overlaps heavily with G2.*
- **EX-9** — Locale-drift → dependent-capability re-verify. Now unblocked (the G1-2 `groundId` edge exists); fire `REVERIFY_SG_CAPABILITY` on a `driftHash` change.
- **EX-10** — SPA-route / infinite-scroll / auth-wall handling (Phase 3).
- **Read-singularization** — a "first/the «singular»" ask returns a full list observation (145 items) instead of `item[0]`. Pre-existing, separate from this arc (see `findings.md` 21:16).

---

## Strategic note — the grounding re-think (recorded verbatim intent)
The user's three claims, pressure-tested both ways (full for/against in the chat), net out to:
1. *"The whole ground needn't be mapped ahead of authoring"* — **right about depth, not breadth.** Skip eager Explore; keep cheap eager link/sitemap breadth (it's what enables routing + cross-page planning).
2. *"Page types should be prioritized — a hotpath"* — **yes, by archetype; but derive the hotpath from observed asks + terminal value, never a static list** (hot ≠ important; the once-per-task apply/checkout page is the point).
3. *"What's possible = locales + captured intents"* — **true if split into verified (intents) vs proposed (locale goals) tiers, with an epistemic hedge for the unmapped** — else a bounded, decaying, *proposed* surface reads as a complete, current, *verified* one.

These converge on **G2 (two-speed grounding)** as the next build once the user resumes.
