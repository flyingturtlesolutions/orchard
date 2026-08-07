# DESIGN — Workflows as first-class entities + the workflow gallery (WFG)

**Status:** spec v0.1 (2026-08-04); **WFG-1 BUILT** (`Core/workflowCatalog.js` + the gallery in `chat.js`). AS-BUILT
DEVIATION (user direction): the per-view **"＋ Workflow" IS the single entry**, opening the gallery pre-scoped to
that view — a workflow is always added under a specific view. The unscoped top-level "＋ New workflow" entry AND the
"add to which view?" picker (§7) were built, then **removed** (§10-A resolved: scoped, not standalone), so the
picker / top-level / one-shot-handoff bullets in §7 are **superseded**; WFG-2/3 remain deferred. Live eyeball still
owed (gallery render · preset→plan-gate · scoped bind). Prompted by the direction *"'+ Workflow' should function
like '+ View': a gallery page of presets + custom, not a dump into the open view."* Two explorer maps ground it (the
app-gallery pattern; the workflow model + a presets verdict). The load-bearing decision here is
**architectural** — whether a workflow becomes a first-class independent entity — not a UI reskin. Recommendation:
**first-class in identity + presentation, scope-bound in execution** (the middle path, §5), delivered in three
phases (§6) so nothing is over-built ahead of the design (the canvas lesson). Companions:
`DESIGN_workflow_wizard.md` (the authoring flow the gallery reuses wholesale), `DESIGN_conversations.md` (§7 Rail /
Automate surfaces), `DESIGN_desks.md` (the view/desk a workflow scopes to), `DESIGN_cadence.md` (triggers keyed by
`appId` today), `DESIGN_apps_learning.md` (§10 class-owned generalization — the v1780 ruling), and CS-1 (connections
bind at desk+preset scope, v1996). Memory: `workflows_class_owned`, `desks_role_scoped_unit`.

---

## 1. The ask, and the two facts that reshape it

The request reads as a straight UI parallel: make `+ Workflow` open a gallery the way `+ View` (`_renderAppGallery`,
`chat.js:2023`) does — preset cards + a custom constructor + "yours." Two facts from the code make it more than a
reskin:

**Fact 1 — a workflow is subordinate to a view; it has no standalone identity.** A workflow *is* its storage key:
`il:workflows:<appId>` (`Services/Storage/WorkflowStore.js:12`). Both authoring doors hard-guard with *"Open a view
first — workflows are saved per view"* (`_promptWorkflowIntent` `chat.js:7430`; `_startWorkflowWizard`
`chat.js:7458`). The owning key is `_workflowClassKey() = _currentConversationAppId || _memoryId()`
(`chat.js:9735`). So `+ Workflow` "defaults to the open view" **because the open view is the only `appId` in hand** —
there is nowhere else to put it. A gallery pick still needs a home view.

**Fact 2 — there are zero preset workflows today.** Every IL workflow is user-authored from intent. There is no
curated catalog: `Core/presetMemory.js` seeds *behavior rules* (deltas), never workflows; `Core/appDef.js:139-161`
whitelists `presentation/starters/sites/baseline` with **no** workflow field; `starters[]` are one-shot quick-action
strings, not saved multi-step records. So the "presets" half of the gallery is **net-new** — a catalog module plus
actual curated templates (§8).

Together: the clean `+ View` mirror the request imagines only exists if we also decide **what a workflow is** and
**invent the preset layer.** Hence this doc.

---

## 2. Where workflows live today (the current model)

- **Shape** (`normalizeWorkflow`, `Core/workflowMemory.js:77-113`): `{ id, contentId, ask, subAsks[]≥2, name?,
  appId, steps[](body-blind provenance + pinned clause), schema(1|2), trigger?(cadence), status('ready'|'draft'),
  createdAt, updatedAt, runs, orphanedFrom? }`.
- **Store** (`WorkflowStore.js`): one `chrome.storage.local` entry per view-class at key `il:workflows:<appId>`,
  value `{ items:[…], updatedAt }` (a "bank"), capped 50/key. `listAllWorkflows()` (`:126`) sweeps every bank into a
  flat `Array<{appId, items[], orphaned}>` — **the flat list already exists as a fallback.**
- **Authoring** (`DESIGN_workflow_wizard.md`): `_promptWorkflowIntent` (`chat.js:7429`) → `_startWorkflowFromIntent`
  (`chat.js:7781`, DECOMPOSE_STEPS → the plan gate) → `_startWorkflowWizard` (`chat.js:7457`, run+approve each step)
  → `_wfDoSave` (`chat.js:7936`) → `saveWorkflow(_appId, buildWorkflowSave(...))` where `_appId` was pinned at wizard
  birth from `_workflowClassKey()`.
