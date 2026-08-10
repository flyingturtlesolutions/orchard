# auto-glf â€” the tick prompt (v2.74.2024)

The fixed prompt the 5-minute cron fires. **This file is the source of truth**; update the cron job from it.
Human paste shortcuts to *start* a session live in [`SHORTCUTS.md`](SHORTCUTS.md): `run glf grader` / `run glf builder`.
Changes here are numbered against the audit that produced them (see `../orchard-journal/findings.md`, the 2026-08-03 entries).
v2.74.2014 adds the **test bus** (`../orchard-logs/tests/` + `results/`, via `tools/glf/testbus.cjs`): open
assertions now live as test files any builder session can write, and this loop â€” the **grader** â€” answers them
through append-only result files. Roles are claimed, not assigned: builder is whoever changed the code (stamped
by lane tag), grader is whoever holds the lease below. v2.74.2017 adds the **builder half**: when the lease is
REFUSED, the same tick becomes builder mode (inbox â†’ act oldest unacked â†’ ack) â€” one loop, two modes, no second cron.
v2.74.2024 closes the grader half-hit hole: MECH without VALUE while `[human]` ACTION remains is
**INCONCLUSIVE (waiting-human)**, never UNMAPPED and never a prose PASS.

---

## STEP 0 â€” RECORD THE FIRING *(new: audit item 1)*

Run first, before reading anything:

```bash
node tools/glf/tick.cjs
```

It appends one row to `logs/run/loop-ticks.jsonl` and prints two lines. **Quote both in the reply.** *(v2.74.2044:
it may print two more — `BUS UNDELIVERED ▸` (a previous tick's tests/results sit uncommitted in orchard-logs; the
push IS the delivery, so finish it this tick) and `FP DEGRADED ▸` (git was unreachable — the fingerprint is NOT a
build identity; do not grade against it). Quote those too when present.)*

- `LOOP GAP <n>min` â€” **a first-class verdict, not a preamble.** The loop was not running. That is a different
  fact from QUIET and must never be reported as one. Measured before this existed: 91 firings against 257
  expected (35.4% duty cycle), 943 minutes lost across 16 gaps, the two largest 314 and 450 minutes â€” and every
  analysis of "wasted idle ticks" used the expected count as its denominator and was wrong by ~3Ã—.
- `BUILD â–¸ <sha>+<diffhash>@<manifest>` â€” the build fingerprint. **This, not the manifest version, identifies the
  build.** Chrome loads the repo root, so uncommitted files are live; and in a shared checkout the version is
  bumped by whichever session edited last. Live evidence: a graded window read `v 2.74.1977` while manifest said
  1978 and the fix under test was in neither, and a later reload landed on a sibling's 1979 while the fix sat
  uncommitted â€” which blocked a grade outright.

If `BUILD` lists dirty files the open block does not claim, say **CONTENDED** and name them. `git add <file>`
cannot separate two authors inside one file; "stage by name" is not protection when the file is co-edited.

**Then claim the grader lease** *(v2.74.2014 â€” exactly one grader at a time)*:

```bash
node tools/glf/testbus.cjs lease claim <lane>
```

