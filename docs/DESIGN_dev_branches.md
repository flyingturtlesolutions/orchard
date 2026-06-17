# DESIGN — Dev branches (a dev conversation is a branch is a proposal)

> Status: **proposed** · Author: design discussion 2026-06-16 · Builds on the dev-bridge (`DESIGN_dev_bridge.md`,
> `Services/Chat/devBridge.js`), the DB-2 reload icon (`btn-dev-reload`), the dev-conversation kind (v2.74.1029,
> `ConversationStore` `kind:'dev'`), and the "no build step — the repo root IS the unpacked extension" property
> (CLAUDE.md). Sibling of `DESIGN_background_agents.md`, but orthogonal: that doc is the in-browser **runtime**
> (parallel tabs); this is **repo tooling** (parallel code directions via the dev bridge).

## 1. Problem & vision

Dev conversations (v2.74.1029) gave Claude Code its own gated chat surface. The natural next step the user wants:
**split dev work into parallel directions, each explorable independently, then merge the good ones into `main`
and abandon the dead ends.** The clean framing:

> **A dev conversation = a git branch = a proposed change.** Its lifecycle is *draft → (merge | abandon)*.

Each thread is a direction you're exploring; merging accepts it, abandoning rejects it. This is the git-worktree /
branch-per-task pattern that modern agent tooling uses, made first-class inside the panel — and it gives the
"multiple dev conversations" direction a reason to exist that a single window cannot match (§2 of the prior
single-vs-multiple analysis): **multiple resumable directions with isolated state.**

**Execution model.** Phase 1 runs one `claude` child at a time (a second run returns `busy`) — branches isolate
*state*, runs are serial. But concurrency is **designed in, not out of scope**: §10's single-host multiplexing
lets one host run N children over the one native-messaging port, so "three branches" can mean three *running*
directions, bounded by a resource cap (tokens/CPU), not the architecture. **Serial-first, concurrent-when-needed.**

## 2. Core model

| concept | maps to |
|---|---|
| dev conversation | a git branch `dev/<slug>-<shortid>` off `main` |
| the conversation's transcript | the record of the work + Claude Code runs on that branch |
| "live-test this direction" (`lt`) | check the branch out in the loaded folder + reload the extension |
| accept the direction | `merge` → main (gated) |
| reject the direction | abandon → delete the branch |
| `main` | the serialization point — branches diverge freely, re-converge through main **one merge at a time** |

A dev conversation gains persisted fields: `{ branch, concern, sessionId, mergedAt? }` (on the `kind:'dev'`
conversation record). `sessionId` per-conversation is what makes `dev:` resume *this* direction's Claude Code
session rather than a single global thread (today's `settings:devBridgeLastSession` is global — that becomes
per-conversation here).

### 2.1 The control boundary — Claude proposes, the panel acts

Three processes, and a one-directional control flow the whole design leans on:

| process | role | has |
|---|---|---|
| **the panel** (`chat.js`, `devBridge.js`) | orchestrator | *power* — UI, `ConversationStore`, `chrome.storage`, git via the host |
| **the native host** (`bridge/host.js`) | bridge | frames the port, spawns the `claude` child, streams its events back |
| **Claude Code** (`claude -p`) | worker | *context* — edits files, runs allowlisted tools, emits text/plans/questions |

Control is one-way:

```
panel ──prompt──▶ host ──spawns──▶ claude -p
panel ◀── stream events ── host ◀── text · tools · ExitPlanMode · AskUserQuestion ── claude
```

**Claude can't drive the panel.** Everything it produces is *output the panel reads* — file edits, tool calls,
streamed text, and the structured `AskUserQuestion` / `ExitPlanMode` blocks (already relayed, DB-4). It has **no
channel** to call panel functions: create a conversation, switch branch, seed the input, start a new run, write
`ConversationStore`. Those are panel-side JS APIs; Claude is a subprocess across the native-messaging bridge with
no handle to them. It is also a *deliberate* boundary (§5: "nothing composes or auto-sends a bridge prompt") —
even with a back-channel you wouldn't let a model autonomously spawn branches/runs. **Claude is a worker, never
a controller.**