- **Binding to a view** (v1780, `workflows_class_owned`): keyed to the **CLASS** (`appId`), never the instance — so
  all instances of a preset share workflows and a re-created desk re-adopts them. `_railWfAddRow(desk)`
  (`chat.js:10203`) makes creation land in a chosen desk by first `_openConvFullTimeline(desk)` (`chat.js:1243`),
  which sets `_currentConversationAppId` to that desk before the wizard reads it.
- **Lifecycle drift** already needs machinery: deleting a view **orphans** its bank —
  `markWorkflowsOrphaned` (`WorkflowStore.js:153`), `_loadWorkflowsMerged` sweeps both `appId` + `instanceId` keys
  and folds orphans back in (`chat.js:9739`), the Rail re-groups banks to owners via
  `desks.find(c => c.instanceId===key || c.appId===key)` (`chat.js:10235`); ownerless banks show nowhere.
- **Cadence** (`DESIGN_cadence.md`): `FLEET_SCHEDULE` / `FLEET_ROUTINE` alarms are keyed by the same `appId` /
  `instanceId`.

---

## 3. The fork: first-class independent vs view-subordinate

"First-class independent" = give a workflow its own identity and store (its own id-space, a flat `il:workflows`
catalog) so it exists whether or not a view does.

### 3.1 Pros of first-class

1. **Gallery symmetry falls out for free.** `+ Workflow` becomes a true `+ View` mirror — top-level catalog, no
   awkward "which view?" step. The request wants this model.
2. **Reuse across views** instead of copy-per-`appId`. "Triage & tag incoming" applies to several views without
   re-authoring; today it is duplicated per class.
3. **Portability / sharing / federation.** A standalone workflow is exportable/importable — it fits the
   federation direction (`desks_role_scoped_unit`: "federate queues cross-site") and the existing publish/import
   path. A view-nested workflow can't travel alone.
4. **Cross-view / multi-site tasks get a home.** "Zendesk → cross-ref Shopify → post Slack" has no single-view
   owner today; a first-class workflow can own a multi-site scope directly (the router-over-a-tool-lattice framing,
   `project_router_over_tools`).
5. **Simpler lifecycle.** Independence largely retires the orphan machinery (`markWorkflowsOrphaned` /
   `_loadWorkflowsMerged` / re-key-and-adopt).
6. **One discoverable surface.** The flat catalog `listAllWorkflows` already assembles becomes primary, not a patch
   over scatter.

### 3.2 Cons of first-class

