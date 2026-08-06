# DESIGN — The Grading Loop (GL): a portable model for verifying shipped changes against production telemetry

**Status:** spec v1.0 (2026-08-06) — the MODEL abstracted out of its reference implementation, **auto-glf**
(`tools/glf/*` + the `orchard-logs` bus, v2.74.1981–2044). Written because the model/binding split turned out to
be clean (see §8): everything in §§2–7 is host-agnostic; everything Orchard-specific is confined to the five
binding points a host project supplies. Extraction cost for a second project ≈ a day, mostly the prompt rewrite.
Companions: `docs/RESEARCH_auto_glf.md` (the deep-read + as-built + parked decisions), `tools/glf/README.md` (the
new-user guide), `tools/glf/CRON_PROMPT.md` (the reference protocol text), `../orchard-logs/tests/README.md` (the
reference bus contract). Every rule below traces to a named incident in the reference implementation's ledger —
none is speculative.

---

## 1. Purpose

Close the **mechanism/value gap** on shipped code. A change that lands, passes unit tests, and logs its mechanism
firing can still fail to deliver the thing the user was promised — the reference project shipped one arc through
five builds and four ★PASS grades while the user-visible outcome never worked once. The Grading Loop makes
"fixed" a claim that only **production telemetry** may confirm, through predictions registered *before* the
evidence exists.

It is NOT: a unit-test runner (that gate runs pre-commit; GL watches post-ship), an auto-fixer (it delivers
verdicts; fixing is a separate, human-initiated act unless deliberately granted), or a monitoring/alerting stack
(it grades *specific pre-registered claims*, not thresholds).

## 2. Objects

- **TEST** — one open question. `{ id, claim (one sentence naming the VALUE the user should get), owner (lane),
  status (open|retired), build (fingerprint at write), files (claimed-file list), files-fp, created }` + a body:
  an `ACTION:` checklist (`[auto]` steps the loop can perform; `[human]` steps a person owes) and `PREDICT:` arms
  (§5). Never overwritten — amended by append (REARM/REPAIR history) or closed by its owner.
- **RESULT** — one grading attempt. Append-only, one file per attempt, named so the name alone tells the story
  (`<id>--<stamp>--<verdict>`). Carries both fingerprints (build-at-grade vs build-at-write), a files-match audit
  bit, a self-graded bit, and the evidence quoted from the graded window. **Two attempts that disagree are DATA**
  — overwriting one would erase the disagreement instead of surfacing it.
- **THE BUS** — a git-synced channel (`tests/` + `results/` + `state/`) separate from the code repo. The journal
  (narrative: symptom → cause → change) stays in the code project; the bus holds the LIVE questions and their
  answers, so any session on any day can write a question and any other can answer it. **The push IS the
  delivery** — a result that exists only locally was never delivered.

## 3. Roles — claimed, not assigned

- **BUILDER** — causal. Whoever changed the code writes the test for it, stamped with a session-minted lane id.
  Only the owner rewrites a test (rearm / retire). Builders never write results.
- **GRADER** — leased. Exactly one grades at a time: a lease file claimed every tick (claim IS the renewal),
  expiring after N missed ticks so a dead grader is replaceable without a human and a duplicate grader is refused.
  Graders never write tests, never retire (reporting a verdict ≠ closing a question), and never silently adopt an
  orphan (adoption is a visible owner-rewrite in history).
- **The same agent may hold both roles.** Integrity comes from the arms being **pre-registered before the
  evidence exists**, not from grader independence — but a self-graded result is stamped, and it auto-acks so the
  dual-role session doesn't re-act on its own verdict.
- **One loop, two modes.** A refused lease claim IS the role switch: the same tick becomes builder mode (inbox →
  act oldest unacked → ack). A second schedule for the builder half would reintroduce the dual-ticker problem the
  lease solved.

## 4. Admissibility — which build did I actually observe?

- **Build identity is a fingerprint, never a version label.** In any environment where uncommitted state is live
  or multiple writers share a checkout, a version number stops identifying the running build. The reference:
  `HEAD + hash(working diff) + version`.
- **Staleness is scoped to the CLAIMED files.** A whole-tree fingerprint stales every open test on every
  neighbor's save. States: **LIVE** (tree identical) · **LIVE\*** (tree moved; every claimed file byte-identical —
  gradeable, audited) · **STALE** (a claimed file actually changed — waits for its OWNER's rearm; never graded
  against memory of what the build "should" contain) · **ORPHAN** (stale + owner silent past a window — flagged
  with a result, never silently adopted).
- **Rearm is part of landing.** A test records its build while the fix is uncommitted; landing moves the
  fingerprint forever, so the owner re-stamps (append-only history) every owned open test whose code just landed
  — and sweeps owned STALE tests staled by neighbors. A gate that is always tripped is a gate nobody re-arms.
- **Admissibility must fail CLOSED.** The reference's worst silent bug: a parsing quirk froze a fingerprint
  constant, so drifted tests presented as gradeable and their verdicts looked entirely legitimate. Wrongly-STALE
  waits (annoying, visible); wrongly-LIVE gets GRADED (invisible, corrupting). Bias every ambiguity toward STALE.

## 5. The arm grammar — grade against declared criteria, never memory

Every arm is a **greppable literal** against the telemetry:

- `SCOPE` / `REQUIRES` — admissibility of the observation itself. An unmet precondition is not evidence.
- `QUANTIFIER` — ONE-suffices vs ALL-must-comply. **Not optional**: without it the same block graded PASS and
  FAIL five minutes apart, both readings faithful to its text.
- `MECH` — proves the changed code path RAN. **MECH alone is never a grade** (the founding doctrine).
- `VALUE` — proves the user got the RIGHT THING. The claim names this, not the mechanism.
- `FAIL` — ran, wrong value. If you cannot state a FAIL distinguishable from INCONCLUSIVE, the fix is not yet
  testable and needs an observability change first — **a fix needs a falsifier before it needs a verifier.**
- `INCONCLUSIVE` — looks like FAIL but is not evidence (the known confounders, named).

**Evaluation order (strict):** not-admissible → INCONCLUSIVE · precondition unmet → INCONCLUSIVE · confounder arm
→ INCONCLUSIVE · MECH+VALUE at the QUANTIFIER → PASS · FAIL arm → the red path · **half-hit** (MECH yes, VALUE no,
FAIL no, a `[human]` ACTION still unmet) → INCONCLUSIVE(waiting-human), emitted once per distinct evidence state ·
nothing matched → **UNMAPPED**, treated as INCONCLUSIVE and read as "the test is malformed — repair it." Never
argue a grade in prose; a prose ★PASS once shipped a push.

## 6. Liveness + self-accounting — the loop measures itself

- **Every firing is recorded** (a tick ledger) and **a gap is a first-class verdict**: loop-not-running and
  nothing-happened are different facts that correlate (both follow the human walking away), and conflating them
  once inflated the loop's apparent health ~3×.
- **The headline numbers are computed, not remembered**: duty cycle from the ledger; a per-test verdict-chain
  scoreboard from the results; an undelivered-bus check.
- **The waiting-human census is the escalation channel.** Tests blocked on `[human]` steps are surfaced with
  their unmet checklists on every QUIET tick — dead air becomes the human's to-do list. Without this, the
  dominant INCONCLUSIVE mode (waiting-human) starves silently.
- **Retention semantics of the signal are load-bearing:** if the telemetry store rewrites/expires (the reference:
  a ~48h ring that retro-truncates), any window cited in a result must be copied to durable local storage in the
  same tick, and mtime is never a freshness signal.

## 7. Scheduling + containment

- **Durable grading, interactive building.** The grader is the time-critical half (evidence expires); it belongs
  on an OS-level schedule that survives session death and names its gaps on wake. Interactive sessions default
  into builder mode against a live scheduled grader and inherit grading automatically when it goes quiet (the TTL
  handoff, both directions, no human required).
- **A scheduled (unattended) session must be CONTAINED by mechanism, not discipline:** pin an enforcing
  permission mode explicitly (an allowlist under a bypass-style ambient mode is documentation, not enforcement —
  empirically proven in the reference), scope mutation rights to the bus only, confine writes, and let a denied
  tool abort the firing — the correct unattended failure. **Verify the sandbox by escaping it** at build time.
- The scheduled grader needs a **fixed lane identity** (claim-is-renewal across fresh sessions); reserve the name.

## 8. The binding interface — what a host project supplies

Five bindings; everything above is invariant across hosts.

1. **Build-identity provider** — a function yielding a fingerprint that changes exactly when the running code
   changes (and a visible DEGRADED signal when it cannot be computed — never a silent fake identity).
2. **Signal source** — where production telemetry lives, how it syncs, and its retention semantics (ring?
   rewrite-in-place? per-stream files?). The loop's STEP-1 read and copy-in-same-tick rules derive from these.
3. **Domain vocabulary** — the log-marker grammar arms grep against, and the scrub patterns/roster for the
   project's PII shape (with the NEVER-list for synthetic sentinels — a scrubbed marker is an unmatchable one).
4. **The prompt pair** — the protocol text (this model instantiated in the host's dev-loop terms: its test gate,
   its version join key, its shared-checkout rules) + the headless variant's constraints.
5. **State locations** — the lease / ack-ledger / tick-ledger homes (single-machine: local files are correct;
   multi-machine: they must move onto the bus, host-scoped — the reference deliberately defers this until a
   second machine exists).

Privacy is part of the interface, not an option: **every byte reaching the bus is scrubbed at write, the write
REFUSES on residual PII**, and the scrub preserves distinctness/recurrence (stable tokens) while destroying
identity, keeping the host's reproducer vocabulary.

## 9. Invariant ledger (the one-liners, each incident-traced)

1. MECH alone is never a grade.
2. A fix needs a falsifier before it needs a verifier.
3. QUANTIFIER is not optional.
4. An unmet precondition is not evidence.
5. Results are append-only; disagreement is data.
6. Retirement is the owner's act; a grader reports, never closes.
7. Adoption is visible, never silent.
8. The push is the delivery.
9. A gap is a verdict, not a preamble; loop-dead ≠ quiet.
10. Grade the fingerprint, never the version label.
11. Staleness scopes to claimed files; admissibility fails CLOSED.
12. Rearm rides the land; a landed fix must not freeze its own test.
13. Pre-registration, not grader independence, is the integrity source.
14. One loop, two modes; the refused claim IS the role switch.
15. An allowlist is only a mechanism under an enforcing mode.
16. The census rides the quiet tick — starvation must be loud.
17. Every byte on the bus is scrubbed at write; residual refuses.
18. The loop's numbers are computed, never remembered.
