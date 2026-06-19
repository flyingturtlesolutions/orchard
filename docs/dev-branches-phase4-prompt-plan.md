# Dev branches — Phase 4 prompt plan (concurrency · §10) · bcp-gated

> **▶ STATUS (2026-06-18 checkpoint) — substrate landed, concurrency core deferred.**
> **Done + on `origin/main`, tested (933 passing):** the three trust sign-offs (worktree paths · v:2 cutover) were
> granted; **P4-1** (worktree git ops, v2.74.1061) · **P4-2** (v:1→v:2 protocol cutover + multiplex toolkit, .1062) ·
> **P4-3a** (run-pool scheduling core — `canStart`/`nextQueued`/`queuePosition`/`queueAccepts`, .1066) all shipped.
> **NOT yet eyeballed:** the v:2 single-run cutover (reload host **and** panel together) + on-disk worktree create/remove.
>
> **⚠ Resumption — the slice boundaries below need merging.** In code, **P4-3b (host run-pool) + P4-4 (panel
> multi-run) + P4-5 (worktree execution topology) are ONE coupled landing**, not three independent `bcp` slices: a
> `cap>1` host garbles a single-run panel, and "spawn each run in its worktree" *is* the single-tree→worktree shift.
> Do them as **one focused, coordinated, live-tested change** — and **NOT while actively dogfooding** the dev-bridge,
> since it rewrites the shared host's run lifecycle (lock/journal-tail/reattach) your live sessions depend on. The
> per-frame `runId` tagging + `pool` emission the P4-2 toolkit is waiting for belong in that landing. P4-6/P4-7/P4-8
> stay as written. (See `logs/run/findings.md` 2026-06-18 — LESSON[scope]/[process].)

Ready-to-paste prompts for **Phase 4** of `docs/DESIGN_dev_branches.md` (§10 single-host multiplexing + §7.2 merge
lock/queue + §11 worktree `node_modules` + §9/U10 worktree GC), in dependency order. Same discipline as Phases 1–3:
paste one → land → verify → eyeball any live-only checks → **`bcp`** → *then* the next. **Don't batch across prompts.**

**Where Phases 1–3 left us:** a dev conversation **is** a branch **is** a proposal, with the full converge lifecycle
(`sync` · `merge` prepare→squash-land · freshness · abandon · drift) and scope discipline (`scope` backstop · `split:`
+ Claude-proposed `propose_split` at plan time · `fork` · optional `scope?`). **Everything is still SINGLE-TREE +
SERIAL:** one `claude -p` run at a time (host `busy` lock), one working folder (the repo root; `lt` switches its
branch + reloads), `PROTOCOL_V = 1` frames with **no `runId`**. Phase 4 makes execution **concurrent** — N runs over
one host port, each in its own worktree — so split-then-fan-out becomes **real parallel decomposition** (§8.1/§10).

**Scope guard:** Phase 4 is concurrency ONLY. It does **not** add new verbs or change the grammar — it changes the
*execution substrate* underneath the existing verbs. `main` is still mutated only by the gated squash-land (now
**lock-serialized**, §7.2); Claude's allowlist stays git-free; **no `push`** (the `pr`/`gh` variant is P3-6, a
separate gate). The §10.1 "parallel live-test via separate unpacked instances" is **optional + additive** — last,
or skipped.

---

## THREE TRUST SIGN-OFFS are required before code (§3/§10 — don't relax silently)

1. **Worktree git ops (P4-1).** The host's git allowlist gains `worktree add/remove/list/prune`. §3's table already
   lists these as **W-auto** ("only ever touches a `dev/…` branch or a host-managed worktree"), but they were never
   implemented — confirm the surface at the boundary: a worktree is a **new on-disk working folder**; the host must
   constrain `worktree add` to a **host-managed `.wt/` root** + a validated `dev/…` branch (or a detached tip for the
   preview), never an arbitrary path. Sign off the worktree-path scoping.
2. **The `v:2` protocol (P4-2).** Every run-scoped frame gains a `runId`; one new frame type (`pool`). Not a trust
   relaxation but a **coordination** one: host + panel ship + reload together, so it's a **hard `v:1`→`v:2` cutover**
   (the panel drops mismatched-version frames — `m.v !== PROTOCOL_V`), and a stale host vs a new panel mismatches.
   Sign off the cutover (no mixed-version runtime; both bump atomically in one slice).
3. **The preview-tree topology (P4-5).** Chrome stops loading the repo root and loads a fixed **preview worktree**
   instead — a **one-time manual** "Load unpacked" of that folder + adding its extension ID to the native-host
   allowlist (§10). Sign off the re-point (who loads what, the daily terminal `cp`/`bcp`-in-repo-root workflow is
   preserved by design). *(Alternative — keep Chrome on the root, move `main` into a worktree — was weighed + rejected
   in §10: it relocates the daily push, a worse trade.)*

