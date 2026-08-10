# BUILD ARC — the sequenced plan after the pause arc (specced 2026-08-07; adversarially reviewed same day, 3 lenses — the v1 draft's invented SGV coupling, misplaced metrics rung, false §12.6 citation, and three seam-readiness overclaims are corrected below)

**Where this picks up:** `848ada5 v2.74.2061` landed the pause-first stopping model (§12, WFP-1..5,
live-confirmed) plus the card captions. Three build-ready items are open on the user's word — WFP-6, WFG-1e,
SGV — and a longer owed list sits behind them. This doc is the ORDER with the dependency logic stated. Where it
adds contract text of its own (it does, twice — marked **[arc-owned]**), that is this doc's design to defend,
not a citation.

**Sibling arc:** `docs/BUILD_ARC_exec_channel.md` sequences the remote-exerciser work specced in
`DESIGN_exec_channel.md`. No shared *rungs* — but **one shared directory**: both arcs write in
`background/handlers/` (rung 1 below edits `cadence.js`; the exec arc adds `exec.js`). Different files, so
`git add` by name separates them cleanly, but a lane running both at once must not `git add -A`. Everything else
is disjoint (`orchard-cloud`, `Core/execCommand.js`, `tools/`). *(Corrected 2026-08-08 — the first version of
this line claimed the surfaces were fully disjoint, which was wrong.)*

**The organizing principle:** cheapest-and-closing first, the governor last-and-largest — because the pause arc
already broke ground on the seams SGV-1 needs (stated precisely in rung 5, with the overclaims from review
removed). The arc's destination is the iron principle — *"Orchard fails if the user becomes a state manager"* —
enforced at the end by REMOVAL (SGV-4 deletes the Connect chore).

---

## Rung 1 — WFP-6: headless ⏸ (DESIGN_workflows.md §12.9)

**What:** a run-state broadcast from `_fire` (start/end; the §12.9 row names `WORKFLOW_RUN_STATE` — **payload
shape and emission points are WFP-6's contract to write at build**, they are not yet specced) → the Automate
card renders a running state for cadence fires (attribute named at build; precedent: `data-run-state` on the
run button, `data-paused` on the card — nothing called `data-running` exists) → ⏸ latches
`cadence:pause:<runId>` (own key, runId-scoped — the marker-overwrite lesson) → a **net-new** `shouldPause` opt
polled at `runWorkflow`'s clause boundaries (clause-only; the duplicate-write rule; note `shouldStop` was never
built — abort was de-scoped in §12.7, so this is the FIRST run-level poll through runDriver) → pause exits
through the park path with a `pauseCause` on the result.

**Honest sizing (review):** the SW park path hardcodes the GATE story at three sites that must all become
cause-aware — the history why (cadence.js:353), the park record's kind/tier stamp (:367), and
`_cadencePresence` (:336), which per §12.5's table must fire **neither** badge nor OS notification for a pause.
Still ~1 day, but that day includes those four seams, not just a broadcast.

**Why first:** the smallest open rung, and it CLOSES §12 — the pause arc ships whole. (The v1 draft also
claimed SGV reuses the broadcast; review confirmed nothing in the SGV spec consumes a run-state signal — its
nudges read the blocked store, Door A gates on the fire *result*, pulses gate on `userActiveOn`. The claim is
withdrawn; rung 1 stands on size and closure alone.)

**Verify:** bus test, `[human]`: schedule a 3+-step workflow, let it fire headless, ⏸ from the card, ▶ resume —
the retired panel test's arms, SW tier.

## Rung 2 — WFG-1e: editing after creation (DESIGN_workflows.md §11)

**What:** ✎ opens the BUILDER pre-loaded (`draftId → updateWorkflow`, the WW-1b draft-resume path made
explicit); slim-B in-place rename/remove/reorder in the pinned detail; partial re-proof saves as `draft`.

