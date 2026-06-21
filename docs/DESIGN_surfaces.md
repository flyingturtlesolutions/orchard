# DESIGN — Surfaces (the unified task lifecycle)

**Status:** BUILT — code-complete, **live-verification pending** · 2026-06-20 · v2.74.1138–1147 · see §9 (as-built)
**Relation:** *generalizes* `DESIGN_dev_branches.md` (the low-level dev bridge — branches, worktrees, the land flow) into a **surface-agnostic** task model; companion to `DESIGN_inference_layer.md` (the page-side agent). The dev bridge is one surface; this doc is how the user tasks **any** agent and ships the result with the wiring out of sight.

> One line: **pick a surface, pin a task, approve the result** — and every branch / worktree / sync / test / merge / version / deploy step happens below the waterline. The user sees three states and takes one action each.

---

## 0. Thesis

The friction isn't the agents — it's that **each surface owns its own integration path.** This chat (high-level / conceptual) commits straight to `main`; the dev chat (low-level / implementation) branches *beside* it. Two integration models that don't compose → the preview tug-of-war, the "behind main" guards, the version collisions, the `lt`/`cp`/`sync`/`merge`/`regress` verb soup the user has to operate by hand.

**Surface independence** = collapse that to **one** lifecycle. A **task** is the unit. A **surface** is merely *which agent* runs it. The user sees `Running → Review → Shipped` and acts once per transition; the git/preview/deploy plumbing is invisible and **shared** by every surface, so surfaces stop colliding and start composing.

---

## 1. The root problem — asymmetric integration

| Friction the user hits today | Root cause |
|---|---|
| Preview "tug-of-war" (you `lt` your branch, the other surface yanks `.wt/preview` back to `main`) | two surfaces, **one** preview pointer, **manually** moved |
| "1 commit behind `main`" guard on every `lt` | this chat advances `main` *while* a dev branch is open |
| Recurring version collision (`1133`-vs-`1133`) | **both** surfaces bump `manifest.json`; they meet at merge |
| "Is it actually live?" (panel reload vs host respawn vs the right ref) | three deploy layers, none automatic |
| Verb soup (`lt` / `lt!` / `cp` / `sync` / `merge` / `regress` / `fork`) | the user operates git by hand |

Every row reduces to **one** asymmetry: **this chat works *on* `main`; the dev chat works *beside* it.** Make every surface work *beside* `main` — symmetric, isolated, integrated through one queue — and the whole table collapses.

---

## 2. The model

### 2.1 Task = the unit
A **task** is a pinned intent + its isolated sandbox + its lifecycle state. It is *durable* (survives a panel close / host crash — already true of dev runs, `DESIGN_dev_branches.md` §P4) and *bound to its sandbox* (a worktree off `main`). It is never "a chat message that edits files in place."

### 2.2 Surface = which agent runs the task
A **surface** is an agent config — its altitude, prompt, and tool scope. `{ high-level (conceptual), low-level (dev bridge), …research, …review }`. Surfaces are **interchangeable** w.r.t. the lifecycle: they all produce a sandbox of landmark-able edits and feed the same `Running → Review → Shipped` pipe. Adding a surface = registering an agent, not a new integration path.

### 2.3 The three states (and the one action each)
```
RUNNING  ─►  REVIEW  ─►  SHIPPED
            (diff +      Approve ─► ship
             preview)    Discard ─► gone
```
- **Running** — the agent works in its sandbox. The user may watch the stream or walk away.
- **Review** — on completion the task auto-enters Review: the **diff** + an **auto-preview** (no manual `lt`). The user takes exactly one action.
- **Shipped** — **Approve** runs `sync → test → version@land → merge → push → deploy`, all automatic; the change is on `main` and live. **Discard** drops the sandbox, no trace.

