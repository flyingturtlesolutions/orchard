# Dev branches — Phase 3 prompt plan (scope + split) · bcp-gated

Ready-to-paste prompts for **Phase 3** of `DESIGN_dev_branches.md` (§8 scope discipline + §8.1 split detection +
§6.1 fork + the §6 `pr` variant), in dependency order. Same discipline as Phases 1–2: paste one → land → verify →
eyeball any live-only checks → **`bcp`** → *then* the next. **Don't batch across prompts.**

**Where Phases 1–2 left us:** a dev conversation is a branch is a proposal, with the full converge lifecycle —
`sync`, `merge` (prepare → human-confirmed squash-land), freshness, abandon, drift. The per-conversation `concern`
(DBR-5) exists; in Phase 1 its contract just said *"if a fix needs shared/foundational code, STOP and tell the
user."* Phase 3 turns that into **active decomposition**: keep branches focused (scope discipline), and when work
carries a separable concern, **propose a split** the human approves one tap at a time.

**Scope guard:** Phase 3 is still **single-tree, serial** (no worktrees/concurrency — that's Phase 4). Splits in
Phase 3 are **seed-and-hold or serialized seed-and-run** (the child waits its turn); fan-out-in-parallel is the
Phase-4 payoff (§8.1). Phase 3 biases **hard to PLAN-TIME** splits (split before code exists — routing a sub-task,
not surgery on a tangled diff).

**Two TRUST SIGN-OFFS are required before code** (DESIGN §3 — don't relax silently):
- **P3-3 `propose_split` tool** exposes a *new tool to the spawned `claude -p`*. The DESIGN argues it doesn't
  widen the surface (proposal-only — no git/fs mutation; actuation stays panel-side + human-gated, §2.1). Confirm
  that reasoning + the tool-exposure mechanism (MCP) before building.
- **P3-6 `pr` variant** needs `git push` + `gh` — both **deliberately excluded** in Phase 1 (§3: "no `push`";
  "Claude Code's allowlist stays git-free"). A PR push is human-driven via the `pr` verb, but it is still a new
  host capability reaching the network. Sign off the surface (who pushes, to where, with what auth) first.

**Standing guardrails (every prompt — §3, signed off 2026-06-17):**
- Host git stays **discrete, parameter-validated**; **Claude's allowlist stays git-free**; the `propose_split`
  tool is **proposal-only** (emits a typed payload; the panel alone mutates, on a human tap — §2.1).
- `main` is mutated only by the existing gated `merge --squash` (or, post-P3-6, an explicit human `pr`).
- Bump `manifest.json` per behavior change; **`npm test` is the gate** (currently **890** passing).
- **New decision markers** (`SPLIT ▸`, `SCOPE ▸`, `FORK ▸`, `PR ▸`) → `_DECISION_RE` (`studio.js`) (INVARIANT #1).
- New engine-driven run (a seed-and-run child; the `scope?` model call) → busy-mark / honest cost (INVARIANTS).
- **Verification honesty:** headless (`npm test`, unit tests) vs. live (the seeded branch + conversation, the
  `propose_split` tool_use round-trip, the PR push).

---

## DBR-P3-1 — The split-seeding mechanism + `split <concern>` corrective verb (logic headless + live) · *do first*

> Build the panel actuation every later slice reuses (§8.1 "seeding an approved split"): given a
> `{concern, branchBase, seedPrompt, suggestedName}`, the **panel** (the actor, §2.1) creates `dev/<slug>` off the
> base (default `main`; DBR-1 `branchCreate`), creates a `kind:'dev'` conversation (DBR-2) bound to it, and
> **seeds it SEED-AND-HOLD** — the seed prompt is **pre-filled as a draft, NOT sent** (strictly "user-typed only";
> the human reviews + presses enter). Surface it first via a **manual `split <concern>` verb** (§8): whole-message
> `split …` in a dev conversation → derive a slug from the concern → seed a new branch+conversation off `main`.
> Pure: `splitSlug(concern)` (collision-resistant `dev/<slug>-<shortid>`, valid per `validateBranchName`) +
> `buildSeedPrompt({concern, parentConcern})`. `SPLIT ▸` marker → `_DECISION_RE`.
>
> Acceptance (headless): unit tests — `splitSlug` yields a valid `dev/…` name + is collision-resistant;
> `buildSeedPrompt` embeds the concern. Verify: `npm test` green — then **live**: `split fix the drawer animation`
> in a dev conversation → a NEW dev conversation appears, bound to a fresh `dev/…` branch off `main`, with the seed
> **pre-filled but unsent**. State the seeding is live-only.

## DBR-P3-2 — Deterministic split backstop — diff-scope drift nudge (§8 / §8.1 layer 2) (logic headless + live)

> The always-on, no-LLM backstop (§8.1 layer 2) — *"catches what Claude forgets to flag."* Reuse the P2-7
> detectors (`isFoundationalFile`, `computeDrift`) + add the §7.1 **split-cluster** signal: the branch's changed
> files, linked by import edges, fall into **≥ 2 connected components with no edge between them** (a light static
> ESM/`.cjs` import scan — PURE given the file→imports map). Flag a branch when its diff (a) forms a split-cluster,
> (b) touches a **foundational/shared file alongside leaf work**, or (c) **drifts off its concern**. On a run
> completing (and on a `scope` verb), post a nudge — *"⚠ this branch (concern: `<concern>`) now edits `<file>` /
> spans `<N>` unrelated areas — `split`?"* A NUDGE, **never a block** (§8). `SCOPE ▸` marker.
>
> Acceptance (headless): pure tests — the split-cluster detector (≥2 import-disconnected components) on a fixture
> file→imports map; the foundational-alongside-leaf + concern-drift classifiers. Verify: `npm test` green — then
> **live**: a branch that edits a foundational file gets the `split`-offering nudge. State the live nudge is
> eyeball-only.

## DBR-P3-3 — The `propose_split` typed bridge tool (Claude proposes; §8.1/U5) · **TRUST SIGN-OFF FIRST**

> Implement the §8.1 *propose → approve → act* split. Expose a **proposal-only** bridge tool **`propose_split`**
> with schema `{ concern, reason, branchBase, seedPrompt, suggestedName }` to the spawned `claude -p` (the MCP /
> tool-exposure mechanism — sign off the surface first). Claude calls it → it arrives as a structured `tool_use`
> event whose `block.input` is **already-validated JSON** the panel reads directly — reuse the SAME devBridge.js
> path that handles `AskUserQuestion`/`ExitPlanMode` `tool_use` blocks (NO fuzzy prose parsing — typed by
> construction). The panel renders a **"Split `<concern>` into its own branch? [Yes, split] [No, keep here]"** card;
> on **Yes**, it performs P3-1's seeding (branch off `branchBase` — **`main` by default**, parent-branch only if the
> split genuinely depends on the parent). The tool **never mutates git/fs** — actuation stays panel-side + human-
> gated (§2.1), so exposing it doesn't widen the trust surface (verify that claim in the sign-off).
>
> Acceptance (headless): pure tests — the `propose_split` payload validator (well-formed → accepted; missing
> fields / a non-`dev` derived name → rejected); the panel's tool_use→card mapping is unit-testable on a fixture
> `block.input`. Verify: `npm test` green — then **live**: a dev run emits `propose_split`; the panel shows the
> card; **Yes** seeds the child branch+conversation; **No** keeps it. State the tool_use round-trip is live-only.

## DBR-P3-4 — Concern contract → "propose a split" at plan time (§8.2 / §8.1 layer 1) (logic headless + live)

> Upgrade the DBR-5 concern contract (`bridge/concern.cjs`). Phase 1's contract said *"…STOP and tell the user."*
> Phase 3's says: *"…if completing it needs shared/foundational code OUTSIDE this scope, or the task carries a
> separable concern, **call `propose_split`** with a seed prompt for the out-of-scope work instead of doing it
> inline."* **Fire at PLAN time** (scope-check the plan, not a sprawling diff — §8.1). Keep it a contract, not a
> hard block (Claude honors it; P3-2 is the backstop; *not 100%* by design). Depends on P3-3 (the tool must exist).
>
> Acceptance (headless): `concern.test.js` — the contract text now references `propose_split` + the plan-time
> framing; the existing in-scope-files-editable assertion still holds. Verify: `npm test` green — then **live**:
> a dev task whose first plan-step is a foundational change → Claude proposes a split (the P3-3 card) instead of
> editing inline. State the multi-turn plan-time behavior is eyeball-only.

## DBR-P3-5 — "Fork from here" (§6.1/U12) (logic headless + live)

> Implement "fork from here" (§6.1). A **merged/abandoned** (archived, read-only) conversation gets a **Fork**
> action → a NEW branch off `main` + a NEW dev conversation **seeded** (P3-1) with the parent's
> summary/concern + *"continue from here."* It seeds a FRESH session (Claude Code sessions are linear — no
> fork-a-session primitive; a summary carries the relevant context without dragging the whole transcript). `FORK ▸`
> marker.
>
> Acceptance (headless): pure test — the fork seed-prompt builder embeds the parent summary + concern + the
> continue cue; the new record is `kind:'dev'`, `status:'active'`, bound to a fresh `dev/…` branch. Verify:
> `npm test` green — then **live**: Fork a merged conversation → a new seeded dev conversation on a fresh branch.
> State live-only.

## DBR-P3-6 — The `pr` / `gh` variant (§6) · **TRUST SIGN-OFF FIRST** (logic headless + live)

> Implement the optional `pr` merge variant (§6 "Optional later"). Instead of the local squash-merge, `pr` runs the
> same prepare (sync → test → diff) then, on confirm, **pushes the branch + `gh pr create`** (review + CI) rather
> than mutating `main` locally. This needs `git push` + `gh` — **both excluded in Phase 1** (§3). SIGN OFF FIRST:
> who pushes, to which remote, with what auth; the host op stays discrete + parameter-validated; the push is
> human-gated by the `pr` verb + confirm (never autonomous). `PR ▸` marker.
>
> Acceptance (headless): pure tests — the `gh pr create` argv builder (validated branch/title/body, never a shell
> string); the push target is parameter-validated. Verify: `npm test` green incl. host op tests — then **live** (on
> a repo with a `gh` remote): `pr` a green branch → a PR opens; `main` is untouched. State the network push is
> live-only + requires `gh` auth.

## DBR-P3-7 (optional) — `scope?` semantic check (§8.1 layer 3) (logic headless + live)

> A `scope?` verb (or an auto-check at `merge`): **diff + concern → a quick model call** for a second opinion on
> scope creep / a missed split. On-demand (costs a call — honest about it; §8.1 layer 3 is explicitly optional).
> Reuses the panel's LLM path. `SCOPE ▸` marker (shared with P3-2).
>
> Acceptance (headless): the prompt/contract builder is unit-tested (diff + concern in → a structured verdict
> shape out). Verify: `npm test` green — then **live**: `scope?` on a drifted branch returns a split suggestion.
> State the model call is live-only + metered.

---

## After Phase 3

Phase 3 makes Claude a **planner that decomposes work into seeded branches** (the human approves one tap at a
time), keeps branches **focused** (scope nudges + the split corrective), and adds **fork** + an optional **PR**
merge path. **Still single-tree + serial** — each approved split waits its turn.

**Phase 4 — concurrency** (own plan, the natural payoff of split detection — §8.1/§10): per-run worktrees + the
preview-tree topology, the host run-pool + `v:2` `runId` multiplex, the panel multi-run manager, the full §7.2
merge **lock + FIFO queue** + worktree GC. Split-then-fan-out becomes **real parallel decomposition**. Needs its
own trust sign-off (`v:2` protocol + worktree topology) before code.
