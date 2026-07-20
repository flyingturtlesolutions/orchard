# DESIGN — the ＋ Workflow wizard & routines as first-class desk objects (WW / RT)

Status: **spec v1** (user-ruled 2026-07-19; supersedes the predictive-qualification sketch).
Entry points: the launch page's **＋ Workflow** card · `new workflow` command. Companion surfaces: the `workflows`
view (WF-2), the desk launch page (DL-1, proven-cards-only), the routine clock (FLEET_ROUTINE → remodeled here).

## 0. The three rulings this spec is built on (user, verbatim-shaped)

1. **Qualification is EMPIRICAL.** A step is proposed and then RUN for a result — never graded by prediction.
   Ran-to-completion → the user approves or declines the RESULT; approve = the step is BANKED; decline = "show
   me" (a demonstration capturing BOTH drive and ride legs) → reattempt. Transient failure (auth …) → reason +
   reattempt prompt. Can't engage (missing leg …) → "show me" → reattempt.
2. **Schedules may include writes — human-approval-gated.** A scheduled run executes to the write step and
   PARKS there until approved (e.g. the tracking-number poller: checks on cadence; when the number appears it
   parks at "update the document" until the human approves). The §9 confirm gate is never bypassed — the
   schedule just delivers the run TO the gate.
3. **Routines are first-class desk objects** (like seeds) — N per desk, each keyed to a `workflowId`; seeds STOP
   declaring routines. Open question answered in §5: do all clocked behaviors (vitals checks included) inherit
   from the same class?

## 1. Why the empirical model is right for this codebase

The house gate is trial-as-proof (PB-5, SG-T2-ACC, the RH-1d verify): nothing is believed until it has run.
Static ✓/◐/✗ badges would have re-introduced prediction at exactly the layer the system exists to de-risk.
Consequences that fall out for free:

- **The wizard's qualification pass IS the chain's first supervised run.** Steps run in order, in the desk's
  conversation, so cross-step context (HS-2 scope wiring, conversation focus) accrues exactly as a replay would
  see it. No separate "final run" is needed — "run and save" is inherent.
- **Banked = proven.** The launch page's proven-cards-only rule holds with zero exceptions.
- **The alias flywheel does the hard-binding.** Each approved step's run banks its phrase→capability alias, so
  replays go warm/deterministic automatically. The workflow record still replays step TEXT through the full
  router (self-healing on drift) — provenance is recorded for display, never as a rigid binding.

## 2. WW — the wizard (stages)

Transient one-on-screen card flow, the OV-5c `add leg` pattern (`_wfWizardMsg`; a surface change drops it).

