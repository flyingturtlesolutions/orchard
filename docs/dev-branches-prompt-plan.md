# Dev branches — Phase 1 prompt plan (bcp-gated)

Ready-to-paste prompts to implement **Phase 1** of `DESIGN_dev_branches.md` (§13: *branches + live-test*), in
dependency order. Each prompt is scoped to land in one focused turn, carries its **acceptance criteria** and
**verification gate** up front (built to a target, not iterated by eyeball), and ends in a **`bcp`-able** state.

**How to use:** paste one prompt → let it land → run its verify → eyeball any live-only checks → **`bcp`** →
*then* the next. **Don't batch across prompts** — each depends on the prior landing. Phase 1 is `DBR-1 → DBR-6`;
the big UI-touching slices are split into a **logic half** (headless-verifiable) and a **UI half** (needs a live
eyeball), per the rule that UI asks need explicit acceptance criteria.

**Scope guard:** Phase 1 is **single-tree, serial, no merge** (DESIGN §4, §13). No worktrees, no `merge`/`sync`/
`split`, no concurrency — those are Phases 2–4 and get their own plans. Don't pull them forward.

**Standing guardrails (apply to every prompt — from CLAUDE.md + DESIGN §3):**
- **Trust (§3, signed off 2026-06-17):** host git is a **discrete, parameter-validated** op set — *never* a
  passthrough `git <args>`. **Claude Code's own allowlist stays git-free.** Phase-1 host ops are read + W-auto
  only (`status`/`log`/`diff`/`rev-parse`/`branch --list`/`merge-base`; `commit`/`switch`/`switch --detach`/
  `branch` create) — **no `merge`/`rebase`/`push`/worktree** yet. The host **refuses any write whose target
  isn't a `dev/…` branch**, and rejects branch args with shell metacharacters.
- **Bump `manifest.json`** (`v2.74.X`) on every behavior change; keep the inline `v2.74.X` marker in sync.
- **`npm test` is the gate** — must stay green (currently 822 passing).
- **New decision marker** (anything a `gl -decisions-` download should surface — e.g. `DEVBR ▸`, `LT ▸`,
  `BRANCH ▸`) → add it to `_DECISION_RE` (`studio.js`), or the feature is invisible to a decisions download.
- **Verification honesty:** state plainly what was proven headless (`npm test`, unit tests) vs. what still needs
  a live eyeball (panel UI, the `lt` reload, persistence across a conversation switch).

---

## DBR-1 — Host scoped-git foundation (headless) · *do this first*

> Implement the §3 Phase-1 host git surface in the dev-bridge host (`bridge/host.js`) as **discrete,
> parameter-validated operations**, not a passthrough. Factor the trust-critical bits into a **pure, testable
> module** (e.g. `bridge/gitOps.js` or a `Services/` helper): `validateBranchName(name)` (must match
> `^dev/[A-Za-z0-9._-]+$`, no shell metacharacters / no `..`), and `buildGitArgs(op, params)` returning an argv
> array (never a shell string) for the allowed ops only. The host executes via `spawn('git', argv)` (no shell).
> Allowed Phase-1 ops: **read** (`status`, `log`, `diff`, `rev-parse`, `branch --list`, `merge-base`) and
> **W-auto** (`commit` on a `dev/…` branch, `switch`/`switch --detach`, `branch` create `dev/…`). The host
> **refuses** any write op whose branch target isn't `dev/…`, and rejects invalid names. Add a `v:1`-compatible
> protocol message (e.g. `{type:'git', op, params}` → `{type:'git-result', op, ok, data|error}`) so the panel
> can call these later. No `merge`/`rebase`/`push`/`worktree` (Phases 2–4). Add a `DEVBR ▸` decision marker for
> git ops the panel will log, and register it in `_DECISION_RE`.
>
> Acceptance (headless): unit tests for the pure module prove (a) a valid `dev/x` arg builds the expected argv;
> (b) a non-`dev/` target on a write op is refused; (c) names with metacharacters / `..` / spaces are rejected;
> (d) read ops parse their output into structured data; (e) `buildGitArgs` never returns a shell string. Verify:
> `npm test` green including the new `gitOps` tests; `node --check bridge/host.js`. Fully headless — no eyeball.

## DBR-2 — Dev conversation ↔ branch data model (headless)