### 2.4 The waterline
Everything the user touched by hand today lives **below** the line and becomes internal:
```
══════════ visible: surface · task · {Running, Review, Shipped} · {Approve, Discard} ══════════
 worktree · branch · commitWip · sync · npm test · version@land · merge · push · panel-reload · host-respawn · preview-checkout
```
`lt` / `cp` / `sync` / `merge` / `regress` / `fork` are not *removed* — they become the verbs of the runtime, not of the user.

---

## 3. Concurrency — the funnel

Concurrency is the point, and it has a fixed shape: **wide where it's safe, serial where it must be.**

```
RUN      ▓▓▓▓▓▓▓▓   many, parallel   — isolated worktrees, bounded by a cap (N) + LLM spend
REVIEW   ▓▓▓▓▓▓     many, parallel   — a queue of finished tasks awaiting the user
APPROVE  ▓▓▓▓       many, parallel   — the user approves several
LAND     ▓          ONE at a time    — merge queue: re-sync → re-test → merge → version
LIVE     ▢          ONE at a time    — Chrome loads one extension/profile; the user selects
```

- **Run / Review / Approve are fully parallel.** Each task is its own worktree, so any number run, finish, and sit in Review without touching each other. The cap (`MAX_CONCURRENT`, `DESIGN_dev_branches.md` §P4-3) is the knob.
- **Land is serialized — and that is correct, not a limit.** You cannot safely parallel-merge into one `main`. Approvals fan into a **FIFO merge queue**: task A lands → `main` moves → task B's land **re-syncs onto the new `main`, re-runs the test gate, then merges**. An overlap with A's code surfaces *there* as a "needs your input" Review state — never a silent clobber. **This already exists** — the land-lock + FIFO (`mergeLock`, §P4-6) + freshness re-sync (§P2-5). The hard part of safe concurrency is built.
- **Live preview is serial** — one extension per Chrome profile. Execution and review are unbounded; only the final eyeball is one-at-a-time, by the user's selection.

Net: **concurrent execution, serialized integration** — the merge-queue pattern. The two bricks in §4.1/§4.2 are what make it *safe* rather than colliding.

---

## 4. The architecture (the bricks)

