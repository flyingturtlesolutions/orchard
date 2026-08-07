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
