# RESEARCH — Auto-glf: model, implementation, live state, and the fix proposal

**Status:** research report, 2026-08-06 (~13:00Z read); **§8 F1–F5 BUILT same day (v2.74.2044, commit dd9146d)** —
the grade-only scheduler variant, per the user's authorization. As-built deviations + the adversarial-verify
critical catch are stamped at §8's head; the two decisions deliberately left parked and the one verification still
owed live in **§9**. Five-reader deep-read (protocol · testbus impl · instrumentation · live bus state · history),
synthesized. Sources: `tools/glf/*` (CRON_PROMPT.md v2.74.2024, testbus.cjs, tick.cjs, blocks.cjs, scrub.cjs), the
`apps/orchard-logs` bus repo, `logs/run/findings.md` 2026-08-02→06 entries, `docs/DESIGN_cloud_logs.md` (the CW-8
substrate).

---

## 1. What auto-glf is

A **pre-registered prediction market over live fleet traffic**. A **builder** (whoever changed the code) writes a
*test* — a falsifiable claim with greppable arms, registered *before* the evidence exists. A **grader** (whoever
holds the lease) pulls the fleet logs every 5 minutes and answers those tests with append-only *results*. Integrity
comes from **arms-before-evidence, not grader independence** — self-grading is allowed and stamped
`self-graded: true`; the lease prevents duplicate result-writes, not bias.

One loop, two modes, no second cron (v2.74.2017): every tick runs `tick.cjs` → claims the lease → **won = grader**,
**REFUSED = builder mode**.

**Topology.** `tools/glf/` = the toolchain (`CRON_PROMPT.md` 251-line protocol — the cron's source-of-truth FILE;
`testbus.cjs` 524-line bus CLI; `tick.cjs` liveness+identity; `blocks.cjs` legacy VALIDATE ledger; `scrub.cjs` PII).
`apps/orchard-logs` = the bus (`tests/` open questions · `results/` answers · `logs/` the ~48h fleet ring ·
`state/watermark.json`). The "cron" is a **session-scoped 5-min job**, armed by paste shortcuts `run glf grader` /
`run glf builder` (SHORTCUTS.md), pointed at the file, never a copy of its text.

## 2. The grader half (STEPs 0→3B)

1. **STEP 0 — `tick.cjs` first.** Appends `{ts, build, head, manifest, dirty, gapMin}` to
   `logs/run/loop-ticks.jsonl`; prints two must-quote lines: **`LOOP GAP <n>min`** (>15 = a first-class verdict,
   never conflated with QUIET) and **`BUILD ▸ <sha7>+<diffhash>@<manifest>`** — the fingerprint, not the manifest
   version, is build identity (shared checkout + Chrome-loads-the-repo-root broke version-as-join-key). Dirty files
   the test doesn't claim → **CONTENDED** (the set-subtraction is the agent's, `contended()` is runtime-dead).
2. **STEP 1 — read the signal.** Pull orchard-logs; scan ALL install dirs' newest hour-files. The ring **rewrites in
   place and retro-truncates** — any cited window is copied to `logs/run/` the same tick. Nothing new → QUIET, stop.
3. **STEP 2 — `grade-pending`.** Open tests classify against the fingerprint: **LIVE** (tree identical) · **LIVE\***
   (tree moved, every *claimed* file byte-identical — v2022 files-scoping; result records `files-match`) · **STALE**
   (a claimed file changed; waits for its owner's rearm, never graded from memory) · **ORPHAN** (stale + untouched
   >24h → ORPHANED result; **never silent adoption**). Grade **the oldest LIVE/LIVE\***, one per tick, one-line
   reason for every other open test.
