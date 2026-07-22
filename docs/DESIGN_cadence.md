# DESIGN — Cadence (time-triggered workflows)

**Status:** specced 2026-07-22, nothing built. Supersedes `DESIGN_workflow_wizard.md` §4.1/§4.4 (see §1.2).

**Thesis:** a cadence is not a thing. It is a **field on a workflow** that says when the workflow runs by itself.
Everything else this document specifies is the workflow surface growing up to carry that field honestly — always
reachable, intent-composed, manageable, and auditable.

---

## 1. The ruling: cadence is a FIELD, not an ENTITY

### 1.1 Why the entity design was rejected

The obvious reading of the pain points — schedules are invisible, orphaned, un-pausable, unauditable — is that a
schedule wants to be its own object with its own store, its own roster surface, and its own lifecycle. That design
was drafted and rejected, and the reason matters more than the conclusion:

**The orphaning is not caused by cadence being an attribute. It is caused by `chrome.alarms` holding a reference
nothing collects.** `background/handlers/fleet.js` mints one alarm per desk per kind (`fleet-sweep:{instanceId}`,
`fleet-routine:{instanceId}`) and the desk-delete path clears neither. Promoting the schedule to an entity would
not have fixed that; it would have added a store, a surface, and a lifecycle *around* a bug whose fix is one line
of clock architecture (§2).

Diagnosing a leaking reference as a modelling error is how a one-line fix becomes a subsystem. The workflow
already has an id, a store, a card, a launch page, and a run path. A trigger is a fifth field on a record that
already exists.

### 1.2 What this supersedes

`DESIGN_workflow_wizard.md` §4 designs routines as first-class desk objects keyed `routines:<instanceId>`, with
the surface as "a block in the desk's workflows view". **Do not build RT-0 as written.** Two reasons:

1. **The key is wrong.** `instanceId` is the desk. A workflow already survives desk deletion (stamped
   `orphanedFrom`, `chat.js:1019`); a trigger keyed by the desk does not, and an alarm keyed by the desk outlives
   both. Key the trigger by **workflow id** and it travels with the thing it describes.
2. **§5 of that same document already broke §4.1 without noticing.** It says vitals' clocks should register as
   `source:'system'` routines "visible in the same list, same vocabulary" on the Admin desk. Desk-keyed storage
   and a shared cross-desk list cannot both be true. That inconsistency is latent in the spec and disappears once
   the trigger belongs to the workflow.

RT-0 → RT-4 collapse into: add a trigger field, add a scanner, park writes, surface history. §11.

---

## 2. The clock: ONE SCANNER, never an alarm per workflow

**Rule: there is exactly one repeating alarm for triggered workflows. It wakes, scans workflow records, and fires
the ones that are due.**

This is the vitals model, and vitals adopted it by absorbing the mistake this section forbids —
`background/handlers/vitals.js:246`:

> `try { chrome.alarms.clear('conn:heartbeat'); } catch { /* absorbed (VT-1) — one clock owner */ }`

and `DESIGN_vitals.md`: *"the freshness WINDOW is the cadence; the tick is just the scanner."* Fleet deliberately
went the other way, and fleet is where the orphaned alarms are.

What one clock owner buys, all of it structural rather than disciplinary:

- **Nothing to orphan.** There is no per-workflow alarm, so deleting a workflow or a desk cannot leave one behind.
  A scanner simply stops finding the record.
- **One place decides validity.** "Is this workflow still real, still armed, still owned by a live desk?" is
  answered once per tick, in one function, rather than in N independently-registered listeners.
- **Cheap N.** A hundred triggered workflows is a hundred rows in a scan, not a hundred alarm registrations
  against a platform quota.

**Do not** register an alarm at arm time and clear it at disarm time. That is the fleet pattern and it is the bug.

### 2.1 What the scanner must check per row

In order, cheapest first — every one of these is a reason NOT to fire:

1. the workflow record still exists
2. `trigger.enabled` is true
3. the trigger is due (`nextDue <= now`)
4. the owning desk still exists — else **auto-disarm** and write a history entry (§6) saying so
5. no run of this workflow is already in flight (§7.2)

A row that fails 1–3 is silent. A row that fails 4 or 5 writes history, because a person will later ask why it
stopped.

### 2.2 The run must not need the panel — extract the driver, inject the reporter

**Rule: the side panel is the CONTROL and REPORTING surface. It is not the execution engine. Once a workflow is
built it runs regardless of panel state.**

An earlier draft of this document deferred headless execution, citing `DESIGN_workflow_wizard.md` §5 —
*"Pretending one executor exists would make scheduled workflows silently fail with the panel closed."* **That
quote describes how the code is currently arranged, not what the platform permits, and this document repeated it
as though it were a limit.** It is not. The evidence is already in the tree:

- **Every heavy stage already runs in the service worker.** `INTERPRET_ASK` (the routing LLM call,
  `background/handlers/sg.js:1519`), `CLASSIFY_BRANCH_ITEMS` (sg.js), `DECOMPOSE_STEPS`
  (`background/handlers/pipeline.js`), and ride execution `INVOKE_SESSION` (`background/handlers/connector.js`)
  are all SW handlers. The panel is not doing that work — it asks the SW and renders the reply.
- **The SW already orchestrates a multi-step run headlessly.** `runHeadlessSweep`
  (`background/handlers/fleet.js:188`), whose own header states the destination: *"Headless orchestration mirrors
  chat.js `_runFleetSweep` … candidate for a shared Core sweep-driver with **injected IO** once both are proven."*

So what actually blocks it is **coupling, not capability**: the chain runner and every clause runner take a `msg`
DOM element and write into it (~723 `_setMessageBody` / `_orchFinalize` / `_ilBusy` call sites in chat.js).

**The move:** lift the chain runner into a Core driver that takes an injected **reporter** instead of a DOM
element. Two implementations of one interface:

| Host | Reporter | Behaviour |
|---|---|---|
| panel | DOM reporter | renders live into the thread, exactly as today |
| service worker | history reporter | writes §6.3 entries; renders nothing |

This is the treatment the whole `Core/` layer already received and the chain runner never did — every decision
core takes injected dependencies by design (`makeBranchEvaluator({evaluate, scope, lookup})`,
`runUpsert({find, create, act})`). The driver is the last piece still holding its own IO.

**Two real constraints, neither a wall:**

- **MV3 evicts the service worker** after idle. The fleet sweep already runs 121 invokes over ~17s in the SW, and
  §8's parked-run model already persists `chainState` — so the checkpoint primitive a resumable long run needs is
  the same one parked writes require. Build it once, both get it.
- **Steps that need a human.** Not a blocker: §8 already rules that a non-interactive run reaching a write
  **parks** rather than prompting. Teaching a step by demonstration stays panel-bound, but that is AUTHORING, not
  running — a workflow is only schedulable once its steps are qualified.

---

## 3. Entry points — a workflow surface you can always reach

The workflow machinery is good and effectively hidden. Both entry points below exist to make "where are my
workflows" answerable from anywhere, which is most of what the "invisible schedules" complaint actually was.

### 3.1 The Rail desk card grows a workflow icon

Every desk row in the Rail carries a workflow glyph; clicking it opens that desk's workflows page. The Rail row is
the only always-visible per-desk affordance, so this is the load-bearing one.

**The Front desk takes workflows** (ruled 2026-07-22). It takes no CASES by rule (`DESIGN_desks.md`) and that
stands — cases are opened *on* an item under a role, and Front has no role. Workflows are different: a saved
ask-chain need not belong to a role, and excluding Front would mean a user with no desks yet cannot build one at
all. Two consequences follow:

- the glyph is **unconditional** — every row in the Rail carries it, with no special-casing for the fixtures
- there is no such thing as a role-less workflow with nowhere to live, which is what would have quietly re-created
  the cross-desk roster §12 rejects

