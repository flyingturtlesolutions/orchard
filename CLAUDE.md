# CLAUDE.md — Orchard (pkg `ahub`)

Chrome side-panel agent that learns to operate websites. MV3 extension; no build step (source loads directly).

## Commands
- **Test (the gate):** `npm test` — node harness over `Core/*.test.js`, `Services/*.test.js`, `Services/Engine/*.test.js`. Must stay green (currently 808 passing).
- **Syntax-check edited JS:** `node --check <file>` before relying on a change (ESM files: `node --input-type=module --check < <file>`).
- **Scratch goes to the OS temp dir, never the repo root.** The repo root IS the unpacked-extension root (no build step), and Chrome refuses to load a directory containing any `_`-prefixed file (`_metadata`/`_locales` are reserved) — so a stray `_tmp_*.mjs` probe at root breaks `Load unpacked` entirely. Write probes/one-offs to `%TEMP%` (e.g. `C:\Users\Divine\AppData\Local\Temp`). `.gitignore` ignores root `/_*` so they can't be committed, but an untracked one still blocks the load until deleted.
- **Version:** bump `manifest.json` (`v2.74.X`) on every behavior change — it's the join key between `logs/build/` (the conversation), `logs/run/` (traces + `findings.md`), and commit messages. Never ship a behavior change without a bump. *(v2.74.1138 — **version-at-land** exception: a dev-bridge **`merge`** now stamps `main`'s version to current+1 automatically at land (`bridge/setVersion.cjs`, `docs/DESIGN_surfaces.md` §4.2), so don't hand-bump `manifest.json` on `dev/…` branches — the land owns the number and overwrites the branch's; inline `v2.74.X` markers there are author annotations only. Direct-to-`main` work, like this high-level chat, still bumps by hand.)*
- **`bcp`** = bug pass → commit → push (diff review + syntax + `npm test`, then commit/push only on green).

## Layout
`Core/` engine + matching · `Services/` (incl. `Services/Chat/`, `Services/Engine/`) · `background/` (SW + `background/handlers/`, e.g. `sg.js`, `explore.js`) · `Studio/` + `studio.js` · `Sidepanel/` · `ContentScripts/` · `docs/` design specs · `logs/` git-ignored build/run journals.

---

# Invariants — add to these, don't relearn them

Three failure *families* below have each been re-diagnosed from scratch several times (see `logs/run/findings.md`). They are checklist-shaped: a new code path silently breaks a contract that no test covers. Before finishing any change that touches the listed trigger, confirm the paired rule.

## 1. New decision marker → add it to `_DECISION_RE`
**Trigger:** you add or rename a decision-worthy log marker (anything a `-decisions-` download should surface — `ROUTE ▸`, `ORCH_MATCH`, `WALK ▸`, `RICH_INTENTS ▸`, `INTENT_MENU ▸`, `ACCEPT_SG_TRIAL`, `INTERACTION_OUTCOMES ▸`, etc.).

**Rule:** add the new marker to `_DECISION_RE` (`studio.js:5888`). The decisions-view filter is an explicit allow-list — a marker absent from it is **structurally invisible** to a `gl -decisions-` download, so the feature it's meant to verify can only be confirmed from a FULL trace.

**Why this keeps biting (the "#165 lesson"):** missed at v2.74.818 (`MERGE_GROUNDS`), .832 (`WALK ▸`), .882 (`bindClauseParams`), .898 (four new markers at once — intent-menu / rich-intents / hetero-strategies all unverifiable from a decisions download). Same class every time. The fix is one line; the cost of forgetting is a blind verification run.

## 2. New engine-driven click emitter → busy-mark its tab
**Trigger:** you add a code path where the **engine** (not the user) drives clicks/types/navigation on a tab — replay, trial, sweep, workflow invoke, walk teach-step, etc.

**Rule:** wrap the driven span with `markEngineBusy(tabId, true)` / `…false` (exported from `background/handlers/sg.js:122`; refcounted via `_busyTab`, always in a `try/finally` so it unmarks on every exit). Engine clicks then drop from the interaction monitor as `dropped: 'engine-run'` instead of polluting the trace / C4 / C5 as phantom `INTERACTION hit/miss` lines.

**Exception — do NOT suppress the observation/demonstration recorder.** When the *user* is demonstrating a capability, those clicks ARE the signal; busy-marking them would erase the recording. Suppress engine-synthesized clicks only.