Mint `<lane>` ONCE per session (`node tools/glf/testbus.cjs lane`) and reuse it on every tick â€” the claim is
also the renewal. `LEASE â–¸ REFUSED` means another session is actively grading â€” **do not grade and do not write
results/** (duplicate graders produce duplicate result files). Instead continue at **STEP 0b** below. A lease
whose holder died expires on its own (TTL = 3 missed ticks), so a takeover needs no human.

## STEP 0b â€” BUILDER MODE (lease refused) *(v2.74.2017)*

You are not the grader. Do not grade. Do not write `results/`.

1. `git pull` in `../orchard-logs` (if you short-circuited before STEP 1, pull now).
2. `node tools/glf/testbus.cjs inbox --owner <lane>`
3. If empty â†’ one line `glf tick â€” builder; inbox empty` and **STOP**.
4. Otherwise take the **OLDEST** unacked result. Read its evidence (`results/<file>`). Act by verdict:

   | verdict | act |
   |---|---|
   | PASS | `testbus.cjs retire <id> PASS "<note>"` â†’ `ack <file> --owner <lane> --disposition retired` â†’ commit+push `tests/` |
   | FAIL | diagnose in source (same discipline as grader STEP 3A) â†’ fix + bump â†’ write/rearm test â†’ `ack â€¦ --disposition fixed` â†’ push `tests/` |
   | UNMAPPED | repair the test's PREDICT arms (owner rewrite) so the observation has a home â†’ `ack â€¦ --disposition arm-repaired` â†’ push `tests/` |
   | INCONCLUSIVE | if unmet `[human]` steps: `ack â€¦ --disposition waiting-human` and STOP (surface the ACTION checklist in the reply â€” that is the human nudge). If arms are wrong: same as UNMAPPED. |
   | ORPHANED | adopt (rewrite `owner:` to this lane) or `retire SUPERSEDED`; never silent â†’ `ack â€¦ --disposition adopted\|retired` â†’ push `tests/` |

5. **One result per tick.** Do not drain the inbox â€” same "oldest first" discipline as grading LIVE tests.
   Push is the delivery for any `tests/` change. Acks live in `logs/run/builder-ack.jsonl` (local, git-ignored)
   â€” never rewrite `results/`, never touch a test's mtime just to ack (orphan detection uses mtime).
6. **OWNER SWEEP** *(v2.74.2022 â€” the missing half of rearm)*: after the inbox act (or when it is empty), run
   `node tools/glf/testbus.cjs grade-pending` and look at YOUR OWN open tests only. `LIVE`/`LIVE*` need nothing.
   For each **STALE** test this lane owns â€” which now means *a file the test claims actually changed*
   (fingerprints are files-scoped since v2022) â€” review the diff to its claimed files, then `rearm <id>
   "<why the claim still holds>"` or `retire <id> SUPERSEDED "<what replaced it>"`. Never leave an owned STALE
   test unswept two ticks running: rearm was previously tied only to STEP 3B's "code just landed," so a test
   staled by a NEIGHBOR's edit had no owner step anywhere in the loop and rotted ungraded with its evidence
   already in the window (live: v2.74.2015-map-prior-binds-source, 2026-08-05). Push any `tests/` rewrite.

When the lease **is** claimed, skip this step and continue at STEP 1 as the grader. Self-graded results are
auto-acked as `seen` at write time so this inbox does not re-diagnose them next tick.

## STEP 1 â€” READ THE SIGNAL

`git pull` in `apps/orchard-logs` (tail the summary line only). Find the newest UTC hour-file(s) across **all**
install dirs (`logs/<newest date>/*/*/*.txt` â€” never hardcode one install; a new `pk_`/`ins_` dir must not be
missed). Compare the latest event stamp against the last entry in `../orchard-journal/findings.md`.

Note the archive is a ~48h ring **and rewrites in place**: hour-files are re-exported hourly with only the header
changing, and old files retro-truncate (one sweep deleted 243 lines from a 48-hour-old file; fleet totals shrank
13,169 â†’ 12,047 overnight). So mtime and "which files changed" are useless freshness tests, and **any window you
intend to cite must be copied to `logs/run/` in the same tick or it may not exist at the next one.**

**QUIET** (nothing new, or only SyncEngine/heartbeat/boot/already-explained lines): run
`node tools/glf/report.cjs census` and quote any waiting-human rows it prints *(v2.74.2044 — the census turns dead
air into the human's to-do list: 8 of the first 18 INCONCLUSIVE grades were waiting on a `[human]` ACTION step that
nothing ever surfaced)*, then reply with ONE line â€”
`glf tick <HH:MM CDT> â€” no new events since <last stamp>` â€” and STOP.

## STEP 2 â€” GRADE AGAINST THE DECLARED CRITERIA, NOT AGAINST MEMORY

Run `node tools/glf/testbus.cjs grade-pending`. *(v2.74.2014 â€” the open assertions live on the bus now; the
STEP 1 `git pull` in orchard-logs already fetched any new test a builder pushed.)* It prints every OPEN test
with its BUILD state:

- **LIVE** â€” the test's fingerprint matches this tick's. Gradeable. **Grade the OLDEST LIVE/LIVE\* test**, and
  say in one line why each other open test is not gradeable this tick.
- **LIVE\*** *(v2.74.2022)* â€” the shared tree moved but every file the test CLAIMS (`files:`) is byte-identical
  to its stamp (`files-fp:`). Gradeable exactly like LIVE â€” the build under the claim did not change, only a
  neighbor's files did; the result records `files-match` for audit. (Before this, a two-lane checkout staled
  every open test on every save by either lane, and a test could sit ungraded with its evidence in the window.)
- **STALE** â€” a file the test claims actually changed (or a pre-v2022 test's whole-tree fingerprint moved).
  Not evidence of anything; it waits for its OWNER to `rearm` (STEP 0b's owner sweep is where that happens).
  Never grade a stale test against memory of what the build "should" contain.
- **ORPHAN** â€” stale AND untouched past the orphan window: the owner is presumed gone. Write an `ORPHANED`
  result so the builder (or the human) sees it needs adoption. **Never silently adopt** â€” adoption is a visible
  `owner:` rewrite in orchard-logs history, and it is the human's or the owner's act, not the grader's.

Each verdict goes to the bus as an append-only result â€” evidence quoted from the window, via a temp file
(PowerShell quoting eats inline heredocs):

```bash
node tools/glf/testbus.cjs result <id> <PASS|FAIL|INCONCLUSIVE|UNMAPPED|ORPHANED> --grader <lane> --evidence-file <tmp> [--note "â€¦"]
```

When the test's owner equals `<lane>`, the tool auto-acks the result as `seen` (v2.74.2017) so a dual-role
session does not re-act on it next tick. Foreign owners discover it via STEP 0b's `inbox`.

Then, in `../orchard-logs`: `git add tests results` â†’ **commit FIRST, then `pull --rebase`, then push**. The
hourly exporter pushes underneath almost every tick, and a `pull --rebase` on a dirty tree refuses â€” pulling
before committing failed the delivery two ticks in a row before this sentence existed. **The push IS the
delivery** â€” a result that only exists locally was never delivered. Builders read the channel with
`testbus.cjs inbox --owner <lane>` (or `results <id>` / `mine --owner <lane>`), possibly from a different
machine-day than this one.

Retirement stays the OWNER's act (`testbus.cjs retire <id> <PASS|FAIL|SUPERSEDED|WONTFIX> <note>`) â€” the grader
reports verdicts; it does not close questions it does not own. *(Legacy: `node tools/glf/blocks.cjs list` still
reads the pre-bus VALIDATE ledger in findings.md; anything still open there was migrated to the bus at
v2.74.2014, so it should print none open. If it ever shows an open block, migrate it rather than grading it in
place.)*

Evaluate the chosen test's arms **in this order**:

1. The test is not LIVE/LIVE\* in grade-pending (tree fingerprint moved AND a claimed file changed) â†’
   **INCONCLUSIVE**. Name it in one line. *(new: item 2; files-scoped since v2.74.2022)*
2. `SCOPE`/`REQUIRES` unmet â†’ **INCONCLUSIVE**. Say which precondition failed. An unmet precondition is not evidence.
3. `INCONCLUSIVE` matched â†’ name the confounder, stop. Never let a confounded observation count as FAIL.
4. `MECH` **and** `VALUE` both matched, at the declared `QUANTIFIER` â†’ **PASS** â†’ STEP 3B.
5. `FAIL` matched â†’ STEP 3A.
6. **Half-hit — `MECH` matched, `VALUE` did not, `FAIL` did not, and at least one `[human]` ACTION step
   remains unmet** â†’ **INCONCLUSIVE** (waiting-human). Name which VALUE grep is still absent and surface the
   remaining ACTION checklist. This is *not* UNMAPPED: the observation has a home (progress toward PASS), and
   it is *not* a prose PASS (`MECH` alone is never a grade — see below). Write a result **once per distinct
   evidence state** (e.g. "no seed yet" â†’ "seeded, park before run" is a new state; quiet ticks with the same
   absences do not re-emit). *(v2.74.2024 — live hole on v2.74.2023-warranty-preset-seeds-wizard: seed line
   landed, wizard parked, no PRIOR/WRITE yet; letter-of-steps-1â€“5 would have forced UNMAPPED.)*
7. **Nothing matched â†’ report `UNMAPPED` and treat as INCONCLUSIVE.** *(new: item 4)* Do **not** argue a grade in
   prose. This has happened: PASS clauses 1â€“3 hit, clause 4 missed, both FAIL arms missed, and the tick graded
   â˜…PASS on prose and pushed. If a real observation maps to no arm, the block is malformed â€” say so and repair it.
   Reserve UNMAPPED for observations that fit **no** arm *and* are not a half-hit under step 6.

## STEP 3A â€” RED

Diagnose to root cause **in the source** (name `file:line`). Build, bump `manifest.json`, `node --check` every
touched file, `npm test` to green. **Do not commit or push.**

Append ONE findings entry with `INCIDENT[...]` tags, then run:

```bash
node tools/glf/scrub.cjs ../orchard-journal/findings.md --apply
```

**No PII in the journal, ever.** `logs/.gitignore` is the only thing between it and every install: this repo has
no build step, so the repo root *is* the unpacked-extension root and anything in the tree is in the bundle. The
scrubber maps each value to a stable token (`[order:a3f2]`) so counting, joining and same-vs-different reasoning
survive while identity does not. Division and product names are deliberately kept â€” they carry the reproducer
vocabulary, and an ask stated outside the owning ground's vocabulary tests the wrong path.

Then write the prediction to the BUS, not into findings.md *(v2.74.2014 â€” findings keeps the narrative; the bus
keeps the live question)*. Put the body in a temp file and run:

```bash
node tools/glf/testbus.cjs write --id v<version>-<slug> --owner <lane> --claim "<ONE assertion, naming the VALUE the user should get>" --files "<files the change touched>" --body-file <tmp>
```

The body is an ACTION checklist plus the arm schema, every arm a greppable literal:

```
ACTION:
  - [auto]  <asks the loop can send itself, e.g. via tools/exercise>
  - [human] <what only a person can do â€” reload, send an ask in the panel, re-run a map>

PREDICT:
  SCOPE        = <the event class that makes an observation admissible> Â· grep: `<literal>`
  QUANTIFIER   = ONE <event> suffices | ALL <events> in the window must comply
  MECH         = grep: `<literal log line>`  â€” proves the changed code path RAN
  VALUE        = grep: `<literal>`           â€” proves the user got the RIGHT THING
  FAIL         = grep: `<literal>`           â€” it ran and produced the WRONG value
  INCONCLUSIVE = <observations that look like FAIL but are not evidence>
```

(The tool stamps `build:` with the STEP 0 fingerprint and scrubs on write.) End the findings entry with a
pointer line â€” `TEST[v<version>-<slug>] â†’ orchard-logs/tests/` â€” so the journal and the bus stay joined. Then
commit+push the test in `../orchard-logs`, or a grader on another day cannot see the question.

`MECH` alone is not a grade. *(item 4)* 20 of 25 historical blocks asserted mechanism only; the focus-pin arc ran
five builds, four â˜…PASS grades and three pushes while **the user-visible outcome never worked once**. The single
block in the corpus that named a value caught a defect on its first firing, against a run whose markers were all
verbatim-correct and whose own tally read `5 matched, 0 no-match, 0 failed`. **A success tally is not a
correctness signal.**

`QUANTIFIER` is not optional. *(item 4)* Without it the same block graded â˜…PASS at 20:14Z and FAIL at 20:19Z on
the same build, five minutes apart, both readings faithful to its text.

If you cannot state a `FAIL` distinguishable from `INCONCLUSIVE`, say so plainly â€” the fix is not yet testable and
needs an observability change first.

## STEP 3B â€” GREEN

Push only if **all** hold:

- (a) the `MECH` and `VALUE` markers are NEW in this window, not a re-read;
- (b) the test is LIVE or LIVE\* this tick *(replaces the old version-equality check, which is unsatisfiable in
  a shared checkout; files-scoped since v2.74.2022)*;
- (c) `npm test` green and `node --check` clean on every touched file;
- (d) STEP 0 reported no CONTENDED file that this block does not claim.

Then review the diff, re-check the manifest against `origin/main` and bump to current+1 if the parallel lane
moved, stage touched files **BY NAME** â€” never `git add -A` â€” commit, push, report the hash. Mark the block's
`INCIDENT` closed.

**Then re-arm every OPEN test whose code just landed:** `node tools/glf/testbus.cjs rearm <id> "landed in <sha>"`
â€” but ONLY for tests this lane OWNS; a stale test someone else owns waits for its owner (or the orphan rule).
A test records its BUILD while the fix is still uncommitted; the moment it lands, HEAD and the diff both move and
the recorded fingerprint can never match again, so the test reads STALE forever. Retiring was an explicit act
and re-arming was not â€” that froze two landed-but-unverified blocks the same way stack-not-a-set froze three.
Push the rearms with the commit's orchard-logs sync.

---

## Still owed (audit items not yet built)

- **Item 1, second half â€” BUILT (v2.74.2044, glf F5, user-authorized 2026-08-06): the `orchard-auto-glf` OS task.**
  `schtasks` fires `tools/glf/headless-tick.cmd` every 5 minutes; the cmd (config-in-repo â€” edit IT, never the
  task) runs headless `claude -p` against `tools/glf/HEADLESS_PROMPT.md`, the **grade-only** variant: fixed lane
  `lane-cron` (claim-is-renewal needs a stable identity; never reuse it interactively), a scoped `--allowedTools`
  list whose only git-mutation prefix is `git -C ../orchard-logs` (the extension repo is structurally
  un-committable from that session), writes confined to `logs/run/`, STEP 3A ends at the delivered FAIL result
  (the owner fixes interactively), STEP 3B never applies. Output appends to `logs/run/cron.out` (rotated at 5MB).
  Interactive sessions keep working exactly as before: they out-claim nothing â€” the headless grader holds the
  lease when no one else does, and lands in a one-line refused tick when an interactive grader is live. The
  full-rights variant (headless landing code on `main`) stays NOT built â€” that grant is the user's call; the
  parked decisions (full-rights Â· multi-machine lease/acks) and the owed sleep/wake recovery check are documented
  with their re-open triggers in `docs/RESEARCH_auto_glf.md` Â§9.
- **Item 5** â€” `EXERCISE` is in the template but nothing consumes it yet. `tools/exercise/exercise.cjs` exists,
  drove 4 of 4 historical drains to a graded PASS, and is documented in no file the loop reads.
- **Item 3â€²** â€” the journal still has one copy and no history. It must NOT be committed here (bundle exposure);
  move it to a sibling repo outside the extension root, the pattern `apps/orchard-logs` already uses.