**Standing guardrails (every prompt — §3, signed off 2026-06-17; + the §10 additions above):**
- Host git stays **discrete, parameter-validated**; worktree ops are **path-scoped to the `.wt/` root + a `dev/…`
  branch (or detached tip)**; **Claude's allowlist stays git-free**; `main` is mutated only by the gated squash-land,
  now holding the §7.2 **land-only lock**; **no `push`** (P3-6).
- Bump `manifest.json` per behavior change; **`npm test` is the gate** (currently **920** passing).
- **New decision markers** (`POOL ▸`, `WORKTREE ▸`, `QUEUE ▸`, `MERGE_LOCK ▸`, `GC ▸`) → `_DECISION_RE` (`studio.js`)
  (INVARIANT #1).
- **INVARIANT #2 is N/A here** — dev-bridge runs edit CODE, they don't drive page tabs; the engine-busy monitor guards
  web-automation clicks, which concurrency doesn't touch. (The preview-tree `lt` reload is the same reload as Phase 1.)
- **Verification honesty:** the run-pool / worktree / multiplex machinery is **heavily live-only** (real `claude -p`
  children, real `git worktree`, real Chrome reload) — the pure cores (queue/slot logic · frame tag/demux · lock
  state machine · GC decision · worktree-arg builders) are headless-tested; everything else is an eyeball.

---

## DBR-P4-1 — Worktree git ops (pure gitOps + host management) · **WORKTREE SIGN-OFF FIRST** · *do first*

> Add the worktree lifecycle to the host's git allowlist (§3/§10). `bridge/gitOps.cjs`: four PURE ops →
> `worktreeAdd { branch, path }` (`git worktree add <path> <dev/…branch>` — or `--detach <ref>` for the preview),
> `worktreeRemove { path }`, `worktreeList`, `worktreePrune`. VALIDATE: `path` must be under the host-managed `.wt/`
> root (a fixed relative prefix; no `..`, no absolute escape), `branch` must be `validateBranchName` (`dev/…`), the
> detach ref must be `validRef`. Add them to `ALLOWED_OPS`. `bridge/host.js`: a `.wt/` root constant (under the repo,
> git-ignored) + a `worktree` op dispatch reusing the existing discrete-arg spawn; the host additionally refuses a
> `worktreeAdd` whose resolved path escapes `.wt/`. `WORKTREE ▸` marker.
>
> Acceptance (headless): `gitOps.test.js` — worktreeAdd/Remove/List/Prune argv (valid `dev/…`+`.wt/` path → argv;
> a non-`.wt/` path, a `..`, a non-`dev/…` branch → rejected); the detach form for the preview. Verify: `npm test`
> green — then **live**: `worktreeAdd` a `dev/…` branch creates `.wt/<id>/` with that branch checked out; `worktreeList`
> shows it; `worktreeRemove` cleans it. State the on-disk worktree create/remove is live-only.

## DBR-P4-2 — The `v:2` protocol cutover (runId on every frame + `pool` frame; cap still 1) · **v:2 SIGN-OFF FIRST**

> Bump `PROTOCOL_V` to `2` in BOTH `bridge/host.js` and `Services/Chat/devBridge.js` ATOMICALLY (the panel drops
> mismatched-version frames, so this is one slice). Every **run-scoped** frame (`run`/`event`/`done`/`error`/`pause`/
> `approval`/`approval-decision`) gains a `runId`; non-run frames (`git`/`test`/`preflight`/`status`/`history`) are
> unchanged. Add the `pool` frame type (`{v:2, type:'pool', running:[…], cap}`) — emitted but trivial while cap=1.
> **Keep single-run semantics:** the host's `runs` is a `Map` with `MAX_CONCURRENT=1`, the panel's `runs` is a `Map`
> keyed by a single `runId='r1'`. Behavior is IDENTICAL to today — this is the wire format only. Pure: a frame
> tag/demux helper (`tagFrame(frame, runId)`, `frameRunId(frame)`).
>
> Acceptance (headless): a new `bridge/protocol.test.js` (or in devBridge.test) — tagFrame/frameRunId round-trip;
> a `pool` snapshot shape; a v:1 frame is rejected by the v:2 check. Verify: `npm test` green — then **live**: a single
> dev run behaves EXACTLY as before (the runId is invisible at cap=1). State the wire cutover is live-only (reload host
> + panel together; a stale host = no runs until reload).

## DBR-P4-3 — Host run-pool (runs Map + FIFO queue + spawn-in-worktree) (logic headless + live)

> Replace the host's single-run `busy` lock with the §10 **run-pool**: `runs: Map<runId,{proc,sessionId,cwd,status}>`.
> A `run` frame spawns a `claude -p` child with **`cwd` = its branch worktree** (created via P4-1 if absent) and pipes
> its NDJSON as `runId`-tagged `event` frames. **Overflow = FIFO queue, not reject** (§10/U10): beyond `MAX_CONCURRENT`
> (default 4) a run waits + **auto-starts when a slot frees** (`"⏳ queued — Nth in line"`, cancellable pre-start); a
> high hard ceiling rejects only runaway pile-ups. Per-run `pause`/`approval`/`done`/`error` keyed by `runId`. Per-child
> stdout **flow-control** (pause reading on `write()===false`). Emit real `pool` frames. `POOL ▸` / `QUEUE ▸` markers.
>
> Acceptance (headless): pure tests — the slot/queue core (`canStart(running, cap)`, `nextQueued(queue)`, the
> "Nth in line" index, the hard-ceiling reject); the `pool` snapshot from a `runs` Map fixture. Verify: `npm test`
> green — then **live**: launch 2 dev runs in 2 conversations → both run concurrently (cap≥2), each in its own
> `.wt/` worktree; a 5th with cap=4 shows "queued — 1st in line" + auto-starts on a free slot. State the live pool is eyeball-only.

## DBR-P4-4 — Panel multi-run manager (demux + per-run bubbles + running-bar) (logic headless + live)

> Replace the panel's single `run` with the §10 **multi-run manager**: `runs: Map<runId, RunHandle{conversationId,
> bubble, blocks, …}>`. An `event` **demuxes by `runId`** to its run's bubble, which lives in its OWN dev conversation
> — possibly **off-screen**, so the §9 persistence-pinning (DBR-3, already shipped) is now load-bearing: each run
> persists to its conversation regardless of what's displayed. The running-bar extends to **N live runs + per-run
> pause**; **approvals stack per run** (`runId`-scoped Allow/Deny + `AskUserQuestion`, each child blocks independently,
> NO global modal) with an aggregate **"N runs awaiting approval"** badge. Pure: the demux + the running-bar/badge model.
>
> Acceptance (headless): pure tests — demux routes an `event` to the right RunHandle; the running-bar model (live count,
> per-run status, awaiting-approval aggregate) from a `runs` fixture. Verify: `npm test` green — then **live**: 2
> concurrent runs render in their own (possibly background) conversations; switching conversations shows each run's live
> stream; an approval in run B doesn't block run A. State the live multi-run UI is eyeball-only.

## DBR-P4-5 — The 3-folder topology + preview-tree `lt` (detached checkout) · **TOPOLOGY SIGN-OFF + one-time re-point**

> Implement the §10 **folder topology**: (a) **repo root** = canonical `main` (merges land here; daily `cp`/`bcp` push
> here — unchanged); (b) **preview worktree** (fixed `.wt/preview`, created once) = the ONLY folder Chrome loads,
> read-only; (c) **branch worktrees** (P4-1/P4-3) = where agents edit + `npm test`. `lt` shifts from "switch the repo
> root's branch + reload" to "**`worktree --detach` the branch tip in the preview + reload**" (a detached checkout is
> legal even while that branch is checked out in its own worktree — §4). The **one-time setup** (Load-unpacked
> `.wt/preview` + add its ID to the native-host allowlist) is documented + surfaced. The behind-main `lt` guardrail
> (DBR-P1.043) carries over (now it diffs the preview's target vs main).
>
> Acceptance (headless): pure — the preview detached-checkout arg builder + the `lt`-target selection. Verify:
> `npm test` green — then **live** (after the one-time re-point): `lt dev/x` flips the preview to x's tip + reloads
> WITHOUT touching the repo root or any branch worktree; a branch can be live-tested in the preview WHILE its own
> worktree runs. State the re-point + the detached-preview live-test are eyeball-only + need the one-time Chrome action.

## DBR-P4-6 — Merge serialization: the land-only lock + FIFO queue (§7.2) (logic headless + live)

> Implement §7.2. **Prepare runs lock-free** in the branch's worktree (sync + test + the human confirm — slow,
> parallel). The **land step ONLY** (`git switch main` + `merge --squash` + commit, in the **repo-root `main` tree**)
> holds a single in-panel **merge lock**; concurrent `merge`s queue **FIFO** with a visible *"waiting to merge — Nth
> in line"*. Land-only + the existing P2-5 freshness re-check (re-sync+re-test if main moved) gives safety AND
> parallelism. The panel is the sole merge coordinator (§10.1 preview instances don't merge). `MERGE_LOCK ▸` marker.
>
> Acceptance (headless): pure — the lock state machine (`acquire`/`release`/`queueDepth`/"Nth in line"); a held lock
> defers a second land; release auto-promotes the head of queue. Verify: `npm test` green — then **live**: prepare two
> branches in parallel (own worktrees) → confirm-land both → they land ONE AT A TIME on the repo-root main, the second
> showing "waiting to merge", each re-validated by the freshness check. State the live serialized land is eyeball-only.

## DBR-P4-7 — Worktree GC (§9/U10) + the auto cross-branch drift broadcast (§7) (logic headless + live)

> Two §-followups concurrency unblocks. (a) **Worktree GC** — the conversation↔worktree↔branch reconciliation on host
> startup (+ after merge/abandon): `git worktree prune` registry-stale; **keep** worktrees with a **live** conversation;
> `git worktree remove` those whose conversation is **merged/abandoned**; **NEVER auto-delete** a worktree with unmerged
> work + **no** conversation (→ surface for an explicit `delete branch`). (b) **Auto cross-branch drift broadcast** (the
> Phase-2 follow-up, now real with N live branches): after a merge moves `main`, compute which OTHER live dev branches
> the merge touched (the P2-7 `computeDrift` over each live branch) → a per-conversation nudge (*"`main` moved under
> you — `sync`?"*). Warning only, never blocks. `GC ▸` marker.
>
> Acceptance (headless): pure — `gcPlan(worktrees, conversations)` (keep/remove/surface per the 4 rules, NEVER auto-delete
> unmerged+orphan); the post-merge drift broadcast set (reuses `computeDrift`). Verify: `npm test` green — then **live**:
> a merged conversation's worktree is removed on the next GC; an unmerged+orphan worktree is KEPT + surfaced; merging
> branch Y nudges live branch X if it overlaps. State the live GC + broadcast are eyeball-only.

## DBR-P4-8 — node_modules junction (§11/U3) + pool reattach on reload + optional token budget (logic headless + live)

> The robustness tail. (a) **`node_modules` junction (§11/U3):** a new branch worktree **junctions** its `node_modules`
> to the main store (Windows directory junction — no admin); fall back to a per-worktree `npm ci` ONLY when the branch
> changed `package.json`/the lock (so its test run sees the right deps). (b) **Pool reattach on panel reload:** on
> reload the host sends a `pool` frame listing live runs → the panel rebuilds each run's bubble (runId→conversation
> from the persisted record / the run's journal), so a reload doesn't orphan live runs. (c) *(Optional)* a **token
> budget** backing `MAX_CONCURRENT` (N concurrent Claude ≈ N× burn / 429 risk — §10/§11). Pure: the junction-vs-`npm ci`
> decision (branch touches package.json/lock?); the reattach reconcile (pool list ∩ persisted conversations).
>
> Acceptance (headless): pure — `needsOwnDeps(changedFiles)` (true iff package.json/lock changed); the reattach
> reconcile (match live runIds to conversations, drop unknowns). Verify: `npm test` green — then **live**: a worktree
> whose branch doesn't touch deps junctions instantly (no `npm ci`); reload the panel mid-run → the live run's bubble
> rebuilds from the `pool` frame. State the junction + reattach are eyeball-only.

---

## After Phase 4

Phase 4 turns split detection (§8.1) into **real parallel decomposition**: Claude proposes splits, you approve them,
and the approved branches **run concurrently** — each in its own worktree, multiplexed over one host port, demuxed into
its own (possibly off-screen) conversation — while `main` stays a single-merge-at-a-time serialization point. The
preview tree lets you live-test any branch without disturbing the runners; GC keeps the worktree set honest.

**Remaining after Phase 4** (each its own small slice + any needed sign-off):
- **P3-6** (`pr`/`gh` merge variant) — still gated on its **push + network** sign-off (§3 excludes `push`; `gh` reaches
  the network). Independent of concurrency; revisit whenever.
- **§10.1 parallel live-test** (separate unpacked instances per branch worktree) — optional + additive; a one-time
  manual Load-unpacked per branch, no bridge in those instances.
- **The drawer Merged/Abandoned grouping + read-only render** (the Phase-2 UI follow-up) — orthogonal to concurrency
  but pairs well with the multi-run manager's off-screen run bubbles.
- **DESIGN §12 deferred:** `revert` (deferred in U1), a high-worktree-count warning (§9 nudges short-lived branches).

**This completes the dev-branches arc** (Phases 1–4 + the two optional tails): a dev conversation is a branch is a
proposal; converge (sync/merge/freshness/abandon/drift); scope discipline (split/fork/scope); and concurrency
(worktrees + run-pool + merge lock). The teach-once flywheel now has a parallel-experimentation substrate.
