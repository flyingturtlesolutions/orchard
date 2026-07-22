# HANDOFF — building cadence (time-triggered workflows), as of v2.74.1690

**Spec:** `docs/DESIGN_cadence.md` — read §1 (the ruling), §2.2 (headless), §8 (parked writes) before touching code.
This document is the BUILD map: what exists, what is broken, where every insertion point is, and which patterns to
copy. Everything below was read out of the tree, not inferred; file:line refs are as of v2.74.1690.

**Progress (v2.74.1691) — the FOUNDATION is built + gated (2921/0).** The three prerequisite bugs (§2) are fixed
and CD-0 (the trigger field) has landed. Still unbuilt: the scanner (CD-1), the driver + reporters (CD-1a), the
run-history store (CD-5), and all panel surfaces (CD-2/3/4/6). Details:

- **§2.1 BLOCKER fixed** — `_normSteps` now carries `steps[].clause`, and the `normalizeWorkflow` literal now
  carries `schema`. `buildWorkflowSave`'s pinned clause + `schema:2` finally reach storage; `replayPlan`'s
  drift branch is now reachable. Regression-guarded in `Core/workflowMemory.test.js`.
- **§2.2 fixed** — `patchMeta`'s allow-list gains `summary` + `resolvedAt` (`ConversationStore.js:279`).
  Guarded in `Services/ConversationStore.test.js`.
- **§2.3 fixed** — `deleteAll` (`chat.js:584`) now stamps every desk's workflows via `markWorkflowsOrphaned`
  before the wipe.
- **CD-0 built** — `Core/trigger.js` (pure: normalize · arm · isDue · coalescing · advance · failure→disarm ·
  setEnabled · honest label) + `Core/trigger.test.js`; the `trigger` field is whitelisted in
  `normalizeWorkflow`, so `updateWorkflow(appId, id, {trigger})` already persists a cadence. The wizard cadence
  STAGE (§6.6) and migration of `fleetRoutine` records are NOT yet done — that is the rest of CD-0/CD-8.

**Progress (v2.74.1692) — the full §11 BACKBONE is built + gated (2953/0), import graph link-verified.** Every
module in the §3.2 / §11.1 map now exists with real, tested logic; the scanner is wired into `background.js` and
fires headless. What is NOT yet built: the panel SURFACES (the DOM reporter, Rail glyph, workflows page, card
icons, history overlay, page-slot owner) and the fleet-routine RETIREMENT/migration — those are live-only and
listed under "Remaining" below.