1. **The execution context a workflow inherits from its view doesn't disappear — it just moves.** Sites,
   connections, seed/role, memory, object model, target routing all come from the view. Detach the workflow and
   *each one* must carry or resolve all of it, pushing the binding from creation-time to **every run** ("run this
   where?") — usually worse than once.
2. **It reopens the connection/auth scope CS-1 just closed.** Connections bind at **desk+preset scope** (v1996). A
   view centralizes "these sites, signed in, scoped." Detaching risks re-fragmenting that — every workflow needing
   its own scope or borrowing a view's at run time.
3. **It discards the v1780 class-owned property on purpose** unless "which class/scope" is re-encoded onto the
   workflow anyway.
4. **Learning + safety are view/class-scoped.** The apps-learning loop (deltas, preset memory, the ratchet) and the
   safety scaffolding (safetyClass, connection trust, money=human-click) live at the class; a step's clause resolves
   against the view's grounds. Detached workflows need their own binding — more seams for a dropped safety property
   (the recurring "one of N call sites" class).
5. **Recall / routing ambiguity grows.** One global pool means disambiguating across *all* workflows and choosing a
   run context — more surface for the "unreachable clause → wrong act" risk (`unreachable_clause_safety`).
6. **Real migration cost.** The Rail grouping, the Automate tab, cadence keying, orphan handling,
   `_memoryId`/`_workflowClassKey` all assume `il:workflows:<appId>`. High regression surface against the test gate
   and much live-owed UI.

---

## 4. The two "workflow" entities (a convergence note)

There are already **two** unrelated things called "workflow":

- **IL / chat workflow (WF-1)** — the per-view record above (`chat.js`, `WorkflowStore.js`, `workflowMemory.js`,
  `workflowWizard.js`). This doc's subject.
- **Studio "Workflow" entity** — an older **first-class top-level** record with `steps[]` / `groundIds[]`, a step
  debugger + breakpoints, IndexedDB-backed via `StorageManager.saveWorkflow`, and already **publishable/importable**
  (`Services/Storage/PublicationImport.js:53`, `background/handlers/workflowDebug.js`,
  `Services/WorkflowExecutor.js`).

So a first-class IL workflow is not a leap into the unknown — it moves WF-1 **toward the shape Studio workflows
already have.** That is either a convergence opportunity (one entity, two front doors — the interrogator/director
pattern of `interrogator_read_engine`) or a divergence risk (two first-class workflow types). The chosen model (§5)
keeps the door open to convergence without forcing it now.

---

## 5. The chosen model — identity ≠ execution context

**Separate a workflow's identity from its execution context. Don't conflate "independent record" with "no scope."**

> Make the workflow a first-class record with its own id and a flat store, but have it **carry a `scope`** — the
> target view-class / sites / connections — rather than being *keyed* by the view.

- **Identity** is first-class: own id, own catalog, shown in one gallery. This buys the pros of §3.1 — clean gallery,
  one surface, portability, reuse, simpler orphan story.
- **Execution context** stays explicit and resolvable via `scope`, defaulting to a bound class and falling back to
  "run where?" **only** when a workflow is genuinely cross-view. This keeps the cons of §3.2 contained — CS-1 scope,
  learning/safety binding, and routing all resolve through `scope`.
- **v1780 survives as a special case:** `scope` can *be* a class id, so class-generalization is preserved rather
  than discarded — it becomes one shape of scope, not the only shape.

This is the "first-class in identity + presentation, scope-bound in execution" recommendation. Full context-free
independence is the right bet **only if** portable / cross-view / shareable workflows are a near-term goal; if they
are, WFG-3 (§6) becomes the point rather than a maybe.

---

## 6. The build, phased (WFG-1..3)

Never over-built ahead of the design; each phase is shippable and reversible.

- **WFG-1 — the gallery as presentation (low risk, no data-model change).** A `_renderWorkflowGallery()` mirroring
  `_renderAppGallery` (§7) reads the flat list `listAllWorkflows()` for "Your workflows," offers `+ Custom workflow…`
  (the existing intent flow), and — since presets are net-new — ships a first curated set (§8). Binding stays
  view-scoped: a pick ends with a **"add to which view?"** step (existing views + "new view" → the app gallery),
  which sets the target view current and then runs the *unchanged* authoring flow. Behaviorally identical to today's
  save path; new UX only. This alone satisfies the request.
- **WFG-2 — flatten the store + add `scope` (the real migration).** Move from `il:workflows:<appId>` to a flat
  `il:workflows` store; each record carries `scope`. Migrate existing banks (scope = their old `appId`). Re-point the
  Rail grouping, Automate tab, cadence keying, and `_workflowKeys`/`_loadWorkflowsMerged` to read `scope`. The
  orphan machinery mostly retires. Gated on WFG-1 having proven the model live.
- **WFG-3 — cross-view / multi-site scope + export/import (the federation payoff).** `scope` gains multi-site /
  cross-view shapes; the export/import path (converging with the Studio entity, §4) makes a workflow a shareable
  artifact. Built **only** if federation is the near-term goal.

---

## 7. The gallery (WFG-1 detail)

Mirror `_renderAppGallery` exactly — same surface, same card idiom (the explorer map is the build spec):

- **Surface:** timeshare the empty-state skeleton (`chat.html:137-149`): clear+hide `#messages`, un-hide
  `#empty-state`, set the greeting ("Add a workflow") + subtitle, repopulate `#suggestion-cards`. Not a modal, not a
  claimed composer — an imperative repaint, re-invocable, with explicit re-renders at mutation points (the app
  gallery's pattern, incl. its self-re-render after a delete, `chat.js:2198`).
- **Sections, in order:**
  1. **Preset cards** — `<button class="suggestion-card">` per `galleryWorkflows()` (§8): name / description /
     a `suggestion-card-meta`>`suggestion-card-kind` "suits" line. Click → the "add to which view?" step, then seed
     the intent + steps into the plan gate.
  2. **`+ Custom workflow…`** — `<button class="suggestion-card suggestion-card-preset">` → the step-by-step
     **builder** (`_startWorkflowWizard()`, WW-1b) in that view. (As-built: scoped, no picker; user direction — the
     builder, not the describe-it `_promptWorkflowIntent` intent door.)
  3. **`Your workflows`** — a `suggestion-section` divider, then one card per `listAllWorkflows()` item, each labeled
     with its owning view (resolve `appId`→desk title); click opens/runs. `<div role="button" tabindex="0">` + a
     nested delete button (the "Your views" a11y pattern), else `<button>`.
- **The "add to which view?" step** — a sub-render of `#suggestion-cards` (like `_renderNewDeskChooser`,
  `chat.js:2073`): existing views (recency-ordered) + a "+ New view" card (→ app gallery) + "← Back". A one-shot
  handoff var (mirror `_pendingExtend`, `chat.js:2072`) carries the chosen preset/intent through view selection into
  the authoring flow, and survives a panel reload via the setup stash.
- **Entry points** repointed to `_renderWorkflowGallery`: the Automate-tab `+ Workflow` rows (`_railWfAddRow`,
  `chat.js:10203` — the CN-1.2 per-view rows become "browse the gallery, pre-scoped to this view"), and optionally a
  top-level rail row + an `IL_PANEL_LEGS` leg (mirror `NEW_CONVERSATION`, `chat.js:11559`).
- **a11y:** `<button>` for any card without nested interactive children; `<div role="button" tabindex="0">` + keydown
  only where a delete button nests. All user text through `escHtml`.

---

## 8. The preset catalog (net-new)

Mirror `Core/appCatalog.js` with a new pure module `Core/workflowCatalog.js`:

- **Preset shape:** `{ id, name, description, ask, subAsks[]≥2, suits?:{types?[],sites?[]}, schema:1 }` — a
  *template*, not a saved record: it pre-fills the authoring flow's `ask` + steps; the user still runs the plan gate
  and approves each step (so no unapproved clause ever banks — the PP-0c safety argument holds unchanged). `suits`
  is advisory only (pre-selects a matching view in the "add to which view?" step).
- **Gallery membership = one field**, exactly as `preconfiguredDesks() = builtinPresets().filter(p=>p.sites?.length)`
  (`appCatalog.js:247`): `galleryWorkflows()` filters the catalog. Promoting a template is one data edit.
- **Shipped set: EMPTY at v2.74.2009 (user direction); FIRST template landed v2.74.2023.** The four proposed
  starters ("Daily digest of new items," "Triage & tag incoming," "Weekly summary," "Follow up on stalled items")
  were removed — they were guesses, and each real template is to be built and proven one at a time. The first
  proven one is **`warranty-shopify-customers`** ("Warranty → Shopify customers"): read new warranty tasks across
  every division → per-task map to the homeowner's Shopify customer (contact enrichment rides the map's
  drill+sidecar, not a separate step) → create customers for the unmatched. Landed only after every step verified
  live (2026-08-05: map 16 matched/2 no-match/0 failed at 14:05Z; create `1 created, 0 blocked` and the new
  customer matching on re-lookup at 14:45–14:49Z). Its subAsks are the exact phrasings from those traces.
  *(WFG-2, v2.74.2024, user direction: a template pick now ADDS the workflow directly — banked `ready` with
  preset provenance, visible in the Automate tab, `WF_PRESET ▸ added` — instead of seeding the wizard. The
  wizard remains the path for hand-written plans via "+ Custom workflow…".)*
- **User layer** (mirror `Core/userCatalog.js`): "Your workflows" already comes from `listAllWorkflows`; no new store
  needed for WFG-1. A saved workflow promoted to a *shared template* is a WFG-3 concern.

---

## 9. Invariants this touches / must not break

- **v1780 class-owned** — preserved as a `scope`-shape (§5); WFG-1 does not touch keying at all.
- **CS-1 connection scope (v1996)** — a scoped workflow resolves connections through its `scope`'s desk+preset; do
  not let a first-class workflow acquire an independent connection scope in WFG-1/2.
- **PP-0c step safety** — presets pre-fill intent only; every step still runs the approve gate. No preset ships a
  pre-approved clause.
- **Cadence keying** — WFG-2 must re-point `FLEET_SCHEDULE`/`FLEET_ROUTINE` off `appId` onto `scope` in lockstep, or
  triggers orphan.
- **Injection boundary** — preset text is trusted (shipped), but "Your workflows" labels derive from user asks →
  stay on the `escHtml` render path.
- **Invariant #4 (chat intercepts claim at ENTRY)** — the gallery is a render, not a `sendChatMessage` intercept; the
  authoring flow it hands off to already obeys #4.

---

## 10. Open decisions

- **A — binding model for WFG-1. RESOLVED (user direction): SCOPED.** The per-view "＋ Workflow" is the single
  entry and opens the gallery pre-scoped to its view; no unscoped top-level entry, no "add to which view?" picker (a
  workflow is always added under a specific view). The standalone-gallery + picker option was built then removed.
- **B — the preset set. RESOLVED (user direction, v2.74.2009): ship the WFG-1 shell with NO presets.** The curated
  starter set was built, then deleted: templates get authored one at a time rather than guessed in a batch. The
  gallery is "+ Custom workflow…" + "Your workflows" until the first hand-built template lands in §8's catalog.
  *(That happened at v2.74.2023: `warranty-shopify-customers`, proven live before landing — see §8.)*
- **C — how far to go now.** Recommended: **WFG-1 only** (delivers the request, zero data-model risk), then decide
  WFG-2/3 from live use. Full first-class independence (WFG-3) is worth committing to now **only if** cross-view /
  portable / shareable workflows are a near-term goal.

---

## 11. Editing after creation — WFG-1e (specced 2026-08-06, user: "workflows should be editable after creation")

**The design law — the PROOF SPLIT.** A saved step is not text: schema-2 steps carry PINNED CLAUSES proven by
run+approve (PP-0c — nothing banks unapproved). Every edit therefore classifies by what it does to proof, and the
classification decides its SURFACE:

| Edit | Proof | Surface |
|---|---|---|
| rename · description/ask | untouched | in place, on the card |
| remove a step · reorder steps | pins ride their steps — preserved | in place, on the card |
| **rephrase a step · add a step** | **broken/absent — must RE-PROVE** | **the builder** |

The card must never be able to silently un-prove a step; the builder is where proof is made, so it is where
proof-breaking edits go.

**A — the backbone: ✎ Edit opens the BUILDER, pre-loaded.** The workflow card (and its "Your workflows" gallery
twin) gains an ✎ chip → opens the step-by-step builder in the workflow's OWNING view, seeded with the saved
record: `w.steps` = the proven steps, `w.draftId = wf.id`, name/ask/cadence carried. An added or rephrased step
RUNS AND IS APPROVED exactly as wizard steps always are; Save flows through the wizard's existing
`draftId → updateWorkflow` branch. Mechanically this is the WW-1b draft-resume path made explicit — the wizard
learns nothing new.

**B (slim) — proof-preserving edits stay in place** (the RB-6c realtime doctrine): inline RENAME on the title;
✕ remove-step and ↑↓ reorder in the pinned detail — direct `updateWorkflow`, in-place confirmation, unforced
truth-repaint on disengage. Text editing is deliberately NOT offered here.

**Contract:**
- `id` persists across every edit (`updateWorkflow`, WW-1 v1610) → schedule, run history, and bound routines
  survive by construction; `contentId` recomputes at save (the edit-detector) — exactly the split the store was
  built around.
- **No edits while a run is parked or in flight.** A parked resume replays from `stepIndex` against the step list
  it parked with; editing underneath corrupts the resume. The ✎ disables with an open ✋/live run (tooltip names
  why); alternatively the edit flow offers to cancel the park first.
- **Partial re-proof saves honestly:** `buildWorkflowSave`'s existing rule — `status:'ready'` only when ALL steps
  are approved — makes an incompletely re-proven edit save as `draft`, visibly.
- Deferred by name: conversational editing ("swap step 2 for…" — reachability/ambiguity, its own pass) and any
  step-level re-pin without a re-run (a PP-0c breach, never).

**Status:** SPECCED, not built. Cost at build time: A ≈ ½ day (seed function + ✎ chip + parked-guard) · slim-B ≈
½ day (three in-place ops + tests) · no storage or schema change.

## 12. Stopping an in-flight run — PAUSE (⏸, the card verb) + ABORT (terminal) — WFP (specced 2026-08-07)

*(History: v1 of this section specced abort-only (◼) and survived one adversarial pass; the user then ruled the
card's ▶ should become ⏸ in flight ("Run this workflow is a good candidate for pause"), and a second 4-lens
adversarial review of that direction found a FATAL + 4 HIGH in the naive reuse story. This section is the
corrected pause-first spec; every subsection that exists because of a review finding says so.)*

### 12.1 The two verbs

**Pause (⏸)** — the card's in-flight verb: a request latched onto the RUN, honored at the next **clause**
boundary, that ends the run as a **user-minted park** — `stepIndex` + `chainState`, resumable, the same record
shape the write gate mints. **Abort** — the terminal verb: typed `stop` (panel runs) and **✕ discard from the
paused state** (both tiers). While running you can only ⏸; the terminal act happens from the paused card. Both
verbs latch and honor at boundaries — the current atomic action always finishes
(DESIGN_background_agents.md:247), so ⏸ loses no halt latency vs the dropped in-flight ◼.

This SUPERSEDES §12.1-v1's "a user-initiated resumable ⏸ stays gate-minted only / remains the roster arc's
item": the per-workflow half of that item arrives HERE. DESIGN_background_agents.md keeps Pause-ALL / Exit-all /
the panic key (roster controls, fan-out to these latches when built). And the doctrine stands: a pause or abort
is **a user act, never a drift signal** — no failure strike, no `failedStep` pollution, trigger exactly as armed
as it was found.

### 12.2 The tier split — the FATAL the review caught, stated as architecture

The naive design ("pause exits through runDriver's park path; resume = WORKFLOW_RESUME_PARKED, which exists")
is true ONLY for the SW tier. The panel ▶ runs `_orchRunChain` (chat.js:10797) — it never touches runDriver,
mints no park records ("an interactive run never parks", DESIGN_cadence.md:425), and `WORKFLOW_RESUME_PARKED`
resumes through `_fire`'s headless executor, which runs only pinned fieldRead/map/write/ride steps
(cadence.js:452-468) — a resumed panel-tier workflow would fail every branch/case/walk/unpinned step. So:

- **The park record gains two fields: `kind: 'gate' | 'paused'` and `tier: 'panel' | 'sw'`.** Both are minted
  where the park is minted, never inferred from the latch (a gate park can fire while a pause is latched — the
  gate cause wins the record; see 12.3).
- **SW tier** (cadence fires, headless runs): `runWorkflow` gains a `shouldPause` opt distinct from abort's
  `shouldStop`; a hit exits through the EXISTING park path with a `pauseCause` on the result — `r.park` is a
  step-result field and must NOT be overloaded (§12.3-v1's "driver return-contract change" lesson, mirrored).
  `_fire`'s park branch stamps kind/tier from the cause. Resume: `WORKFLOW_RESUME_PARKED`, which gains a tier
  check — it refuses `tier:'panel'` records (routes the caller to the panel path) instead of silently failing
  their steps headless.
- **Panel tier** (card ▶ runs): TWO new pieces, and they are the real cost of this feature. (1) A park-mint:
  the chain's pause exit banks {stepIndex, chainState, kind:'paused', tier:'panel'} via a new SW message (the
  parked store is SW-owned). (2) A return contract: `_orchRunChainInner` returns void on every exit today
  (chat.js:9754), so the card's `.then()` would mark all chips done and `_wfRecordPanelRun` would write a lying
  positional history row — the chain must return `{paused: true, atStep}` (at minimum) and the card handler
  branch on it. Resume: the panel re-runs the card chain with `_orchRunChain`'s EXISTING `startIndex`/`state`
  seam (chat.js:9725, the `_resumeAfterDemo` path) — never through `_fire`.
- **Honest state caveat:** the panel chain's state carries scaffold keys (`readouts`/`ranSteps`/`policyConfig`)
  the SW state lacks; the panel park banks the PANEL shape and only the panel resumes it. The two shapes share
  map/write keys but are not interchangeable — the `tier` field is what keeps each resume on its own executor.

### 12.3 Poll points and latch discipline (review: duplicate-writes + latch-collision)

**Pause polls between CLAUSES only.** The abort spec's between-rows poll points (map/write `onRow` seams) are
ABORT-ONLY: a pause honored mid-write-step parks at the step's index with the full miss list still in
`chainState`, and resume re-enters `runWriteStep` from row 0 — rows 0..k created TWICE (the park record has no
row cursor; gate parks are safe only because they park BEFORE the create loop, headlessWrite.js:150). The
worst-case pause latency is therefore one whole step (a 25-create write, a 121-row map); the escalation for
"stop NOW" mid-step is typed `stop` (panel) or wait-for-the-park-then-✕ (headless) — stated as the deliberate
trade, not an oversight.

**Two latches, strict precedence.** The pause latch is a SECOND flag/key, never the abort latch reused — panel:
`_walkAbortFlag` cannot encode two verbs (it is one boolean, chat.js:11765); SW: `cadence:abort:<runId>` and
`cadence:pause:<runId>` are separate keys (both runId-scoped, both own-key so the ≤1/60s heartbeat re-stamp of
the RUN marker cannot erase them — the v1 marker-field design died on exactly that overwrite,
`_stampRunMarker` cadence.js:90). Rules, each one a bug if unstated:

- **Abort beats pause at every poll** — both latched, the boundary honors abort; an honored abort clears the
  pending pause for that runId.
- **A gate park beats a pending pause at the same step** — the gate's record (kind:'gate', with preview) is
  minted; the pause latch is consumed without effect. Safe-but-two-clicks beats a preview nobody saw.
- **Latches reset at RUN START only** (`_orchRunChain`'s `if (!state)` reset, chat.js:9739, extended to both
  flags) — the executor entry-resets of `_walkAbortFlag` are SCOPED to standalone runs (`inChain:false`), the
  WFP build's first panel change: mid-chain they erased a stop pressed during the preceding clause's INTERPRET
  roundtrip, after which a write step creates up to 25 rows the user already refused. *(Build-verify correction:
  there are FIVE such executors, not the four this spec first enumerated — `_runWriteClause`, `_runMapClause`,
  `_runBranchClause`, `_runFieldReadClause`, and `_runCaseClause`, whose miss would have spawned the cases the
  user refused. Launchers that pass shared state — the thread-replay ▶ and the wizard step-runner — reset the
  pause latch themselves, since the chain-level fresh reset never fires for them.)*

### 12.4 The button, honestly (review: toggle mechanics ×4)

- **No `data-icon` swap.** The WFC-5 always-visible CSS is keyed to `[data-icon="run"]` (chat.css:2137) and the
  due auto-runner FINDS the button by it (chat.js:11158); there is no pause glyph and `_mkIconBtn`'s fallback
  renders ✕ — "discard" in this very spec's vocabulary. The button keeps `data-icon="run"` and gains
  **`data-run-state="" | "running" | "pausing"`** (the `data-sched` state-attribute pattern, chat.js:10838);
  innerHTML/aria-label/title swap together on state change.
- **Per-card run-live branch BEFORE the WFC-1 refusal.** Re-enabling the once-guarded ▶ mid-run routes the
  second click into `_railBusyHeld()`'s refusal — which flashes "blocked" on its OWN card (the live-card
  selector finds itself). The handler's first check becomes: this card running → ⏸ semantics; another card
  running → the existing refusal; else → launch.
