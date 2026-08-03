# auto-glf — the tick prompt (v2.74.1981)

The fixed prompt the 5-minute cron fires. **This file is the source of truth**; update the cron job from it.
Changes here are numbered against the audit that produced them (see `logs/run/findings.md`, the 2026-08-03 entries).

---

## STEP 0 — RECORD THE FIRING *(new: audit item 1)*

Run first, before reading anything:

```bash
node tools/glf/tick.cjs
```

It appends one row to `logs/run/loop-ticks.jsonl` and prints two lines. **Quote both in the reply.**

- `LOOP GAP <n>min` — **a first-class verdict, not a preamble.** The loop was not running. That is a different
  fact from QUIET and must never be reported as one. Measured before this existed: 91 firings against 257
  expected (35.4% duty cycle), 943 minutes lost across 16 gaps, the two largest 314 and 450 minutes — and every
  analysis of "wasted idle ticks" used the expected count as its denominator and was wrong by ~3×.
- `BUILD ▸ <sha>+<diffhash>@<manifest>` — the build fingerprint. **This, not the manifest version, identifies the
  build.** Chrome loads the repo root, so uncommitted files are live; and in a shared checkout the version is
  bumped by whichever session edited last. Live evidence: a graded window read `v 2.74.1977` while manifest said
  1978 and the fix under test was in neither, and a later reload landed on a sibling's 1979 while the fix sat
  uncommitted — which blocked a grade outright.

If `BUILD` lists dirty files the open block does not claim, say **CONTENDED** and name them. `git add <file>`
cannot separate two authors inside one file; "stage by name" is not protection when the file is co-edited.

## STEP 1 — READ THE SIGNAL

`git pull` in `apps/orchard-logs` (tail the summary line only). Find the newest UTC hour-file(s) across **all**
install dirs (`logs/<newest date>/*/*/*.txt` — never hardcode one install; a new `pk_`/`ins_` dir must not be
missed). Compare the latest event stamp against the last entry in `logs/run/findings.md`.

Note the archive is a ~48h ring **and rewrites in place**: hour-files are re-exported hourly with only the header
changing, and old files retro-truncate (one sweep deleted 243 lines from a 48-hour-old file; fleet totals shrank
13,169 → 12,047 overnight). So mtime and "which files changed" are useless freshness tests, and **any window you
intend to cite must be copied to `logs/run/` in the same tick or it may not exist at the next one.**

**QUIET** (nothing new, or only SyncEngine/heartbeat/boot/already-explained lines): reply with ONE line —
`glf tick <HH:MM CDT> — no new events since <last stamp>` — and STOP.

## STEP 2 — GRADE AGAINST THE DECLARED CRITERIA, NOT AGAINST MEMORY

Grep for the LAST `VALIDATE[` block. Evaluate its arms **in this order**:

1. `BUILD` does not match this tick's fingerprint → **INCONCLUSIVE**. Name it in one line. *(new: item 2)*
2. `SCOPE`/`REQUIRES` unmet → **INCONCLUSIVE**. Say which precondition failed. An unmet precondition is not evidence.
3. `INCONCLUSIVE` matched → name the confounder, stop. Never let a confounded observation count as FAIL.
4. `MECH` **and** `VALUE` both matched, at the declared `QUANTIFIER` → **PASS** → STEP 3B.
5. `FAIL` matched → STEP 3A.
6. **Nothing matched → report `UNMAPPED` and treat as INCONCLUSIVE.** *(new: item 4)* Do **not** argue a grade in
   prose. This has happened: PASS clauses 1–3 hit, clause 4 missed, both FAIL arms missed, and the tick graded
   ★PASS on prose and pushed. If a real observation maps to no arm, the block is malformed — say so and repair it.

## STEP 3A — RED

Diagnose to root cause **in the source** (name `file:line`). Build, bump `manifest.json`, `node --check` every
touched file, `npm test` to green. **Do not commit or push.**

Append ONE findings entry with `INCIDENT[...]` tags, then run:

```bash
node tools/glf/scrub.cjs logs/run/findings.md --apply
```

**No PII in the journal, ever.** `logs/.gitignore` is the only thing between it and every install: this repo has
no build step, so the repo root *is* the unpacked-extension root and anything in the tree is in the bundle. The
scrubber maps each value to a stable token (`[order:a3f2]`) so counting, joining and same-vs-different reasoning
survive while identity does not. Division and product names are deliberately kept — they carry the reproducer
vocabulary, and an ask stated outside the owning ground's vocabulary tests the wrong path.

End the entry with a block in exactly this shape:

```
VALIDATE[v<version> — <ONE assertion, naming the VALUE the user should get>]:
  BUILD        = <fingerprint from STEP 0, e.g. f920cca+bff537f6@2.74.1981>
  SCOPE        = <the event class that makes an observation admissible> · grep: `<literal>`
  QUANTIFIER   = ONE <event> suffices | ALL <events> in the window must comply
  MECH         = grep: `<literal log line>`  — proves the changed code path RAN
  VALUE        = grep: `<literal>`           — proves the user got the RIGHT THING
  FAIL         = grep: `<literal>`           — it ran and produced the WRONG value
  INCONCLUSIVE = <observations that look like FAIL but are not evidence>
  EXERCISE     = <asks the loop can send itself> | HUMAN: <what only a person can do>
```

`MECH` alone is not a grade. *(item 4)* 20 of 25 historical blocks asserted mechanism only; the focus-pin arc ran
five builds, four ★PASS grades and three pushes while **the user-visible outcome never worked once**. The single
block in the corpus that named a value caught a defect on its first firing, against a run whose markers were all
verbatim-correct and whose own tally read `5 matched, 0 no-match, 0 failed`. **A success tally is not a
correctness signal.**

`QUANTIFIER` is not optional. *(item 4)* Without it the same block graded ★PASS at 20:14Z and FAIL at 20:19Z on
the same build, five minutes apart, both readings faithful to its text.

If you cannot state a `FAIL` distinguishable from `INCONCLUSIVE`, say so plainly — the fix is not yet testable and
needs an observability change first.

## STEP 3B — GREEN

Push only if **all** hold:

- (a) the `MECH` and `VALUE` markers are NEW in this window, not a re-read;
- (b) the tick's `BUILD` fingerprint matches the block's `BUILD` *(replaces the old version-equality check, which
  is unsatisfiable in a shared checkout)*;
- (c) `npm test` green and `node --check` clean on every touched file;
- (d) STEP 0 reported no CONTENDED file that this block does not claim.

Then review the diff, re-check the manifest against `origin/main` and bump to current+1 if the parallel lane
moved, stage touched files **BY NAME** — never `git add -A` — commit, push, report the hash. Mark the block's
`INCIDENT` closed.

---

## Still owed (audit items not yet built)

- **Item 1, second half** — the schedule lives inside one interactive session (`.claude/scheduled_tasks.lock`),
  so it dies with the laptop. That is the cause of the two largest gaps, both of which sit exactly on the human's
  absence. Move it to an OS-level task running headless `claude -p`:

  ```powershell
  schtasks /create /tn "orchard-auto-glf" /sc minute /mo 5 /ru "$env:USERNAME" /tr "cmd /c cd /d C:\Users\Divine\Documents\2026_projects\apps\chrome-sidepanel-tester && claude -p @tools\glf\CRON_PROMPT.md >> logs\run\cron.out 2>&1"
  ```

  Not run automatically — it changes machine configuration and is the user's call.
- **Item 5** — `EXERCISE` is in the template but nothing consumes it yet. `tools/exercise/exercise.cjs` exists,
  drove 4 of 4 historical drains to a graded PASS, and is documented in no file the loop reads.
- **Item 3′** — the journal still has one copy and no history. It must NOT be committed here (bundle exposure);
  move it to a sibling repo outside the extension root, the pattern `apps/orchard-logs` already uses.