> Wire dev conversations to branches per DESIGN §2/§9. Extend the `kind:'dev'` conversation record
> (`Services/ConversationStore.js`) with `{ branch, concern, sessionId, status, mergedAt?, mergeCommit? }`,
> `status ∈ {active, merged, abandoned}` (default `active`). On **"New dev conversation"** (`chat.js`), derive a
> unique branch name `dev/<slug>-<shortid>` (slug from the title/first-ask; shortid from `crypto.randomUUID`) and
> create it via the DBR-1 host `branch` op; store it on the record. Replace the **global**
> `settings:devBridgeLastSession` resume with **per-conversation `sessionId`** for dev conversations:
> `dev:`/bare-text resumes *this* conversation's session (read/write `sessionId` on the record; the `done`
> handler stores the run's session there). Add a reconciliation stub: on load, flag a dev conversation whose
> branch is missing (don't act yet — Phase 2 handles GC).
>
> Acceptance (headless): `ConversationStore` tests cover the new fields + `kind:'dev'` round-trip; branch-name
> derivation is valid (`validateBranchName` passes) and collision-resistant; the resume path targets the
> per-conversation `sessionId`, not the global key. Verify: `npm test` green including new store tests;
> `node --input-type=module --check` on edited files. Headless (branch *creation* calls the host — unit-test the
> derivation/store logic; the host call is integration-covered in DBR-4's live check).

## DBR-3 — Persistence pinning / the leak fix (logic headless + live)

> Implement DESIGN §9 "persistence pinning" — the fix for the run-output leak. Today a dev run's streamed blocks
> persist via `_ensureConversation()` = the *currently active* conversation, so switching away mid-run writes
> Claude Code output into the wrong thread. Bind every run to its **originating dev conversation id** at spawn,
> and make the bridge's persist path (`Services/Chat/devBridge.js` `_persistBlocks`/the `persistMessage` hook in
> `chat.js`) write to **that** id regardless of what's active. Thread `conversationId` through explicitly; do not
> resolve "current" at persist time for dev-run bubbles.
>
> Acceptance: a unit/integration test proves a run bound to conversation A persists its blocks to A even when B
> is the active conversation (no leak); the existing chat-persistence tests stay green. Verify: `npm test` green
> — then a **live eyeball**: start a dev run, switch to another conversation mid-run, confirm the streamed output
> lands in the dev thread (not the one you switched to) and rehydrates there on reload. State plainly the
> cross-switch behavior is only confirmable live; give me the exact steps to run.

## DBR-4 — The `lt` live-test verb (logic headless + live)

> Implement the `lt` live-test verb (DESIGN §4). In a dev conversation, intercept — **whole trimmed message,
> case-insensitive** — the allowlist `{ lt, live, "live test", livetest }` *before* forwarding to Claude (same
> intercept layer as the existing bridge verbs). On match: post a `↻ switching to <branch> and reloading…`
> bubble → host **WIP-commit** the current branch (DBR-1 `commit`) → host **`git switch`** the loaded folder to
> this conversation's branch (DBR-1) → `chrome.runtime.reload()`. A longer sentence merely *containing* "live
> test" must flow to Claude as a normal prompt (whole-message match only). Add an `LT ▸` decision marker →
> `_DECISION_RE`. (Phase 1 is single-tree branch-switch — no worktree/preview yet.)
>
> Acceptance: matcher unit tests — bare `lt`/`live`/`live test`/`livetest` fire; *"can you live test the search
> box?"* does **not**; non-dev conversations never intercept. The flow issues WIP-commit → switch → reload in
> order. Verify: `npm test` green incl. matcher tests — then a **live eyeball**: make a change on a dev branch,
> `lt`, confirm the extension reloads showing that branch's code, and switching conversations + `lt` again lands
> on the other branch. State plainly the reload is only confirmable live.

## DBR-5 — Concern capture + per-spawn re-injection (logic headless + live)

> Implement DESIGN §8.2. **Capture:** a dev conversation's `concern` defaults to its **first ask** (trimmed to a
> one-line label), stored on the record (DBR-2), shown in the header (DBR-6), user-editable. **Re-injection
> (load-bearing):** the host must re-pass the scope contract via **`--append-system-prompt` on every `claude -p`
> spawn — initial *and* every `--resume`** — built each spawn from the stored `concern`: *"You are working ONLY
> on: `<concern>`. Don't refactor unrelated/shared code; if a fix needs shared/foundational files, STOP and say
> so."* (The `propose_split` tool is Phase 3 — for now the contract just says "stop and tell the user.") Editing
> the concern updates the stored value → next spawn picks it up. Factor the contract-builder as a pure function.
>
> Acceptance (headless): the contract-builder is unit-tested (concern in → expected `--append-system-prompt`
> text); the spawn path includes it on **both** a fresh run and a `--resume` run; editing `concern` changes the
> next spawn's contract. Verify: `npm test` green incl. builder tests — then a **live eyeball**: over a 2-turn
> dev conversation, confirm the concern guardrail is present on turn 2 (resumed), not just turn 1. State plainly
> the live multi-turn check is eyeball-only.

## DBR-6 — Branch status in the dev header (UI · *needs a live eyeball*)

> Build the dev-conversation header status from DESIGN §13, using **read-only** DBR-1 ops only. Show: branch name
> · ahead/behind `main` (`rev-parse`/`merge-base`) · clean/dirty (`status`) · last-test result (from the most
> recent in-conversation `npm test`, if any). Render in the dev conversation's header area
> (`chat.js`/`chat.html`/`assets/chat.css`); **panel only**, nothing in the page (injection-boundary rule).
> Refresh after a run completes and after `lt`. Also surface the editable `concern` (DBR-5) here.
>
> Acceptance: with a dev conversation active, the header shows the correct branch + ahead/behind + dirty state,
> and updates after a run / `lt`; editing the concern persists. Verify: `npm test` (no logic regression) + CSS
> braces balanced — then I'll eyeball the live header; give me the exact steps. State plainly the header's
> appearance is confirmable only live.

---

## After Phase 1

Phase 1 leaves: dev conversations each bound to a branch with per-conversation session resume, the output-leak
closed, `lt` live-testing a branch by switch+reload, the per-spawn concern guardrail, and a status header. **No
merge yet.**

Later phases get their **own** prompt plans (don't pull forward — DESIGN §13):
- **Phase 2 — converge:** `merge` (sync → test → **merge-summary** → confirm → `merge --squash` + commit, §6/§6.3),
  `sync` (§6.2 conflict sub-flow), abandon (soft, §5/U13), drift nudges (§7/§7.1), conversation archive +
  knowledge-to-`main` (§6.1), merge serialization (§7.2).
- **Phase 3 — scope + split:** concern contract + `propose_split` tool (§8.1), diff-scope drift nudge,
  panel-created seed-prompted branches, `pr`/`gh` variant.
- **Phase 4 — concurrency:** per-run worktrees + the preview-tree topology (§10/U6), host run-pool + `v:2`
  `runId` multiplex, panel multi-run manager, pool queue + worktree GC (§10/§9). Needs its own trust sign-off
  (`v:2` protocol + worktree topology) before code.
