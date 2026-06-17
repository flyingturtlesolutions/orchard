# Background Agents — sequential prompt plan

Ready-to-paste prompts to implement `DESIGN_background_agents.md`, in dependency order. Each prompt is
scoped to land in one focused turn, carries its **acceptance criteria** and **verification gate** up front
(so it's built to a target, not iterated by eyeball), and ends in a `bcp`-able state.

**How to use:** paste one prompt, let it land + verify, eyeball any live-only checks, then `bcp` before the
next. Don't batch across prompts — each depends on the prior landing. The order is the design's BA-1→BA-6
with the two big slices (BA-3, BA-5) split into a logic half (headless-verifiable) and a UI half
(needs a live eyeball), per the rule that UI asks need explicit acceptance criteria.

**Standing guardrails (apply to every prompt — from CLAUDE.md):**
- Any **new decision marker** (`AGENT_PAUSE`, `AGENT_RESUME`, `HANDOFF ▸`, `SCHED ▸`, `PAUSE_ALL`, …) →
  add it to `_DECISION_RE` (`studio.js:5888`), or a `gl -decisions-` download is blind to the feature.
- Any **new engine-driven click/type/nav path** (the scheduler now drives more tabs) → `markEngineBusy()`
  (`sg.js:122`, try/finally). Never suppress the user-demonstration recorder.
- Bump `manifest.json` (`v2.74.X`) on every behavior change; `npm test` is the gate.

**Decisions already defaulted (design §13 — override in the prompt if you disagree):** handoff default =
`notify` (grab opt-in per step); pool cap = fixed 4; resume-after-takeover = explicit (no auto-resume).

---

## BA-1 — background-safe waits (tier B) · *do this first*

> Implement BA-1 from `docs/DESIGN_background_agents.md` §4-B/§5: move `WAIT_FOR` and the settle/poll waits
> off the content-script `setTimeout` (`ContentScripts/contentScript.js`, ~line 2874) to **SW-side polling**
> via `chrome.scripting.executeScript`, so a hidden `active:false` tab isn't throttled. This touches the
> **foreground path too** — it must be a strict behavioral SUPERSET (§13 Q4): same observable behavior on a
> focused tab, plus survival in a backgrounded one. No new permission, no CDP.
>
> Acceptance: a known taught capability replays to completion in an `active:false` tab with no throttling
> stall while I work in another tab; the existing suite stays green; one live foreground replay behaves
> identically to before. Verify: `npm test`, then tell me the exact live replay to run to confirm the
> background case (I'll run it and paste the trace).

## BA-2 — the supervision contract (`isTrusted` discriminator) · *small, independent safety win*

> Implement BA-2 from §6. Wire `isTrusted` into the `INTERACTION_RAW` path (`Core/interactionCapture.js` →
> `background/handlers/sg.js`, the `markEngineBusy` blanket-drop at ~sg.js:1228). On a busy tab, drop only
> `isTrusted:false` (engine); treat `isTrusted:true` as **unambiguously the user** → emit a pause for *that*
> agent (takeover), not a global stop. Add the `AGENT_PAUSE tab=N reason=user-takeover` marker — and add it
> to `_DECISION_RE`.
>
> Acceptance: switching to a worker tab mid-replay and clicking pauses *that* agent (trace shows
> `AGENT_PAUSE tab=N reason=user-takeover`), other agents unaffected; engine's own synthetic clicks still
> drop silently (the .908 suppression still holds — no regression in the interaction feed). Verify:
> `npm test` + a unit test for the discriminator (false→drop, true-on-busy→pause); name the live takeover
> check for me to run.

## BA-3a — DAG scheduler (the logic half) · *the real arc; headless-verifiable*

> Implement the BA-3 scheduler from §3/§8/§11-new-1. Promote `Services/WorkflowExecutor.js`'s serial walk
> into a **dependency scheduler**: run all dependency-ready (no-unmet-`dependsOn`) steps concurrently via
> `Promise.all` over the ready frontier, bounded by a fixed pool cap of 4, advancing as scope writes land;
> serialize only across `dependsOn` edges. Parallel = all-independent; sequential = a chain; both are this
> one scheduler — reuse `wireCrossGroundData`/HS-2 scope verbatim, don't invent a new dependency mechanism.
> Add scope **fan-in** (§8): a merge/sink step that `dependsOn` N branches awaits all N before folding.
> Respect the §13-Q4 **tab-ownership** constraint: an in-place foreach iteration can't start while another
> holds its effector tab (open-each iterations each get their own). Add a `SCHED ▸` decision marker
> (ready-set dispatched / edge resolved / fan-in) → `_DECISION_RE`. Any newly-driven tab → `markEngineBusy`.
>
> Acceptance (all headless): unit tests prove (a) independent branches dispatch concurrently under the pool
> cap, (b) a dependent step stays out of the ready set until its producer's scope write lands, (c) the
> fan-in barrier waits all N branches, (d) tab-ownership blocks a concurrent in-place foreach. Verify:
> `npm test` green including the new scheduler tests. This slice is fully headless — no eyeball needed.

## BA-3b — workflow-grouped roster (the UI half) · *needs a live eyeball*

> Build the roster UI from §9/§9.1. Evolve the existing `#running-bar` (in `chat.js`/`chat.css`/`chat.html`)
> from flat per-invocation rows into a **workflow-grouped roster**: tabs nested under their workflow, scope
> edges drawn between rows (the `──┐` provenance trail), and per-row state from the run + monitor —
> `searching…` / `read captured` / `paused: you're driving` (§6) — with `[Switch ▸]` (→ `focusTab(tabId,
> 'roster-jump')`) and `[Resume]`/`[Skip]`. **Nothing renders in the page** (injection-boundary rule) — roster
> lives in the panel only. Match the two ASCII mockups in §9 (parallel fan-in; sequential chain). Reuse the
> existing per-invocation stop button; don't add a second transport.
>
> Acceptance: with the BA-3a scheduler driving a 2-branch run, the roster shows both tabs grouped under one
> workflow, live state transitions (searching → read captured → done), a visible scope edge on the
> sequential case, and `[Switch ▸]` focuses the right tab. Verify: `npm test` (no logic regression), CSS
> braces balanced — then I'll eyeball the live roster; give me the exact run to trigger it. State plainly
> this slice's appearance can only be confirmed live.

## BA-4 — human-handoff (SSO / foreign-iframe class)

> Implement BA-4 from §7. Four parts, one coherent contract: (1) **proactive tag** — at teach time, when the
> demonstration recorder sees the user's real click land in a cross-origin frame (`frameUrl` origin ≠ top;
> `crossOriginIframes` is already counted at `contentScript.js:4748`), tag the step `requiresUser:true`.
> (2) **reactive detection** — on replay, a CLICK that dispatches but whose declared effect is
> `expected-missing` drift (`Services/ActionEffectObserver.js:205`, PB-8) escalates to the same handoff.
> (3) **policy** `fail | notify | grab`, settable globally AND per-step (default `notify`; `requiresUser`
> steps may carry `grab`); `grab` = `focusTab(tabId, 'handoff-required')` (new FM reason). (4)
> **resume-after-handoff** — after a grab, watch for the user's `isTrusted:true` completion (the §6 signal
> inverted) + the postcondition (URL/landmark), then resume the rest. HITL renders in the panel/roster,
> never in the page. Add a `HANDOFF ▸` marker → `_DECISION_RE`.
>
> Acceptance: a taught capability containing an SSO step, on replay, raises the handoff per policy; on
> `grab` it focuses the tab, waits for the trusted completion, and resumes downstream; on `notify` it posts
> the HITL card with no focus steal and waits (timeout). Verify: `npm test` + unit tests for the tag
> derivation and the policy branch; name the live SSO replay for me to run.