### 3.2 "workflow" resolves through the front door — as a LEG, not an intercept

A regex intercept on the composer is the wrong mechanism and CLAUDE.md invariant #4 plus
`DESIGN_target_routing.md` §8 both push against new pre-door branches.

**Add `OPEN_WORKFLOWS` as a `domain:'self'` leg** in `Core/palette.js`, beside `OPEN_CASE` / `LIST_CASES` /
`REVIEW_QUEUE`. Then "workflow", "show my workflows", and "what runs automatically" all resolve through the normal
router with no regex — **and the step decomposer sees it too**, which is the lesson v1689 paid for: a capability
absent from the catalog is not unavailable, it is silently substituted.

---

## 4. Composition — intent first, wizard as the destination

The `＋ Workflow` card no longer opens a blank first step. The sequence is:

```
＋ workflow → intent typed in the message input → builder proposal (N steps) → "use these N steps" → stepwise wizard
```

The stepwise wizard is **not** demoted and **not** a fallback. It is where the approved plan is executed and
qualified, one step at a time, exactly as today — only its steps arrive pre-populated instead of typed blank.

### 4.1 Two rejection loops, at two different altitudes

These already exist separately in code and must not be merged:

| Reject what | Goes where | Machinery |
|---|---|---|
| the **plan** | back through decomposition, carrying the rejection forward so the re-split does not repeat itself | `stepRejectionContext`, `rejectedSteps`, `buildResplitMessages` |
| a **step** | stays inside the wizard — show-me / reattempt / change the step | `stepBarClass`, `_wfShowMe`, `_wfRunStep` |

Collapsing them would send a bad step back through decomposition, which re-derives a plan the user already
approved.

---

## 5. The saved workflow card

Three action icons plus a card body that is itself a target:

| Target | Action |
|---|---|
| **run** icon | launches the workflow — unchanged behaviour |
| **delete** icon | deletes the workflow; **confirmation required** |
| **edit** icon | opens the step list: add / delete / reorder steps, and set or change the trigger |
| **card body** | opens the run-history overlay (§6) |

Run is an icon and not the card body. That is deliberate: once a workflow can fire on a clock, an accidental
manual run is a more expensive misclick than an accidental open.

---

## 6. Run history — an overlay, and its own store

### 6.1 Why history is NOT the desk timeline

Two independent reasons, either of which is sufficient:

1. **The desk conversation is deletable.** `ConversationStore.delete` removes the conversation and its children.
   An audit trail inside a deletable container is not an audit trail. (This is the same failure class as §1.1 —
   durable state keyed to something disposable.)
2. **Triggered runs would interleave with a live conversation.** A workflow firing at 09:00 writing into the desk
   thread interrupts whatever the person is doing there, and several triggered workflows on one desk turn the
   thread into a log. This is CLAUDE.md invariant #2 one layer up: engine-driven output must not pollute a surface
   whose value is the human's own trail.

### 6.2 The surface

Clicking the card body opens an **overlay on the timeline**:

- workflow name + the action icons from §5 + a **close** icon, pinned to the top
- a **scrollable list of run entries** below
- close returns to the card view — the overlay expands to fill the view and contracts back

**Reusable today:** the takeover/restore mechanism. `_wfEnterPage` / `_wfExitPage` (`chat.js:5492`, `:5496`)
already hide `#messages`, show the page slot, and restore the thread or the launch page on exit. That is
open/close, working.

**New:** the motion. There is no height/transform transition in `chat.css`; the wizard's swap is a hard toggle.
Expand-to-fill-then-contract is new CSS.

**Structural note.** The page slot now has three consumers — empty state, wizard, workflow history. The Rail is
the cautionary tale: no section registry, every fixture hand-coded in two coupled places, so adding a third means
editing both. Introduce one explicit "which page is showing" value rather than a third ad-hoc `classList` toggle.
It is cheap now and it is the exact debt the Rail is carrying.

