# DESIGN — Dev branches (a dev conversation is a branch is a proposal)

> Status: **approved — Phase 1 GO** (design discussion 2026-06-16; all U1–U14 resolved + §3 trust gate signed
> off 2026-06-17) · Builds on the dev-bridge (`DESIGN_dev_bridge.md`,
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

**The enumerated allowlist (resolves U1).** The host exposes **discrete, parameter-validated operations — never a
passthrough `git <args>`.** The panel calls `gitSwitch(branch)` / `gitMergeNoFf(branch)`; the host builds the
exact command with a validated branch name (must match `dev/…`; no shell metacharacters). This blocks argument
injection and scope creep — and Claude's own allowlist stays git-free regardless.

| tier | ops | rule |
|---|---|---|
| **R — read-only, unrestricted** | `status` · `diff` · `log` · `show` · `branch --list` · `rev-parse` · `merge-base` | no mutation; feeds drift/preview/status |
| **W-auto — host-run, dev-branch-scoped** | `commit` (on `dev/…`) · `switch` / `switch --detach` (to `dev/…` or a commit) · `branch` (create `dev/…`) · `worktree add`/`remove`/`list`/`prune` (preview + per-branch trees, §10/U6) | only ever touches a `dev/…` branch or a host-managed worktree; never authors on `main` |
| **W-gated — human-confirmed chat verb only** | `rebase`/merge-main-into-branch (`sync`) · `merge --squash` into `main` · `branch -D` (abandon) · `cherry-pick` (split extraction) | fires only from `merge`/`sync`/`split`/abandon + the in-chat confirm |
| **FORBIDDEN** | `push`(+`--force`) · history rewrite on `main` · `reset --hard` · `config` · remote ops | never; `push` stays manual `cp`/`bcp` |

Rulings: **`revert` is deferred** (not v1 — un-merging a bad merge is rare; do it manually, keeping `main`'s
mutation surface to exactly one op, the gated `merge`). **`stash` is excluded** — WIP-commits on the dev branch
serve the clean-tree need and are inspectable/recoverable, where stash is opaque global state that collides
across worktrees. **Host-side guard:** the host refuses any write whose target isn't a `dev/…` branch *except*
the single gated `merge --squash` into `main` — this is what makes "Claude can't rewrite main" structurally true,
not merely conventional. *(Worktree ops `worktree add`/`remove`/`list`/`prune` are included per the §10/U6
topology — host-managed preview + per-branch trees.)*

This relaxation is **opt-in with the dev bridge** and strippable with it (the trust module, `DESIGN_dev_bridge.md`
§11): drop the bridge + the new host git verbs and the feature never existed.

> **✅ SIGNED OFF — 2026-06-17 (project owner).** §3's scoped-git relaxation is approved as specified
> (discrete validated host ops; Claude's allowlist stays git-free; `merge`/`switch`/`rebase` human-gated; `push`
> manual; dev-branch guard on writes). The Phase-1 gate is cleared — implementation may begin.

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
| abandon | **soft by default** (U13): archive the conversation (`abandoned`) + remove the worktree (free the slot), but **keep the branch**; a separate explicit **"delete branch"** is the hard option (confirm) |

Discoverability: extend the dev-conversation empty-state hint (which already lists `gl · gc · gch · bug: · pause
· history · …`) with `lt · merge · sync · split`.

## 6. Merge — the gated flow

`merge` runs a fixed, human-gated sequence (the host executes git; Claude does not):

1. **WIP-commit** the branch (clean tree).
2. **Sync** — rebase/merge `main` *into the branch*. Conflicts surface **on the branch**, where Claude has the
   task context to fix them — never on `main`.
3. **Gate** — `npm test` in the branch. Red → **one automatic retry** (real suites flake); passes on retry →
   land but flag *"flaky — passed on retry"* (never silently treat a flake as green); two reds → stop, report,
   no merge. (U14)
4. **Diff preview** — show **`git diff --stat`** (file list + ±counts) as the chat bubble; full hunks on demand
   ("show full diff" / it's in the worktree), so a huge diff doesn't flood the chat. (U14)
5. **Summarize (knowledge → main).** Claude emits a structured **merge-summary** `{ changed, learned,
   newInvariant? }`. This is what carries the branch's *knowledge* into `main` (the session itself doesn't
   merge — §6.1): the summary becomes the merge commit message, and a reusable lesson is *proposed* into a
   tracked home (§2.1, §6.1).
6. **Confirm in chat** → host `git switch main` + `git merge --squash dev/<branch>` + `git commit` **with the
   step-5 summary as the message** (one clean commit; the branch's auto-WIP history is discarded — see §6.3/U8)
   → archive the conversation (§6.1).
7. **Push stays manual** (`cp`/`bcp`). The host never pushes.

Optional later: a `pr` variant that opens a `gh` PR (review + CI) instead of a local merge.

### 6.1 After a merge — what persists (and how branch knowledge reaches `main`)

A merge retires the *git* artifacts but keeps the *chat* record, and it **carries the branch's knowledge to
`main` as tracked content** — not just its code. Per artifact:

| artifact | fate | why |
|---|---|---|
| the **conversation** (transcript) | **kept** — `{ status:'merged', mergedAt, mergeCommit }`, moved to a **"Merged"** group, **read-only** | the provenance: *how* the change was built. Not deleted; not in git. |
| the **branch** `dev/<slug>` | **deleted** | squash-merged into **one** commit on `main`; the branch's auto-WIP history is intentionally discarded (the granular story lives in the archived conversation; provenance via the summary + a `Dev-conversation:<id>` trailer). |
| the **worktree** (§10) | **`git worktree remove`** | disposable scratch; its run is done. |
| the **session** (`sessionId`) | **retained, dormant** | still on disk (terminal-resumable), but the archived conversation isn't where you continue. |
| the **loaded / preview tree** | now on **`main`** with the change | step 6 switches to `main`; the live extension reflects the merged result. |
| **other live branches** | **drift-nudged to `sync`** (§7) | `main` moved. |

**The knowledge rule (why step 5 exists).** A branch's Claude **session memory does *not* merge** — it isn't in
git, and `findings.md` / `logs/` are **git-ignored**, so notes written there stay local to the branch's tree.
Knowledge reaches `main` **only via tracked files**. So the merge **externalizes** the branch's learning on
purpose:

- Claude's step-5 **merge-summary** `{ changed, learned, newInvariant? }` becomes the **squash commit message**
  (the one commit the feature lands as, §6.3) — durable in `main`'s history by construction, always carried.
- When the lesson is **reusable beyond this change**, Claude *proposes* (propose→approve→act, §2.1) appending it
  to the right **tracked** home — a `CLAUDE.md` invariant (for a genuine invariant), a `docs/` note, or a tracked
  dev-journal — so future `main` work and new branches inherit it. **Not** the git-ignored `findings.md` (it
  wouldn't merge). The human approves the destination; over-writing `CLAUDE.md` on every merge is avoided —
  only genuine invariants land there, everything else is the commit message + an optional doc line.

**Follow-up work** doesn't reopen a merged conversation (its branch is gone) — it starts a **new** branch,
optionally **"fork from here"** (resolves U12): a **new** branch off `main` + a **new** dev conversation whose
seed prompt = the merged conversation's summary/concern + "continue from here." It seeds a *fresh* session, not a
resume of the dormant one — Claude Code sessions are linear (no clean "fork a session" primitive), and a summary
gives the relevant context without dragging the whole prior transcript.

### 6.2 Sync-conflict resolution (resolves U4)

`sync` (and `merge` step 2) brings current `main` into the branch. Bounded sub-flow:

1. Host attempts the rebase/merge of `main` into the branch (in the branch's tree). **Clean → proceed** (merge
   continues to the test gate).
2. **Conflicts → host pauses the flow and auto-seeds a scoped resolution run** (`claude -p` in the branch's tree)
   with a fixed prompt: *"Resolve these git conflicts in `<files>`. Preserve the branch's intent (`<concern>`)
   AND main's incoming changes; touch nothing unrelated; run `npm test` when done."* It's an ordinary dev run —
   visible/pausable in the conversation, and it **never touches `main`** (conflicts resolve on the branch, §7).
3. **Resolution run green → resume** at the gate (re-run `npm test` → diff → confirm). **Bounded: one auto-attempt.**
4. **Can't resolve** (run exits unresolved, or tests still red) → **stop, surface the conflict in chat, leave the
   branch conflicted-but-committed, hand to the human** (*"couldn't auto-resolve `<files>` — fix in the
   worktree/terminal, then re-run `merge`"*). No silent retry loop.

Conflict resolution is thus just an auto-seeded run on the branch — it reuses the run machinery (and, under §10,
its own worktree), composes with concurrency, and stays off `main`.

### 6.3 WIP-commit hygiene — squash at merge (resolves U8)

The host auto-creates **WIP commits** (checkpoints) before every `lt`/switch/sync/merge so the tree is clean
enough for git to switch — and since Claude's allowlist is git-free (U1), **every** commit on a branch is an
auto-WIP, never a curated unit. Left alone they'd flood `main`'s history with "WIP" noise (one feature's real
story buried under bookkeeping, × every branch).

So a branch **lands as one clean commit**: the merge is `git merge --squash dev/<branch>` (stages the branch's
net changes on `main` *without* importing its commits) + `git commit` with the **merge-summary** as the message.

- `main` history = **one meaningful commit per feature**; readable `git log`.
- The WIP checkpoints did their job (mid-branch switching/recovery) and are **discarded** — they were never
  coherent, tested states.
- The granular story survives in the **archived conversation** (§6.1); a `Dev-conversation:<id>` commit trailer
  links the commit back to it.

Trade-off: no `git bisect` *into* a branch's individual steps — but a WIP checkpoint isn't a coherent state, so
that granularity was illusory; bisecting across the one-commit-per-feature `main` is unaffected.

## 7. Cross-branch divergence — gate the *merge*, not the *change*

Scenario: branch A changes a fundamental element, merges; branch B was built on the old version and now breaks.
Divergence is unavoidable; you control **where and when** it surfaces.

- **Hard gate (always): no merge unless the branch is rebased on *current* `main` AND green.** Property: the
  **later merger pays the integration cost, in their own branch, in context.** When A merges, `main` moves; when
  B later types `merge`, step 2 pulls A's change into B first → B breaks *in B's conversation* (Claude fixes it)
  and only a green, current B reaches `main`. **`main` is therefore always buildable.** This is merge-queue /
  trunk-based discipline; `main` is the serialization point — **serial merges even as execution runs concurrent
  (§10), enforced by the lock + freshness check in §7.2.**
- **Soft gate (warning, never blocks): drift detection.** When `main` moves, compute which *other* live dev
  branches touched the same files and post a chat nudge in them: *"⚠ main changed `Core/orchMatch.js`; this
  branch also touches it — `sync` to catch up."* A `merge` touching surface used by other live branches warns:
  *"changes shared `X` used by branches B, C — merge anyway?"* (read-only git; safe).
- **Do NOT gate the act of making a foundational change.** Vetoing fundamental changes blocks legitimate
  refactors. Let A make the change; make the consequences *visible* (drift) and *force reconciliation before the
  next merge* (the hard gate). That division is the whole design.

### 7.1 Defining "foundational / shared", drift, and split-clusters (resolves U2)

The detective signals in §7 and §8.1 need concrete, cheap definitions — no LLM, all read-only git + a static
import scan, run on panel load / after each merge:

- **Foundational / shared file** = lives in a shared layer (`Core/` or `Services/`, per the repo layout) **or**
  is imported by **≥ 3** other modules. A light static import/`require` scan (the codebase is ESM + some `.cjs`)
  gives the importer counts; `Core/`+`Services/` is the cheap directory prior. The layer list + threshold live in
  **config**, not magic numbers in code.
- **Drift** (§7 soft gate) = `main`'s new commits since the branch forked touch a file the branch **also**
  modified — a `git diff --name-only` set-intersection. That's the `sync`-nudge trigger.
- **Split-cluster** (§8.1 backstop) = the branch's changed files, linked by import edges, fall into **≥ 2
  connected components with no edge between them** → likely ≥ 2 concerns. Combined with "touches a foundational
  file alongside leaf files," this is the deterministic split signal.

Tunable and refinable — the point is they're now concrete enough to build, replacing the "weakly-connected"
hand-waving.

### 7.2 Merge serialization — the lock + freshness check (resolves U7)

§7's "`main` always buildable" guarantee holds only if merges into `main` are **serialized** — otherwise two
branches that both prepared against the same `main` can both land, and the *combination* was never tested.

- **Freshness check (the correctness guarantee).** A merge records the `main` commit it synced onto; just before
  landing it re-checks `main`'s current HEAD. If `main` moved (another merge — or a terminal commit — landed
  meanwhile), the merge **re-syncs onto the new `main` and re-tests** (§6.2) before landing. So nothing ever
  lands on a `main` it wasn't synced+green against — even against out-of-band changes.
- **Merge lock (the ordering).** A single in-panel lock on `main` (the panel is the sole merge coordinator;
  §10.1 preview instances don't merge). The **land step only** (`git switch main` + `merge --squash` + commit, in
  the repo-root `main` tree) holds it; the slow **prepare** (sync + test + the human confirm) runs lock-free in the
  branch's worktree. Concurrent `merge`s queue FIFO with a visible *"waiting to merge — Nth in line"* status.
- **Why land-only:** holding the lock across test + think-time would serialize everything and let a slow human
  block others; holding it only for the fast land — plus the freshness re-check — gives safety *and* parallel
  prepare. (A lightweight version of a GitHub-style merge queue.)

Net: branches prepare in parallel (own worktrees); `main` is touched one merge at a time, each re-validated
against the exact `main` it lands on.

## 8. Scope discipline — keeping a branch on its concern

Focused branch = small diff = easy merge/abandon, low collision. A sprawling branch touches shared surface and
collides with everything. You can't hard-enforce scope without crippling the agent, so it's layered (mostly
soft/preventive, hard gate is the merge gate):

- **A stated `concern` per conversation** (one line; **defaults to the first ask**, editable — §8.2) — the
  contract. Shown in the header and **injected into Claude's per-branch system prompt** (*re-injected every spawn*
  — §8.2): *"Your scope is `<concern>`. Do not refactor unrelated areas. If a fix needs shared/foundational code,
  PAUSE and propose a split."* Claude honors explicit scope contracts; the pause-for-question relay (DB-4) is the
  stop valve.
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
2. **Deterministic backstop (host, always-on, no LLM).** Extend §8's diff-scope analysis using the §7.1
   definitions: flag a split when the diff (a) forms a **split-cluster** (≥ 2 import-disconnected components),
   (b) touches a **foundational/shared file** alongside leaf work, or (c) **drifts off the concern**. A nudge →
   offers `split`; can't read intent, so never an authority. Catches what Claude forgets to flag.
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
- **How it's emitted (resolves U5): a dedicated bridge tool `propose_split`** with that typed schema — *not*
  prose the panel has to parse. Claude calls the tool; it arrives as a structured `tool_use` event whose
  `block.input` is already-validated JSON the panel reads directly (the same path that already handles
  `AskUserQuestion`/`ExitPlanMode` `tool_use` blocks, devBridge.js). No fuzzy parsing — the channel is typed by
  construction. The tool is **proposal-only** (no git/fs mutation); actuation stays panel-side + human-gated
  (§2.1), so exposing it to Claude doesn't widen the trust surface. *(Rejected: stuffing the payload into an
  `AskUserQuestion` string and parsing it back — fragile; its schema is questions/options, not our fields.)*
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

### 8.2 Concern: capture + per-spawn re-injection (resolves U9)

The scope guardrail lives in the **system prompt** (the standing job-briefing, separate from the conversation) —
and the system prompt is rebuilt on **every** `claude -p` spawn (continuity is `--resume <sessionId>`, which
replays the transcript but reconstructs the system prompt per-invocation). So:

- **Capture (zero-friction).** `concern` **defaults to the first ask** (trimmed to a one-line label) — no separate
  field at creation. Shown in the header, **user-editable**; Claude may propose a tighter restatement in its first
  plan (a structured field) that you can accept.
- **Re-injection (load-bearing).** The host stores `concern` on the conversation and **re-passes the scope
  contract via `--append-system-prompt` on every spawn — initial *and* every resume** — not just the first, or
  the guardrail is active one turn then silently gone. Built each spawn from the stored value: *"You are working
  ONLY on: `<concern>`. Don't refactor unrelated/shared code; if a fix needs shared/foundational files, STOP and
  call `propose_split` (§8.1) instead of doing it inline."* This is also where `propose_split` is declared to
  Claude.
- **Editing** the concern updates the stored value → the next spawn injects the new scope. Repo-wide `CLAUDE.md`
  rules load automatically in every worktree; the concern contract is the per-branch addition.

## 9. Lifecycle, state & the persistence-pinning fix

- **Mapping:** the `kind:'dev'` conversation record carries `{ branch, concern, sessionId, status, mergedAt?,
  mergeCommit? }` where `status ∈ {active, merged, abandoned}`. A `merged`/`abandoned` conversation is
  **archived read-only** (kept as provenance — §6.1; its branch/worktree are gone, so `lt`/`dev:`/`merge` are
  disabled, view + export only). A reconciliation pass on panel load reconciles conversations whose branch was
  deleted out-of-band (terminal) and flags branches with no conversation.
- **Worktree GC (resolves U10).** A crash does **not** orphan a worktree — the conversation↔worktree↔branch
  mapping is persisted here, so a dead child just leaves a **parked, resumable** branch. So GC = the
  reconciliation pass extended to worktrees, run on host startup (and after merge/abandon): (1) `git worktree
  prune` registry-stale entries; (2) keep worktrees with a **live** conversation; (3) `git worktree remove` those
  whose conversation is **merged/abandoned**; (4) **never auto-delete** a worktree with unmerged work and **no**
  conversation — surface it (*"orphaned branch dev/X has unmerged work — keep or delete?"*). Only provably-safe
  removal is automatic. (Optional: warn when the worktree count is high — nudges §8's short-lived-branch
  discipline.)
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
  = its worktree) and pipes its NDJSON stdout as `event` frames. **Overflow (resolves U10): FIFO queue, not
  reject** — beyond `MAX_CONCURRENT` (e.g. 4) a run waits and **auto-starts when a slot frees**, showing *"⏳
  queued — Nth in line"* (cancellable before it starts); a high hard queue-ceiling rejects only to stop runaway
  pile-ups. This is a *separate* queue from the merge lock (§7.2) — this rations compute slots, that rations
  landing on `main`. Per-run control (`pause`, `approval`/`approval-decision`, `done`, `error`) is all
  `runId`-scoped. Per-child stdout **flow-control** on port backpressure (pause reading when `write()` returns
  false) so a chatty child can't balloon memory.
- **Concurrency forces worktrees** (a `git worktree` = an extra working folder on the same repo, each able to
  hold a different branch). Two children can't share one folder on different branches, so each live run gets its
  own worktree as `cwd`. This replaces Phase-1's single-tree branch-switch for *execution*.

**Folder topology (resolves U6).** Three roles, all host-managed (the user never juggles folders):

| folder | role | notes |
|---|---|---|
| **repo root** (where you work today) | canonical **`main`** — merges land here; terminal `cp`/`bcp` push runs here | unchanged from today; daily push workflow preserved |
| **preview worktree** (fixed path, created once) | the **only** folder Chrome loads; `lt` detached-checks-out a branch's tip here + reloads | read-only (never authored in); one live-test at a time |
| **branch worktree** (one per active branch) | where that branch's agent edits + runs `npm test` | created on first run; `worktree remove`d on merge/abandon |

Keeping the **preview separate from `main`** is what lets you live-test branch X *while* a merge of branch Y runs
(different folders, no collision); a detached checkout in the preview is legal even while that branch is checked
out in its own worktree (§4). **Transition:** Phase 1 = just the repo root (branch-switch + reload, no worktrees).
Enabling concurrency adds the preview worktree (**one-time:** Load-unpacked it in Chrome + add its ID to the
native-host allowlist) and per-run branch worktrees; `lt` shifts from "switch the repo root's branch" to "flip
the preview + reload." *(Alternative weighed and rejected: keep Chrome on the repo root and move `main` into a
worktree — avoids the one-time re-point but relocates the daily terminal push, a worse trade.)*
- **Panel → multi-run manager.** `runs: Map<runId, RunHandle{conversationId, bubble, blocks, …}>`; an `event`
  demuxes to its run's bubble, which lives in its dev conversation — possibly **off-screen**, so the §9
  persistence-pinning is now load-bearing (each run persists to its OWN conversation regardless of what's
  displayed). The running-bar extends to show each live run + per-run pause. **Approvals stack per run (resolves
  U11):** each Allow/Deny (or `AskUserQuestion`) renders in *its* run's bubble — `runId`-scoped, each child blocks
  independently, no global modal — and the running-bar shows an aggregate *"N runs awaiting approval"* badge to
  jump to whichever needs you.
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
- **node_modules per tree (resolves U3).** A worktree shares `.git` but not `node_modules`, so `npm test` (the
  merge gate, §6) can't run in a fresh worktree. **Default: junction a shared store** — on `worktree add`, the
  host points the worktree's `node_modules` at the main checkout's via a Windows directory junction
  (`New-Item -ItemType Junction`, no admin needed; `ln -s` elsewhere). Fast, ~zero disk, and deps are dev-only
  (no build step). **Fallback:** if a branch modifies `package.json`/`package-lock.json`, the host replaces the
  junction with a per-worktree `npm ci` (so its tests run against its own deps). Dependency churn in a dev branch
  is rare, so the cheap junction is the common path.
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
- **Merge model = local `git merge --squash` + `commit`** (one clean commit per feature, message = the
  merge-summary; auto-WIP history discarded — §6.3/U8) after sync+green+diff-confirm; `gh` PR flow optional later.