## BA-5a — global lifecycle flag (the logic half)

> Implement the lifecycle scheduler control from §9.2/§11-new-7. Generalize the existing
> `_STOP_RE`→`isAborted` plumbing (`Services/WorkflowExecutor.js`/`ExecutionEngine.js`, CR-S1…S4) from a
> single walk to the **whole agent set**: one global flag the DAG scheduler polls before dispatching each
> step/iteration. Three operations — **Pause-all** (freeze every agent at its next node/iteration boundary;
> scope + open tabs + DAG position preserved → resumable), **Exit-all** (terminate at next boundary → not
> resumable), **Resume-all** (un-freeze each from its saved position). Idempotent, fast (flag set
> immediately, halt within a step), lands only on a boundary (never mid-DOM-write). **Never closes tabs**
> (stop = stop *driving*). **Excludes the dev bridge** (that's a Claude Code run with its own pause). Add
> `PAUSE_ALL`/`EXIT_ALL`/`RESUME_ALL` markers → `_DECISION_RE`.
>
> Acceptance (headless): unit tests prove pause-all halts all agents at a boundary with state preserved,
> resume-all restores each from its saved position, exit-all terminates without resumability, and no tab is
> closed by any of them. Verify: `npm test` green with the new lifecycle tests.

## BA-5b — ambient surface + panic key (the UI/manifest half) · *needs a live eyeball*

> Wire the BA-5a flag to its three triggers (§9.2) and the ambient surface (§9.1). (1) **Header strip** —
> one new element: a collapsed `⚙ N agents · M needs you  ⏸ ◼` indicator placed in the app header
> **directly after `#btn-history`** (leftmost, before the brand), visible whenever ≥1 agent runs; its inline
> `⏸ ◼` are global Pause-all / Exit-all; clicking the strip expands the BA-3b roster. (2) **Roster header**
> gets Pause-all / Exit-all / Resume-all. (3) **`commands` panic-key** — add a `commands` block to
> `manifest.json` (orchard has none today) binding e.g. `Ctrl+Shift+.` to **Exit-all**, firing from any
> Chrome tab with no panel focus needed. (4) Active-agent count → the toolbar badge
> (`chrome.action.setBadgeText`). No in-page UI.
>
> Acceptance: with several agents running, the panic key halts all at the next boundary without closing
> tabs; Pause-all then Resume-all restores each from its saved position; the strip + badge reflect the live
> count; the strip sits after `#btn-history`. Verify: `npm test`, manifest validates, CSS balanced — then
> I'll eyeball the strip/badge/panic-key live; give me the trigger steps. Note the appearance is live-only.

## BA-6 — CDP tier *(optional; gated on a real case)*

> Only if BA-1…BA-5 left a concrete site that can't be driven (synthetic clicks rejected, or lazy-render
> below the fold). Implement tier C from §4-C/§11-new-8: use the already-declared `chrome.debugger`
> permission to attach per tab and dispatch **trusted** input (`Input.dispatchMouseEvent isTrusted:true`),
> evaluate, and force rendering — focus-free and throttle-immune. **Auth steps still route to BA-4 handoff,
> not CDP** (§7 — fully automating someone's authentication is a trust boundary; CDP is for ordinary
> `isTrusted`-checking buttons only). Accept the per-tab "being debugged" banner.
>
> Acceptance: name the real failing site first; then that capability replays to completion via CDP where
> the synthetic path failed, with the handoff class still routing to BA-4. Verify: `npm test` + the live
> replay on the named site.

---

## Sequencing notes

- **BA-1 and BA-2 are independently useful and low-risk** — BA-1 removes the throttling blocker; BA-2's
  takeover-pause is a safety win even for single-tab foreground runs. Land both before the big arc.
- **BA-3 is the core** (scheduler + roster) and the only slice split purely for verification shape (3a
  headless, 3b eyeball). Don't start 3b until 3a's scheduler is green — the roster has nothing to render
  without it.
- **BA-4 and BA-5 are independent of each other** and both depend on BA-3. Order them by whichever use case
  you want first: handoff (sequential book-the-flight w/ SSO) vs. lifecycle control (running several agents
  at once safely).
- **BA-6 is explicitly gated** — don't write it speculatively; only when BA-1…BA-5 hit a wall on a real site.
- Per design §13 Q5, this whole arc slots after the R-7 / DB / GA-4 queue unless the parallel-search use
  case is the priority — in which case BA-1→BA-3 jumps it.