**Stage 1 — CAPTURE.** Name (optional; suggested at save) + the step list: one natural-language step per row
(add / edit / reorder / remove). Seeding shortcuts: "use the steps from my last run" (the last chain's clauses).

**Stage 2 — QUALIFY = RUN, step by step.** For the current step:
1. Dispatch it through the NORMAL front door (the same pipeline as typing it — invariant #4 claims at entry;
   the wizard adds a per-step ATTEMPT frame with the outcome buttons).
2. Outcome ladder (user ruling #1):
   - **Completed** → the result renders as usual → `✓ Looks right` / `✗ Not right`.
     - Approve → step banked (`{text, via: {kind, host, name} snapshot, bankedAt}`) → next step.
     - Decline → **Show me** → the demonstration path with BOTH capture classes armed: the OBS recorder for
       drive (clicks/typing → a taught capability) and the §17 FORAGE tee for rides (API reads harvested) —
       the RH-1b relearn-bar precedent. Demonstration ends → REATTEMPT the step → back to the approve gate.
   - **Transient failure** (the vitals classifier's auth vocabulary: signed-out / session-expired / csrf-not-
     ready …) → friendly reason (chatVoice) + `Sign in & retry` / `Retry` / `Skip for now`.
   - **Can't engage** (honest-gap: no leg, op-not-captured, named-system fence, no candidate) → **Show me** →
     teach → reattempt.
3. A write step during qualification confirms INTERACTIVELY as normal (§9 unchanged — the human is present).
4. `Skip for now` marks the step unproven; a workflow with unproven steps can be saved as **draft** but never
   shows on the launch page and cannot take a cadence (proven-only, both).

**Stage 3 — CADENCE (optional).** "Run this every …" (minutes/hours/daily). Creates a ROUTINE object (§4)
bound to the saved workflowId. Writes allowed under the parked model (§4.3). Default: no cadence.

**Stage 4 — SAVE.** Every step banked → `saveWorkflow(appId, {name, ask, subAsks, steps: provenance, qualifiedAt})`
(WF-1 store, additive fields) → the launch-page card + the `workflows` view. The trigger `ask` defaults to the
name (workflowMatch recall unchanged).

## 3. Step outcome classification (pure, tested)

`Core/workflowWizard.js` — `classifyStepOutcome({ok, error, status, declined, gapKind})` →
`'banked-pending-approval' | 'transient' | 'cant-engage' | 'hard-fail'`, reusing the vitals auth vocabulary
(`rideOutcomeSignal`) for the transient class and the router's honest-gap markers for can't-engage. The wizard
STATE MACHINE (capture → per-step attempt/approve/teach/reattempt → cadence → save) is pure and tested too;
chat.js renders it (the deskLanding.js pattern: logic in Core, DOM in the panel).

## 4. RT — routines as first-class desk objects

### 4.1 The store remodel
`routines:<instanceId>` becomes a LIST: `[{ id, workflowId, minutes, enabled, source: 'user'|'system',
declaredAt, lastFiredAt, due, parkedRunId: null }]`. Replaces FLEET_ROUTINE's single `{minutes, ask}` record.
Migration: an existing record becomes one list entry (its bare `ask` wrapped as a 1-step workflow so everything
is workflowId-keyed). **Seeds stop declaring routines** (ruling #3): the seed-directive routine parsing is
removed; an existing seed-owned routine migrates to a `source:'user'` object once, with a one-line notice.

### 4.2 Firing (the DK-8 model, N-ified)
One alarm per routine id → fire marks `due` → desk-open (and panel-boot for the current desk) runs due
routines' chains through `_orchRunChain` — the full pipeline, honestly PANEL-TIER (the pipeline lives in the
panel; a due routine waits for the desk like today). The routine row shows "due — opens with the desk".

### 4.3 Parked writes (ruling #2)
The §9 write gate, made schedule-shaped: when a scheduled (non-interactive) run reaches a write step, it
PARKS — persist `{runId, workflowId, stepIndex, chainState, writePreview}` — and surfaces as a CASE under the
desk (`wfp_<runId>`, the VT-2b incident-case pattern: Rail child + a card holding the write PREVIEW with
`Approve & continue` / `Cancel run`). Approve resumes via `_orchRunChain({startIndex, state})` (both params
already exist); the write then executes through the normal confirmed path. Cancel logs and closes the case.
An interactive (user-clicked) run never parks — the confirm bar renders live as today.

### 4.4 Surfaces
`routines` command + a block in the desk's `workflows` view: per routine — workflow name · cadence · armed
toggle · last fired · parked badge. The launch page may later show "runs every 4h" on the workflow card (sub
line, no new card kind).

## 5. The unification question: are vitals checks "just another workflow"?

**Answer: one CLASS, two EXECUTION TIERS — unify the model, not the runtime (yet).**

- The Routine RECORD/lifecycle/surface is one class for everything clocked. Vitals' clocks (the tick's presence
  sweep, the daily visit, keep-alive) REGISTER as `source:'system'` routines on the Admin desk — visible in the
  same list, same vocabulary ("every 20m · last fired 3m ago"), read-mostly (enable/disable where the vitals
  settings already allow it).
- The EXECUTORS stay two, because the difference is real and shouldn't be papered over: system routines run
  SW-NATIVE (headless — alarms fire in the service worker; canaries ride INVOKE_SESSION from there), while user
  workflows need the PANEL pipeline (router/interpret/chain live in chat.js — the DK-8 "due, fires on open"
  model). Pretending one executor exists would make scheduled workflows silently fail with the panel closed.
- **The graduation path (recorded, not built):** a workflow whose every banked step resolved to a ride LEG
  (no walks, no LLM synthesis) is in principle SW-executable — the daily canary already proves the pattern.
  Such workflows could later run tier-'sw' headless, parking writes exactly as §4.3. That is the honest route
  to "vitals checks are just another workflow" becoming literally true.

## 6. Safety notes (nothing new opens)

- The schedule NEVER bypasses §9: a parked run is the confirm gate waiting for its human. Money/inventory
  stay human-click-only regardless (§4 hard lines untouched).
- Wizard attempts are real runs through the existing belts (arm guard, read-only re-validation, the fence).
- "Show me" reuses the consent-shaped capture flows verbatim (OBS recorder; FORAGE arm states the tab reload).
- Parked-write previews render body-MINIMAL (the §9 preview discipline) on the escape-first path.

## 7. Build ladder

- **WW-1** — wizard stages 1+2+4: capture → empirical per-step qualify (approve/decline/show-me/reattempt) →
  save. Pure state machine + outcome classifier in Core (tested); no cadence yet.
- **RT-0** — routine store remodel (list, workflowId-keyed) + FLEET_ROUTINE door widened + migration.
- **RT-1** — seeds stop declaring routines (directive parsing removed; one-time migration notice).
- **WW-2** — wizard stage 3 (cadence) binding to RT-0 objects; `routines` surface.
- **RT-2** — N-routine firing via the due model.
- **RT-3** — parked writes as `wfp_` cases (chain park/resume; the case card with preview + approve).
- **RT-4** — vitals clocks registered as visible `source:'system'` routines on the Admin desk.

Livability checkpoints: after WW-1 the ＋ Workflow card is real end-to-end (build → prove → save → launch-page
card runs it); after RT-3 the tracking-number example works exactly as ruled.

## 8. Lessons inherited from the drive-workflow history (binding on WW/RT)

Mined 2026-07-19 from Core/workflows.js, specs/TIER_MODEL.md, docs/automation-arc-status.md, the chain runner,
and findings.md LESSON lines — the constraints below are load-bearing, not commentary.

1. **Compose from INTENT, never from structure.** The v488-era Core/workflows.js composed journeys bottom-up
   from the siteMap graph (nav edges, archetype paths). It shipped, works, and nothing user-facing consumes it —
   the workflows users actually run are ASK-CHAINS (text steps through the router), because asks self-heal
   (re-route on drift) where graph-bound compositions calcify. WW steps stay natural-language asks; structure
   is the EXECUTOR's per-step concern. Never resurrect graph-composed workflows as a user surface.
2. **Name tiers precisely at birth.** The "Workflow" noun in Core/workflows.js was wrong on day one (it builds
   T2 Strategies — TIER_MODEL stratifies by SITE SCOPE, not page count); the cost was a 7-agent audit (v778),
   an entityKind inversion fix, and a rename debt still deferred. Here: "workflow" = the user's saved ask-chain
   (WF-1, `il:workflows:*`), "routine" = a clocked binding to one. NOTE the live surface collision: the T3
   structural store is ALSO `workflows:*` (Studio picker) — two "workflows" vocabularies; don't worsen it, and
   label the Studio one "site journeys" when next touched.
3. **Layers bind to the executor CONTRACT, not the discovering call site** (findings L3012; Invariant #2's
   generalization — busy-marking was discovered one emitter at a time, INVOKE_WORKFLOW fourth). The wizard adds
   NO step-execution wrapper: attempts dispatch through the normal front door; parked resume re-enters through
   `_orchRunChain({startIndex, state})` — never a bespoke resumer. (Verify at RT-2 build: the routine-fire path
   inherits busy-marking because it reuses the same dispatch — confirm, don't assume.)
4. **Every loop gets a budget and a working stop** (#189 foreach budget, CR-E4 cap, CR-S1/S2 liveness+abort).
   The wizard's teach→reattempt cycle caps (3 per step, then "skip or keep teaching" honestly); wizard runs and
   routine-fired chains register with the stop machinery (the chain runner already does — keep it that way).
5. **A turn-based agent is not a daemon; durable state lives in durable artifacts** (findings L809 + L808 —
   both learned bloodily in the dev-bridge arc). Cadence = alarms + due-marking, never a held loop; a parked
   run's ENTIRE resume state persists (`{runId, stepIndex, chainState, writePreview}`), because the panel dies.
6. **Success = an observable effect** (SG-T2-2/T2-9 postconditions). The wizard's approve gate is the HUMAN
   postcondition; scheduled replays lean on the same observable outcomes (leg JSON ok / walk postconditions),
   and a scheduled failure leaves a LEGIBLE run record (chatVoice lines in the case card — findings L1963:
   diagnostic detail must reach the eyeball, not die in the envelope).
7. **Cross-step value flow is the chain's real product** (HS-2; findings L3714: the row you click after
   searching X is "the row containing X" — parameterize by REUSING the upstream param, never the demonstrated
   position). Qualification runs steps IN SEQUENCE IN the desk conversation so scope wiring accrues exactly as
   replay sees it; a step taught mid-wizard generalizes its params against upstream values before banking.
8. **Demo quality is the capability ceiling** (findings L1235): the "show me" prompt nudges a minimal, direct
   demonstration — a wandering demo bakes wandering in.
9. **Settle is a step** (SG-T2-4/T2-8): a reattempt after teaching re-settles the tab first — never replay
   into the DOM the failure left behind.
10. **Scheduled runs can't spend user gestures** (findings L880: user-activation is unfakeable). Anything
    gesture-privileged parks for a real click — which the §4.3 Approve button IS.
11. **Automation waited for substrate quality ON PURPOSE** (automation-arc-status v855: every primitive built,
    the unattended runner deliberately unwired until grounding improved). The empirical-qualification ruling is
    the same judgment: only proven chains reach a clock; the panel-tier limitation stays stated, never papered.

## 9. Sizing: what the tiers teach about step and workflow length

**A wizard STEP ≅ one Tier-2 Strategy: ONE intent, ONE system, ONE reviewable result.** T1 is the wrong level
for a step — but it defines the step's INTERNAL grammar; T3 composition bounds the workflow's length.

PRECISION (user-probed): the target is a HARD boundary (crossing sites always splits — routing is per-target,
park/resume works only between steps, aliases bank per-target, and the X→Y value handoff exists ONLY at the
chain seam). But same-site ≠ same-step: a Ground hosts many Strategies — two separately-reviewable results on
one site are two steps ("get my open tasks" + "export them to CSV"); actions on the way to one result are one
step ("open the filter, pick Atlanta, apply" = "filter to Atlanta"). Litmus: "is there ONE result I could look
at and approve?" Both boundaries self-enforce: two targets → the resolver split-suggestion; two intents → the
front door would DECOMPOSE the text (that decompose verdict is the capture-time split cue).

**From T1 (Fragments) — the internal grammar, not the step unit:**
- The segmenter's rule (Core/observedSegment.js): a unit = the actions that CAUSED one world-state transition;
  the boundary is LOGICAL (an SPA settle counts like a navigation). Action count is noise — preclean drops
  focus clicks; coalesce merges keystrokes. "Open the filter, pick Atlanta, apply" is ONE fragment.
- Form atomicity (SG-RES-5: a submit pulls its inputs), option-groups (7d), and reveal boundaries (7f: a unit
  never reaches across a disclosure) all say: the atom is the smallest POSTCONDITION-VERIFIABLE unit.
- Why a step can't be T1-sized: a fragment has no HUMAN-reviewable result — "the dropdown opened" cannot be
  approved. The empirical gate structurally enforces T2 sizing: you can only approve what produces a result.

**From T2 (Strategies) — the step unit:**
- TIER_MODEL: a Strategy = one user intent WITHIN one Ground; crossing Locales is internal (navigate nodes).
  Mapped: a step's TEXT stays intent-sized; multi-page complexity (settle, phases, per-phase postconditions —
  SG-T2-4/8/9) belongs to the EXECUTOR, invisible in the step list.
- The T2→T3 boundary IS the step boundary: crossing SYSTEMS = crossing steps. "Get vendorsuite tasks and check
  each in shopify" is two steps. Enforcement is deterministic and already built: TARGET_RESOLVE per step; two
  explicit system tokens in one step → the wizard suggests a split (one vocabulary — the v1598 rule).
- The alias/capability flywheel is T2-sized (one ask ↔ one capability): T2-sized steps are exactly what banks,
  aliases, and replays cleanly. T1-sized steps would bank noise; T3-sized steps match nothing.

**From T3 + the chain runner — workflow length:**
- The chain's scope wiring is a ONE-VALUE PIPE (`st.lastValue`/`lastLeg`): a step consumes the IMMEDIATELY
  PRIOR read. Distant dependencies (step 6 needs step 1's list) exceed the wiring today — the honest length
  rule is: dependencies adjacent, workflows short. SOFT CAP ~6 steps, with this stated as the reason; beyond
  it the wizard suggests two workflows (or a fan-out).
- Loops NEVER unroll into steps: "foreach division …" is ONE clause (the each-mode/fan-out primitive, budgeted
  — #189/CR-E4). Length is measured in INTENTS, not iterations.
- Even the structural T3 era bounded composition (maxDepth/maxPaths on journey search) — unbounded chains were
  never believed. Partial-failure surface grows with length; park/resume (§4.3) makes mid-chain stops normal,
  but shorter chains orphan fewer halves.

**Wizard rules encoded from this:**
1. Step copy nudges intent phrasing ("one step = one result you could look at"); micro-steps also FAIL the
   approve gate naturally (nothing to review) — the gate self-teaches sizing.
2. One system per step; resolver-backed split suggestion on a two-system step.
3. Loops inside steps via the foreach grammar; never unrolled; budget inherited.
4. Soft cap ~6 steps (the one-value-pipe reason, said plainly); suggest splitting beyond.
5. Teach-time compression: a "show me" demo banks a capability sized to the STEP's intent — the segmenter's
   preclean/coalesce already strips the wander (L1235's mitigation, mechanical).

## 10. Underspecified — the critical pass (2026-07-19; resolve before/while building)

### A. Contract gaps that BLOCK WW-1

1. **The ATTEMPT ENVELOPE does not exist.** "Dispatch through the normal front door" and "receive a
   machine-readable outcome" are contradictory today: `sendChatMessage` is fire-and-render (returns nothing);
   outcome shapes differ per path (connector `{success,error,status,hint}` · walk verdicts · IL prose · the
   named-system fence AND `rp.error` both return bare `false` — indistinguishable). `classifyStepOutcome`'s
   inputs (`gapKind`, `declined`) exist today only as rendered strings/log lines (the L1963 class). WW-1's
   real engineering: a structured attempt outcome AT the dispatch contract (L3012), not a wizard-side scrape.
2. **Result attribution.** A step's result may span several bubbles (progress + result + bars; fan-outs spawn
   children; broadcasts interleave vitals cards). Which rendered thing does Approve/Decline attach to?
3. **Attempt echo semantics.** Via sendChatMessage, every attempt/reattempt persists a USER message (invariant
   #4 echo) — transcript noise, and it flips the DL launch-state gate. Not via it — "same pipeline as typing"
   stops being literal. Pick one; specify what attempts look like in the transcript.
4. **Teach-target derivation.** "Show me" needs `{groundId, tabId}` (recorder) + host (FORAGE arm) — but a
   can't-engage step often failed BECAUSE no target resolved. Derivation order (TARGET_RESOLVE host →
   ENSURE_GROUND_FOR_URL → open/ensure tab) is unspecified.
5. **Review-state of teach products.** The §18 arm guard blocks `pending` records (GA-4 lifecycle is literally
   still open). Is an OBS-derived capability / just-harvested leg ARMED for the immediate reattempt, or does
   the loop deadlock on recipe-not-armable? Unverified — must be pinned with code, not assumption.
6. **Wizard persistence + modality.** `_addLegMsg` precedent: dropped on surface change (banked progress lost?).
   `_setupState` precedent: persisted across reloads + modal typed-answer intercepts. Which model — and may the
   user interleave normal asks mid-wizard (breaks #2's attribution)?
7. **Store contract breaks (VERIFIED).** `normalizeWorkflow` (a) strips unknown fields — `steps`/`qualifiedAt`/
   `draft` die at save (the invariant-#3 class, caught pre-build); (b) rejects `subAsks.length < 2` — a
   one-step workflow (a legitimate scheduled check) cannot exist. Both need Core/workflowMemory changes.

### B. Correctness / safety gaps

8. **Write steps DOUBLE-EXECUTE in qualification.** Decline-after-a-write → teach → reattempt performs the
   write again (a

## 11. Resolutions (spec v2 — user-approved 2026-07-19; supersedes earlier text where noted; resolves §10)

The critical pass found the spec assumed each primitive was more general than it is. Five decisions close all
eleven gaps; each pulls the design toward what the primitive actually guarantees.

### 10.A — WorkflowStore: split the id, extend the whitelist *(amends §2.4, §3, §4.1; gaps #1,#4)*
- The record carries TWO ids: a stable surrogate `id` (minted ONCE at creation, never recomputed) and
  `contentId = workflowId(ask, subAsks)` (the existing hash — used ONLY for rebank-dedup). **Routines bind the
  surrogate `id`**; editing steps changes `contentId`, not `id`, so a bound routine survives an edit.
- Add `updateWorkflow(appId, id, patch)` (preserve `id`; replace `subAsks`/`steps`/`contentId`; bump
  `updatedAt`). Wizard "edit" → update; "new" → fresh surrogate. Dedup in `saveWorkflow` keys on `contentId`.
- `normalizeWorkflow` STAYS A WHITELIST (a safety property — trusted config, no page content; a syncable record
  must never spread `...r`). Extend it with three TYPE-GUARDED fields: `steps` (provenance array), `status`
  ('ready'|'draft'), `qualifiedAt`. **Provenance is BODY-BLIND** — `{text, via:{kind,host,name}, bankedAt}`,
  never a captured value (the record can sync — P2b).

### 10.B — the wizard DRIVES the chain runner one clause at a time *(amends §1, §2.2, §9-runs; gaps #2,#9)*
- No change to `_orchRunChain`. Each step = `_orchRunChain(frame, {clauses:[{text:step}], state: st})` — a
  1-clause chain SHARING `st`. `st.lastValue` from step i is present for step i+1: the HS-2 one-value pipe is
  preserved because `st` is shared, NOT because messages persist. This IS the `_resumeAfterDemo` pattern
  (chat.js:5131) generalized; decline -> show-me -> reattempt re-runs the same 1-clause chain with the same `st`.
- CONTEXT accrues via shared in-memory `st`; RENDERING is a TRANSIENT wizard frame (DOM-only, dataset.messageId
  deleted — the `_addLegMsg` discipline). Qualification leaves the transcript clean; only the saved workflow
  persists (a card). CARVE-OUT: a CONFIRMED WRITE during qualification really happened -> it leaves a persisted
  audit line; reads stay transient. (§1's "runs in the desk's conversation" -> "runs sharing the chain's `st`,
  rendered transiently".)
- BUILD-VERIFY: repeated 1-clause calls don't corrupt the CR-S1 liveness refcount; length-1 clauses don't trip
  the fan-out gates.

### 10.C — split detection: target at capture, intent at qualify *(amends §9; gap #3)*
- TARGET split = CAPTURE-TIME, authoritative (`TARGET_RESOLVE`; two explicit system tokens -> suggest split —
  the v1598 vocabulary).
- INTENT split = QUALIFY-TIME: when a step's dispatch RETURNS a decompose verdict (agentLoop.js:87 — it ran as a
  mini-chain), the wizard offers "split into these N" adopting the verdict's own `subAsks`. There is NO
  capture-time decompose classifier; the earlier "capture-time cue" claim was mistimed and is retracted.
- Optional soft capture-time NUDGE on obvious connectives ("... and then ...") — non-authoritative pre-fill only.

### 10.D — routine binding is a UNION; park the preview, not the pipe *(amends §4.1, §4.3, §5; gaps #5,#6,#7)*
- The routine target is a union: `{kind:'workflow', workflowId}` · `{kind:'ask', ask}` (a bare standing
  instruction — **what a migrated seed routine becomes**, so no 1-step workflow is minted and the >=2-step
  normalizer rule is never violated, closing #7) · `{kind:'system', systemId}` (vitals clocks, #6).
- **System routines are PROJECTED at read-time, not stored**: the routines VIEW = stored user routines + a
  projection of the vitals subsystem's own alarms. Vitals keeps its single source of truth; §5's unification is
  a merged VIEW, not a duplicated store. (§4.1's "keyed to a workflowId" applies to STORED user routines only.)
- **Parked writes:** rename `unattended` -> **`parkWrites`** (honest under panel-tier — the human just opened the
  desk; the flag means "don't blockingly confirm mid-routine, PARK instead"). Threaded through `_orchRunChain` ->
  the existing write gate branches on it. **Park the write step's RESOLVED BINDINGS (the preview already computes
  them) + chain position — NOT the raw `st.lastValue` list.** That bounds size AND minimizes PII-at-rest (the
  preview IS the sanitized subset). Add a pure `serializeChainState/hydrate` pair.
- BUILD-VERIFY (unresolved until read): is `st.lastLeg` plain-serializable, or a live object? The serialize pair
  snapshots ONLY the re-dispatch key, never a live ref — confirm the shape before trusting it.

### 10.E — honesty corrections *(amends §0, §2.4, §4.2; gaps #8,#10,#11)*
- **`ask` = the UMBRELLA INTENT** captured at stage 1 (what the user would re-type; `workflowMatch` recalls it),
  NOT the display `name`. `name` = optional short label. (§2.4's "ask defaults to name" is retracted.)
- **v1 routines are DESK-OPEN-TRIGGERED** (panel-tier, §4.2). The tracking-number poller in v1 = "checks each
  time you open the desk, parks the write if ready" — real background polling awaits SW-graduation (§5). The §0
  example is aspirational-until-graduation, not a v1 promise.
- **Alarm migration + budget:** RT-0 clears `routineAlarmName(instanceId)` once and mints per-routine
  `routine:<routineId>` alarms; cap ~10 enabled routines/desk; the alarm namespace is shared
  (`vitals:tick` · `fleet-sweep:*` · `routine:*`) — MV3's real limit is create-RATE not count, so the cap is
  prudence.

### 10.F — two open choices, user-ruled
1. Confirmed writes during qualification: **persist an audit line** (ruled yes — a real side effect leaves a record).
2. `parkWrites` semantics: **routine-initiated runs ALWAYS park**; interactive (user-clicked) runs confirm live.

## 12. Method-agnosticism: a step says WHAT; the router picks HOW (ride / drive / broker)

**A workflow is METHOD-AGNOSTIC by construction — the determination is made by the ROUTER at dispatch, per step,
never stored on the workflow.** Grounded: `INTERPRET_ASK` (sg.js ~1536) assembles ONE heterogeneous palette per
ask — `retrieveTools` (saved capabilities) + `connectorLegsForConnections` (curated RIDE) + `harvestedRecipeLegs`
(harvested ride via SESSION_REPLAY) + `seededDriveLegs` (DRIVE artifacts) + `brokerLegsForLinked` (BROKER) — and
the interpreter SELECTS one, binding params. The step text carries intent; the method is whatever leg wins.

Consequences the wizard/routines inherit:
- **Provenance records the method USED, as DISPLAY/AUDIT — never a binding.** A step qualified via DRIVE today
  replays via RIDE tomorrow if a ride leg gets harvested for that intent (the empirical-model rule §1:
  "provenance for display, never a rigid binding"). The method can IMPROVE silently over time — a workflow gets
  more robust without re-authoring.
- **This is why "show me" arms BOTH capture classes** (§2, ruling #1): the method isn't predetermined, so the
  decline path teaches whatever the page affords — drive (OBS recorder) OR ride (FORAGE tee) — and the router
  picks it up next dispatch.
- **Preference is the ROUTER's, applied at selection, not the workflow's**: connector/API legs (ride, broker)
  are first-class and preferred where they exist (project_router_over_tools — API is more robust than DOM);
  drive is the tail-coverage class for what no leg reaches. A step never PINS a method; if the preferred leg is
  gone (drift, deauth) the router falls to the next available — the same self-heal a typed ask gets.
- **Safety travels with the METHOD, not the workflow.** A ride WRITE confirms via §9 exactly as a drive submit
  does; the parkWrites gate (§4.3/10.D) fires on the ACT regardless of method. The named-system fence, the
  read-only belts, and the arm guard all apply per-step because the step dispatches through the normal door.
- **Implication for sizing (§9):** the target boundary is method-INDEPENDENT — "on site X" splits whether X is
  reached by ride or drive. Step boundaries never need to know the method; that's the router's concern.

## 13. Primitive-reality table (what each engine ACTUALLY guarantees)

Pin against future drift — the critical pass exists because prose assumed generality the code doesn't have.

| Primitive | File | REALITY (not the assumption) |
|---|---|---|
| `normalizeWorkflow` | Core/workflowMemory.js | WHITELIST (no `...r`); REJECTS <2 steps; extend field-by-field |
| `workflowId` | Core/workflowMemory.js | CONTENT hash (ask+steps) — changes on edit; use as `contentId`, mint a separate surrogate `id` |
| `_orchRunChain` state | chat.js ~5122 | in-memory `st`: `{lastValue(PII), lastLeg(obj), ranSteps, readouts, policyConfig}` — shared pipe; NOT auto-serializable |
| `_resumeAfterDemo` | chat.js ~5131 | the resume seam: `{startIndex:i+1, state:st}` — reuse for wizard pauses; don't reinvent |
| write gate | chat.js (INVOKE_SESSION belt) | ALWAYS interactive today; needs a `parkWrites` branch — no headless park exists yet |
| the palette | sg.js ~1536 | heterogeneous per-ask (ride+drive+broker+caps); router selects; method NOT stored |
| FLEET_ROUTINE | background/handlers/fleet.js | ONE routine/instance, one `{minutes,ask}`, one `routineAlarmName(instanceId)` — RT-0 makes it a list |
| routine firing | chat.js `_maybeFireDueRoutine` | PANEL-TIER (fires on desk-open), not headless — the tracking-poller limit |
| vitals clocks | background/handlers/vitals.js | SW-native alarms, global (not instance/workflow-keyed) — project into the routine VIEW, don't store |