- **After merge (§6.1):** branch + worktree **deleted**; the **conversation is archived read-only** (kept as
  provenance). **Branch knowledge persists in `main`** via a tracked merge-summary — Claude's `{ changed, learned,
  newInvariant? }` becomes the **squash commit message**, and a reusable lesson is *proposed* into a
  tracked home (`CLAUDE.md` invariant / `docs/` note), **never the git-ignored `findings.md`**. *Decided.*
- **Branch naming:** `dev/<slug>-<shortid>`; **WIP commits** auto on the branch; abandon = delete branch.
- **Split detection = Claude-proposed (plan-time, via the question/plan relay) + a deterministic diff backstop**
  (§8.1); an approved split is **panel-created and seed-prompted from Claude's payload** — Claude never launches
  it. Default seed policy = **seed-and-hold**; splits branch off `main` by default.
- **Open (remaining detail; U10–U14 tracked in §14):** split-seed policy seed-and-hold vs. seed-and-run;
  whether split detection fires at plan time only or also on the live diff; whether to add a **git-tracked
  dev-journal** as the default home for reusable merge-lessons vs. commit messages + occasional `CLAUDE.md`/
  `docs/` appends (§6.1). *(U1–U5 resolved — see §14.A.)*

## 13. Phases (implementation order; each `bcp`-able)

1. **Phase 1 — branches + live-test.** Dev conversation ↔ branch mapping + the per-conversation fields; host
   scoped-git (read + `switch`/`commit`); `lt` verb (WIP-commit → switch → reload); persistence pinning (§9, the
   leak fix); per-conversation `sessionId` resume. Branch status (branch · ahead/behind · clean/dirty · last
   test) in the dev header. *No merge yet.*
2. **Phase 2 — converge.** `merge` (sync → test → diff → **merge-summary** → confirm → **squash+commit**), `sync`,
   abandon→delete-branch, drift nudges (§7 soft gate), worktree GC, **conversation archive (read-only) +
   knowledge-to-`main`** (summary → merge commit message, + proposed tracked-doc/`CLAUDE.md` append, §6.1).
3. **Phase 3 — scope + split.** `concern` contract in Claude's prompt + diff-scope drift nudge; **split detection
   (§8.1)** — Claude-proposed (plan-time, via the question/plan relay) + the deterministic backstop — with
   **panel-created, seed-prompted branches on approval**; the `pr`/`gh` merge variant.
4. **Phase 4 — concurrency (§10).** Per-run **worktrees**; host **run-pool** + `v:2` `runId`-multiplexed protocol
   (+ flow-control, `pool` frame); panel **multi-run manager** + running-bar (per-run pause); **preview-tree**
   live-test (detached checkout); `MAX_CONCURRENT` + optional token budget; pool reattach on reload. Turns split
   detection (§8.1) into real fan-out. *(Optional: §10.1 separate-instances for parallel live-test.)*

**Gate for starting Phase 1:** ~~sign-off on §3 (scoped git in the host)~~ — **✅ signed off 2026-06-17 (§3);
Phase 1 is GO.** `lt`/`merge`/`sync`/`split` depend on the §3 allowlist, now approved. Phase 4 additionally
needs the `v:2` protocol + worktree topology signed off (not yet — revisit at the Phase-4 boundary).

## 14. Underspecified — resolve before implementation

The doc above is solid on *model and trust intent* but thin on *mechanism*. These were the open decisions, with
stable IDs; each was resolved one at a time and folded back into the relevant section (`[open]` →
`[resolved → §X]`). The **blockers** gate whether Phase 1–2 even runs; the rest would otherwise be invented at
build time. **Status: all U1–U14 resolved; §3 trust gate signed off 2026-06-17 — Phase 1 is implementation-ready.**

### 14.A Blockers — resolve before any code

- **U1 — scoped-git allowlist (§3).** `[resolved → §3]` Discrete, parameter-validated host ops (no passthrough
  `git`), tiered R / W-auto (dev-branch only) / W-gated (`merge`·`sync`·abandon·`cherry-pick`) / FORBIDDEN
  (`push`·`main`-rewrite); `revert` **deferred**, `stash` **excluded**, host guard refuses any non-`dev/…` write
  except the single gated `merge --squash`. Worktree ops (`worktree add/remove`) appended with U6.
- **U2 — "foundational/shared" + drift/cluster (§7.1).** `[resolved → §7.1]` Foundational = in `Core/`/`Services/`
  **or** imported by ≥ 3 modules (config-tunable); drift = main↔branch changed-file intersection; split-cluster =
  ≥ 2 import-disconnected components. Read-only git + a static import scan, no LLM.
- **U3 — `node_modules` in worktrees (§11).** `[resolved → §11]` Default: **junction** the worktree's
  `node_modules` to the main store (Windows junction, no admin); fallback to per-worktree `npm ci` only when the
  branch changes `package.json`/lock.
- **U4 — sync-conflict resolution flow (§6.2).** `[resolved → §6.2]` Auto-seed **one** scoped resolution run on
  the branch (fixed prompt, runs `npm test`); green → resume the gate; fail/red → stop and hand to the human.
  Never touches `main`.
- **U5 — structured split payload (§8.1).** `[resolved → §8.1]` A dedicated **`propose_split` bridge tool** with
  the typed schema; arrives as a `tool_use` event whose `block.input` is validated JSON the panel reads directly
  (same path as `AskUserQuestion`). Proposal-only, no mutation.

### 14.B Will-be-invented — pin before Phase 2–4

- **U6 — concurrency topology (§4 ↔ §10).** `[resolved → §10]` Three host-managed folders: **repo root** =
  canonical `main` (merges + terminal push), **preview worktree** (fixed path, the only thing Chrome loads; `lt`
  detached-checks-out any branch + reloads), **branch worktree** per active branch (agent edits + tests). Preview
  kept separate from `main` so live-test and merge don't collide. One-time setup when concurrency is enabled:
  Load-unpacked the preview + whitelist its ID.
- **U7 — merge serialization enforcement (§7.2).** `[resolved → §7.2]` A **freshness check** (re-sync+re-test if
  `main` moved since the branch synced — the correctness guarantee) + a single in-panel **merge lock** held only
  for the fast land step (`switch main` + `merge --squash` + commit), with FIFO queue + "Nth in line" status. Branches
  prepare in parallel; `main` is touched one merge at a time. Lightweight merge-queue.
- **U8 — WIP-commit hygiene (§6.3).** `[resolved → §6.3]` **Squash at merge** — `git merge --squash` + `commit`
  (message = merge-summary) lands each feature as **one clean commit**; the auto-WIP trail is discarded (never a
  coherent state), the granular story stays in the archived conversation (`Dev-conversation:<id>` trailer links
  them). Replaces the earlier `--no-ff` choice (all branch commits were auto-WIP, so preserving them = preserving
  noise).
- **U9 — concern capture + re-injection (§8.2).** `[resolved → §8.2]` Concern **defaults to the first ask**
  (editable, header). Guardrail lives in the system prompt, which is rebuilt every spawn — so the host
  **re-injects the concern contract via `--append-system-prompt` on every spawn** (initial + every resume), built
  from the stored `concern`; also declares `propose_split`. Editing the concern → next spawn picks it up.
- **U10 — pool overflow + worktree GC (§10, §9).** `[resolved → §10/§9]` **Overflow = FIFO queue** (auto-start on
  free slot, "Nth in line", cancellable; hard ceiling rejects only to stop runaway) — separate from the merge
  lock. **GC = §9 reconciliation extended to worktrees:** `prune` stale; keep live; remove merged/abandoned;
  **never auto-delete unmerged+unmapped** (surface it). A crash doesn't orphan (mapping persisted → parked,
  resumable).

### 14.C Smaller — resolve in passing

- **U11 — approval-relay stacking under concurrency (§10).** `[resolved → §10]` Approvals are `runId`-scoped:
  each Allow/Deny renders in *its* run's bubble (each child blocks independently, no global modal); the
  running-bar shows an aggregate *"N runs awaiting approval"* badge.
- **U12 — "fork from here" mechanism (§6.1).** `[resolved → §6.1]` A **new** branch + **new** dev conversation
  seeded with the merged conversation's summary/concern — a *fresh* session, not a resume (sessions are linear;
  no clean fork primitive; a summary beats dragging the whole transcript).
- **U13 — soft/recoverable abandon (§5).** `[resolved → §5]` **Soft by default:** archive the conversation
  (`abandoned`) + remove the worktree, **keep the branch**; explicit **"delete branch"** is the hard option.
  (Matches U10's "never auto-destroy unmerged work.")
- **U14 — diff-preview size + flaky tests (§6).** `[resolved → §6]` Preview = `git diff --stat` (full hunks on
  demand). Gate red → **one auto-retry**; pass-on-retry lands flagged *"flaky"*; two reds block. No quarantine
  system.