### 6.3 The store

History cannot be conversation messages, so it is its own store keyed by **workflow id** — the vitals sidecar
shape (`DESIGN_peritem_pipeline.md` §9.3: *"real state in an owned store"*) minus the conversation shell.

One entry per run:

```
{ at, trigger: 'auto' | 'manual', verdict, counts, parkedRunId?, why? }
```

- `trigger` is the auto-vs-manual stamp, and it is the discriminator the whole surface exists to show.
- `verdict` reuses `Core/pipelineRun.js`'s run verdict — which already exists and is **unused on every scheduled
  path today**. That is most of "auditable history" already built.
- `parkedRunId` points at the case (§8) when a run stopped for a human.

**Row granularity is RUN-level** (`09:00 · auto · 22 items · 6 matched · 2 parked`). Per-item detail already lives
in `pipelineRun` records and parked cases; a row points at them rather than inlining them.

### 6.4 Retention — bounded per workflow, and never silently

"Auditable" and "silently evicts" cannot both be true. The cautionary tale is the action ledger, already
disqualified as run state in `DESIGN_peritem_pipeline.md` §9.2: cap 500 shared across all kinds, so a per-item run
*"starts evicting its own earliest entries near N≈150"*.

Therefore: **the cap is per workflow, not global**, and when it bites the surface says so —
*"showing the last 50 of 214"* — rather than presenting a truncated list as a complete one.

---

## 7. The trigger

Set in the builder **after the workflow is named**, via an optional "add schedule" step, and editable later from
§5's edit icon. Naming-first is not cosmetic: `Services/Storage/WorkflowStore.js` already mints a stable surrogate
id for precisely this, with the comment *"Routines bind it, so it must NOT be recomputed from content."* A trigger
needs stable identity to bind to, and that id has been waiting for it.

### 7.1 Shape

```
trigger: { kind: 'cadence', minutes, enabled, nextDue, lastFiredAt, failures }
```

`kind` is present from day one even though `cadence` is the only value. Time is one trigger among several — "when
a new warranty task appears" wants every other field in this document unchanged. Naming the discriminator now
costs one field; retrofitting it costs the surface.

### 7.2 Policies — all decided here, all fields rather than architecture

| Policy | Ruling | Why |
|---|---|---|
| **Overlap** | skip if a run of this workflow is in flight | the live sweep took ~17s over 121 divisions; overlap is reachable, and two concurrent runs corrupt each other's DOM waits |
| **Coalescing** | several due-times passed before a run happened → run **once**, and record *"3 due-times collapsed"* | firing a backlog at once is work the user did not see coming; the point of a cadence is currency, not completeness of the series |
| **Failure** | auto-disarm after N consecutive failures, with a history entry | a workflow whose route has drifted otherwise fails silently every day forever; connects to the RH drift/heal arm |
| **Orphaned desk** | auto-disarm, history entry, workflow stays visible | matches how workflows already survive deletion (§9) |

Auto-disarm is what makes history load-bearing rather than decorative: it is the only place a person learns their
automation stopped.

**On the coalescing wording.** An earlier draft called this row *"missed fire (browser closed) → skip"*, which was
written while triggered runs were assumed panel-tier — where the panel being shut is the NORMAL case, so read
literally the rule skipped almost everything. Under §2's scanner plus the headless driver (§11 CD-1a), a due-time
passing is not a miss; a *backlog* of them is. The ruling is unchanged, the framing was wrong.

### 7.3 The trigger surface must not claim more than it delivers