4. **Arm evaluation, strict 7-step order** over `PREDICT` arms (`SCOPE`/`QUANTIFIER`/`MECH`/`VALUE`/`FAIL`/
   `INCONCLUSIVE`, each a greppable literal): not-live → INCONCLUSIVE · unmet precondition → INCONCLUSIVE ("an unmet
   precondition is not evidence") · confounder arm → INCONCLUSIVE · MECH+VALUE at the QUANTIFIER → PASS · FAIL arm →
   STEP 3A · **half-hit (v2024): MECH-without-VALUE with an unmet `[human]` ACTION → INCONCLUSIVE (waiting-human)**,
   once per distinct evidence state · nothing matched → UNMAPPED = "the block is malformed, repair it" — never a
   prose grade.
5. **Delivery = push** (commit FIRST, then `pull --rebase`, then push — the per-minute exporter commits underneath).
   "A result that only exists locally was never delivered."
6. **STEP 3A (red):** diagnose in source → fix + bump → findings entry (+`scrub.cjs --apply`; no PII in the journal,
   ever) → prediction to the BUS via `testbus.cjs write` (findings keeps narrative, the bus keeps the live question)
   → push the test. **STEP 3B (green):** push only if MECH+VALUE are NEW in-window, the test is LIVE/LIVE\*, gates
   green, no unclaimed CONTENDED file; stage BY NAME; **rearm every OWNED open test whose code just landed**.

Doctrines the design crystallized around: **"MECH alone is not a grade"** (20/25 historical blocks were
mechanism-only; the focus-pin arc took four ★PASS while the user-visible outcome never worked once) and
**"QUANTIFIER is not optional"** (one block graded PASS and FAIL five minutes apart, both faithful to its text).

## 3. The builder half (STEP 0b, lease refused)

"You are not the grader. Do not grade. Do not write results/." Pull → `inbox --owner <lane>` (unacked results for
MY open tests, oldest first) → act **one** per tick by verdict: PASS→`retire` · **FAIL→diagnose-in-source,
fix+bump, rearm** · UNMAPPED→repair arms · INCONCLUSIVE→`waiting-human` (surface the ACTION checklist — that IS the
human nudge) · ORPHANED→adopt-or-retire, never silent → `ack` (local `builder-ack.jsonl`) → push `tests/` changes.
Then the **OWNER SWEEP** (v2022, item 6 — there is no STEP 0c): rearm-or-retire every owned STALE test; never leave
one unswept two ticks running.

Ownership boundaries: only the **owner** rearms/retires (the grader reports verdicts, never closes questions);
adoption is a visible `owner:` rewrite in git history; self-graded results auto-ack `seen`.

## 4. Implementation facts worth keeping

- **Two fingerprints:** tree (`sha7+sha256(git diff)[0:8]|clean@manifest` — ONE definition, tick.cjs:38, reused by
  blocks + testbus) and `files-fp` (8-hex sha256 over sorted (path, content|`<MISSING>`) pairs; missing ≠ empty).
- **Result files** `results/<id>--<YYYYMMDDTHHMMZ>--<VERDICT>.md`, append-only — "two attempts that disagree are
  DATA." Meta: both fingerprints, `files-match`, `self-graded`, grader lane, note.
- **Every bus write is scrubbed** (`scrubbedWrite`: scrub → `residual()` → **refuse write, exit 3** on leftover
  PII). Scrub model: stable tokens `[kind:4hex]` preserve count/join/distinctness, destroy identity; explicit names
  roster; divisions/products kept (reproducer vocabulary); NEVER-list protects synthetic sentinels (a scrubbed
  marker is an unmatchable one).
- **Closed vocabularies:** results `PASS|FAIL|INCONCLUSIVE|UNMAPPED|ORPHANED` · retire `PASS|FAIL|SUPERSEDED|
  WONTFIX` · ack `waiting-human|arm-repaired|rearmed|fixed|retired|adopted|seen` (+ NEXT_BY_VERDICT suggestions).
- **Lease:** `logs/run/grader.lease` — LOCAL to the extension repo, git-ignored ("all sessions share this checkout
  today"), JSON `{lane, ts}`, TTL 15 min = 3 missed ticks, torn/absent = free, claim-is-renewal, expired = takeover
  without a human. `ORPHAN_H = 24`.
- **Exit codes:** 0 ok · 1 lease refusal/not-yours · 2 usage/missing-bus/bad-id/exists · 3 residual-PII or
  test-not-found.
- Test coverage: `tick.test.cjs` + `testbus.test.cjs` are **standalone** (npm harness excludes `tools/`), and cover
  the pure exports only — the impure CLI seams (where the live bugs happened) are characterized, not executed.

## 5. Live state (2026-08-06 ~13:00Z)

- Lease **live** (a grader lane renewing per tick). Bus age: **~30 hours** (scaffolded 08-05, v2.74.2014, 6 tests
  migrated from the findings VALIDATE ledger).
- **22 tests** — 14 open / 8 retired, two lanes. **28 results: 8 PASS · 18 INCONCLUSIVE (8 waiting-human) ·
  2 UNMAPPED · 0 FAIL · 0 ORPHANED.** 9 open tests never graded (tracked in grade bodies as a queue note, not
  ignored). Retirement is genuinely an owner act (one test stayed open after a PASS; one retired by supersession
  without ever passing).
- Best artifact: the 2011 UNMAPPED grade — routing proven, receipt died on an API-side wall no arm covered → graded
  UNMAPPED honestly, repaired the arms, filed a real code fix (v2.74.2016), spawned its test, one push. The core
  loop works.
- Repeated-INCONCLUSIVE has two species: pure human-wait (demo starvation — restamps) vs productive iteration (each
  grade names a NEW cause; spawned the 2038 diagnosis triplet). Only the first is rot.
- Fleet = **one install** — "live fleet traffic" is one user's browser; every `[human]` gate is gated on that one
  person; PASS evidence is n=1 by construction.

## 6. Evolution ledger (failure → ruling)

| When | Shipped | Driving failure |
|---|---|---|
| 08-02 | First tick; arm discipline; EX-1 exerciser (v1946) | 4/5 ticks INCONCLUSIVE on preconditions — "automating the observer does not automate the experiment" |
| 08-03 am | tick.cjs + fingerprint + scrub.cjs + VALUE/QUANTIFIER/UNMAPPED | **35.4% duty cycle** (91/257, 943 min lost/16 gaps, max 314+450); manifest version failed as join key; journal held 37 emails/28 tracking numbers; a prose ★PASS pushed once |
| 08-03 pm | blocks.cjs SET-not-stack; REARM; exit-hook tally | 3 fixes shipped structurally unobservable; landing froze its own block; the self-test under-reported itself |
| 08-04 | CLAUDE.md re-arm bullet | Five gaps (42/62/17/20/54 min) |
| 08-05 | The BUS (2014) → builder half (2017) → files-scoped LIVE\* + owner sweep (2022) → half-hit rule (2024) | Ledger bound role to session; REFUSED sessions never read deliveries; every neighbor edit staled every test; mid-flight progress had no written home |
| 08-06 | Comma-split files-fp fix (2043) | Admissibility gate **failed open** 4 days — 5/14 open tests wrongly LIVE\*; verdicts look legitimate; no retro-flag |

Note: testbus ran live from v2014 but only landed in git at v2035 — the working tree is live for tools too.

## 7. Gaps (synthesized, ranked)

1. **Scheduler is a discipline, not a mechanism.** `LOOP GAP 503min` fired 08-06. The `schtasks` headless
   `claude -p @tools/glf/CRON_PROMPT.md` job is written out and deliberately unbuilt — it needs an unattended agent
   with commit/push rights on main (the user's call). TTL expiry and "two ticks running" deadlines are measured in
   ticks that often don't fire.
2. **Three pieces of state don't travel:** the lease, `builder-ack.jsonl`, and (at read time) **10 rearmed test
   files uncommitted in the bus tree** — violating "the push is the delivery." All safe only while every lane shares
   one checkout; a second machine silently breaks single-grader, ack-dedup, and fingerprint truth at once.
3. **The bad-news path is unexercised:** 0 FAIL in 28 grades; the FAIL→builder-fix cycle is asserted, not proven.
4. **Human-wait has no escalation:** 8/18 INCONCLUSIVE wait on `[human]` steps on a fleet of one; restamps are
   indistinguishable from genuine re-grades and inflate counts.
5. **Fails-open admissibility is the recurring class:** the comma-split freeze; same-minute same-verdict result
   filenames silently overwrite (append-only violated at the edge); `currentFilesFp` from a wrong cwd reads all
   `<MISSING>`; git failure fingerprints as `?+clean` with no warning; the lease claim is read-then-write with no
   atomicity; owner-only rearm/retire and lease-gating of `result` are convention, not code.
6. **Nothing aggregates:** duty cycle is computed by no tool (lives in a comment); `results/` has no scoreboard
   (pass rates, time-to-grade, INCONCLUSIVE churn); queue state lives in the latest grade's prose footnote.
7. Smaller: the scrub names-roster is reactive AND itself a PII carrier in-tree; rearms touch mtime and quietly
   interfere with the mtime-based orphan clock; `tools/` has no npm-gate coverage; the loop's prompt once cached a
   wrong "KNOWN BLOCKER — do not re-diagnose" for hours; result `graded` ordering is ISO-string comparison.

**Verdict:** the model is sound — pre-registered falsifiable arms, append-only disagreement-preserving results,
claimed-not-assigned roles, every rule traceable to a named live failure. The implementation is ~30h old and shows
it in exactly two places: **liveness** (a decision, not a bug) and **single-checkout state** (a porting job, not a
redesign).

---

## 8. Fix proposal — IMPLEMENTED v2.74.2044 (dd9146d), same day

Ordered by leverage-per-risk. F1–F4 are small, independent, and need no protocol change. F5 is the decision item.

**As-built stamp (2026-08-06).** All five landed; F5 as the recommended grade-only variant (b), user-authorized.
Deviations from the text below: F1 also gained the `BUS UNDELIVERED ▸` sentinel in tick.cjs (checked at tick time,
so anything dirty is by definition a *previous* tick's undelivered work — no mtime logic needed); the allowlist's
file rule is `Edit(logs/run/**)` (a `Write(…)` rule is not matched by file permission checks — the first live
firing caught this); and the **critical adversarial-verify catch**: the user-level `permissions.defaultMode:
bypassPermissions` made the entire `--allowedTools` list INERT (empirically proven — a non-allowlisted command
executed), so `headless-tick.cmd` pins `--permission-mode default` (the dev-bridge pattern) + `--add-dir` for the
bus repo (an allowlist never widens the directory boundary). Verified live across three firings; the first
ENFORCED one ran clean end-to-end (tick quoted · lease claimed as `lane-cron` · honest QUIET · census quoted and
deduplicated into an ordered human to-do list · zero denials). LESSON banked: *an allowlist is only a mechanism
under an enforcing mode* — an unattended invocation must pin its own permission mode, never inherit the
interactive default.

- **F1 — Deliver the stranded rearms (bus hygiene, ~zero code).** Commit+push the 10 modified `tests/` files in
  orchard-logs (a `tests: deliver stranded rearms` bus commit). They are another lane's rearm — flag it in the
  commit message rather than silently absorbing. Optionally add a one-line warning to `tick.cjs`: if the bus tree
  has uncommitted `tests/|results/` older than one tick, print `BUS UNDELIVERED ▸ <n> file(s)` (makes rule-breaking
  visible instead of policed by memory).
- **F2 — Close the append-only edge (testbus.cjs, ~5 lines).** `resultFileName` collides for same-test/same-verdict/
  same-minute; `scrubbedWrite` then overwrites. Fix: if the target exists, suffix `-2`, `-3`, … Never overwrite a
  result, ever.
- **F3 — Atomic lease + anchored paths (testbus.cjs + tick.cjs, ~15 lines).**
  (a) Lease claim via `fs.writeFileSync(tmp)` + `fs.renameSync` after an `O_EXCL`-style existence re-check — closes
  the read-then-write dual-grader race. (b) Resolve `LOG`, `LEASE_FILE`, and `currentFilesFp` paths from the repo
  root (walk up from `__dirname`), not `process.cwd()` — kills the parallel-ledger and all-`<MISSING>` failure
  modes. (c) Fingerprint on git failure prints a visible `FP DEGRADED ▸` instead of silently `?+clean`.
- **F4 — `tools/glf/report.cjs` — the aggregator (new, ~150 lines, pure+CLI).** One command the loop (and the human)
  can run: duty cycle from `loop-ticks.jsonl` (fired vs expected, gap census — makes the headline metric computed,
  not commented); a `results/` scoreboard (per-test verdict chain, time-to-first-grade, INCONCLUSIVE churn,
  waiting-human census = the human's to-do list); and the undelivered-bus check from F1. Add one CRON_PROMPT line so
  a QUIET tick prints the waiting-human census — that is the missing **escalation** for gap 4, done without new
  machinery.
- **F5 — the durable scheduler (DECISION, then ~10 minutes).** The `schtasks /sc minute /mo 5` headless
  `claude -p @tools/glf/CRON_PROMPT.md` job from CRON_PROMPT "Still owed" item 1. Everything is staged for it (the
  schtasks grader would simply hold the lease permanently; interactive sessions land in builder mode). Blocked
  solely on: **an unattended agent holding commit/push rights on main.** Options: (a) grant it — full autonomy,
  the 35.4%→~100% duty-cycle fix; (b) grant a **read+grade-only** variant — the scheduled job pushes only to
  orchard-logs (results), never to the extension repo, so FAIL fixes still wait for an interactive session: ~90% of
  the value, no unattended rights on main; (c) stay session-scoped and accept the duty cycle. **Recommendation: (b)**
  — grading is the time-critical half (evidence expires with the 48h ring); building isn't.
- **Deferred (named, not proposed now):** multi-machine lease/acks (move both to the bus repo with host-scoped
  files) — not needed until a second machine actually joins; a retro-flag mechanism for verdicts graded during a
  known-bad admissibility window; moving the scrub names-roster out of the shipped tree (fold into item 3′'s
  sibling-repo journal move).

**Costs:** F1 ≈ one commit · F2+F3 ≈ one small `bcp` with standalone tests · F4 ≈ one afternoon pass ·
F5 ≈ one decision + one command. F2/F3/F4 are `tools/`-only (never the shipped bundle's behavior) — by prior
convention these can ride a `tools/glf:`-prefixed commit without a manifest bump unless process files change the
loop's behavior (CRON_PROMPT edits bump, per the v2024 precedent).

---

## 9. Parked decisions + owed verification (as-built addendum, 2026-08-06)

Two capabilities were **deliberately not built** at v2.74.2044, and one claim is **not yet proven**. Each parked
item names its trigger so the decision re-opens itself instead of relying on memory.

### 9.1 PARKED — the full-rights headless variant (trigger: FAIL-to-fix latency demonstrably hurts)

Grade-only means the scheduled `lane-cron` session **observes and reports, never changes code**: on a confirmed
FAIL it writes the FAIL result to the bus and stops — the protocol's STEP 3A tail (diagnose in source → fix →
bump → rearm) waits for a human-opened session whose builder inbox picks the FAIL up. Full-rights would close that
loop unattended: symptom in fleet traffic at 3am → diagnosed → fixed → committed+pushed to `main` → test rearmed →
graded next tick. Zero human latency.

Why it stays parked — three concrete risks, not one abstract one:
1. **The shared checkout.** An unattended editor writes into the same tree the interactive lanes hold 30+ dirty
   files in — the co-edit hazard (`git add <file>` cannot separate two authors inside one file) with no human
   present to notice.
2. **Uncommitted IS live.** Chrome loads the repo root; a wrong 3am "fix" is running in the browser the moment it
   is written, and pushed to `main` moments later.
3. **HITL inversion.** Today every code change traces to a session the user started. Full-rights breaks that
   provenance property silently.

Mechanically it is one edit (widen `headless-tick.cmd`'s allowlist; drop the STEP 3A/3B overrides in
`HEADLESS_PROMPT.md`) — **the grant is the decision, not the build**. The evidence that would justify re-opening:
measured FAIL-to-fix latency once FAILs actually fire (as of v2.74.2044, no FAIL has ever fired — the bad-news
path is still unexercised, §7 gap 3).

### 9.2 PARKED — the multi-machine lease/acks port (trigger: a second machine actually joins)

The bus is a git-synced channel — tests and results travel, so a grader on any machine can in principle answer a
builder on any other. But two pieces of coordination state never made that jump; both are plain local files:

- **The lease** (`logs/run/grader.lease`) — the exactly-one-grader guarantee is machine-local. A second machine's
  sessions would hold "the" lease concurrently with this one's and write duplicate results — the exact failure the
  lease prevents, failing SILENTLY (each machine sees a perfectly valid lease).
- **The ack ledger** (`logs/run/builder-ack.jsonl`) — "which results have I acted on" is machine-local. A builder
  lane resumed elsewhere has amnesia: its inbox re-shows everything, and it may re-act on handled results.

The port: move both into the bus repo as host-scoped files (`state/lease-<host>.json` + a cross-host election
rule; `state/acks-<lane>.jsonl`), riding the same pull/push the results already do. Contained — but it buys
nothing until a second machine exists, and it *costs* something today: a bus-synced lease depends on git latency,
which is strictly worse than a local file while there is one machine. Parked on the trigger, not the difficulty.

### 9.3 OWED — the sleep/wake recovery eyeball (the MECH-vs-VALUE gap on F5 itself)

F5 exists because the session cron **died silently with the laptop** — the two largest gaps (314/450 min) sat
exactly on the user's absences. The scheduled task is supposed to survive sleep and resume alone. Everything
verified at build time, however, happened **while a human was present**. The one unobserved scenario is the very
one the feature was built for: sleep → wake with no session open → the task resumes with nobody prompting.

What to look for in `logs/run/cron.out` after the first overnight:
1. A **gap in firing headers** covering the sleep — expected, not a bug (schtasks cannot fire a sleeping machine).
2. The first post-wake firing appearing **on its own**, its `LOOP GAP <n>min` honestly sized to the sleep — the
   gap named, never silently absorbed.
3. That firing doing real work unattended: lease claimed by `lane-cron` (or refused to an interactive grader), an
   honest QUIET or a grade, the census.
4. Failure signatures: no post-wake headers at all (task didn't resume — check `schtasks /query /tn
   orchard-auto-glf`; note its `Logon Mode: Interactive only`), or headers followed by permission-denial aborts (a
   missing allowlist rule only some code path hits).

`node tools/glf/report.cjs duty --hours 24` grades the recovery numerically. Until 1–3 are observed, F5's status
is honestly "MECH proven, VALUE pending" — the same half-hit distinction the loop itself grades by (v2.74.2024),
applied to the loop's own scheduler.