**So every Claude-originated action follows one pattern — propose → approve → act:**

1. **Claude proposes** by emitting *structured data* through a channel it is already allowed (an
   `AskUserQuestion` / `ExitPlanMode`) — it has the context, not the power.
2. **The human approves** with one tap — the required gesture (§5).
3. **The panel acts** — it alone can touch git / `ConversationStore` / UI, and only on the approval.

This is the load-bearing pattern for every consequential verb (`split` §8.1; the human-confirm steps of `merge` /
`sync` §6–7): Claude's *intelligence* flows through; the *actuation* stays panel-side and human-gated. Nothing
Claude emits ever "does" anything — the panel does, on your approval.

## 3. Trust posture — the invariant being relaxed, and how

Today the bridge **deliberately has no git** (CLAUDE.md: *"the host's allowlist has no git… commits stay human…
don't relax these silently"*; `reloadExtension` comment: *"Committing stays human"*). Branch-per-conversation
**requires git driven by the tool** — this doc is the explicit, non-silent relaxation. It must preserve the spirit:

- **The host gains a tightly-scoped git capability** for branch/worktree *lifecycle* (`status`, `log`, `diff`,
  `switch`, `branch`, `commit` on a dev branch, `merge`, `rebase`). **Claude Code's own allowlist stays
  git-free** — Claude never runs `git merge`/`git push`. The human drives the consequential ops via chat verbs.
- **Read-only git is unrestricted** (status/log/diff/branch-list — needed for drift detection §7 and previews).
- **Write git is gated:**
  - `commit` on a dev branch (WIP commits) — low risk (disposable branch, fully reversible by deletion) → host
    may do it automatically as part of `lt`/`sync`/`merge`.
  - `switch`/`rebase`/`merge` — human-initiated via a chat verb, with the gates in §6.
  - **`push` stays fully manual** (terminal `cp`/`bcp`). The host never pushes.
- **`main` is never mutated autonomously.** A merge into `main` happens only on an explicit human `merge` + the
  in-chat confirm (§6). This keeps "Claude can't rewrite main on its own" intact — the property the original rule
  protects.

This relaxation is **opt-in with the dev bridge** and strippable with it (the trust module, `DESIGN_dev_bridge.md`
§11): drop the bridge + the new host git verbs and the feature never existed.

## 4. Live-test: in-place branch switch + reload (Phase 1)

The sharpest friction in a branch model is normally "the extension loads `main`, so you can't see a branch live
until you merge." Here it's nearly free, because **there is no build step — the loaded directory IS the source.**

**The loaded directory never changes.** Chrome keeps pointing at the same fixed path; the **extension ID stays
fixed**, so the native-messaging host keeps working without re-whitelisting. What changes is **which branch is
checked out inside that one folder** — same directory, different file contents — and the existing reload icon's
`chrome.runtime.reload()` re-reads them.

```
Chrome ──loads──▶ <repo root>                 ← fixed path, fixed ID, never changes
                     │  git switch dev/<branch>   (rewrites the working tree in place)
                     ▼
              chrome.runtime.reload()          ← re-reads the swapped files → live on that branch
```

This is the **same mechanism as today's edit→reload loop** — only the "edit to the folder" is git swapping the
whole tree to a branch snapshot instead of Claude typing. (Phase 1: one working tree that switches branches.
Under concurrency (§10), authoring moves to per-run **worktrees** and this loaded folder becomes a read-only
**preview tree**.)

**Trigger — `lt`, a reserved keyword (decided), not NLU.** In a dev conversation all bare text is forwarded to
Claude Code, so the control word must be an unambiguous exact token the panel intercepts *before* forwarding —
the same trust grammar as `gl`/`gc`/`gch`/`pause`/`history`. Reasons keyword beats phrasing:

- Live-test is consequential + local (commit, `git switch`, **restart the extension**) — never trigger that on a
  probabilistic NLU guess.
- Collision: fuzzy-matching "let's live test" means you can never *say* "live test the parser" to Claude. A
  reserved token owns one phrase; everything else flows to Claude.
- §5 trust rule: no LLM in the command path. Keyword = zero latency, zero cost, deterministic.

**Match rule:** case-insensitive, **whole trimmed message only**, against a small allowlist `{ lt, live,
"live test", livetest }`. So a bare `lt` fires; *"can you live test the search box?"* (a longer sentence) flows
to Claude. Primary token `lt` (mirrors `gl`/`gc`/`gch`); the others are friendly aliases.

**`lt` flow:** post a `↻ switching to dev/<branch> and reloading…` bubble → host WIP-commits the current branch →
`git switch` the loaded folder to this conversation's branch → `chrome.runtime.reload()` (panel reopens on the
reloaded build). **Viewing** a dev conversation stays instant (chat-view swap, no git/reload); **live-testing**
is the explicit `lt` step — the two are decoupled so selecting a conversation never surprises you with a reload.