- **"pausing…" is a named third state.** ⏸ click: latch + `data-run-state="pausing"` + button DISABLED + the
  run-bar tick flips to "pausing at the next step…" (RB-6c in-place, the ◼ precedent) — a second click in the
  latch-to-boundary window (seconds — an INTERPRET roundtrip) has one honest meaning: nothing. An arming grace
  (~300ms) between ▶ and the ⏸ branch keeps a double-click from becoming run+instant-pause.
- **The paused state must LAND under the pointer that clicked ⏸.** The `WORKFLOW_PARKED_CHANGED` re-render is
  unforced and the user is by definition hovering the card — on Conversations the deferral has NO ceiling
  (chat.js:1074), on Automate a 30s one. The pause exit confirms in place in the run host AND the follow-up
  render is **forced** — a user action is entitled to a forced land (the v1816 rule, chat.js:1046).
- **▶ while a pause-park is open = RESUME, and all three run doors check open parks.** `_hasOpenPark` guards
  only the SW tick (cadence.js:205); the panel due-on-open auto-runner (`_maybeAutoRunDueWorkflowCard`,
  chat.js:11153 — clicks ▶ off `data-due` with no park check), the human ▶, and `WORKFLOW_RUN_FIRE`
  (cadence.js:636) all bypass it — a paused workflow would auto-restart from step 0 at its next due-time
  beside its own open park (invisible today only because parks are SW-minted; pause mints the first panel
  parks). The card's ▶ on a paused workflow resumes the park (same lineage, never a fork); the auto-runner and
  RUN_FIRE skip park-open workflows outright.

