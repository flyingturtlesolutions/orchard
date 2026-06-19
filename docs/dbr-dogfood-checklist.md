# DBR dogfood / eyeball checklist

Concrete scenarios to verify the dev-bridge behavior that's **built + headless-tested but never live-eyeballed**
(DBR Phase 3 verbs, the Phase-4 `v:2` cutover, the post-dogfooding guardrails, and the version merge driver). Run
them in order — **Scenario 0 first** (it's the foundation; if the `v:2` cutover is broken, nothing else streams).

Each: **Setup → Do → Expect** + which slice it proves. Tick the box when it passes; note anything that doesn't.

---

## 0. Reload + the `v:2` protocol cutover  ·  *proves P4-2 + the Orchard rename*  — **DO FIRST**
- **Setup:** Reload the unpacked extension in Chrome (this respawns the native host) **and** the side panel.
- **Do:** Confirm the header reads **Orchard** (not AHuB) and the version is **v2.74.1068+**. Start a **New dev**
  conversation and run one trivial task (e.g. *"add a comment to the top of README"*).
- **Expect:** the run **streams and finishes normally** — no hang, no "busy"/version-mismatch error. (If a run
  starts but nothing streams, the `v:2` cutover missed a frame — flag it; everything below depends on this.)
- [ ] pass

## 1. `split: <concern>`  ·  *proves P3-1 (split-seeding)*
- **Setup:** any active dev conversation.
- **Do:** type `split: extract the date formatter`.
- **Expect:** a bubble *"✓ split — created `dev/extract-the-date-…` (off `main`) + a new dev conversation … its seed
  is pre-filled"*; the new conversation **appears in the drawer (☰)**; opening it **pre-fills the composer** with the
  seed (not sent).
- [ ] pass

## 2. `scope` — deterministic backstop  ·  *proves P3-2*
- **Setup:** a dev conversation whose branch has a few changed files.
- **Do:** type `scope`.
- **Expect:** either *"✓ scope — `<branch>` looks focused…"* or *"⚠ scope — … consider `split: <the separable part>`"*
  (a nudge, never a block).
- [ ] pass

## 3. Claude proposes a split at plan time  ·  *proves P3-3 + P3-4*
- **Setup:** a dev conversation.
- **Do:** give a task that mixes two concerns, e.g. *"fix the date util and also restyle the chat header"*.
- **Expect:** at **plan time** Claude calls `propose_split` → a card *"Split `<concern>` into its own branch?
  [Yes, split] [No, keep here]"*. **Yes** seeds a fresh branch + conversation; **No** keeps it. (Claude proposing it
  unprompted = P3-4; the card + seeding = P3-3.)
- [ ] pass

## 4. `fork` — continue a finished conversation  ·  *proves P3-5*
- **Setup:** open a **merged** (archived) dev conversation.
- **Do:** type `fork`.
- **Expect:** *"✓ fork — created `dev/…` (off `main`) + a new dev conversation …"* — a fresh branch off the **current**
  `main`, seeded to continue the work.
- [ ] pass

## 5. Merged-branch guardrail  ·  *proves the post-dogfooding fix*
- **Setup:** open a **merged** dev conversation (e.g. the one from Scenario 4's parent).
- **Do:** type `lt` (then try `sync`, `merge`).
- **Expect:** *"✓ lt — this conversation is already **merged** (as `<sha>`) … A squash-merge leaves the old branch
  reading 'behind main' by design … type `fork` …"* — **not** the old misleading *"1 commit behind main — sync"*.
  (`lt!` should still force-load if you insist.)
- [ ] pass

## 6. `scope?` — semantic check (metered)  ·  *proves P3-7*
- **Setup:** a dev conversation with changes; the **panel API key** set (Settings).
- **Do:** type `scope?`.
- **Expect:** *"↻ scope? — asking the model about `<branch>` vs `main`… (one metered call)"* → a verdict: *"focused"*
  or *"⚠ scope? — …"* with `split:` suggestions. (Costs one model call; no key → it says so and points to `scope`.)
- [ ] pass

## 7. The version merge driver — the pain that started this  ·  *proves the merge driver in the real flow*
- **Setup:** start a dev conversation, make a small change (its branch bumps the manifest version). **Separately**,
  make a one-line change **on `main`** and commit it (so `main`'s version bumps too) — recreating last time's setup.
- **Do:** back in the dev conversation, run `merge` (it syncs `main` in first).
- **Expect:** **no manifest version conflict** — the driver auto-resolves the `version` line to the higher number and
  the flow proceeds to the test gate + land. (Last time this stopped on a conflict; now it shouldn't.) *Proven
  headless on a synthetic merge; this is the live confirmation in the panel flow.*
- [ ] pass

---

### Notes / failures
*(record anything that didn't match — symptom + the scenario #. Each becomes the next fix.)*