Built this pass:
- **`Core/workflowTier.js`** (+test) — the headless gate (§4.5/§11.3). FAIL CLOSED; phase 1 admits a nav or a
  PINNED ride (needs §2.1's clause). One non-sw step demotes the whole workflow to 'panel'.
- **`Core/runHistory.js`** (+test) — the §6.3 entry shape, per-workflow retention + the §6.4 truncation notice,
  the `parked`/`disarmed` verdicts, the RUN-level row renderer.
- **`Core/runDriver.js`** (+test) — the centrepiece (§2.2/§11.2): the chain loop over an injected REPORTER +
  injected `runStep`. `gate()→'park'` when nobody's watching; `startIndex`/`state` are the park/resume seam.
  Ships `makeAccumulatorReporter()` (the SW reporter's pure core).
- **`Services/Storage/WorkflowRunStore.js`** (+test) — `wfruns:<workflowId>`, per-workflow cap, lifetime `total`
  for the truncation notice. (Test uses the robust save/restore chrome-mock pattern — the fragile import-time
  `globalThis.chrome` assign breaks sibling storage suites; see CanvasStore/ProposalStore.)
- **`background/handlers/cadence.js`** (new) — the ONE `cadence:tick` scanner (copy of `vitals.js`): the §2.1
  check order, tier gate (panel-tier defers to desk-open, sw-tier fires headless through the normal
  INVOKE_SESSION executor), the in-flight marker (`priorRunVerdict`), coalescing, failure→auto-disarm,
  orphan→auto-disarm, and history write. Handlers: `WORKFLOW_TRIGGER_SET` / `WORKFLOW_RUNS` /
  `WORKFLOW_RUN_FIRE`. Wired at `background.js` (import + `initCadence` at module top + handler-map spread).
- **`studio.js` `_DECISION_RE`** — `CADENCE ▸` + `TRIGGER ▸` added (invariant #1).

**Caught in the build:** `priorRunVerdict` lives in `Core/fleetSchedule.js`, not `pipelineRun.js` — the wrong
import would have thrown at SW module-link and broken the whole background. Fixed; the whole graph now link-checks.

**Remaining (live-only — the panel surfaces + the fleet cutover):**
- **CD-2/3/4/6** — the panel DOM reporter (the driver's panel side), the Rail glyph, the workflows PAGE (repoint
  `chat.js:10917`), the card run/delete/edit icons, the history overlay (copy `.rail`), the page-slot owner value.
- **CD-1 cutover** — retire the fleet routine branch (`fleet.js:559-570`) + migrate `fleetRoutine` records to
  triggers. Deferred deliberately: it is a risky live cutover of a working feature. The new clock owner runs in
  PARALLEL for now (workflow-keyed triggers); collapse fleet into it once the panel can arm a cadence.
- **CD-6.6** — the wizard cadence STAGE (two edits, §6.6) so a workflow can be given a cadence at save time.
- **CD-7** — parked writes as real `wfp_` cases + resume UI. The scanner already PARKS and drops a
  `cadence:parked:<runId>` marker; promoting it to a case + `Approve & continue` is the panel piece.

**None of the SW fire path is live-verified** — the scanner, INVOKE_SESSION fire, and chrome.storage/alarms seams
can't be exercised headless. Reload the extension and watch for `CADENCE ▸` lines in a decisions download.

**Progress (v2.74.1693) — cadence is now REACHABLE + MANAGEABLE end-to-end (gate 2955/0, undef clean).** The panel
can build a scheduled workflow, list workflows, and arm/change/remove a schedule. Built this pass:
- **CD-6.6 — the wizard cadence STAGE.** After naming, the wizard shows an optional schedule pick (hourly / 4h /
  daily / no-schedule); the pick threads through `buildWorkflowSave` → `armTrigger` (READY workflows only — a
  draft is not schedulable) → the store. New `'cadence'` phase in `_wfConsumeInput`/`_wfRenderPage`, composer
  locked, `_cadenceLabel` helper, save confirmation states the schedule. Pure part regression-tested.
- **CD-2 — `＋ Workflow` unhidden.** `Core/deskLanding.js` now offers it ALWAYS (was `!cards.length` — the §0
  dead-end that made a second workflow uncreatable). Tests updated.
- **CD-2 — `OPEN_WORKFLOWS` self-leg.** Added to `Core/palette.js` beside `LIST_CASES`, dispatched via
  `IL_PANEL_LEGS` in chat.js. "show my workflows" / "what runs automatically" now resolve through the router
  (and the step DECOMPOSER sees it — the v1689 no-silent-substitution lesson).
- **CD-4 (manage view) — the schedule control.** `_renderWorkflows` (the `workflows` / `OPEN_WORKFLOWS` view)
  now shows each workflow's honest cadence and offers ▶ Run · ⏱ Schedule (arm/change/remove via
  `WORKFLOW_TRIGGER_SET`) · 🗑 Delete per row.
- **CD-2 — launch cards show the cadence** ("⏱ runs every 4h" / "due every 4h") via the pure builder. Tested.

**Progress (v2.74.1694) — CD-6 run history is READABLE.** Each workflow row in the manage view (`workflows` /
`OPEN_WORKFLOWS`) gained a **📜 History** button reading the wired `WORKFLOW_RUNS` handler and rendering the
RUN-level rows (time · auto/manual · counts · verdict, parked → "waiting on you") via the pure
`runHistory.describeRun`, with the truncation notice. Delivered as a bubble list, NOT the §6.2 `.rail` overlay —
the overlay motion + page-slot owner value is polish; §6's actual requirement (a person can READ the history) is
met. The overlay-on-card-body (§6.2) remains as visual polish.

**Still remaining (large, live-only):**
- **CD-3** — intent-first `＋ Workflow` (repoint the card at an intent prompt). Left deliberately: it touches the
  composer intercept + a new wizard phase, high-risk to do blind; the `workflow: <intent>` command is the
  intent-first door meanwhile.
- **CD-6 overlay polish** — the `.rail`-style takeover from the card body + the explicit page-slot owner value
  (§6.2/§6.4). The history itself is readable now (bubble list); this is the motion.
- **CD-7** — parked writes as real `wfp_` cases + `Approve & continue` resume. The scanner already parks + drops
  a `cadence:parked:<runId>` marker; promoting it to a case is the panel piece.
- **CD-1a phase 2** — the panel DOM reporter (route the panel run through `Core/runDriver` too, so panel and SW
  are ONE loop with two reporters — §9.4). Phase 1 deliberately left the panel path on `_orchRunChain`.
- **CD-1 cutover** — retire `fleet.js:559-570` + migrate `fleetRoutine` records. The new clock owner runs in
  PARALLEL for now.

---

## 0. If you read nothing else

1. **Three bugs must be fixed before CD-0 opens.** §2. One of them (`normalizeWorkflow` dropping `clause`) makes
   the entire PP-0c pinning + drift-check subsystem inert, and an unattended scheduled run is exactly the caller
   that needs it.
2. **`＋ Workflow` disappears after the first save.** `Core/deskLanding.js:65` guards it with `!cards.length`.
   There is no on-surface way to create a second workflow today. This is not a nice-to-have entry point — it is a
   dead end, and it is why CD-2 ranks where it does.
3. **The driver extraction is ~78 reporter calls, not 723.** §4.2. The chat.js-wide figure quoted in earlier
   drafts of the spec overstated it by an order of magnitude.
4. **`background/handlers/*.test.js` is not in the test glob.** All decision logic must live in `Core/` or it
   cannot be tested at all. §3.1.
5. **`.rail` is already a full-surface overlay with a transform transition.** The spec's claim that the motion is
   new CSS is wrong. §6.3.

---

## 1. What exists today — the honest baseline

### 1.1 There is no scheduled workflow

`normalizeWorkflow` (`Core/workflowMemory.js:49-77`) has no cadence/trigger/schedule field. What exists is two
DESK-keyed clock systems, neither of which knows what a workflow is:

| | key | alarm | executes |
|---|---|---|---|
| Sweep | `fleetSchedule:{instanceId}` (`fleet.js:28`) | `fleet-sweep:{id}` (`Core/fleetSchedule.js:31`) | headless in the SW — `runHeadlessSweep` (`fleet.js:188`) |
| Routine | `fleetRoutine:{instanceId}` (`fleet.js:29`) | `fleet-routine:{id}` (`Core/fleetSchedule.js:175`) | **nothing** — sets `due=true` (`fleet.js:567`); the panel runs it on next desk open |

`WorkflowStore.js:40-41` mints a stable surrogate id whose comment reads *"Routines bind it, so it must NOT be
recomputed from content."* **Nothing binds it.** That id has been waiting for this arc.

### 1.2 The workflow record

`Core/workflowMemory.js:57-77`, `normalizeWorkflow` returns a **constructed object literal** — the field set is
closed by construction, and anything not listed is dropped on every normalize including on edit:

```js
{ id, contentId, ask, subAsks[], name, appId, createdAt, updatedAt,
  runs, dismissed, status:'ready'|'draft', orphanedFrom?, qualifiedAt, steps[] }
```

`steps[]` via `_normSteps` (`:37-46`) → `{ text, via:{kind,host,name}, bankedAt }`.

Store: `Services/Storage/WorkflowStore.js`, key `il:workflows:${appId}` (`:12`), value `{items, updatedAt}`
(`:37`), `CAP = 50` with `.slice(-CAP)` on append (`:11`, `:54`), per-appId serialized chain (`:26-34`).

Exports: `loadWorkflows` `:19` · `saveWorkflow` `:45` (dedups by `contentId`, `:52`) · `updateWorkflow` `:62` ·
`bumpWorkflowRun` `:78` · `bumpWorkflowDismissed` `:90` · `deleteWorkflow` `:101` · `listAllWorkflows` `:126`
(a `chrome.storage.local.get(null)` prefix scan) · `markWorkflowsOrphaned` `:153`.

### 1.3 Surfaces that exist, and what they actually are

| Surface | Where | Reality |
|---|---|---|
| Launch-page workflow cards | `Core/deskLanding.js:57-64` + `chat.js:12562-12591` | max 6, sorted by `runs` desc; click **runs immediately** (`chat.js:12566-12575`) — no preview, no detail |
| `＋ Workflow` card | `Core/deskLanding.js:65` | **only when `!cards.length`** — vanishes after the first save |
| `workflows` command | `chat.js:10917` → `_renderWorkflows` `chat.js:7478` | a **transient bubble menu** in `#messages`, ▶ Run / 🗑 Delete. Not a page. Already owns the command name. |
| `routines` command | `chat.js:10496` → `_renderRoutines` `chat.js:6569` | same shape, per-desk, one routine max |
| Rail sweep countdown | `chat.js:644-650`, `:952` | `⏱` filled by `_setItemMeta`; **sweep alarms only**, `role==='app'` only |

**There is no workflows page. It must be built.**

---

## 2. Three bugs to fix BEFORE CD-0

### 2.1 BLOCKER — `normalizeWorkflow` drops `clause` and `schema`, so pinning is inert

`Core/workflowMemory.js` contains **zero** occurrences of `clause` or `schema` (verified by grep). But
`buildWorkflowSave` (`Core/workflowWizard.js:141-160`) emits both:

- `steps[].clause` — the PP-0c pinned resolution, attached at `workflowWizard.js:89-90` via `pinnedClause()`
  (`:100-111`), shape `{ kind, capabilityId, groundId? }`
- `schema: WORKFLOW_SCHEMA` (`:158`, `WORKFLOW_SCHEMA = 2` at `:163`)

`_normSteps` (`workflowMemory.js:37-46`) rebuilds each step as `{text, via, bankedAt}`. Both `saveWorkflow:50` and
`updateWorkflow:68` route through `normalizeWorkflow`. **No pinned clause has ever reached storage.**

Everything downstream is therefore dead code:

- `replayPlan` (`workflowWizard.js:190-214`) always takes the `!clause → loose` branch; `pinned` always 0, `stale`
  always empty, `runnable` always true
- `isPrePinned()` (`:166`) always returns true — missing `schema` → `Number(undefined || 1) < 2`
- the chain runner's warm path (`chat.js:7096`, `if (_pin && _pin.capabilityId)`) is unreachable
- **the drift check never fires** — and `workflowWizard.js:180-182` says of precisely this: *"A drift check that
  can be bypassed by a fallback is not a drift check"*

**Why this blocks cadence specifically.** Without pinning, every triggered fire re-interprets each step from prose
— ORCH_MATCH + INTERPRET_ASK per step, ~13k input tokens each — and cannot detect that a step now resolves
somewhere different from what the human approved. A workflow that silently re-aims itself at 03:00 is the exact
failure the gate architecture exists to prevent. **Fix this in CD-0, not later.**

The fix is two additive fields in `normalizeWorkflow`'s literal and one in `_normSteps`. Follow `orphanedFrom`'s
precedent at `:72-73`, which carries an in-comment warning for the same reason: *"whitelisted so an edit can't
strip it."*

### 2.2 `patchMeta` silently drops `summary` and `resolvedAt`

`Services/ConversationStore.js:279` is a hardcoded key list — `['branch','concern','sessionId','status',
'mergedAt','mergeCommit','title','syncedMain','seed','titledByLlm', …]`. `chat.js` writes `summary` and
`resolvedAt` anyway, so `resolvedAt` is never set, the `!conv.resolvedAt` guard at `chat.js:12856` is permanently
true, and every `VITALS_CHANGED` re-patches and re-logs every closed incident forever.

**CD-5 clones the vitals sidecar and inherits this.** Fix before CD-5.

### 2.3 `deleteAll` skips the workflow-orphan stamp

The per-row delete runs `markWorkflowsOrphaned` (`chat.js:1019`); `deleteAll` (`chat.js:584`) does not. A bulk wipe
strands every desk's workflows with no name to find them by. Cheap, unrelated to the arc, fix while you are here.

---

## 3. Architecture

### 3.1 The hard constraint: what can be tested

`package.json:6` — `npm test` globs `Core/*.test.js`, `Services/*.test.js`, `Services/Engine/*.test.js`,
`Services/Chat/*.test.js`, `Services/Storage/*.test.js`, and the bridge.

**`background/handlers/*.test.js` is NOT in the glob.** SW handler code cannot be unit-tested. Therefore:

> All cadence decision logic lives in `Core/`. `background/handlers/cadence.js` is a thin I/O shell.

This is exactly the vitals split — `Core/vitals.js` (pure: `upsertIncident`, `resolveIncident`, `openIncidents`)
plus `background/handlers/vitals.js` (alarms, storage, sweeps). Do not deviate.

`npm run undef` (`package.json:7`) DOES cover `background/handlers/*.js`. Run it after every edit — it has caught
six real ReferenceErrors this cycle that `node --check` passes cleanly.

### 3.2 Module map

**New — `Core/`, pure and tested**

| Module | Owns | Template to copy |
|---|---|---|
| `Core/trigger.js` | normalize · due calc · coalescing · failure→disarm · orphan→disarm | `Core/vitals.js` |
| `Core/workflowTier.js` | provenance → `'sw' \| 'panel'` | — |
| `Core/runHistory.js` | entry shape · tally · per-workflow retention + truncation notice | `Core/pipelineCase.js` |
| `Core/runDriver.js` | the extracted chain loop | `Core/upsert.js` (`runUpsert`) |

**Extended — `Core/`**

| Module | Change |
|---|---|
| `workflowMemory.js:57-77` | `trigger` + `schema` in the literal; `clause` in `_normSteps` (§2.1) |
| `palette.js` | `OPEN_WORKFLOWS` self leg, beside `OPEN_CASE` / `REVIEW_QUEUE` |
| `workflowWizard.js:141-160` | `buildWorkflowSave` carries `cadence` |

**Storage** — `Services/Storage/WorkflowRunStore.js` (new) · `WorkflowStore.js` (trigger read/write).

**Background** — `background/handlers/cadence.js` (new) · `fleet.js` retires the routine branch.

**Panel** — the DOM reporter · Rail glyph · workflows page · intent-first `＋ workflow` · card icons · history
overlay · the page-slot owner token.

---

## 4. CD-1a — the driver extraction, in detail

### 4.1 What it is today

```js
// chat.js:6972
async function _orchRunChain(msg, { tabId, clauses, firstMatch, ask = '',
                                    startIndex = 0, state = null, offers = true, onRetry = null })
```

State (`chat.js:6985`):
```js
{ readouts, ranSteps, chainGroundId, lastValue, lastLeg, lastReadoutIdx, policyConfig }
```
plus `lastAuthStop` / `lastEmptyStop` / `lastNarrowedFrom` set per run.

`startIndex` and `state` **already exist** — §8's park/resume needs no new parameters.

Clause runners, all the same shape:

```js
async function _runFieldReadClause(msg, fr, { tabId, priorValue, priorLeg, goal })          // chat.js:3759
async function _runBranchClause   (msg, br, { tabId, priorValue, priorLeg, goal })          // chat.js:3988
async function _runWriteClause    (msg, wr, { tabId, priorValue, priorLeg, goal, state })   // chat.js:4260
async function _runCaseClause     (msg, cs, { tabId, priorValue, priorLeg, goal, state })   // chat.js:4439
async function _runMapClause      (msg, map,{ tabId, priorValue, priorLeg, goal })          // chat.js:4612
```

The extraction is mechanical: **replace `msg` with `report`.**

### 4.2 The real size

Across all five clause runners (1,142 lines):

| Category | Count | Disposition |
|---|---|---|
| `_setMessageBody` · `_orchFinalize` · `_ilBusy` | **78** | the reporter — the actual work |
| `_orchLog` | 52 | **already host-agnostic** — routes via `_orchReq('ORCH_LOG')` (`chat.js:2765`) |
| `_str0` · `_rowLabel` · `_errWord` · `_why` · `_legDisplayId` · `_branchScopeFor` | ~37 | pure helpers → lift to `Core/` |
| `_runConnectorLeg` · `_rideExecOnce` · `_rideDrillLeg` · `_chainConnectorRun` · `_legFor` · `_orchReq` | ~27 | inject as deps; all already reach the SW |

Per clause, for phase-2 sequencing:

| Runner | Lines | Reporter calls | Direct `_orchReq` |
|---|---|---|---|
| `_runBranchClause` | 272 | 9 | 3 (`CLASSIFY_BRANCH_ITEMS`) |
| `_runWriteClause` | 179 | 12 | 0 |
| `_runFieldReadClause` | 229 | 14 | 0 |
| `_runCaseClause` | 173 | 19 | 5 (`PIPELINE_*`) |
| `_runMapClause` | 289 | 20 | 0 |

Total direct SW ops needed: `CLASSIFY_BRANCH_ITEMS`, `PIPELINE_RECORD_ITEM`, `PIPELINE_OPEN_ITEMS`,
`PIPELINE_CASES`, `PIPELINE_CLOSE_CASE`. All already exist as handlers.

### 4.3 The reporter interface

| Method | Panel impl | SW impl |
|---|---|---|
| `step(i, total, text)` | `_setMessageBody(msg, …)` | no-op |
| `progress(text)` | `_setMessageBody` + `_ilBusy(msg, true)` | no-op |
| `result(payload)` | `_setMessageBody(msg, text, {markdown:true})` | accumulate for the history entry |
| **`gate(preview)`** | `_hitlConfirmBar(msg, {gated})` → `Promise<boolean>` | **return `'park'`** |
| `done(verdict)` | `_orchFinalize(msg)` | write the `wfruns` entry |

**`gate` is load-bearing.** §8's whole unattended-write policy becomes one return value. If that rule ever needs
stating twice, the interface is wrong.

Panel primitives it wraps, exact signatures:

```js
appendMessage({ role, body, attribution, id, skipPersist, convId })  // chat.js:1187 → HTMLElement
_setMessageBody(msg, text, { markdown, html })                       // chat.js:1320 → undefined
_orchActionBar(msg, { scope })                                       // chat.js:2823 → HTMLElement
_ilBusy(msg, on)                                                     // chat.js:2868 → undefined
_orchFinalize(msg, { outcome })                                      // chat.js:2928 → undefined
_mkBtn(label, fn)                                                    // chat.js:2948 → HTMLButtonElement
_mkOnceBtn(label, fn, { lockBar })                                   // chat.js:2955 → HTMLButtonElement
_hitlConfirmBar(msg, { gated, confirmLabel, cancelLabel })           // chat.js:2971 → Promise<boolean>
```

**Contracts a reporter must not lose:**

- `_setMessageBody` stashes `msg.dataset.srcText` / `srcMd` when `!html` (`chat.js:1324`) so `_orchFinalize`
  persists the SOURCE, not flattened `textContent`.
- `_orchFinalize` early-returns without a `messageId` (`:2931`); it also runs `_revealLines` once per bubble.
- `_orchActionBar` with `scope` disables and `.stale`-marks earlier bars of the same scope (`:2831-2839`).
- `_hitlConfirmBar` registers with `_registerBarCancel` (`chat.js:1085`) so a conversation switch resolves
  `false` rather than stranding the promise.

### 4.4 The template

`Core/upsert.js:71` is the shape, one level down:

```js
export async function runUpsert(item, { find, create, act = null, recheck = null,
                                        trialTag = '', onDisposition = null } = {})
```

with `const say = (line) => { if (onDisposition) { try { onDisposition(line); } catch { /* logging never changes a
verdict */ } } };` — injected async IO plus a callback that **cannot change the verdict**. The driver is that,
scaled up.

### 4.5 Tiering — `workflowTier()`

`stepProvenance` (`Core/workflowWizard.js:74-92`) records `via.kind`, copied verbatim from `ranSteps`.

**`via.kind` is NOT a closed enum.** The literals actually pushed in chat.js are `'navigate'` (`:7043`),
`'fanout'` (`:7094`), `'fieldRead'` (`:7133`), `'write'` (`:7142`), `'case'` (`:7148`), `'branch'` (`:7155`),
`'map'` (`:7192`), `'connector'` (`:7201`) — **plus** two open-ended sources: `_record` pushes
`kind || m.candidate.kind || null` (`chat.js:6987`) and `_resumeAfterDemo` pushes `cap.kind || null` (`:6990`).
The inline comment at `workflowWizard.js:76` lists a stale set; do not trust it.

> **`workflowTier()` must FAIL CLOSED: default to `'panel'` for any unrecognized kind.** Never switch
> exhaustively.

Phase 1 admits only `'connector'` (a ride leg) and `'navigate'`. Everything else → `'panel'`.

---

## 5. CD-0 / CD-1 / CD-5 — the SW side

### 5.1 The scanner — copy `background/handlers/vitals.js`

**Constants** (`vitals.js:26-32`): `TICK_ALARM = 'vitals:tick'`, plus one storage key per concern.

**Registration** — `export function initVitals(ctx)` (`vitals.js:244-258`), `{ periodInMinutes: 20 }` (`:247`),
called from `background.js:428` **at module top level** (module eval = every SW boot), not inside
`onInstalled`/`onStartup`.

Three things to copy verbatim:

1. **Alarms are durable; only the listener re-registers.** `fleet.js:551` — *"chrome.alarms persist across SW
   restarts natively — no re-registration."*
2. **The boot kick** (`vitals.js:255-257`) — `setTimeout(() => { _tick() }, 5000)`, because *"the SW boots dozens
   of times a day, so the tick itself is window-gated — a boot inside every window is a no-op."*
3. **Stamp lastRun BEFORE the sweep** (`vitals.js:268`) — `// stamp at START (double-run guard across SW
   restarts)`.

**Scan-loop shape** — `_dailySweep` (`vitals.js:364-391`): enumerate candidates, guard-and-`continue` with a
**named counter per skip class**, politeness spacing (1500ms; keep-alive uses 800ms at `:332-362`), per-item
`try/catch` (*"per-ground best-effort"*), and **one summary log naming every class including the zeroes**.

**Serialized read-modify-write** — `_mutateIncidents` (`vitals.js:64-75`): a module-level chain promise, read →
pure transform → write, `.catch` returns a neutral shape, chain advanced with `.then(() => {}, () => {})` so a
rejection cannot poison it. Copy this for the run store.

### 5.2 Surviving SW death mid-run

`fleet.js:185-199` is the existing model. Key `fleetRun:${instanceId}`, stamped `{runId, startedAt}` before work,
judged on the NEXT fire by `priorRunVerdict(prior)` (`Core/fleetSchedule.js:84-87`) → `{inFlight, died}`. Fresh
marker → skip (no concurrent double-run, `fleet.js:197`); stale → report the death and proceed (`:205-209`).
Rationale at `:191-193`: *"a mid-flight SW/browser death runs no catch, so the run vanishes without a trace."*

This IS §7.2's overlap policy and §11's checkpoint, already designed. Use `mintRunId` (`Core/pipelineRun.js:44`) —
`fleet.js:198` mints inline and is one of the two diverged copies called out at `pipelineRun.js:11-12`.

### 5.3 Self-heal for an orphaned trigger

`fleet.js:210-216` — an orphaned schedule (its conversation deleted) **self-clears its own alarm and record**
rather than firing forever. Under one clock owner there is no per-workflow alarm to clear, but the scanner still
needs the equivalent: workflow id no longer resolves → auto-disarm + a history entry (§2.1 of the spec, check 4).

### 5.4 Handler registration

Factory returning a plain op map: `export function createPipelineHandlers()`
(`background/handlers/pipeline.js:46`) is the cleanest template. Ops take `(payload, sender, sendResponse)`; both
async-and-await and sync-plus-`return true` styles work (the dispatcher wraps in `Promise.resolve`,
`background.js:1920`).

Wire by spreading into `_sgMessageHandlers` (`background.js:1749-1816`), next to
`...createPipelineHandlers()` at `background.js:1763`. Import in the top block (`background.js:38-48`).

**Handler → handler:** `_invokeSgHandler(type, payload)` (`background.js:1822-1831`). It is a hoisted `function`
declaration and **never rejects** — resolves `{success:false, error}` on a missing handler or a throw. That
hoisting is what lets `background.js:423`/`:428` pass it before the map is initialized (`:422` says so
explicitly). Pass it in at module top level; call it only from inside a tick.

**Handler → LLM:** direct import. `pipeline.js:16` imports `AnthropicService` and calls
`AnthropicService.decomposeIntoSteps(...)` at `:75`.

**Posture to copy** — `pipeline.js:65-73`: ground facts gathered in a `try/catch` falling back to `''`, with
*"facts are an ENRICHMENT: without them the decomposer still runs, just blinder."*

### 5.5 Go through the normal executor

`vitals.js:314-316`, on why a scheduled runner must not take a bespoke path:

> *"The canary runs through the NORMAL executor (recipeToLeg → planExec → INVOKE_SESSION): the §16 ephemeral-tab
> cold start, the arm guard, the belts, and the VT-0 funnel all apply unchanged — the sweep is JUST a caller."*

### 5.6 Retention

`Services/Storage/ActionLedgerStore.js` is the smallest copyable eviction: `LEDGER_CAP = 500` (`:9`), per-key
chain (`:13-21`), and the eviction is one line at `:39` — `[...items, ...list].slice(-LEDGER_CAP)`.

**Do not use the ledger itself.** `Core/pipelineRun.js:14-15`: it *"is capped at 500 entries and SILENTLY EVICTS,
shared across all kinds for the instance — a per-item run writing ~3 entries per item starts evicting its OWN
earliest entries near N≈150."* §6.4 of the spec requires per-workflow caps with a visible truncation notice.

Note `background/handlers/pipeline.js`'s case store is **singleton-keyed and uncapped** (`CASE_KEY =
'pipeline:cases'`, `:24`) — copy its `_mutate` shape (`:28-40`, accepts a bare array or `{list, …}`) but not its
key strategy.

### 5.7 What to retire in fleet.js

Delete the routine branch of `registerFleetAlarmListener` — **`fleet.js:559-570` only**. Keep the sweep branch
(`:554-558`) and the foreign-alarm `return` at `:562`. `chrome.alarms.create` for routines is at `:520` and
`:530`; clears at `:505` and `:531`.

`FLEET_ROUTINE` (`fleet.js:495-547`) has seven live callers, all `chat.js` → `_orchReq`: `:6551` `:6558` `:6574`
`:6583` `:6591` `:6602` `:6613`. `FLEET_SCHEDULE` is fully independent — do not touch it.

Two invariants to preserve in the replacement:
- `fleet.js:517` — *"enabled NEVER auto-flips on a re-declare — the user's arm/disarm survives seed edits"*
- `fleet.js:566` — *"disabled records never fire (a stale alarm self-noops)"*

Migration (CD-0): each `fleetRoutine:{instanceId}` record `{minutes, ask, source, enabled, declaredAt, due,
lastFiredAt, convId}` becomes one trigger on a 1-step workflow, so everything is workflowId-keyed.

### 5.8 `Core/pipelineRun.js` — reuse, do not reinvent

Exports: `ITEM_OUTCOMES` `:35` · `RUN_VERDICTS` `:38` · `mintRunId` `:44` · `openRun` `:57` · `recordStage` `:92` ·
`recordAction` `:105` · `closeItem` `:113` · `markAlreadyOpen` `:128` · `closeRun` `:137` · `runVerdict` `:151` ·
`runTally` `:169` · `runStartLine` `:185` · `runEndLine` `:192` · `trialTag` `:201`.

Verdict order matters (`:151-163`): no run → `failed`; no items → `empty`; `!endedAt` → `running`; nothing settled
→ `failed`; all failed → `failed`; any of notRun/truncated/aborted/failed → `partial`; else `complete`. `:147-149`:
*"A capped run that did 24 of 400 perfectly is not complete."*

This is the `verdict` field in §6.3's history entry. Do not compute a second one.

---

## 6. CD-2 / CD-3 / CD-4 / CD-6 — the panel side

### 6.1 The Rail glyph (CD-2)

`_historyConvRow(conv, row, pending = 0, nextSweep = 0)` — `chat.js:911-1044`. The innerHTML template is
`chat.js:948-960`. Two viable slots:

1. **title line**, beside `pendingChip` — matches the `⏳ N` precedent (`:917-919`). Cheapest.
2. **right-hand cluster**, between `subtaskBtn` (`:939`) and `previewBtn` (`:933`) — matches
   `.rail-item-subtask`, hover-revealed.

**Two traps:**

- **Add the new class to `_isRowActionTarget` (`chat.js:773`)** — it currently lists `.rail-item-delete`,
  `.rail-item-preview`, `.rail-chevron`, `.rail-item-subtask`. Miss this and clicking the glyph also selects the
  conversation.
- **The right edge is already crowded.** `assets/chat.css:1819-1820` hard-codes the arithmetic:
  `.rail-item.is-app:has(.rail-item-timer) .rail-item-title { padding-right: 72px; }`, and the timer's own
  `right:` is `calc(var(--sp-2) + 34px)` (`:1806`). A right-cluster button means re-deriving both.

CSS classes live at `assets/chat.css` (**not** repo root — `chat.html:7` links `assets/chat.css`):
`.rail-item` 1680 · `.rail-item-title` 1700 · `.rail-item-badge` 1611 (`.pending` 1627) · `.rail-item-delete` 1777
· `.rail-item-timer` 1803 · `.rail-item-subtask` 1823 · `.rail-item-preview` 1842 · `.rail-chevron` 1646.

### 6.2 The workflows page (CD-2)

**It does not exist and must be built.** `_renderWorkflows` (`chat.js:7478`) is a transient bubble menu in
`#messages` — its own header says *"A transient menu (DOM-only, not persisted) — re-type `workflows` to
refresh."* It already owns the `workflows` command name (`chat.js:10917`, and `_SETUP_COMMAND_RE` at `:2175`,
and the slash picker at `:11887`).

Either repoint `chat.js:10917` at the new page renderer, or pick a different command. Repointing is right — the
name is correct and the bubble menu is what CD-2 replaces.

`OPEN_WORKFLOWS` as a `domain:'self'` leg goes in `Core/palette.js` beside `OPEN_CASE`/`LIST_CASES`, with its
dispatch entry in the table beside `SHOW_WORK` and its key added to the route guard. (See v1689's commit for the
worked example — the same three edits.)

### 6.3 The history overlay (CD-6) — `.rail` is the pattern

**Correction to `DESIGN_cadence.md` §6.2, which claims the motion is new CSS. It is not.**
`assets/chat.css:1519-1543`:

```css
.rail {
  position: absolute; inset: 0; z-index: 20; overflow: hidden;
  background: var(--c-rail-bg);
  backdrop-filter: blur(20px) saturate(1.4);
  box-shadow: var(--shadow-lg); display: flex;
  transform: translateX(-100%); opacity: 0; pointer-events: none;
  transition: transform var(--t-med), opacity var(--t-med);
}
.rail.open { transform: translateX(0); opacity: 1; pointer-events: auto; }
```

Containing block is `.app-body { position: relative }` (`:1488-1489`). The header comment at `:1504-1518` records
that the input row was **moved out of `.app-body`** to a body-level row (`chat.html:160-163`) precisely so a
full-width overlay never covers it. Copy this structure verbatim.

Also available: `.walk-mode` (`chat.css:2336-2350`) is a genuine full-surface overlay with **zero consumers** —
`chat.html:152-156` records its removal. Safe to reuse or delete.

Other live overlays for reference: `.capability-drawer` (1020-1037, bottom sheet with `@keyframes
drawerSlideUp`), `.param-modal-overlay` (2008-2030, the only true modal).

The wizard's `.wf-page` (2802) and `.desk-landing` (2789) are **plain flex columns** — no positioning, no z-index,
no transition. They are content inside `.empty-state-content`, not overlays.

### 6.4 The page slot — the trap that will bite

`#empty-state` (`chat.html:137-145`) and `#messages` (`chat.html:149`), both inside `<main class="thread">`. The
swap is two class toggles (`_enterConversation`, `chat.js:1087-1090`).

**`appendMessage` calls `_enterConversation()` (`chat.js:1202`)** — appending a message hides `#empty-state`. This
is why `_wfRenderPage` calls `_wfEnterPage()` on **every** render (`chat.js:5559`), with the comment at
`:5555-5558` recording the live bug it fixes:

> *"every appendMessage on the current conversation calls `_enterConversation()`, which hides `#empty-state` — so
> a run's appendMessage flipped the user to the thread and the 'ran' render then pulled the run message OUT of it
> into the hidden page → a blank thread."*

**Six uncoordinated renderers write into `.empty-state-content`** — `chat.js:417` (dev), `:1058`
(`_resetConversation`), `:1389` (suggestions), `:1481` (gallery), `:1732` (app open), `:5560` (`_wfRenderPage`,
which **wipes** `host.innerHTML`). There is no stack, no owner token, no z-order.

The wizard's only claim mechanism is two-sided: re-assert on every render, **plus** the `_wfWizard.convId` guard
in `_renderDeskLanding` (`chat.js:12539` — *"the WIZARD owns its desk's surface while it lives: the landing
YIELDS"*). A new overlay needs the same three-point guard (`_wfForeign` `:5470`, the landing yield `:12539`, the
input intercept `:10310`).

**This is why the spec calls for an explicit page-slot owner value.** With a seventh consumer, ad-hoc `classList`
toggles stop being survivable.

The transient-bubble trick, if the overlay renders messages: `delete msg.dataset.messageId` (`chat.js:5897`,
*"transient — a wizard run isn't desk conversation"*) makes `_orchFinalize` and `_persistMessageUpdate` no-op
(guards at `:2931`, `:1282`).

### 6.5 Intent-first composition (CD-3)

Already mostly built. `_startWorkflowFromIntent(intent)` (`chat.js:5810`) does: capture the prior wizard for
rejection carry-forward (`:5812`) → `DECOMPOSE_STEPS` (`:5831-5838`) → fallback `decomposeAsk` (`:5842`) →
sanitize (`[object Object]` belt, `:5846`) → bail under 2 steps (`:5850`) → `_startWorkflowWizard()` (`:5856`) →
overwrite `ask`/`plan`/`queue`/`coverage` (`:5859-5867`) → thread bubble → render.

Entry is `chat.js:10726-10729` (`workflow: <intent>` / `create a workflow that <intent>`). CD-3 repoints the
`＋ Workflow` card (`chat.js:12576-12577`, currently `_startWorkflowWizard()`) at the intent prompt instead.

**The safety argument at `chat.js:5798-5809` is binding:** generation seeds `w.queue`, **never** `w.steps` —
*"what gets replayed is the resolution they approved — not the sentence a model wrote."*

`＋ Workflow` also needs unhiding — `Core/deskLanding.js:65`'s `!cards.length` guard is §0's dead end.

### 6.6 The cadence stage (CD-8 / WW-2) — exactly two edits

Today `_wfSaveStart()` (`chat.js:5956-5960`) sets `'await-name'`, and `_wfConsumeInput` (`:5782`) is the only exit:
`if (w.phase === 'await-name') { if (t) { w.name = t; } await _wfDoSave(); return; }`.

1. **`chat.js:5782`** — replace `await _wfDoSave()` with `w.phase = 'cadence'; _wfRenderPage(); return;`
2. **`chat.js:5766-5770`** — add an `else if (w.phase === 'cadence')` branch in `_wfRenderPage`, whose primary
   button and whose "skip" both call `_wfDoSave()`

Then thread `cadence` through `buildWorkflowSave` (`Core/workflowWizard.js:141`) and the store.

**Also:** add `'cadence'` to the composer `_lock` list (`chat.js:5548`) and to `_wfAwaitingInput()` (`:5462`) if
typed input should reach it. Note the `'plan'` phase is handled in `_wfConsumeInput` (`:5786`) but **omitted**
from `_wfAwaitingInput` — that asymmetry looks unintentional; decide deliberately rather than copying it.

Wizard phases, for reference: `'plan'` `:5864` · `'await-step'` `:5534` · `'running'` `:5899` · `'ran'` `:5927` ·
`'banked'` `:5934` · `'await-name'` `:5959`. The comment at `:5456` lists only five — `'plan'` is missing from it.

### 6.7 The card icons (CD-4)

`chat.js:12562-12591`. Cards are `<button class="suggestion-card">` with two inner divs; **there is no per-card
affordance today** — one button, one handler. Adding run/delete/edit means restructuring the card from a `button`
into a container with buttons inside, which changes the click target semantics the spec §5 already rules on
(body = history, icons = actions).

Current click behaviour to preserve for the run icon (`chat.js:12566-12575`): `_dismissDeskLanding()` →
`bumpWorkflowRun` → `_wfReplayPlan(wf)` (`chat.js:3964`) → if `!runnable` then `_wfReplayStopped` (`:3977`) else
`_orchRunChain`.

Note `_wfReplayPlan`'s `runnable:false` path is currently unreachable because of §2.1 — fixing the whitelist
turns it on, and it is exactly the guard a scheduled run needs.

---

## 7. Verification

- `npm test` — the gate. 2903 passing / 0 failing at v2.74.1690. Every new `Core/*.test.js` is picked up
  automatically.
- `npm run undef` — after **every** edit touching chat.js or a handler. Four known pre-existing findings
  (`syncGroundAssetsAfterSave` ×2, `broadcastStorageChanged`, `deleteRecordWithSync`); anything beyond that is
  yours. Six real ReferenceErrors this cycle passed `node --check` and were caught only here.
- `node --check chat.js` / `node --input-type=module --check < Core/x.js` before relying on an edit.
- **Live:** the panel needs a reopen for panel-only changes; the SW needs the extension ↻ for anything in
  `background/`. `chrome://extensions` version is ground truth.
- **`gl` / `gc`** for traces. New markers must be added to `_DECISION_RE` (`studio.js:6208`) or they are invisible
  to a decisions download — invariant #1, and it has been missed six times.

**Suggested markers:** `CADENCE ▸` (scan / fire / disarm) and `TRIGGER ▸` (arm / edit / skip). Both need adding to
`_DECISION_RE` in the same edit that introduces them.

---

## 8. Decisions taken — do not re-litigate

From `DESIGN_cadence.md` §1, §13, §14:

1. **Cadence is a FIELD on a workflow, not an entity.** A separate schedule entity with its own store and roster
   was drafted and rejected. The orphaning it was meant to fix is a leaked `chrome.alarms` reference, not a
   modelling error.
2. **One clock owner.** A scanner over workflow records. Never an alarm per workflow. This is the actual bug fix.
3. **The Front desk takes workflows** (it still takes no cases).
4. **History is an overlay with its own store keyed by workflow id** — never the desk timeline, which is deletable
   and would interleave triggered output with a live conversation.
5. **Headless is possible and is CD-1a.** The earlier deferral quoted a coupling constraint as a platform limit.
6. **There is no `writePolicy: 'auto'`, and this arc does not add one.** A triggered run reaching a write parks.
7. **No cross-desk roster.** §3's entry points make every desk's workflows one click away.

---

## 9. The bug classes that recur here

Each has cost multiple versions in this codebase. All four are reachable from this arc.

1. **A new marker missing from `_DECISION_RE`** — structurally invisible to a decisions download. Six instances.
2. **A capability the front door cannot name** — the router substitutes the nearest wrong thing, confidently.
   `case` cost a live outward Zendesk write. If cadence adds any user-nameable capability, it goes in
   `Core/palette.js`, not behind a regex.
3. **A closed whitelist silently dropping a field** — `normalizeWorkflow` (§2.1), `patchMeta` (§2.2). Both are
   live right now.
4. **Two components disagreeing about one concept** — the branch and `fieldRead` each had their own notion of
   "field name" (fixed v1690 by `resolveFieldKey`). Watch for the same between the panel driver and the SW driver
   during CD-1a phase 2: they must be ONE module with two reporters, never two implementations.

---

## 10. State at handoff

- **v2.74.1690**, `main`, gate 2903/0, tree clean, pushed.
- **v1683–v1690 have never been loaded.** The extension was last observed running v1682. The case legs
  (`OPEN_CASE`/`LIST_CASES`/`CLOSE_CASE`), the empty-prior stop, the four-way wizard bar, `resolveFieldKey`, and
  the `WRITE_GATE ▸ held` line are all green in the harness and **unverified live**. This arc leans on all of
  them. Reload and re-run one workflow before building on top.