### 12.5 One story on every surface (review: the kind-blind funnel, six sites)

`kind` threads through the WHOLE park funnel, not just the card face — the review verified six sites that
narrate gate vocabulary for any park:

| site | gate park (unchanged) | paused park (new) |
|---|---|---|
| park-mint history why (cadence.js:353) | "a write step needs approval" | "paused by you at step k of N" |
| `_cadencePresence` (cadence.js:499) | badge + OS notification "Scheduled run needs approval" | **neither** — the user just clicked ⏸; notifying them of their own act is noise |
| ✋ row copy (chat.js:10934/10939) | "a write that needs your approval" + preview | **no row at all** — see the card ruling below |
| resume meta (chat.js:10966) | "sent — the run continued…" | "resumed from step k" |
| ✕ history (CANCEL_PARKED, cadence.js:724) | 'partial' + "parked write cancelled by the user" | "stopped by you at step k of N"; verdict **'partial'** if work ran, **'empty'** if the pause landed before step 1 |
| ✕ confirm copy (chat.js:10981) | "cancelled — the write was not sent" | "discarded — nothing more will run" |

**The paused surface is the CARD, never a second row (user ruling, live 2026-08-07: "this should be handled by
the workflow card in question").** The v1 build rendered a paused park as a ⏸ variant of the ✋ needs-action row —
a duplicate surface one row from the card that owns the run (and its forwarded ▶ was dead on first live use).
Corrected: the "Needs approval" group holds GATE parks only; a paused park renders as card STATE —
`data-paused` (quiet left rail + at-rest ✕ visibility), the meta line names the bookmark ("⏸ paused by you at
step k"), the card's ▶ reads "Resume from step k" (the WFP-5 handler branch), and a ✕ discard chip sits in the
card's own action cluster (direct CANCEL_PARKED, the battle-tested gate path).

`kind` is a REAL FIELD on the park record and on `runHistoryEntry`'s whitelist (Core/runHistory.js:161 — a
closed constructed literal; branching UI on why-prose minted at two different sites is the documented
closed-whitelist trap, DESIGN_cadence.md §11.5). **A kind-less record (every legacy park in chrome.storage)
defaults to `'gate'`** — the wrong default resumes a gate park with the normal reporter, whose gate() always
returns 'park': ✓ Approve re-parks the same write forever, the v2.74.2043 live defect verbatim
(headlessWrite.js:120-126). Resume-reporter selection: `kind === 'paused'` → normal (accumulator) reporter — a
resumed pause must never inherit `makeResumeReporter`'s first-gate-true, or resuming a run paused at step 2
silently approves an unseen write at step 4; anything else → `makeResumeReporter`.

### 12.6 What pause preserves — and what it does not (review: the honesty note)

Preserved: `stepIndex`, `chainState` (per-tier shape), the workflow's trigger state. **Dropped: the driven-tab
binding, any intra-step row position, all live DOM context** — resume re-resolves the active tab
(`_orchActiveTab`), so a nav/walk step after a long pause can target a different site than the run started on.
This is deliberately BELOW DESIGN_background_agents.md's Pause-all bar ("scope + open tabs + DAG position
preserved", :245) — that bar needs the roster arc's scope machinery; this pause is the card-sized version, and
the paused-card copy should not promise more than "resume continues from step k".

### 12.7 Abort, revised to fit (what remains of WFA)

- Typed `stop` stays the panel's terminal verb (reach: live runs via `_planLive`; the §12.3 entry-reset removal
  is what makes it reliable mid-chain). Against an already-PAUSED run it is a deliberate no-op — the run is not
  in flight; the terminal act there is ✕. Say so in the stop reply ("nothing running — 'Warranty…' is paused;
  discard it from its card").
- The in-flight card ◼ is DROPPED (superseding §12.4-v1 items 2-3 and the WFA-3/4 ◼ rows): one in-flight verb.
  A headless run's terminal path is therefore two-click (⏸ → boundary → ✕) — deliberate; cessation-of-driving
  latency is identical to ◼'s (same boundaries), only the second click is added.
- `WORKFLOW_ABORT_RUN` + `cadence:abort:<runId>` are DE-SCOPED to the panic-key fan-out (Exit-all,
  DESIGN_background_agents.md:259) — with the card ◼ gone they have no specced sender; build them when the
  panic key lands, on the runId-keyed-own-key pattern §12.3 already pins down.
- Abort verdicts (when the panic key or typed stop lands one): `aborted: true` result FIELD (never a new
  verdict word — `runHistoryEntry` coerces unknowns to 'failed', runHistory.js:164); history 'partial' +
  "stopped by you at step k of N" (ran > 0) or 'empty' (nothing ran); never a failure strike. The pipelineRun
  precedent is real but narrower than it looks: `closeRun({aborted})` folds to 'partial' only when ≥1 item
  settled — a pre-settle abort reads 'failed' today (pipelineRun.js:159 precedes the :161 fold), a known wart
  of the panel each-run path, not a pattern to copy.

### 12.8 Observability

`STOP ▸` family throughout (Core/decisionMarkers.js:57 — decisions-visible by reuse, invariant #1): one line at
latch ("pause requested for '<name40>'"), one at honor ("paused at step k/N (run <runId>)" / "aborted at …"),
one at resume ("resumed '<name40>' from step k"). A request the run outran is visible as request-without-honor.
CADENCE ▸ lines unchanged.

### 12.9 Build list — WFP-1..6 (SPECCED, not built; order matters)

| # | what | size |
|---|---|---|
| WFP-1 | latch discipline: remove the 4 executor entry-resets; second pause flag; abort-beats-pause; run-start-only reset (panel). Typed `stop` becomes reliable mid-chain — shippable alone | ~¼ day |
| WFP-2 | panel chain return contract (`{paused, atStep}`) + pause exit + park-mint message (kind/tier) + honest card `.then()` branch | ~1 day |
| WFP-3 | the button state machine: `data-run-state`, per-card branch before WFC-1, "pausing…" state, arming grace, forced post-pause render | ~½ day |
| WFP-4 | kind/tier through the funnel: park record + runHistoryEntry whitelist + the six copy/notification sites + legacy-default-'gate' + kind-aware resume-reporter + RESUME_PARKED tier check | ~1 day |
| WFP-5 | park-open checks at the three run doors; ▶-resumes-open-park on the card | ~½ day |
| WFP-6 | SW tier: `shouldPause` + pauseCause through runDriver (clause-boundary only) + `cadence:pause:<runId>` key + `WORKFLOW_RUN_STATE` broadcast + headless card ⏸ (depends on the broadcast — build it first within this rung) | ~1 day |

WFP-1 is independently valuable today. WFP-2..5 are the panel pause (the surface the user named). WFP-6 is the
headless half and can trail. Core changes (runDriver/runHistory/pipeline) are testable headless; the button,
fences, and copy need live eyeballs — the bus test at build time: `[human]` pause a 3-step run at step 2,
resume it, then discard a second paused run, checking history reads "paused by you" / "stopped by you".