Whatever the executor tier, the label a person sees has to match what actually happens. "Runs every 4h" is only
honest once the run genuinely happens on the clock; while any deferral remains, the surface says so
(*"due every 4h"*), and §6's history carries both stamps — `due 09:00 · ran 09:00` when it fired on time, `due
09:00 · ran 14:32` when it did not. A schedule whose first lesson is that it does not keep its word is worse than
no schedule.

---

## 8. Parked writes — the gate, unchanged

**This is the decision that shapes the record, and it comes first.**

`writePolicy` has exactly two values in the codebase — `gated` and `never`. **There is no `auto`.** A triggered
workflow containing a write therefore cannot complete unattended, by construction. That property is correct and
this design does not touch it.

So a triggered run that reaches a write step **parks**: persist `{runId, workflowId, stepIndex, chainState,
writePreview}` and surface it as a CASE on the workflow's own desk (`wfp_<runId>`, the VT-2b incident-case
pattern), with the write preview and `Approve & continue` / `Cancel run`. Approve resumes through
`_orchRunChain({startIndex, state})` — both parameters already exist. This is `DESIGN_workflow_wizard.md` §4.3,
retained verbatim; it is the one part of RT that survives intact.

The history entry for that run reads **parked**, with `parkedRunId` pointing at the case. Distinguishing *ran
clean* from *ran and is waiting on you* is the single most important thing the history surface says.

An interactive run never parks — the confirm bar renders live, as today.

---

## 9. What survives a desk delete

Key the trigger and the history by **workflow id** and this stops being a question.

Workflows already survive, stamped `orphanedFrom` at the last moment their name still exists (`chat.js:1006-1014`,
with the reasoning in-comment). Trigger and history keyed the same way travel with them for free. Nothing this
document adds is keyed by `instanceId`.

Combined with §2, the original complaint dies twice over: there is no alarm to leak, and there is no desk-keyed
record to strand.

---

## 10. Live bugs this depends on or found in passing

1. **Orphaned fleet alarms (blocks nothing, but fix with §2).** The desk-delete path clears no alarm and no
   schedule record. `fleet-routine:{instanceId}` fires forever after its desk is deleted, rewriting `due:true`
   into a record for a desk that no longer exists — the listener checks `enabled` and never checks existence. The
   sweep path has a lazy self-heal, but only when `convId` is set. Adopting one clock owner retires both.
2. **`deleteAll` skips the workflow-orphan stamp** that the per-row delete runs (`chat.js:584` vs `:1019`), so a
   bulk wipe strands every desk's workflows with no name to find them by.
3. **`patchMeta` silently drops `summary` and `resolvedAt`** (closed allow-list, `ConversationStore.js:279`) while
   `chat.js` writes both — so `resolvedAt` is never set and every `VITALS_CHANGED` re-patches and re-logs every
   closed incident forever. **This one matters here**: §6.3 clones the vitals sidecar and would inherit it.

---

## 11. Build ladder

- **CD-0** — the trigger field on the workflow record + migration (existing `fleetRoutine` records become one
  trigger each, bound to a 1-step workflow so everything is workflowId-keyed).
- **CD-1** — **one clock owner**: the scanner (§2), replacing per-desk alarm registration. Retires the fleet
  routine alarm and its orphan class. *Ship before anything user-visible — it is the actual bug fix.*
- **CD-1a** — **the driver extraction** (§2.2): lift the chain runner out of chat.js into a Core driver with an
  injected reporter; the panel keeps a DOM reporter so nothing user-visible changes. Landing this BEFORE the
  trigger surface is what lets §7.3 say "runs every 4h" without lying. It is the largest item on this ladder and
  the one everything else quietly depends on — a triggered run that needs the panel is not really scheduled.
- **CD-2** — entry points: the Rail desk-card icon (§3.1) + `OPEN_WORKFLOWS` as a `domain:'self'` leg (§3.2).
- **CD-3** — intent-first composition (§4): `＋ workflow` prompts for intent, proposal, "use these N steps" into
  the existing wizard.
- **CD-4** — the card's run / delete / edit icons (§5).
- **CD-5** — the history store (§6.3) + entries written by both manual and triggered runs, `pipelineRun` verdict
  reused. **History before overlay** — a surface over an empty store proves nothing.
- **CD-6** — the history overlay (§6.2), including the explicit page-slot value.
- **CD-7** — parked writes as `wfp_` cases (§8). Until this ships, a triggered workflow containing a write must be
  refused at arm time with a stated reason, not armed and silently stuck.
- **CD-8** — the §7.2 policies: overlap, coalescing, failure auto-disarm.

Livability checkpoints: after **CD-1a** a workflow runs with the panel shut, which is the difference between a
schedule and a reminder; after **CD-5** a person can see what their automation did; after **CD-7** it can safely
do something that writes.

**Ordering note.** CD-1a is tempting to defer because nothing user-visible changes when it lands. Deferring it
inverts the whole point: every surface built on top would have to be worded around an executor that only runs when
someone is looking, and then reworded when it stops being true. Do the plumbing while there is nothing on top of
it.

---

## 12. What this deliberately does NOT decide

- **Event triggers.** `kind` is polymorphic from day one; only `cadence` is specified. Nothing here should have to
  change to add `kind:'event'` — if it does, this document got the shape wrong. Deliberately unspecified: what an
  event CONDITION looks like and how it is evaluated. There is a fair chance it resolves to "check on a clock, run
  only if X" — which is a cadence with a predicate rather than a second mechanism — and inventing the shape before
  a real case would be guessing.
- **What the reporter interface looks like in detail** (§2.2). The two implementations and the boundary are ruled;
  the method set is a build-time decision, and pinning it here would be specifying an interface with no second
  caller to check it against.
- **A cross-desk roster.** Rejected: §3's entry points make every desk's workflows one click away, and §9 removes
  the orphaning that motivated a global list. Revisit only if a real user with many desks reports that per-desk is
  not enough.

**Resolved since the first draft** (kept visible so the reversals are legible rather than silently edited away):

- *Does the Front desk take workflows?* → **yes** (§3.1). The glyph is unconditional.
- *Is headless execution possible?* → **yes, and it is CD-1a** (§2.2). The earlier deferral quoted a coupling
  constraint as though it were a platform limit.

---

## 13. How this document was reached

Recorded because the route matters more than the conclusion.

The first draft of this design was a separate schedule entity with its own store, an Admin-desk roster card, and a
Rail case per schedule. It was rejected by the user on the grounds that it over-specified a time-triggered
workflow, and they were right. **The diagnosis was wrong, not the requirements**: the orphaning was read as a
modelling problem when it was a leaked `chrome.alarms` reference, and the expensive fix was reached for first.

**LESSON[fix-the-leak-before-remodelling-the-thing-that-leaked]:** when durable state goes missing or goes stale,
establish whether the *reference* leaked before concluding the *model* is wrong. A leaked reference is a line; a
wrong model is a subsystem. The tell is that the proposed remodel does not actually explain the symptom — an
entity would not have collected the alarm either.

**LESSON[an-audit-trail-cannot-live-in-a-deletable-container]:** run history was briefly proposed to live in the
desk timeline for reuse. The desk conversation is deletable, which makes that the same failure the whole document
exists to fix, one layer along. Durability requirements outrank render-path reuse.

**LESSON[a-design-doc-is-evidence-about-the-code-not-a-law-of-physics]:** this document originally deferred
headless execution by quoting `DESIGN_workflow_wizard.md` §5 — *"Pretending one executor exists would make
scheduled workflows silently fail with the panel closed."* That sentence is true and was never a limit: it
describes chat.js's coupling at the time it was written. Ten minutes of grep found `INTERPRET_ASK`,
`CLASSIFY_BRANCH_ITEMS`, `DECOMPOSE_STEPS` and `INVOKE_SESSION` all already in the service worker, and a working
headless orchestrator in `fleet.js` whose own comment names the fix. The constraint was inherited, not verified.

The general form, and it recurred four times in the session that produced this document: **a stated constraint is
a claim about a moment in the code, and it decays.** Quoting one into a new design carries its expiry date with
it, invisibly. Cheap check, expensive miss — deferring headless would have shaped every surface above it around an
executor that only runs when someone is watching.
