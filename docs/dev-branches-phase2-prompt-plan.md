# Dev branches — Phase 2 prompt plan (converge: merge · sync · abandon · drift) · bcp-gated

Ready-to-paste prompts to implement **Phase 2** of `DESIGN_dev_branches.md` (§5–§7: *converging branches back
into `main`*), in dependency order. Same discipline as Phase 1: paste one prompt → let it land → run its verify →
eyeball any live-only checks → **`bcp`** → *then* the next. **Don't batch across prompts.**

**Where Phase 1 left us:** dev conversations each bound to a branch, per-conversation session resume, the
output-leak closed, `lt` live-test (switch + reload, with the v2.74.1043 behind-main guardrail), the per-spawn
concern contract, and a status header. **No merge yet** — branches accrete but never re-converge. Phase 2 closes
the lifecycle: **draft → (merge | abandon)**.

**Scope guard:** Phase 2 is still **single-tree, serial** — NO worktrees, NO concurrency (those are Phase 4).
Merges happen one at a time on the loaded tree by switching branches (like `lt`). The §7.2 merge **lock + FIFO
queue** is mostly a Phase-4 concern (concurrent prepare in worktrees); Phase 2 builds only the **freshness
re-check** (out-of-band `main` moves), not the queue. `split`/`propose_split`, the diff-scope drift nudge, and the
`pr`/`gh` variant are **Phase 3** — don't pull forward.

**Standing guardrails (every prompt — DESIGN §3 trust, signed off 2026-06-17):**
- Host git stays a **discrete, parameter-validated** op set — never a passthrough `git <args>`. **Claude Code's
  own allowlist stays git-free** — Claude never runs `git merge`/`switch`/`push`; the human drives the
  consequential ops via chat verbs (§2.1: Claude proposes structured data, the human taps, the panel acts).
- **`main` is mutated by exactly ONE op** — the human-confirmed `merge --squash` + commit (§3). No autonomous
  `main` mutation. W-gated ops (`sync`-rebase, `merge --squash`, `branch -D`) fire **only** from a confirmed chat
  verb carrying the one-time confirm token. **No `push`** (manual `cp`/`bcp` — §6 step 7). **No worktrees.**