**Why this keeps biting:** discovered one emitter at a time — `REPLAY_SG_CAPABILITY` (.908) → `EXPLORE_PAGE_STRUCTURE` sweep (.911) → `RUN_SG_TRIAL` (.912) → `INVOKE_WORKFLOW` (flagged .966, distinct dispatch path). Each new driver re-introduced the same monitor pollution. Treat busy-marking as part of the definition of "engine drives a tab," not a follow-up.

## 3. New ride-recipe field → thread it through all THREE catalog→leg hops (+ seed into existing Grounds)
**Trigger:** you add a field to a `CONNECTOR_RECIPES` entry (`Core/connectorRecipes.js`) — a transport marker (`gql` / `csrf` / `persistedOp` / `urlParam` / `bodyType` / `contentType`), a human-page marker (`itemUrl` / `listUrl`), an identity marker (`verifyIdentity` / `identityProbe`), or a digest marker (`pulse` / `drill`).

**Rule:** the field must survive the **SEEDED** path (a forged / Overview-workbench Ground rides `harvestedRecipeLegs`), not just the catalog-invoked path — an app selecting a curated leg reads the entry DIRECTLY, so it never notices a drop; only a seeded Ground exercises all three hops. Catalog → invocable leg is three hops:
1. `recipeFromCatalogEntry` (`Core/rideRecipe.js`) — entry → stored per-Ground record. **Add the field** to the additive block.
2. `harvestedRecipeLegs` (`Core/connectorRecipes.js`) — record → leg. It SPREADS the whole record into `recipeToLeg`, so a new field flows **automatically** — nothing to do here (that spread IS the v1432 consolidation).
3. `recipeToLeg` (`Core/connectorLeg.js`) — the single field-reader (record/entry → `leg.tool`). **Add the field** here.
Plus: `GET_RIDE_RECIPES` (`background/handlers/sg.js`) MERGES curated into a NON-empty Ground (adds-missing; preserves a user's disable/reject), so a forged Ground actually receives the curated legs — it is not seed-on-empty-only.

**Why this keeps biting (the "re-learn per ride" lesson):** the ride MODEL generalized cleanly, but ACTIVATION (reachable + fresh + armed) was hardcoded to the Zendesk/Shopify connected-app shape, so each new transport/field was dropped on the seeded path one at a time — cookie-ride auth (v1430), palette projection (v1428), `itemUrl` for "show warranty" (v1432). Same class every time: the curated app worked, the forged/seeded Ground silently lost the marker. The v1432 spread makes hop 2 automatic; hops 1 + 3 (+ the merge) are the residual two-line discipline.

---

# Working conventions (from the build/run loop)

- **The loop is `build → gl (download trace) → diagnose → fix + bump → re-verify → publish digest`.** `findings.md` is the system-of-record for *why* a fix happened (symptom → cause → change); commit messages + `manifest` version are the system-of-record for *what*. When you fix something a trace surfaced, add/append the `findings.md` entry.
- **Publish the progress digest at pass-end.** After appending the `findings.md` entry, run `node tools/progress-digest/digest.cjs --post` (reads `FORGE_REPO_PATH` from env/`.env`). It derives a **meta-only** summary — schema fields only, never source/paths/identifiers/raw findings — and commits + pushes it to the Forge catalog (`project-catalog/digests/webpilot.md`, overwritten in place; git history is the timeline). **Fail-safe:** any git/offline failure warns one line and never blocks the pass; missing `FORGE_REPO_PATH` skips. Preview safely with `--dry-run`; standalone self-test `node tools/progress-digest/digest.test.cjs`. Lives in `tools/` (local toolchain, never the shipped extension bundle — it holds git push, the extension must not). For cleaner judgment fields, drop a `DIRECTION:` / `LESSON[tag]:` / `DIGEST_MILESTONE:` / `DIGEST_BLOCKER:` / `DIGEST_NEXT:` line into the findings entry (lightly scrubbed; the auto-extracted markers are heavy-scrubbed and choppy). *(Currently manual `--post`; an auto Stop-hook will replace it after a few clean passes.)*
- **Verification honesty:** state plainly what was proven (syntax, `npm test`, headless harness) vs. what still needs a live eyeball (panel UI / DOM feel / cross-reload survival can't be confirmed headless — say so rather than implying it's done).
- **Injection boundary:** untrusted page-derived strings must stay on the escape-first render path (`renderMarkdown` HTML-escapes before parsing); host commands are validated before reaching the command line (see `docs/DESIGN_injection_boundary.md`). Don't widen the trust surface without saying so.
- **Trust rules for the dev-bridge:** the bridge runs `claude` under a scoped allowlist in `--permission-mode default`; no `git`, no arbitrary Bash beyond the DB-2 allowlist (`Bash(npm test:*)`, `Bash(node:*)`). Don't relax these silently.