**Consequence (Phase 1):** one folder, one branch on disk at a time → one live-test at a time, and switching
needs a clean tree (the WIP-commit handles it; *ad-hoc work must live on a branch too* — the one workflow change,
"everything is a branch"). **Under concurrency (§10)** execution moves to per-run worktrees and this loaded
folder becomes a read-only **preview tree** that `lt` detached-checks-out to any branch — still one live-test at
a time for this instance (parallel live-test = separate instances, §10.1), but now it's never authored in, so the
clean-tree caveat disappears. (Detached HEAD at a branch tip is allowed even while that branch is checked out in
its worktree — so previewing a running branch is fine.)

## 5. The chat grammar (keyword-in-chat, zero buttons)

All dev-branch control is reserved verbs typed in the dev conversation, intercepted before forwarding to Claude —
consistent with `lt` and the existing bridge verbs. No new UI chrome.

| verb | effect |
|---|---|
| `lt` (· `live` · `live test` · `livetest`) | live-test this branch (§4) |
| `merge` | sync → test → diff → confirm → merge to `main` (§6) |
| `sync` | pull current `main` into this branch (catch up; conflicts resolved *here*) |
| `split <concern>` | extract an out-of-scope change into its **own** dev conversation/branch (§8) |
| abandon | the existing delete-conversation → delete the branch (confirm) |

Discoverability: extend the dev-conversation empty-state hint (which already lists `gl · gc · gch · bug: · pause
· history · …`) with `lt · merge · sync · split`.

## 6. Merge — the gated flow

`merge` runs a fixed, human-gated sequence (the host executes git; Claude does not):

1. **WIP-commit** the branch (clean tree).
2. **Sync** — rebase/merge `main` *into the branch*. Conflicts surface **on the branch**, where Claude has the
   task context to fix them — never on `main`.
3. **Gate** — `npm test` in the branch. Red → stop, report in chat, no merge.
4. **Diff preview** — render branch-vs-`main` diff as a chat bubble for human eyeball.
5. **Summarize (knowledge → main).** Claude emits a structured **merge-summary** `{ changed, learned,
   newInvariant? }`. This is what carries the branch's *knowledge* into `main` (the session itself doesn't
   merge — §6.1): the summary becomes the merge commit message, and a reusable lesson is *proposed* into a
   tracked home (§2.1, §6.1).
6. **Confirm in chat** → host `git switch main` + `git merge --no-ff dev/<branch>` **with the step-5 summary as
   the commit message** → archive the conversation (§6.1).
7. **Push stays manual** (`cp`/`bcp`). The host never pushes.

Optional later: a `pr` variant that opens a `gh` PR (review + CI) instead of a local merge.

### 6.1 After a merge — what persists (and how branch knowledge reaches `main`)

A merge retires the *git* artifacts but keeps the *chat* record, and it **carries the branch's knowledge to
`main` as tracked content** — not just its code. Per artifact:

| artifact | fate | why |
|---|---|---|
| the **conversation** (transcript) | **kept** — `{ status:'merged', mergedAt, mergeCommit }`, moved to a **"Merged"** group, **read-only** | the provenance: *how* the change was built. Not deleted; not in git. |
| the **branch** `dev/<slug>` | **deleted** | `--no-ff` preserves the lineage in `main`'s history via the merge commit; the ref is now redundant. |
| the **worktree** (§10) | **`git worktree remove`** | disposable scratch; its run is done. |
| the **session** (`sessionId`) | **retained, dormant** | still on disk (terminal-resumable), but the archived conversation isn't where you continue. |
| the **loaded / preview tree** | now on **`main`** with the change | step 6 switches to `main`; the live extension reflects the merged result. |
| **other live branches** | **drift-nudged to `sync`** (§7) | `main` moved. |

**The knowledge rule (why step 5 exists).** A branch's Claude **session memory does *not* merge** — it isn't in
git, and `findings.md` / `logs/` are **git-ignored**, so notes written there stay local to the branch's tree.
Knowledge reaches `main` **only via tracked files**. So the merge **externalizes** the branch's learning on
purpose:

- Claude's step-5 **merge-summary** `{ changed, learned, newInvariant? }` becomes the **`--no-ff` merge commit
  message** — durable in `main`'s history by construction, zero new infra, always carried.