- Bump `manifest.json` (`v2.74.X`) on every behavior change; keep the inline marker in sync.
- **`npm test` is the gate** — must stay green (currently **859** passing).
- **New decision markers** (`MERGE ▸`, `SYNC ▸`, `DRIFT ▸`, `ABANDON ▸`) → add to `_DECISION_RE` (`studio.js`),
  or the feature is invisible to a `gl -decisions-` download (**Invariant #1**).
- Any **new engine-driven run** (the §6.2 auto-seeded conflict-resolution run) → busy-mark its tab
  (**Invariant #2**), so its clicks don't pollute the interaction monitor.
- **Verification honesty:** state plainly what was proven headless (`npm test`, unit tests) vs. what needs a live
  eyeball (the actual mutation of `main`, the reload, the conflict-resolution run, the drift nudge).

---

## DBR-P2-1 — Host W-gated converge ops + the confirm-token gate (headless) · *do this first*

> Extend the dev-bridge host (`bridge/host.js`) + its pure gitOps module with the Phase-2 **W-gated** git ops,
> each **discrete + parameter-validated** (never a shell string) and each refusing to fire without a one-time
> **confirm token** the panel passes only AFTER the in-chat human confirm (§2.1/§3): **`syncMain`** (rebase/merge
> `main` INTO a `dev/…` branch, in the branch's tree), **`mergeSquash`** (`git switch main` + `git merge --squash
> dev/<branch>` + `git commit -m <summary>`), **`branchDelete`** (`branch -D dev/<branch>`). Reuse
> `validateBranchName`. The host **still refuses** any `main`-mutating op whose source isn't a `dev/…` branch, and
> refuses `mergeSquash`/`branchDelete` **without** the confirm token. Add `MERGE ▸`/`SYNC ▸`/`ABANDON ▸` markers +
> register them in `_DECISION_RE`. NO worktrees, NO `push`.
>
> Acceptance (headless): gitOps unit tests prove (a) each op builds the expected argv array, never a shell string;
> (b) `mergeSquash`/`branchDelete` without a confirm token are **refused**; (c) a non-`dev/` merge SOURCE is
> refused; (d) `main` is never the rebase/merge TARGET of an autonomous op. Verify: `npm test` green incl. the new
> tests; `node --check bridge/host.js`. Fully headless — no eyeball.

## DBR-P2-2 — `sync` + the conflict sub-flow (§6.2) (logic headless + live)

> Implement `sync` (DESIGN §5/§6.2): pull current `main` into this branch. Matcher (whole-message `sync`,
> dev-conversation only — same intercept layer + discipline as `lt`/`isLiveTest`). Flow: WIP-commit → host
> `syncMain` (P2-1). **Clean → done** ("✓ synced onto `main@<short>`"). **Conflict → auto-seed a scoped resolution
> run** (`claude -p` in the branch's tree, **busy-marked** — Invariant #2) with the fixed §6.2 prompt: *"Resolve
> these git conflicts in `<files>`. Preserve the branch's intent (`<concern>`) AND main's incoming changes; touch
> nothing unrelated; run `npm test` when done."* **Bounded to ONE auto-attempt:** green → "✓ resolved + synced";
> still red / unresolved → **stop, surface the conflict in chat, leave the branch conflicted-but-committed, hand
> to the human** (no silent retry loop). Record the synced-onto `main` commit on the conversation record (feeds
> the P2-5 freshness check). `SYNC ▸` marker.
>
> Acceptance: matcher unit tests (bare `sync` fires; a sentence merely containing "sync" does NOT; non-dev never
> intercepts); a pure test that a clean sync records the `main` commit and a conflicted sync seeds **exactly one**
> resolution run then stops. Verify: `npm test` green — then a **live eyeball**: move `main`, `sync` a branch
> (clean path), then engineer a conflict and confirm the one-shot resolution run + the hand-to-human stop. State
> the conflict path is live-only.

## DBR-P2-3 — `merge` prepare half: WIP → sync → test gate → diff preview (§6 steps 1–4) (logic headless + live)

> Implement the **lock-free prepare** half of `merge` (§6). Matcher (`merge`). Sequence: (1) WIP-commit;
> (2) **sync** (reuse P2-2, incl. its conflict sub-flow); (3) **test gate** — `npm test` in the branch via the
> host run machinery, **one automatic retry** on red (real suites flake — U14), still red → **stop, no merge**;
> (4) **diff preview** — post `git diff --stat main...<branch>` (file list + ±counts) as a chat bubble, full hunks
> on demand. **STOP here** — the land half is P2-4. `MERGE ▸` marker per stage.
>
> Acceptance: a pure test of the stage sequencing (sync → test → diff; red-after-retry aborts BEFORE the diff).
> Verify: `npm test` green — then **live**: `merge` a green branch → see the sync, the test gate, the diff-stat
> bubble, and that it halts awaiting confirm (no `main` mutation yet). State live-only.

## DBR-P2-4 — `merge` land half: merge-summary → confirm → squash-merge + archive (§6/§6.1/§6.3) (logic + live)

> Implement the **land** half. After the P2-3 diff, Claude emits a structured **merge-summary** `{ changed,
> learned, newInvariant? }` (§6/§6.1), rendered as a confirm bubble. On the **human confirm** (§2.1 gesture → the
> panel passes the confirm token): host `mergeSquash` (P2-1) = `switch main` + `merge --squash dev/<branch>` +
> `commit` with the summary as the message + a **`Dev-conversation:<id>` trailer** (§6.3); the loaded tree is now
> on `main` with the change. Mark the conversation `{ status:'merged', mergedAt, mergeCommit }`, move it to a
> read-only **Merged** group (§6.1). **Knowledge → main:** the summary IS the commit message; if `newInvariant`,
> **propose** (never auto-write) a one-line `CLAUDE.md`/doc addition for human approval. **Push stays manual**
> (§6 step 7). The squash discards the branch's WIP history (§6.3); the branch is removed by the merge.
>
> Acceptance: pure tests — the summary shape; the conversation transitions to `merged` with `mergeCommit`; the
> commit message embeds the summary + trailer; **no `push` is issued**. Verify: `npm test` green — then **live**:
> confirm a merge end-to-end → `main` gets ONE squash commit, the conversation shows Merged/read-only, the header
> reflects `main`, `git log` shows one clean commit. State the actual `main` mutation + reload are live-only.

## DBR-P2-5 — Freshness re-check before the land (§7.2 correctness half) (logic headless + live)

> Implement the **freshness check** (§7.2 — the correctness guarantee; the full lock + FIFO queue defers to Phase
> 4 concurrency). A merge recorded the `main` commit it synced onto (P2-2). **Just before the land step**, re-read
> `main`'s current HEAD; if `main` moved since the sync (another merge — or a terminal/out-of-band commit —
> landed meanwhile), **re-sync onto the new `main` and re-run the test gate** (§6.2/P2-3) before landing — so
> nothing ever lands on a `main` it wasn't synced + green against. (Single-tree Phase 2: merges are already
> serial, so no lock is needed yet; this guards **out-of-band** `main` moves.)
>
> Acceptance: a pure test — given recorded-sync-commit ≠ current `main` HEAD, the land path re-syncs + re-tests
> before proceeding; equal HEAD → lands directly. Verify: `npm test` green — then **live**: move `main` out of
> band between a branch's `sync` and its confirm, then confirm → see the re-sync + re-test fire before the land.
> State live-only.

## DBR-P2-6 — abandon: soft (keep branch) + hard (delete branch) (§5/U13) (logic headless + live)

> Implement abandon (DESIGN §5/U13). **Soft (default):** archive the conversation (`status:'abandoned'`, moved to
> an **Abandoned** group, read-only) and free its slot, but **KEEP the branch** (recoverable). **Hard ("delete
> branch", explicit + confirm):** host `branchDelete` (P2-1) = `branch -D dev/<branch>` after an in-chat confirm.
> Matchers (`abandon`; `delete branch`). `ABANDON ▸` marker. A soft-abandoned conversation reopens read-only; the
> hard delete is irreversible (the confirm copy says so).
>
> Acceptance: pure tests — soft abandon flips status + keeps the branch (no git delete issued); hard delete issues
> `branchDelete` **only** after the confirm token. Verify: `npm test` green — then **live**: soft-abandon a
> conversation (branch still in `branch --list`), then hard-delete (branch gone). State the git delete is
> live-only.

## DBR-P2-7 — Drift nudges + the foundational/shared detector (§7/§7.1) (logic headless + live)

> Implement the **soft gate** (§7) on the deterministic detectors (§7.1) — read-only git + a static import scan,
> **no LLM**. Pure module: (a) **foundational/shared file** = under `Core/` or `Services/` **OR** imported by
> **≥ N** modules (N + the layer list in **config**, not magic numbers in code) via a light ESM/`.cjs` import
> scan; (b) **drift** = `main`'s new commits since a branch forked touch a file the branch **also** modified
> (`git diff --name-only` set-intersection). On panel load / after each merge: for every live dev branch, compute
> drift vs current `main`; if non-empty, post a chat nudge in that branch (*"⚠ main changed `<file>`; this branch
> also touches it — `sync` to catch up"*). A `merge` touching surface used by other live branches warns
> (*"changes shared `X` used by branches B, C — merge anyway?"*). **Warnings only, never blocks** (§7). `DRIFT ▸`
> marker.
>
> Acceptance: pure tests — the foundational classifier (Core/Services + ≥N importers) on a fixture; the drift
> intersection given a fork-point + two file-sets. Verify: `npm test` green — then **live**: merge branch A
> (touches a shared file), confirm branch B (also touching it) gets a drift nudge to `sync`. State the live nudge
> is eyeball-only.

---

## After Phase 2

Phase 2 closes the lifecycle: a branch **merges** (squash → `main`, knowledge externalized via the summary, the
conversation archived read-only) or is **abandoned** (soft-keep or hard-delete); drift nudges push convergence;
the freshness re-check keeps `main` buildable. **Still single-tree + serial.**

Later phases get their **own** prompt plans (don't pull forward — DESIGN §13):
- **Phase 3 — scope + split:** the concern contract's `propose_split` tool (§8.1), the diff-scope drift nudge
  (§8), panel-created seed-prompted branches / "fork from here" (§6.1/U12), the `pr`/`gh` merge variant (§6).
- **Phase 4 — concurrency:** per-run worktrees + the preview-tree topology (§10/U6), host run-pool + `v:2`
  `runId` multiplex, panel multi-run manager, the full merge **lock + FIFO queue** (§7.2) + worktree GC. Needs its
  own trust sign-off (`v:2` protocol + worktree topology) before code.
