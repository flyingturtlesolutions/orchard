# DESIGN — Background Agents (supervised parallel execution in the user's own tabs)

> Status: **proposed** · Author: design discussion 2026-06-13 · Builds on FM-1 (focus grammar), the C2b
> interaction monitor, the .908 `markEngineBusy` family, PB-8 effect drift, and the cross-ground scope
> wiring (HS-2). Sibling of the deferred companion-surfaces direction; scope here is **in-browser**, not a
> separate process. Not the dev bridge (that's repo tooling); this is the *runtime*.

## 1. Problem & vision

The product thesis: **pages are the center of the experience; the app is a companion that works in the
background and surfaces only when the user's input is required.** Concretely — the user works in one
(focused) tab while orchard replays taught workflows across *other* tabs. A supervised, multi-tab runtime
that runs both **parallel** work (independent branches) and **sequential** work (a later ground's action
depends on an earlier ground's result) — most real workflows are a DAG of both (§3).

**Two canonical use cases:**
- *Parallel* — search one person across 3 web tools simultaneously, collate into the focused tab.
- *Sequential* — find the cheapest flight on ground A, then book *that* flight on ground B (B's action is
  parameterized by A's read).

In both, at any instant the user can switch to any working tab to verify or take over by hand.

**The defining constraint: INDIRECT SUPERVISION.** The user must be able to *glance at, verify, or take
over any working tab at any instant.* The work is *present and reachable* — just not forced into
attention. This single constraint selects the architecture (§2) and rules out the cloud/separate-context
option that would otherwise be the obvious "parallel agents" play.

## 2. The supervision spectrum (why same-browser tabs, not the cloud)

| mode | what the user can do mid-flight | fits the constraint? |
|---|---|---|
| **direct** (today's foreground replay) | watch every step happen | yes, but serial + demands attention |
| **indirect** (this design) | switch to / verify / take over any worker tab, isn't forced to watch | **← the target** |
| **none** (cloud / separate profile, "E") | only see the final result; can't reach a worker mid-run | **NO** |

A cloud or separate-profile browser is **invisible and unreachable** from the user's window: you can't
alt-tab to it, can't glance at tab 2 to confirm the match, can't grab the keyboard and finish a search by
hand — and it doesn't even carry your local logins. (Streaming a remote browser's live view into a tab is
*strictly worse*: "take over" becomes remote-controlling a remote browser without your sessions.) So
**background work must run in the user's own browser: real, visible, switchable, same-session tabs.** That
is tiers A/B/C below — never E.

## 3. Core model: the **workflow** is the agent; tabs are effectors; **scope is the spine**

The tempting framing — "a tab is an agent" — is *parallel-biased*: it works for N independent searches
but has nowhere to put a **data dependency** ("ground B's action is parameterized by ground A's result"),
which is what most real orchard workflows are (the T3 cross-site case). So the unit of agency is **not**
the tab. It is the **workflow**:

> **An agent = a workflow = a goal + a plan (a DAG of ground-actions) + a `scope` (its working memory).**
> Tabs are where steps *act*; **`scope` is where results *live and flow*.**

This decoupling is the whole answer to dependent work: the dependency "B needs A's result" lives in
**`scope`, not in the tabs** — a read on ground A writes to scope; the action on ground B binds from
scope. Tabs are *stateless* with respect to the data flow (a producer tab could be closed once its read
is captured — though §9 keeps it open as provenance). This is exactly orchard's existing
`dependsOn` / `wireCrossGroundData` / HS-2 machinery; nothing new is invented for the dependency — it is
already the spine.

**Three plan shapes fall out of one model** (the orchestrator is a **DAG scheduler over the plan**, not a
fan-out pool):
- **Parallel** — independent branches → their tabs run concurrently (the 3-search case).
- **Sequential** — a chain → tabs activate in order; scope threads A→B→C.
- **DAG** — a mix (diamond A → {B,C} → D): parallelize independent branches, **serialize across dependency
  edges**. `WorkflowExecutor` already walks plans serially with `dependsOn` edges + scope; the new piece
  is letting *independent* branches run concurrently. "Fan-out" is the all-independent special case.

**"Tab = agent" survives, narrowed, in two places:** (a) the **1:1 special case** of an all-parallel
workflow (3 independent searches ≈ 3 agents); and (b) the **supervision *surface*** — what the user
switches-to / verifies / takes-over is always per-tab, so the **roster shows tabs grouped under their
workflow** (§9). One sequential workflow owns several tabs.

- **The roster substrate exists:** `markEngineBusy` (the refcounted .908 registry) already tracks "the
  engine is driving tab X"; `onTabResolved` (.967) reports every tab a run drives. The arc reads these as
  a per-workflow roster.
- **Concurrency is I/O-bound async over a *ready set*.** The SW is single-threaded, but tab work is
  awaiting content-script/CDP responses + network — so the scheduler runs all dependency-ready steps
  concurrently (`Promise.all` over the ready frontier), bounded by a pool cap, and advances as edges
  resolve. Dependent steps simply aren't in the ready set until their producer's scope write lands.
- **Why this is tractable & safe:** every step replays a **verified, deterministic, no-LLM-per-step**
  capability — not an autonomous reasoner. A 5-tab workflow is five cheap proven scripts wired by scope,
  not five reasoners you must trust. The teach-once flywheel is what makes background execution — parallel
  *or* sequential — cheap *and* safe.

## 4. Execution tiers (focus-free driving)

orchard **already** drives tabs by `tabId` with synthetic DOM events, not by focus — `WorkflowExecutor`
opens cross-ground hop tabs `active:false` and runs them to completion. So background driving isn't new;
robustness and parallelism are.

- **A — naive background tabs (works today, partial).** `active:false` + drive by `tabId`. Fine for
  short, above-the-fold, deterministic capabilities. Limited by §5 throttling + lazy-render.
- **B — SW-side waits (cheap, highest-leverage).** Replace the content-script `setTimeout` poll
  (`WAIT_FOR`, [contentScript.js:2874](../ContentScripts/contentScript.js)) with **SW-side polling** via
  `chrome.scripting.executeScript` — the service worker isn't throttled like a hidden tab. Removes most of
  the throttling pain with no new permission and no CDP weight. **Do this first.**
- **C — `chrome.debugger` / CDP per tab (robust; an unused permission orchard already holds).** The
  manifest declares `debugger` but nothing uses it. CDP attaches to a specific tab, dispatches **trusted**
  input (`Input.dispatchMouseEvent`, `isTrusted:true`), evaluates, and waits — focus-free, throttle-immune,
  can force rendering. The path for sites that reject synthetic clicks or lazy-render. Cost: a "being
  debugged" banner per tab, heavier, one attach each.
- **E — cloud / separate context.** Ruled out by §2 (no indirect supervision). Reserved for *unattended*
  work (laptop-closed, scheduled), which is a different requirement (C-P3), not this one.

## 5. The one real blocker: hidden-tab throttling

Chrome progressively throttles `setTimeout`/`setInterval`/`requestAnimationFrame` in backgrounded tabs
(hard after ~5 min hidden) and many sites lazy-render below-the-fold / visibility-gated content. The
*click/type/read* all work in background — it's the **waiting** and **rendering** that break. Tier **B**
(SW-side waits) fixes the waiting; tier **C** (CDP) fixes both waiting and rendering for the hard sites.
Everything else in this doc assumes B has landed.

## 6. The supervision contract: the `isTrusted` discriminator

This is the heart of "supervisable," and the infrastructure is already present.

- Today `markEngineBusy(tabId)` marks a tab engine-driven and the monitor **blanket-drops** all interaction
  on it as `dropped: 'engine-run'` ([sg.js:1228](../background/handlers/sg.js)) — the .908 self-capture
  suppression.
- The missing piece is **discriminating user from engine on a busy tab**, and the discriminator already
  exists in the code's vocabulary: **synthetic engine clicks are `isTrusted:false`; real user input is
  `isTrusted:true`** (referenced at [contentScript.js:7865](../ContentScripts/contentScript.js)).
- **Wire `isTrusted` into `INTERACTION_RAW`** and, on a busy tab, drop only `isTrusted:false` (engine);
  a `isTrusted:true` event is **unambiguously the user.** One signal, two roles:
  - **Takeover** — user barged into a worker tab → **pause that agent** (cede control; never fight the
    user for the cursor). Resume when they leave, or the task is moot and they finish by hand.
  - **Handoff-completion** — the user did the gated step the agent *asked* for (§7) → **resume** the rest.

The same trusted-event-on-a-busy-tab signal serves both; it is the entire supervision contract.

**Under a data dependency (§3), takeover refines by the tab's role in the plan:**
- Taking over the **active** tab (a step in flight) pauses the *workflow* at that step — the downstream
  dependents simply never become ready until it resumes.
- Touching an **already-read producer** tab (its result is captured in `scope`, the step is done) is
  *harmless to the data flow* — the downstream binding already has its value. The roster marks such a tab
  **"read captured"** so the user knows editing it won't retroactively rewrite the run (re-running that
  read is an explicit action, not a side effect of looking).

## 7. Human-handoff steps (the SSO / foreign-origin-iframe class)

**The class:** steps that require genuine human presence — SSO/OAuth consent, CAPTCHA, payment 3-D-Secure,
file pickers, passkey/2FA. They reject `isTrusted:false` synthetic events **by design** (anti-automation /
anti-clickjacking), and a *cross-origin iframe* compounds it: same-origin policy often blocks orchard from
reaching the iframe DOM at all. SSO is the canonical case.

**Detection — two paths, both grounded in existing signals:**
- **Reactive:** the CLICK dispatches fine at the DOM level but the declared effect isn't observed →
  **`expected-missing` drift** (PB-8, [ActionEffectObserver.js:205](../Services/ActionEffectObserver.js)).
  That *is* "the iframe swallowed my click." Escalate.
- **Proactive (preferred):** at **teach time** the demonstration recorder sees the user's real click
  landed in a **cross-origin frame** (`frameUrl` origin ≠ top; orchard already counts `crossOriginIframes`,
  [contentScript.js:4748](../ContentScripts/contentScript.js)) → tag the step **`requiresUser:true`**. On
  replay it goes *straight to the policy*, no try-and-fail. The agent knows in advance which step is the
  human's.

**The policy — configurable, parallel to FM-1's `auto/ask/never`:**

| policy | behavior | mechanism |
|---|---|---|
| **fail gracefully** | abort the step, report "couldn't complete the sign-in automatically"; the worker yields | graceful exit |
| **notify** | HITL card / OS notification "the Google sign-in needs you — tab 2"; **no focus steal**; agent waits (timeout) | the summon/HITL pattern |
| **grab focus** | bring the worker tab forward so the user completes it now | `focusTab(tabId, 'handoff-required')` — a new FM reason |

Settable **globally and per-step**: the `requiresUser` tag lets a known SSO step carry `grab` while a
flaky non-auth click stays `notify`.

**Resume-after-handoff** reuses §6 inverted: focus-grab → user does the trusted click(s) (which *work*) →
the `isTrusted`-on-busy-tab signal fires as *completion* → agent watches the postcondition (URL changed /
success landmark) and **resumes** the rest.

**CDP nuance (honest):** tier C *can* send trusted events and would defeat *some* of these (it's how
Playwright clicks reCAPTCHA). But for the **auth** class specifically, **human-handoff is the correct
primitive even when CDP could click** — some flows need real human/OS presence CDP can't fake (passkeys,
OS prompts, popups), and fully automating someone's authentication is a trust boundary orchard should not
cross. CDP is for ordinary "site checks `isTrusted` on a button" cases; **handoff is for auth, by design.**

## 8. Data flow & collation (the scope spine, both shapes)

The data flow is the same mechanism for parallel and sequential — it's all **scope** (§3):
- **Sequential dependency:** ground A's read writes `scope.X`; ground B's action binds `{param: X}` from
  scope. This is `wireCrossGroundData` / HS-2 verbatim — the producer→consumer edge across grounds.
- **Parallel collation:** N independent reads each write `scope.*`; a final sink folds them into the
  focused surface. This is the *same* scope mechanism with a **fan-in merge** at the end (wait the ready
  frontier's branches, fold) instead of a single producer→consumer thread.

So collation is not a special feature — it's a sink step whose inputs are several scope writes. The only
new code is the **fan-in barrier** (await N branches before the merge step), which the DAG scheduler (§3)
already expresses as "the merge step `dependsOn` all N branches."

## 9. The agent roster UI — tabs grouped under their workflow

The roster is the indirect-supervision dashboard. It groups **tabs under their workflow** (§3) — the unit
of agency is the workflow; the tabs are its rows. The grouping makes the plan shape legible: a parallel
workflow shows independent rows; a sequential one shows the chain + the scope edges (so the **provenance
trail** is visible — switch back to a producer to verify what fed a dependent).

**Parallel workflow** (independent branches; collate at the end):
```
▸ "research Jane Doe"  · 3 grounds, fan-in
  ✓ LinkedIn      — read captured (4 results)        [Switch ▸]
  ⏳ PeopleFinder  — searching…
  ✋ Google        — paused: you're driving           [Resume]
  ⋯ (collate → focused tab, waiting on PeopleFinder)
```

**Sequential workflow** (data flows down the chain; a handoff mid-way):
```
▸ "cheapest flight → book it"  · 2 grounds, chain
  ✓ Kayak    — read captured: flight=DL123 $284  ──┐   [Switch ▸ to verify]
  ⚠ Delta    — needs you: sign-in step  ◀───────────┘   [Switch ▸] [Skip]
              (will book DL123 once you're in)
```

Each row = a `markEngineBusy` tab; state from the run + the monitor; the `──┐` edges are scope
dependencies. Clicking a row focuses that tab (`focusTab`, reason `roster-jump`). "read captured" (§6)
marks a producer whose result is already in scope — safe to inspect. A handoff (§7) renders the "needs
you" affordance with the downstream consequence spelled out ("will book DL123 once you're in").

### 9.1 Surfaces — minimal, ambient, reusing what exists

The thesis (pages are the center; the companion surfaces only when needed) caps the new UI hard. There is
exactly **one** new element; everything else reuses an existing surface, and **nothing renders in the
page** (no in-page border/overlay/title-mutation — that crosses the injection boundary and intrudes on
the pages this whole design exists to keep central).

- **Ambient header strip (the one new element):** a collapsed indicator
  `⚙ 3 agents · 1 needs you  ⏸ ◼` placed in the app header **directly after the conversations icon
  (`#btn-history`)** — leftmost, before the brand. Always visible while ≥1 agent runs; the inline `⏸ ◼`
  are the global **Pause-all / Exit-all** controls (§ lifecycle). Clicking the strip expands the roster.
- **The expanded roster *is the existing `#running-bar` grown up.*** orchard already ships a sticky
  "global running state" transport (`#running-bar`, v2.71.7) that renders a row per running invocation
  *with a stop button*. The arc evolves it from flat invocation rows → the **workflow-grouped roster**
  above (rows nested under their workflow, scope edges, read-captured / needs-you states, per-agent
  pause/stop). So per-agent stop already exists in primitive form; this is an upgrade, not a new surface.
- **Active-agent count → the toolbar badge** (already used to indicate running tasks; `chrome.action.
  setBadgeText`). Visible from any tab, zero new UI.
- **Handoffs → the existing HITL card + OS notification** (§7). No new pattern.
- **Roster-jump → `focusTab`** (FM-1). No new surface.

## 9.2 Lifecycle control — pause / exit, one agent or all

Three granularities; the arc must cover all three (the doc previously covered only the first two):
- **step / iteration** — takeover-pause (§6) or the per-row stop.
- **one workflow** — pause/stop a whole agent (all its tabs/iterations) from its roster group.
- **all** — **Pause-all** (freeze every agent at its next safe boundary; scope + open tabs + DAG position
  preserved → *resumable*) and **Exit-all** (terminate all in-flight runs at the next boundary → not
  resumable). Both land on a node/iteration boundary — the current atomic action finishes, then the agent
  halts; you can't kill mid-DOM-write cleanly.

**Mechanism:** one global pause/abort flag the DAG scheduler polls before dispatching each step/iteration
— the generalization of the existing `_STOP_RE` → walk / plan-IR / engine `isAborted` plumbing (CR-S1…S4)
from a single walk to the whole agent set. **Resume-all** un-freezes each agent from its saved position.

**Three triggers** (because the user is usually *off in another tab* — a control that needs the panel
focused is not enough):
1. **Typed `stop`** — exists today; needs the panel focused.
2. **The header strip's `⏸ ◼`** and the expanded roster header's **Pause-all / Exit-all** — one click,
   present whenever agents run.
3. **A global keyboard panic key** (`chrome.commands`, e.g. `Ctrl+Shift+.`) — fires from *any* Chrome
   tab, no panel needed. **= Exit-all** (when you panic you want it *off*, not paused). Requires a small
   `commands` block in the manifest (orchard has none today) — a BA-slice dependency.

**Safety semantics:**
- **Never closes the user's tabs** — stop = stop *driving*; tabs stay open and inspectable. Cleaning up
  ephemeral foreach tabs is a separate, confirm-gated action, never a side effect of stop.
- **Idempotent + fast** — set the flag immediately; agents halt within a step.
- **Scope = the runtime agents** (replays, workflows, walks, trials, explores). The **dev bridge is
  excluded** — it's a Claude Code run with its own pause, not browser automation.

## 10. Trust & safety

- **The user always wins.** A trusted interaction on a worker tab pauses that agent immediately (§6); the
  agent never contends for the cursor.
- **Deterministic replay only.** Workers replay verified capabilities (no per-step LLM), bounding blast
  radius and cost. A *novel* (untaught) task is NOT a background worker — it stays foreground/supervised.
- **HITL stays in real UI.** Handoff prompts and confirms render in the panel/roster, never injected into
  a (possibly hostile) page (the injection-boundary rule).
- **Bounded concurrency.** A pool cap (like the workflow concurrency cap) bounds tab count.
- **Focus-required actions are out of scope for headless background** (file pickers, native dialogs, OS
  permission prompts) — they route through §7's handoff, never silently fail.

## 11. What exists vs. what's new

**Exists:** `tabId`-addressed driving, `active:false` background opening, the `markEngineBusy` roster,
`onTabResolved`, the `INTERACTION_RAW` monitor, `isTrusted` awareness, `crossOriginIframes` + `frameUrl`
capture, `expected-missing` drift, cross-ground scope wiring, `focusTab(tabId, reason)` (FM-1),
deterministic replay.

**New (the arc):**
1. **DAG scheduler** — execute a plan by its dependency graph: run all ready (no-unmet-dep) steps
   concurrently, bounded pool, advance as scope edges resolve (§3). Parallel = all-independent; sequential
   = a chain; both are this one scheduler. `WorkflowExecutor`'s serial walk + `dependsOn` is the seed.
2. **SW-side waits** (tier B) so background runs don't stall (§5).
3. **The `isTrusted` discriminator** — user-vs-engine on a busy tab → pause / resume, role-aware under a
   dependency (§6).
4. **Per-tab agent lifecycle** — start / pause-on-takeover / resume / cancel, with `read captured` state.
5. **Human-handoff** — `requiresUser` teach-time tag + reactive drift detection + the fail/notify/grab
   policy + resume-after-handoff (§7).
6. **Scope fan-in** (§8 — the merge step `dependsOn` N branches) and the **workflow-grouped roster** (§9).
7. **Lifecycle control** (§9.2) — pause-all / exit-all / resume-all via the global scheduler flag; the
   ambient header strip (after `#btn-history`) + the evolved `#running-bar` roster + a `commands`
   panic-key. The `#running-bar` + per-invocation stop + the toolbar badge already seed it.
8. *(optional, later)* **CDP tier** (§4-C) for trusted-event / lazy-render sites.

## 12. Slices

- **BA-1 — background-safe waits (tier B).** Move `WAIT_FOR` (and settle waits) to SW-side polling.
  *Acceptance:* a known capability replays to completion in an `active:false` tab with no throttling
  stall, while the user works in another tab.
- **BA-2 — the supervision contract.** `isTrusted` into `INTERACTION_RAW`; on a busy tab, drop only
  `false`, treat `true` as the user; pause the agent on takeover. *Acceptance:* switching to a worker tab
  mid-replay and clicking pauses *that* agent (trace shows `AGENT_PAUSE tab=N reason=user-takeover`),
  others unaffected.
- **BA-3 — DAG scheduler + roster.** Promote `WorkflowExecutor`'s serial walk to a dependency scheduler
  (concurrent ready-set, bounded pool, scope fan-in) + the workflow-grouped roster. *Acceptance:* the
  3-tool person-search runs its independent branches concurrently and collates into the focused tab; a
  2-ground sequential plan (read A → act on B with A's result) runs B only after A's scope write, with
  both tabs left open as the provenance trail; roster reflects live state + edges.
- **BA-4 — human-handoff.** `requiresUser` teach-time tag (via `frameUrl` cross-origin) + reactive
  `expected-missing` escalation + fail/notify/grab policy + resume-after-handoff. *Acceptance:* a taught
  capability containing an SSO step, on replay, raises the handoff per policy; on `grab`, focuses the tab,
  waits for the user's trusted completion, and resumes.
- **BA-5 — lifecycle control + ambient surface.** The global pause/exit/resume scheduler flag (extends
  CR-S1…S4); the ambient header strip after `#btn-history`; the `#running-bar` → workflow-grouped roster
  upgrade; the `commands` panic-key (manifest add) = exit-all. *Acceptance:* with several agents running,
  the panic key halts all at the next boundary without closing tabs; pause-all then resume-all restores
  each from its saved position; the strip + badge reflect live count.
- **BA-6 *(optional)* — CDP tier.** `chrome.debugger`-backed trusted input + render-forcing for the sites
  that need it. Gated on a real case BA-1..BA-5 can't cover.

## 13. Open questions

1. **Default handoff policy** — `notify` is the safe default (no surprise focus-steal); `grab` opt-in
   per-step via `requiresUser`. Confirm.
2. **Pool size** — fixed cap, or scale to cores like the workflow concurrency cap? Start fixed (e.g. 4).
3. **Resume-after-takeover** — when the user leaves a paused worker, auto-resume, or require an explicit
   "resume" from the roster? Lean explicit (the user may have changed page state).
4. **In-place foreach tab-ownership** — the scheduler's ready-set needs a notion of *tab ownership*: an
   in-place foreach iteration that needs tab `t1` can't start while another holds it (B1 in the worked
   examples), unlike open-each iterations that each get their own effector. A small scheduling constraint.

*Resolved this pass:* **exit/pause-all** → §9.2 (global flag + three triggers + safety); **new UI** →
§9.1 (one ambient header strip after `#btn-history`, everything else reuses `#running-bar` + the badge;
no in-page UI).
4. **BA-1's blast radius** — moving `WAIT_FOR` to SW-side touches the foreground path too; it must be a
   strict behavioral superset (verified by the existing suite + a live foreground run) before background
   relies on it.
5. **Sequencing vs. the rest** — BA-1/BA-2 are small and independently useful (BA-2's takeover-pause is a
   safety win even for single-tab runs). BA-3+ is the real arc; slots after the R-7 / DB / GA-4 queue, or
   jumps it if the parallel-search use case is the priority.