**The no-edit guard [arc-owned contract — §11 only says "no edits while a run is parked or in flight"; the
store-level formula below is this doc's, and should be folded INTO §11 at build]:** ✎ disables when ANY of
THREE sources says the workflow is busy — (a) an open park (`cadence:parked:*`, either kind — a paused park has
NO ✋ row after the §12.5 card ruling, so a literal "open ✋" reading would miss it), (b) the SW run marker
(`cadence:run:<wfId>` — headless in flight), (c) **a live PANEL run** — which stamps no durable marker at all
(review: the run marker is SW-written only), so the guard's third source is panel-local: the card's
`data-run-state`/busy fence. Two stores + one local check, or the guard is blind to exactly the
highest-risk case (§11's own corruption scenario is a panel run).

**Why second:** independent of SGV (no shared seams), user-facing, ~1 day; the parked stores, `_hasOpenPark`,
and the ▶-gating pattern all exist at HEAD (verified). Building it after the pause arc means the guard is real
on day one.

**Verify:** bus test, `[human]`: rename in place (id survives → schedule/history intact), ✎ a step through the
builder (re-proof), attempt ✎ on a paused AND on a mid-run workflow (guard refuses, names why).

## Rung 3 — SGV expansion pass (DESIGN_session_governor.md §11.0, the R4 prerequisite)

Doc-only — inline every "as prior"/"as before" compression in the SGV spec before SGV-0. The v1.4 seal records
this spec once losing machinery to its own compression; R4 made expansion a build GATE. (This arc doc's own
review caught a false citation and a nonexistent attribute name — the compression-failure class is alive; the
gate earns its place.)

## Rung 4 — SGV-0: the planner, inert (DESIGN_session_governor.md §11.1)

**What:** `Core/sessionGovernor.js` — pure plan function (snapshot → `{heals≤3, dueNudges≤1, chainResumes≤1,
llmCalls≤1, interrupts≤1}`), tickLedger, activeAsks bookkeeping — wired into `vitals:tick` as a NO-OP apply:
plans logged as `SGV ▸` lines, nothing executed. **Plus the §10 v1.14 observability FLOOR (the O1–O6 addendum,
2026-08-07 gap analysis), whose SGV-0 deliverables are:** `SGV ▸` registered in `Core/decisionMarkers.js` FIRST
(invariant #1 on the fleet pipe — unregistered lines are dropped before the hour-files; the soak would grade
nothing) · the **O1 tick heartbeat** (`SGV ▸ tick demands=N planned=M deferred=K`, empty plans included — dead
vs quiet must differ) · the **O2 baseline capture** (`sgv:baseline`, 7d presence-fail count + denominators —
"≤50% of baseline" is ungradeable without it) · the **O4 soak FAIL arms** as a bus test (focus-while-active /
cap-exceeded / heal-without-demand / two-heals-one-origin = FAIL). The O3/O5/O6 witness lines (steal-refused,
suppressed, block-opened, verify outcomes, pulse-response) land with the behaviors they witness at SGV-1/2.

**Metrics placement (review correction):** the §10 metrics wire onto the glf bus **at SGV-1, as the spec's
build order says** — the v1 draft moved them to SGV-0, but two of the three pass-bar arms cannot produce data
before SGV-1 exists (`presence_fail_runs` dedups per-incident, and incidents are minted by Door A/B). Rung 4's
soak is graded the gl way: eyeballing `SGV ▸` plan lines in fleet hour-files against what a human would have
planned — vitals ticks every 20 min ≈ 72 plans/day, and the ring survives the loop's gappy duty cycle.

**Why before SGV-1:** the planner gets judged against real fleet traffic BEFORE it gains hands — the trial-gate
ratchet applied to the governor itself.

## Rung 5 — SGV-1: the presence pipe (the big rung)

**What (§5 whole):** PresenceCtx on step+fire results · `presenceStop` · the block predicate + token binding ·
fail→block (Door A/B) · origin-scoped fire-hold until ack · MARK_RAN discipline · nudge/resume-ack · toast+badge
suppression for presence blocks · **the §10 metrics onto the bus (from rung 4's correction)** · **the O3/O5
witness lines with their behaviors** (`block-opened` at every Door upsert, `steal-refused`/`suppressed` at each
gate refusal and §5h suppression, `verify ok|fail|timeout` grammar — required silence must be greppable, never
inferred from absence). O6 `pulse-response` lands with SGV-2's pulses.

**Seam readiness, stated honestly (review corrected three overclaims):**
- The chain return contract `{paused|aborted|done}` EXISTS and all three `_wfReplayPlan` launchers now branch
  on it (the card ▶ since WFP; the thread-replay ▶ fixed during THIS review — it had discarded the result, so
  an aborted replay recorded a positional verdict). But the contract is produced at **three typed return sites
  while ~18 failure/finalize exits still return `undefined`** — and §5g's whole point is that auth-stops must
  not be undefined-indistinguishable-from-success. SGV-1's real work here is CONVERTING those exits to typed
  returns; the pause arc built the pattern and the callers, not the coverage.
- `autoHeld` (§5d) and WFP-5's park-open checks are **adjacent, not one predicate**: their door sets intersect
  only at due-on-open. Park checks gate parks at three doors including the human ▶ (resume/refuse routing);
  `autoHeld` holds blocks at the two AUTO doors (SW scan + due-on-open) and **deliberately leaves the human ▶
  open — it IS the ack path**. An implementer who merges them breaks §5d's resume-ack design. What the pause
  arc contributes is the pattern (kind-aware records, doors that consult a store, ack-clears semantics), not a
  shared predicate.

**Verify:** the §10 bus tests go live here; plus `[human]`: sign out of a ground, let a scheduled run hit the
wall — ONE blocked case, held schedule, no failure strike, no OS spam; sign back in → resume-ack.

## Rung 6+ — SGV-1b → 2 → 3 → 4, each gated on the previous rung's live pass

ChainPark (SGV-1b) · interrupts+pulse (SGV-2, presence-gated, quiet-hours) · drive assist + UrlClass + fenced
LLM pack (SGV-3) · **SGV-4: retire the Connect chore** *(user-facing half LANDED EARLY at v2.74.2076/e21da47 by user direction — dev render retained; pulses re-point waits on SGV-2)* — the scoped teardown (R3 inventory) that deletes the
user-facing state-manager surface. The arc's finish line.

---

## Parked, with re-open triggers (corrected per review — two rows previously parked the wrong thing)

| Item | Actual state | Trigger to re-open |
|---|---|---|
| Privacy: **flip R-4's default + live-verify + `<RECORD>`/`<FINDINGS>` minimization** (DESIGN_llm_privacy.md) | R-1..R-4 are BUILT (v2.74.1662-1663, `Core/redact.js`, `#post` boundary); R-4 ships DEFAULT OFF — the redactor exists, its posture is what's owed | before fleet growth past friendly installs, or any egress of a NEW content class (v2061's workflow-blurb was audited: user's-own-ask class, no trip) |
| Global panic key + `WORKFLOW_ABORT_RUN` fan-out | de-scoped in §12.7 | the background-agents roster arc |
| VT-5 (op-bank class) | gated | after SH-T4, by dependency (DESIGN_vitals.md §10) |
| VT-6 drive · VT-7 broker bindings | pending, NO SH-T4 gate | value call, after VT-5 or independently |
| TR-2 desk-first flip, TR-5/6 affinity | built, unflipped | grade live `TARGET ▸` disagreement lines first |
| RH-1b..1d route-heal loop | built | its LIVE PASS is owed, not its build |
| Per-item BRANCH/UPSERT primitives | unbuilt | the next per-item workflow that needs the shape |
| AL-1..6 apps-learning · CV-3 conversations | specced | user's call — layer above this arc |

**Discipline per rung (unchanged):** bus test with `[human]` checklist written AT BUILD TIME · adversarial
verify before land · findings entry + digest at pass-end · version-at-land numbering · SW-side changes honestly
reported as check/undef-proven until the live pass.