### 4.1 Symmetric isolation — *the keystone*
**Every** surface, including this high-level chat, runs in its own worktree off `main` and integrates through the queue. No agent commits to `main` directly. This single change deletes the §1 table: no preview tug-of-war (each task owns its sandbox; the live pointer is a *selection*, §4.5), no "behind main" surprise (you only go behind by approving someone else's land), no on-`main` actor that can move the branch out from under an in-flight land. *This is the difference between "two channels that fight" and "N surfaces that compose."*
*Exists:* worktree machinery (§P4-1/P4-5). *To build:* route the high-level surface through it (today it's the repo-root exception).

### 4.2 Version-at-land — *the safety prerequisite*
Agents **stop** bumping `manifest.json`. The **land step** assigns the next version on `main`, under the merge lock — so concurrent lands get *sequential* versions (`1138, 1139, …`) and never collide. Without it, two parallel tasks both bump and conflict (the `1133`-vs-`1133` we kept hitting); concurrency makes that *worse*, so it gates §3.
*To build:* one host file-write op (the host does git only today, by its allowlist) invoked inside `commitMerge`, deriving `main`'s current patch + 1.

### 4.3 The review gate — *retire the verb soup*
On completion a task auto-enters **Review**: the `git diff --stat main…task` + an **auto-preview** + two buttons. **Approve** = the §2.3 pipeline. **Discard** = drop the sandbox (today's `regress`, generalized). `lt`/`cp`/`sync`/`merge` become internal steps the gate runs, not things the user types.
*Exists:* `merge` (sync→test→diff→land), `regress`, durable run bubbles. *To build:* the auto-on-completion transition + the unified two-button surface (vs. the typed verbs).

### 4.4 Auto-deploy on approve — *"approved" means "live"*
The gate drives the deploy so the user never reasons about it again: repoint the live build to `main` + **reload the panel**. Panel code is live immediately; **host code refreshes automatically on the panel reopen** — the native host exits on port-close (`host.js` stdin `end`) and Chrome's native messaging spawns a fresh host from repo-root `bridge/host.js` (which is on `main` post-land) on the next connect, so **no respawn capability is needed** (the "host self-restart" in earlier drafts was a phantom — confirmed v2.74.1142). The auto-deploy just **surfaces** a `bridge/`-land's host-refresh (`landTouchedHost`) so it's legible. The "is it actually live?" hour we burned becomes a non-question.
*Built (v2.74.1140–1142):* the Approve-scoped deploy step + the host-refresh note.

### 4.5 Preview-as-selection — *not a fought pointer*
`.wt/preview` stops being a pointer two surfaces move and becomes the target of a **"view task X"** selection. The user picks which build to load; the runtime points it. Defaults to `main` (the shipped trunk) when nothing is selected.
*Exists:* the preview worktree + `previewRepointPlan`. *To build:* drive it from task selection, not from typed `lt`.

---

## 5. What exists vs. to build

| Capability | State | Where |
|---|---|---|
| Isolated worktrees per task (cap>1) | **built** | dev bridge §P4-1/P4-5 |
| Durable, crash-survivable runs bound to a task | **built** | §P4 |
| Serial land queue + freshness re-sync (the hard part) | **built** | §P4-6 (`mergeLock`), §P2-5 |
| `sync → test → diff → merge` land flow | **built** | `merge` verb |
| Discard a task / revert the live build | **built** | `regress` verb (v2.74.1133) |
| **Symmetric isolation** (high-level surface in a worktree) | **to build** | §4.1 — keystone |
| **Version-at-land** | **to build** | §4.2 — safety gate |
| **Auto-on-completion Review + two-button gate** | **to build** | §4.3 |
| Auto-deploy (panel reload + host auto-refresh on reopen) on approve | **built** (v2.74.1140–1142) | §4.4 |
| **Preview-as-selection** | **to build** | §4.5 |

The dangerous machinery (safe serial integration) is done. The deltas are isolation + versioning + a thin UX gate.

---

## 6. The honest limits

- **One live preview.** Chrome loads one unpacked extension per profile, so visual eyeballing is serial — the user selects which task to view. Execution and review are unbounded; only the final look is one-at-a-time. (Separate Chrome profiles could relax even this, but it's heavier and out of scope.)
- **Cost, not correctness.** N parallel agents = N parallel LLM streams. That's the managed-proxy/budget layer's job to meter (`DESIGN_inference_layer.md` §5/§2.6); concurrency is a *spend* dial, not a safety one.
- **Overlapping tasks → one conflict at land.** Two tasks on the same lines = a merge conflict the queue surfaces as a Review state. Unavoidable when work overlaps; mitigated by keeping surfaces on different code (the high/low split already does this).
- **Host-code lands refresh on reopen, not instantly.** A task that edits `bridge/host.js` goes live when the panel reopens — a fresh native-messaging host loads it (automatic, no extra mechanism), but a real moment, not instantaneous. The auto-deploy surfaces a note so it's expected.

---

## 7. Build path

Each phase is shippable and reversible; order is by leverage, not size.

1. **Version-at-land** (§4.2) — *smallest, highest-leverage.* Kills the recurring collision and is the prerequisite for safe concurrent lands. One host op + a `commitMerge` hook.
2. **Symmetric isolation** (§4.1) — *the keystone.* Route the high-level surface through a worktree + the land queue. Deletes the §1 friction table; turns colliding channels into composing surfaces.
3. **The review gate** (§4.3) — auto-on-completion Review + Approve/Discard, with `lt`/`cp`/`sync`/`merge` demoted to internal steps.
4. **Auto-deploy** (§4.4) — fold the three deploy layers into Approve so "approved" = "live."
5. **Preview-as-selection** (§4.5) — drive the live build from task selection; retire typed `lt` from the user's vocabulary.

After (1)+(2) the model is *safe and symmetric*; (3)–(5) are the UX that makes the wiring *invisible*.

---

## 8. Open / not yet decided

- **Surface registry** — how a surface is declared (prompt + tool scope + altitude) and how the user picks one. A small fixed set first (`high`, `low`), extensible later.
- **Cap policy** — the concurrency cap per surface vs. global; how it interacts with the cost governor (§6) and the host's slot model.
- **Cross-task dependencies** — task B that *needs* task A's land first (a DAG of tasks, not just a flat queue). Out of scope for v1; the flat FIFO covers the common case.
- **Conflict-at-land UX** — the exact "needs your input" Review surface when a re-sync conflicts (auto-resolve vs. hand to the user vs. re-task the surface).
- **Where the high-level surface runs** — this chat is a separate CLI today; symmetric isolation needs it to either adopt the worktree convention or be fronted by the same task runtime.

---

## 9. As-built (v2.74.1138–1147)

The whole model above is **implemented**. It turned out to be *less* than a from-scratch runtime: the dev bridge's machinery (worktrees, the land queue, the review/merge flow) was already surface-agnostic, so most of the keystone was "thread a surface config through what exists."

| Plan | Built as | Version |
|---|---|---|
| §4.2 version-at-land | `bridge/setVersion.cjs` + host stamp in the land flow; agents stop hand-bumping on dev branches | 1138 |
| §4.3 review gate | run-`done` → `_offerReview` (cap-correct worktree status) → Approve/Preview/Discard card | 1139–1140 |
| §4.4 auto-deploy | Approve → `_redeployToMain` (preview→main + reload); host code refreshes on reopen (native-messaging respawn — the "host self-restart" was a phantom); `landTouchedHost` note | 1140–1142 |
| §4.5 preview-as-selection | drawer per-dev-row **Preview** + **↩ Preview main** (`previewConversation`/`previewMain`) | 1141 |
| §8 keystone — surface registry | `bridge/surfaces.cjs` — `low`/`high` configs, one git-free trust posture | 1143 (K1) |
| §8 keystone — host engine | `startRun` injects the surface altitude preamble (`--append-system-prompt`); `high` = design altitude, `low` = unchanged | 1144 (K2/K4) |
| §8 keystone — activation | the **`surface high\|low\|design`** dev verb sets `conversation.surface`; the `dev:` run threads it to the host; a violet **design** badge in the drawer | 1145, 1147 (K3) |
| §8 keystone — lands through the gate | **free** — the review gate / queue / version-at-land / auto-deploy are surface-agnostic | (K5) |

**The high surface, concretely:** a dev conversation set to `high` → spawns with the design-altitude preamble → works in an isolated worktree → lands through the same review gate + version-at-land + auto-deploy, never committing to `main`. The terminal chat is **not yet** retired (that migration is the remaining big piece); the in-panel high surface *exists* alongside it.

**Live-verification pending — and that matters here more than usual.** Every behaviour-pure piece is unit-tested (~40 new tests, suite green), but the dev bridge lives in a host process + panel + worktrees the headless harness can't reach. **All six bugs found this session lived in that live-only seam** — the merge-driver dedup gap, the cap>1 diffstat, the host-respawn phantom, `_redeployToMain` at cap=1, and (twice the worst) the `surface` field that the store's `patchMeta` allowlist **silently dropped**, so the keystone looked "functionally complete" while saving nothing. Lesson burned in: **green + code-traced ≠ works** for this subsystem; the live eyeball is where the real bugs are, not optional polish. Confirm with: `surface high` → drawer flips to a `design` badge → `dev: <a design task>` → trace shows `SURFACE ▸ high … preamble injected`, the agent works at a design altitude → Review → Approve → lands.

**Remaining (post-eyeball):** the new-conversation Dev/Design **picker** (UX nicety — the `surface` verb already does this) · `gl`/`bug` runs carrying the conversation's surface (today only `dev:` does — minor consistency) · the **terminal-retirement migration** (make the in-panel high surface the primary entry — a real project, needs its own design pass once the keystone is confirmed live).

---

## 11. The terminal-retirement migration (the last asymmetry)

§4.1 said *every* surface, including this high-level chat, works **beside** `main`. The keystone (§9) built an in-panel high surface that does exactly that. But **this terminal chat still exists** — an external `claude` CLI working *on* `main`. So there are now two high-level surfaces, and the §1 asymmetry survives in the terminal one. This is how that resolves.

### 11.1 Full retirement is impossible — the terminal is the bootstrap surface
The in-panel high surface is spawned by the host, which is part of the extension. **It cannot fix a broken extension** (a bad `bridge/host.js`, a panel that won't load, a corrupt build) — it runs *inside* the thing that's broken. So a terminal `claude` operating on the repo directly must remain as the **bootstrap / recovery surface**. "Retire the terminal" is really **"make the panel the PRIMARY high surface; keep the terminal as the explicit break-glass path."**

### 11.2 End-state — three surfaces, one clear division
| Surface | Where | Does | Isolation |
|---|---|---|---|
| **Terminal** (bootstrap) | external `claude` CLI | extension-breaking / `bridge/` / host changes · recovery · the dev-bridge's own development | on `main` or a worktree — the deliberate exception, used rarely |
| **Panel · Design** (high) | host-spawned, in-panel | routine conceptual / app-level work | worktree → review gate → land |
| **Panel · Dev** (low) | host-spawned, in-panel | implementation | worktree → review gate → land |

Routine high-level work moves to the panel Design surface; the terminal shrinks to the escape hatch it has to be.

### 11.3 The parity gap — what Design must absorb to take routine work off the terminal
The in-panel surfaces carry the **git-free scoped** allowlist (Read/Edit/Write/Grep/Glob + scoped Bash). For Design to absorb routine high-level work it needs, beyond that:
- **A `high` settings tier** — broader than `dev`'s (read-broad · more Bash verbs for build/test/inspect) but **still git-free** (it lands through the gate, never commits) and **still injection-bounded**. The registry's `settingsTier` field (today both `'scoped'`) is the seam — add a `'high'` tier; nothing else in the spawn path changes.
- **Context parity** — CLAUDE.md already rides the repo it runs in; conversation continuity is the panel's per-conversation `--resume`; the memory system (`.claude/memory/`) the surface reads/writes like the terminal does.
- **Sub-agents / web / MCP** — the terminal has the Task tool, web, MCP. Decide per-need: Design likely wants *read* web + MCP, not arbitrary sub-agent spawning (cost + the host's slot model). The `high` tier scopes exactly this.

### 11.4 Migration path
1. **Parallel (now).** Both exist. Shift discretionary high-level work into the panel Design surface; notice what's missing (the §11.3 gaps).
2. **Close the parity gap.** Add the `high` settings tier + confirm context/memory parity. Design can now do most of what the terminal does for routine work.
3. **Reframe, don't delete.** Repurpose the terminal's role *explicitly* to "bootstrap / recovery" (docs + the user's mental model). It stops being the daily driver; it's break-glass.
4. **(Optional) bootstrap ergonomics.** A documented "recover from a broken build" flow so the escape hatch is reliable when the panel is down.

### 11.5 Open
- **The `high` tier's exact scope** — the central call; capability vs. the trust posture (git-free, injection-bounded) that lets a surface land through the gate instead of committing.
- **The hard rule for what STAYS on the terminal** — `bridge/`-or-host changes, extension-breaking changes, recovery. (A panel Design surface that edits `bridge/host.js` and lands it could brick its own host mid-land — host-code MUST stay on the terminal.)
- **Cost governance** — panel surfaces spawn `claude` children; a busy Design surface multiplies spend (the §6 dial, the managed-proxy/budget layer).