- When the lesson is **reusable beyond this change**, Claude *proposes* (propose→approve→act, §2.1) appending it
  to the right **tracked** home — a `CLAUDE.md` invariant (for a genuine invariant), a `docs/` note, or a tracked
  dev-journal — so future `main` work and new branches inherit it. **Not** the git-ignored `findings.md` (it
  wouldn't merge). The human approves the destination; over-writing `CLAUDE.md` on every merge is avoided —
  only genuine invariants land there, everything else is the commit message + an optional doc line.

**Follow-up work** doesn't reopen a merged conversation (its branch is gone) — it starts a **new** branch,
optionally **"fork from here"** seeded from the archived conversation's context.

## 7. Cross-branch divergence — gate the *merge*, not the *change*

Scenario: branch A changes a fundamental element, merges; branch B was built on the old version and now breaks.
Divergence is unavoidable; you control **where and when** it surfaces.

- **Hard gate (always): no merge unless the branch is rebased on *current* `main` AND green.** Property: the
  **later merger pays the integration cost, in their own branch, in context.** When A merges, `main` moves; when
  B later types `merge`, step 2 pulls A's change into B first → B breaks *in B's conversation* (Claude fixes it)
  and only a green, current B reaches `main`. **`main` is therefore always buildable.** This is merge-queue /
  trunk-based discipline; `main` is the serialization point (serial merges, matching serial execution).
- **Soft gate (warning, never blocks): drift detection.** When `main` moves, compute which *other* live dev
  branches touched the same files and post a chat nudge in them: *"⚠ main changed `Core/orchMatch.js`; this
  branch also touches it — `sync` to catch up."* A `merge` touching surface used by other live branches warns:
  *"changes shared `X` used by branches B, C — merge anyway?"* (read-only git; safe).
- **Do NOT gate the act of making a foundational change.** Vetoing fundamental changes blocks legitimate
  refactors. Let A make the change; make the consequences *visible* (drift) and *force reconciliation before the
  next merge* (the hard gate). That division is the whole design.

## 8. Scope discipline — keeping a branch on its concern

Focused branch = small diff = easy merge/abandon, low collision. A sprawling branch touches shared surface and
collides with everything. You can't hard-enforce scope without crippling the agent, so it's layered (mostly
soft/preventive, hard gate is the merge gate):

- **A stated `concern` per conversation** (one line, set at creation / inferred from the first ask) — the
  contract. Shown in the header and **injected into Claude's per-branch system prompt:** *"Your scope is
  `<concern>`. Do not refactor unrelated areas. If a fix needs shared/foundational code, PAUSE and tell the
  user."* Claude honors explicit scope contracts; the existing pause-for-question relay (DB-4) is the stop valve.
- **Diff-scope drift nudge (detective).** Track the file-set each branch touches; when it expands past its
  concern or starts editing foundational files, nudge in chat: *"⚠ this branch (concern: drawer UI) now edits
  `background.js` — intentional?"* A warning, not a block.
- **`split <concern>` (corrective).** When a branch *legitimately* needs an out-of-scope foundational change,
  don't absorb it — extract it into its own dev conversation/branch, merge that first, then `sync` the original
  onto it. Scope pressure resolves by extraction.
- **Short-lived branches (structural).** The real enforcer is process: merge or abandon focused branches
  promptly. A weeks-old branch *will* sprawl and collide; the drift nudges exist partly to push convergence.

### 8.1 Detecting split opportunities — and seeding the split

"Can Claude detect useful splits?" Yes — three layers, **biased to plan time** (the only cheap moment to act):

1. **Claude proposes (model-driven, highest context).** Concern-contract rule (§8): *before implementing*, if
   the task carries a separable concern — a foundational/shared change, an unrelated improvement, or work that
   doesn't serve the stated `concern` — Claude must **stop and propose a split** instead of doing it inline.
   Surfaced through channels already relayed (DB-4): `ExitPlanMode` (a plan) or `AskUserQuestion` (*"Split
   `<concern>` into its own branch? [Yes] [No, keep here]"*). **Fire at plan time** — scope-check the *plan*,
   not a sprawling diff. *Caveat: not 100% — left to its helpfulness Claude often fixes the shared thing inline;
   the contract raises the rate, the backstop catches the rest.*
2. **Deterministic backstop (host, always-on, no LLM).** Extend §8's diff-scope analysis: flag a split when the
   diff (a) splits into **two weakly-connected file clusters**, (b) touches a **foundational/shared file**
   alongside leaf work, or (c) **drifts off the concern**. A nudge → offers `split`; can't read intent, so never
   an authority. Catches what Claude forgets to flag.
3. **Optional semantic check.** A `scope?` verb (or an auto-check at `merge`): *diff + concern* → a quick model
   call for a second opinion. Costs a call; on-demand only.

**The catch: detecting is easy; *post-hoc execution* is surgery.** Splitting an in-progress diff means
interactive hunk-splitting across shared files. Clean only when the concern is its own files/commits (cherry-pick
out to a new branch, revert on the original); tangled hunks become a **guided Claude extraction task**. So the
design **biases hard to plan-time** splits (split before code exists — then it's just routing the sub-task).

**Seeding an approved split — who launches it.** This is the §2.1 *propose → approve → act* boundary applied to
splits. Claude does **not** launch or auto-spawn the new conversation/run itself — it can't drive the panel
(§2.1). Instead:

- Claude's split proposal is a **structured payload** `{ concern, reason, branchBase, seedPrompt, suggestedName }`
  — Claude writes the `seedPrompt` (it has the context), suggests the concern + branch name, and usually sets
  `branchBase: 'main'`.
- On the human's one-tap **approval** ("Yes, split"), the **panel** performs the local actions: create branch
  `dev/<name>` (**off `main` by default** — a foundational split must merge to main independently and have the
  parent `sync` onto it; only a split that genuinely depends on the parent branches off the parent), create the
  `kind:'dev'` conversation, and **seed it with Claude's `seedPrompt`**.
- So **"Claude prompt-seeds" is true in *content*** (the seed is Claude's), but the **panel is the actor**, gated
  on human approval — the trust boundary holds.

**Seed policy + the serial constraint:**

- **Seed-and-hold (default):** the new conversation opens with the seed **pre-filled** (a draft), *not* sent —
  the human reviews and presses enter. Strictly respects "user-typed only."
- **Seed-and-run:** auto-start the child's run from the seed (the "Yes, split" click is the gesture/approval). In
  Phase 1 (serial) it waits its turn — at plan time the parent is paused for the answer, so: create child seeded
  → finish/park the parent → run the child. **Under concurrency (§10)** the child runs *alongside* the parent in
  its own worktree, subject to the pool cap — split-then-fan-out becomes real parallel decomposition.

Net effect: **Claude becomes a planner that decomposes work into seeded branches**; the human approves the
decomposition one tap at a time; each approved split is a branch pre-loaded with Claude's own seed prompt —
serialized in Phase 1, **fanned out concurrently once §10 lands** (the natural payoff of split detection).

## 9. Lifecycle, state & the persistence-pinning fix

- **Mapping:** the `kind:'dev'` conversation record carries `{ branch, concern, sessionId, status, mergedAt?,
  mergeCommit? }` where `status ∈ {active, merged, abandoned}`. A `merged`/`abandoned` conversation is
  **archived read-only** (kept as provenance — §6.1; its branch/worktree are gone, so `lt`/`dev:`/`merge` are
  disabled, view + export only). A reconciliation pass on panel load reconciles conversations whose branch was
  deleted out-of-band (terminal) and flags branches with no conversation.
- **Persistence pinning (subsumes the leak fix).** Today a live run's blocks persist via `_ensureConversation()`
  = the *currently active* conversation, so switching away mid-run leaks Claude Code output into the wrong
  conversation. Under this design every run is **bound to its originating dev conversation id** and persists
  there regardless of what's active — by construction, since the run *is* a branch's run. This fixes the leak
  and is a prerequisite, not an afterthought.
- **Session resume per branch:** `dev:`/bare-text resumes *this* conversation's `sessionId`, not a global last
  session (replaces `settings:devBridgeLastSession` for dev conversations).

## 10. Concurrent execution — single-host multiplexing (the chosen scale path)

Serial is the Phase-1 default, but concurrency is **designed in**, not deferred to a separate architecture. The
chosen path: **one native host multiplexes N `claude -p` children over the single port by tagging every frame
with a `runId`** — the same way HTTP/2 carries many streams over one connection. (The alternative — N separate
extension instances, §10.1 — is heavier and kept only for parallel *live-test*.)

**`runId` turns one port into N channels.** Every run-scoped frame, both directions, carries a `runId`; Chrome
frames each JSON message atomically, so interleaving K children on the wire is safe and the panel demultiplexes
by `runId`. The protocol bumps to `v:2`; only one new frame type (`pool`) is added — the rest just gain `runId`.

```
claude r1 ─┐
claude r2 ─┼─▶ host ─▶ [one port, runId-tagged frames] ─▶ panel ─demux─▶ bubble→conversation per runId
claude r3 ─┘
```

- **Host → run-pool manager.** `runs: Map<runId,{proc,sessionId,cwd,status}>`; a `run` frame spawns a child (cwd
  = its worktree) and pipes its NDJSON stdout as `event` frames; a `MAX_CONCURRENT` cap (e.g. 4) queues or
  pool-`busy`es beyond it. Per-run control (`pause`, `approval`/`approval-decision`, `done`, `error`) is all
  `runId`-scoped. Per-child stdout **flow-control** on port backpressure (pause reading when `write()` returns
  false) so a chatty child can't balloon memory.
- **Concurrency forces worktrees.** Two children can't share one folder on different branches — each live run
  gets its own `git worktree` as `cwd`. This replaces Phase-1's single-tree branch-switch for *execution*;
  **live-test** (§4) then runs in a dedicated read-only **preview tree** that `lt` detached-checks-out to any
  branch — one live-test at a time, even while N branches execute.
- **Panel → multi-run manager.** `runs: Map<runId, RunHandle{conversationId, bubble, blocks, …}>`; an `event`
  demuxes to its run's bubble, which lives in its dev conversation — possibly **off-screen**, so the §9
  persistence-pinning is now load-bearing (each run persists to its OWN conversation regardless of what's
  displayed). The running-bar extends to show each live run + per-run pause.
- **Failure & reattach.** One child crash → `done`/`error` for its `runId` only. But the host is a **single point
  of failure** for all runs (children die with it on Windows, per `findings.md`) — mitigated, not eliminated, by
  the throttled mid-run persist (each run's partial transcript + `sessionId` survive in its conversation). On
  panel reload a `pool` frame lists live runs so the panel rebuilds bubbles (runId→conversation persisted by the
  panel / carried in each run's journal).
- **The real cap is resources, not the wire.** Multiplexing frames is cheap; K is bounded by **tokens / API
  rate** (N concurrent Claude Code ≈ N× burn, 429 risk) and CPU/disk (N worktrees, parallel `npm test`).
  `MAX_CONCURRENT` doubles as the cost/rate governor; a token budget can back it.

Example frames (`v:2`):

```jsonc
// panel → host
{ v:2, type:'run', runId:'r1', prompt:'…', cwd:'…/.wt/r1', resumeSessionId:'…', model:'default', maxTurns:25 }
{ v:2, type:'pause', runId:'r1' }
{ v:2, type:'approval-decision', runId:'r1', id:'a7', decision:'allow' }
// host → panel
{ v:2, type:'event', runId:'r1', ev:{ type:'assistant', message:{…} } }
{ v:2, type:'done',  runId:'r1', result:{ subtype:'success', sessionId:'…' } }
{ v:2, type:'pool',  running:[{runId:'r1',conv:'…',pid:1234}], cap:4 }
```

### 10.1 Parallel live-test (separate instances, optional)

Multiplexing gives parallel *execution*, but the bridge-bearing instance still live-tests one branch at a time
(Chrome loads one folder). To *view* two branches live side-by-side, load each branch's worktree as its **own
unpacked extension** (own SW / side panel / storage / ID; each `chrome.runtime.reload()` reloads itself). Hard
limits (Chrome, not us): **no API to load an unpacked extension** → a one-time manual "Load unpacked" per branch
(+ manual cleanup); **different ID per path** → those instances can't use the bridge (fine — they're the *app
under test*; the main instance keeps the bridge and drives merge/abandon). Opt-in, additive; not required for the
core workflow.

## 11. Hard limits & non-goals

- **Concurrency is resource-bounded, not wire-bounded.** Single-host multiplexing (§10) runs N children over one
  port; the limit is tokens / API-rate and CPU/disk, governed by `MAX_CONCURRENT` (+ an optional token budget) —
  not the transport. Serial is just Phase 1's default.
- **Host is a single point of failure** for all concurrent runs — children die with the host on Windows
  (`findings.md`). Mitigated by the throttled mid-run persist (partials + `sessionId` recoverable per
  conversation), not eliminated.
- **Manual conflict resolution.** `sync` on a foundational change can produce real conflicts costing Claude a
  turn (or several). No magic — the design makes the cost *visible, localized to the right branch, and gated so
  `main` stays green*, not zero.
- **node_modules per tree.** A worktree shares `.git` but not `node_modules`; `npm test` in a worktree needs an
  install or a shared/symlinked modules dir — a **first-class concern once execution moves to worktrees (§10)**,
  not just an instances-only detail (Phase 1's single tree already has them).
- **Chrome can't garbage-collect unpacked extensions** for us — relevant only to the optional separate-instances
  live-test (§10.1), whose cleanup is manual.
- **Non-goal:** autonomous merge/push. The human + the gates are always in the loop for anything touching `main`.

## 12. Decisions taken / defaulted (override in review)

- **Live-test trigger = `lt`** (+ `live`/`live test`/`livetest`, whole-message exact match). *Decided.*
- **Live-test = a single loaded tree** (Phase 1: branch-switch + reload; under §10: a read-only preview tree,
  detached-checkout, one live-test at a time).
- **Concurrency = single-host multiplexing (§10), chosen over separate extension instances.** One host runs N
  `claude -p` children over one port (`runId`-tagged, `v:2` protocol), per-run worktrees, `MAX_CONCURRENT`
  resource cap. Serial is the Phase-1 default; concurrency is a later phase. Separate-instances (§10.1) kept only
  as the optional parallel *live-test* path. *Decided.*
- **Trust:** host-driven scoped git; Claude's allowlist stays git-free; `merge`/`switch`/`rebase` human-gated;
  `push` manual. **← the gate for any code.**
- **Merge model = local `git merge --no-ff`** after sync+green+diff-confirm; `gh` PR flow optional later.
- **After merge (§6.1):** branch + worktree **deleted**; the **conversation is archived read-only** (kept as
  provenance). **Branch knowledge persists in `main`** via a tracked merge-summary — Claude's `{ changed, learned,
  newInvariant? }` becomes the **`--no-ff` merge commit message**, and a reusable lesson is *proposed* into a
  tracked home (`CLAUDE.md` invariant / `docs/` note), **never the git-ignored `findings.md`**. *Decided.*
- **Branch naming:** `dev/<slug>-<shortid>`; **WIP commits** auto on the branch; abandon = delete branch.
- **Split detection = Claude-proposed (plan-time, via the question/plan relay) + a deterministic diff backstop**
  (§8.1); an approved split is **panel-created and seed-prompted from Claude's payload** — Claude never launches
  it. Default seed policy = **seed-and-hold**; splits branch off `main` by default.
- **Open:** how `concern` is captured (explicit at creation vs. inferred from first ask); drift-detection
  granularity (file-set overlap vs. a designated "foundational files" set); whether `main`'s own ad-hoc work
  must always be a branch (implied by Phase 1's clean-tree requirement; moot once §10's preview tree lands);
  split-seed policy (seed-and-hold default
  vs. seed-and-run); whether split detection fires at plan time only or also on the live diff; whether to add a
  **git-tracked dev-journal** (a merging counterpart to the git-ignored `findings.md`) as the default home for
  reusable merge-lessons, vs. relying on commit messages + occasional `CLAUDE.md`/`docs/` appends (§6.1).

## 13. Phases (implementation order; each `bcp`-able)

1. **Phase 1 — branches + live-test.** Dev conversation ↔ branch mapping + the per-conversation fields; host
   scoped-git (read + `switch`/`commit`); `lt` verb (WIP-commit → switch → reload); persistence pinning (§9, the
   leak fix); per-conversation `sessionId` resume. Branch status (branch · ahead/behind · clean/dirty · last
   test) in the dev header. *No merge yet.*
2. **Phase 2 — converge.** `merge` (sync → test → diff → **merge-summary** → confirm → `--no-ff`), `sync`,
   abandon→delete-branch, drift nudges (§7 soft gate), worktree GC, **conversation archive (read-only) +
   knowledge-to-`main`** (summary → merge commit message, + proposed tracked-doc/`CLAUDE.md` append, §6.1).
3. **Phase 3 — scope + split.** `concern` contract in Claude's prompt + diff-scope drift nudge; **split detection
   (§8.1)** — Claude-proposed (plan-time, via the question/plan relay) + the deterministic backstop — with
   **panel-created, seed-prompted branches on approval**; the `pr`/`gh` merge variant.
4. **Phase 4 — concurrency (§10).** Per-run **worktrees**; host **run-pool** + `v:2` `runId`-multiplexed protocol
   (+ flow-control, `pool` frame); panel **multi-run manager** + running-bar (per-run pause); **preview-tree**
   live-test (detached checkout); `MAX_CONCURRENT` + optional token budget; pool reattach on reload. Turns split
   detection (§8.1) into real fan-out. *(Optional: §10.1 separate-instances for parallel live-test.)*

**Gate for starting Phase 1:** sign-off on §3 (scoped git in the host). No code until then — `lt`/`merge`/`sync`/
`split` all depend on it. Phase 4 additionally needs the `v:2` protocol + worktree topology signed off.
