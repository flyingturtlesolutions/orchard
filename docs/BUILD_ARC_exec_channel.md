# BUILD ARC — the exec channel (remote exerciser)

*Sequenced plan for `DESIGN_exec_channel.md` (specced 2026-08-08, twice adversarially reviewed, credential model
ruled option C). This doc is the ORDER with the dependency logic stated; the spec is the contract. Where this arc
adds decisions of its own they are marked **[arc-owned]** — those are this doc's to defend, not citations.*

**Where this picks up:** nothing is built. `tools/exercise/exercise.cjs` (the local exerciser) and
`background/handlers/exerciser.js` (`DEV_RUN_ASK` / `DEV_RELOAD_EXTENSION`) both exist and work; the arc reuses
the handlers unchanged and adds a second, remote caller for them.

**The destination, and how it is measured.** The loop stops asking a human for mechanical steps. This is not
abstract: on 2026-08-08 roughly twenty consecutive ticks reported nothing but *"waiting on a human"*, and
`v2.74.2009` has been open since 2026-08-06 waiting for one person to send one message. **The arc closes when a
test's `[auto]` steps run themselves and that test reaches a graded verdict with no human step.** Anything short
of that is scaffolding.

**The organizing principle:** the thing that can fail for reasons outside this repo goes FIRST, and the thing
that delivers the benefit goes LAST — so a half-finished arc is inert rather than loose.

---

## Rung 0 — EXC-C: enrollment + the path-scoped machine principal

**What:** `orchard-cloud` work (deployed via that repo, never by hand). `exercise.cjs enroll` runs the owner's
sign-in; the cloud binds a **new** Cognito `sub` to the **same** `orchardUserId` with `kind:'machine'` and a
hostname `label`. `requireOrchardUser` (`lambda/api/index.js:166`) returns both fields; a guard before the object
routes refuses a machine principal on any path outside `exec/` and `exec-result/` with a 403.

**Honest sizing:** small/medium, and smaller than it looks, because the codebase already funnels everything
through two choke points — `requireOrchardUser` (26 call sites, one function) and `userScope()` (`:183`, the only
builder of personal object paths). Two DynamoDB fields, one line in the resolver, one guard, plus a token-holder
and an `enroll` verb in `tools/`. No Cognito reconfiguration: the existing public client's auth-code flow and
30-day refresh tokens are sufficient.

**Why first — three reasons, and the third is the real one:**
1. It is the only rung that can fail for reasons outside this repo (deployed infrastructure, IAM, a Cognito
   behaviour that does not match the captured config).
2. EXC-2's disclosure copy is gated on it — the sentence *"commands can only come from your own signed-in
   account"* is a security claim no mechanism enforces until this lands (spec §6.2).
3. **It is the arc's stop condition.** If this rung is refused or cannot be built, the honest answer is to build
   *none* of the rest: without it, the channel is local automation wearing a cloud transport, and the existing
   CDP exerciser is simpler and already works. **[arc-owned]** — the spec states the tradeoff; making it a
   stopping rule is this doc's decision.

**Verify:** two proofs, both adversarial rather than confirmatory —
- a machine token **proven unable** to read `grounds` (attempt it; expect 403);
- **two** enrolled machines proven **distinguishable** in the audit, because "attributable" is the property
  option C was chosen for and one machine cannot demonstrate it. **[arc-owned] fallback if only one machine
  exists:** enrol the same box twice under different labels. It still proves the principals are distinct and the
  audit names them — do not skip the gate for lack of hardware, which is how a chosen property becomes an
  assumed one.

**Repo + deploy note:** this rung lands in `apps/orchard-cloud` and is deployed **via that repo only** — never a
console edit, or the captured config in `capture/` stops describing what is running. Its version does not appear
in `manifest.json`, so the extension's join key does not cover it: **name the cloud commit in the findings entry**
or the two halves of this arc cannot be joined later.

## Rung 1 — EXC-0: the pure envelope

**What:** `Core/execCommand.js` — `validateExecCommand(cmd, {installId, now, seenSet, armed})` returning a
verdict, plus `Core/execCommand.test.js` covering **every refusal** in spec §4: disarmed, unknown verb, expired,
future-dated beyond `MAX_SKEW`, replayed `cmdId`, `installId` mismatch, malformed shape. Also hoists the
`installId` getter out of `CloudLogShipper`'s private storage key into a shared identity module (spec §3.1).

**Honest sizing:** small. It is pure — no network, no browser, no signed-in identity — which is the point.

**Why here:** it has no dependencies and can run **in parallel with rung 0**. **[arc-owned]:** parallel is
allowed, but rung 1 must not be *pushed* before rung 0's verdict is known — landing the envelope for a channel
that will not exist is dead code with a security-shaped name.

**Verify:** `npm test`. Every refusal has a named test; a refusal without one is not built.

## Rung 2 — EXC-1: arming

**What:** `settings:execChannel` = `'off'` (default) | `'armed'` with `armedAt`; `ARM_TTL` auto-disarm; disarm on
version change but **not** on `reload` (spec §4.12 — otherwise the channel's most useful verb bricks the
channel); state re-read from storage on boot, alarm re-created there; kill-switch clears the alarm immediately.
Dev-gated render.

**Honest sizing:** small (~half a day), with one subtlety worth the care: arming is a *session*, not a state. A
forgotten arm is the likeliest way this becomes a standing hole, and `ARM_TTL` is the only rule that catches it.

**Verify:** `node --check`, plus — **[arc-owned], review fix** — `ARM_TTL` expiry must be a **pure function with
an injected clock**, tested in `npm test`. The first draft of this rung said "live eyeball that arming expires,"
which is an eight-hour wait nobody performs; an untestable safety rule is an unbuilt one. Live eyeball covers
only what the harness cannot reach: the dev-gated render, the kill-switch clearing the alarm **immediately**,
and arming surviving a `reload`. Also verify the §4.10/4.11 pair by hand — a disarm mid-turn lets the running
turn finish (it is a normal turn) but stops the next poll, and `stop` halts a remote turn like a typed one.

## Rung 3 — EXC-2: the disclosure

**What:** the acknowledgement dialog (spec §6.2) required to enable dev mode.

**Depends on rung 0**, hard. **[arc-owned] gate:** this rung may not land before EXC-C is deployed. Shipping the
copy earlier means prose asserting a capability the mechanism lacks — the exact failure this repo logged at
v2.74.2104 (`LESSON[a-tools-allowlist-is-a-spec-check-it-against-its-own-comment]`), committed knowingly rather
than by accident. If EXC-C slips, the copy is weakened to describe what is actually enforced.

**Verify — [arc-owned], review fix.** The first draft's gate was "a line-by-line read of the copy against what
the code enforces," which is a careful human reading, not a test, and it is the gate most likely to be skipped
on the day the copy changes. Replace it with a **conformance test** in the `Core/panelConformance.test.js`
idiom (pure text scan): every **claim sentence** in the disclosure is listed in the test alongside the symbol
that enforces it, and the test fails if a claim has no enforcing symbol or the symbol has vanished. Claims to
bind at minimum: *"only from your own signed-in account"* → the machine-principal guard · *"expire after 10
minutes"* → `EXEC_TTL` · *"run once"* → the seen-set · *"still require your confirmation"* → the write belt ·
*"turns itself off after 8 hours"* → `ARM_TTL`. Then the live eyeball for rendering, and the user owns the final
wording (spec §12.3). This makes the disclosure the one piece of user-facing text that cannot drift away from
the mechanism — which is the whole reason it is gated on rung 0.

## Rung 4 — EXC-3: poller + dispatcher

**What:** `background/handlers/exec.js`. Armed-only alarm → one `GET /objects/exec/<installId>` → `queue[0]` →
`validateExecCommand` → **mark seen + write result** → *then* call the existing handler. `EXEC ▸` logging, and
the marker added to `_DECISION_RE` (invariant #1, same change — a marker absent from that allow-list is
structurally invisible to a decisions download).

**Honest sizing:** medium, and the §5.1 ordering rule is the whole risk. `chrome.runtime.reload()` tears the
worker down mid-call, so anything scheduled after it never runs: result-after-reload is an infinite reload loop
on a timer in a browser nobody is watching. The seen-set must be in `chrome.storage`, not memory, for the same
reason.

**[arc-owned] interim guard:** until rung 6 lands, the dispatcher refuses unless exactly one issuer is
configured. Without it, rungs 4–5 are drivable with no lease and two lanes can interleave asks into one panel —
the corruption class already recorded live at findings 165125.

**[arc-owned] REVIEW FIX — this rung also builds the issuer side, or nothing here is testable.** The first draft
said "write a mailbox by hand" without saying *with what*. Nothing writes a mailbox until rung 7, and nothing
reads a result either — so rungs 4–6 had no way to be exercised at all. Two CLI verbs land here:
`exercise.cjs remote-ask "<text>"` (writes the mailbox, using **the machine credential rung 0 enrolled**) and
`exercise.cjs remote-result <cmdId>`. Useful side effect: this is the first real exercise of rung 0's
credential, so a scoping mistake there surfaces now rather than at rung 7.

**Verify — four gates, and the second is the one that must not be skipped:**
1. `node --check` + `npm run undef`.
2. **The reload loop, deliberately provoked.** Issue a `reload`, then confirm on the next poll that the command
   is *not* re-executed. The first draft called this "the whole risk" and then gave it no gate — a hazard named
   in prose with no test is the exact shape this repo keeps re-learning. Test the ordering directly: kill the
   worker between mark-seen and dispatch, and confirm the command is treated as spent.
3. Arm → `remote-ask` → `EXEC ▸` in the trace and a real turn in the panel.
4. **A `gl -decisions-` download actually shows the `EXEC ▸` line.** Editing `_DECISION_RE` is the change;
   seeing the line in a decisions view is the proof. Invariant #1 exists because the edit keeps getting made
   without the check.

## Rung 5 — EXC-4: results

**What:** `exec-result/<installId>/<cmdId>` written per spec §3.3, including the second write when the panel
answers, and the `version` stamp so a grader knows which build executed.

**Why before the lease:** results are the **anti-paradox mechanism**. A remote ask that silently fails to
dispatch looks identical to a loop that never fired — both leave an untouched panel and a quiet trace. Without
results the channel can report progress it is not making, which is the failure the loop exists to prevent.

**Verify:** a refusal and a dispatch each produce a readable result object with the right outcome.

## Rung 6 — EXC-5: the exec lease

**What:** `exec-lease/<installId>` in the object store — `{holder, expiresAt}`, claim-is-renewal, TTL = 3 missed
ticks. A lane without it may not write a mailbox. Drops rung 4's interim guard.

**Why the object store and not the git bus:** `RESEARCH_auto_glf.md` §9.2 parked the multi-machine lease port on
the trigger *"a second machine actually joins"* — this arc pulls that trigger — and its own objection to a
bus-hosted lease was git latency. `/objects` has read-after-write; the bus does not.

**Verify:** `npm test` on the pure election; live, two lanes contending and exactly one winning.

## Rung 7 — EXC-6: the loop consumes `[auto]`

**What:** `tick.cjs` reads a test's `[auto]` lines, writes one command, reads the result on a later tick.
`[human]` lines are untouched and stay untouched.

**Verify — this is the arc's acceptance test, not a unit gate.** The channel's own bus test (spec §13):

```
MECH  = `EXEC ▸ ask dispatched (remote,`            — the dispatcher RAN
VALUE = an exec-result with outcome=dispatched AND a matching turn in the SAME window
FAIL  = `EXEC ▸ dispatched` with NO turn in the window — it claimed to drive and did not
```

`MECH` is the dispatcher's own claim; `VALUE` is a real turn appearing. The distinction is the point — a success
tally is not a correctness signal, and the dispatcher's self-report is a tally.

**Retry policy is part of this rung** (spec §4.12, added by review): re-issue at most `MAX_REISSUE` times and
only for `panel-closed` / `disarmed`; treat `panel-closed` as an INCONCLUSIVE precondition, not a failure to
retry around. Without this the loop re-writes a mailbox every tick against a closed panel forever.

**Arc closes when:** *any* open test whose ACTION list is entirely `[auto]` reaches a graded verdict with **zero**
`[human]` steps run. `v2.74.2009` is the obvious candidate today — but it may be retired or superseded before the
arc lands, and the arc's completion must not depend on one test surviving. **[arc-owned] correction:** the first
draft named that test specifically.

---

## Rung 8 — the security pass, before arming is offered to anyone

**What:** `/security-review` over the whole arc's diff, plus a deliberate red-team of the envelope: replay a
captured command, forge an `installId`, back-date and future-date `expiresAt`, disarm mid-flight, issue an
unknown verb, oversize the mailbox, and attempt a record path with the machine token.

**Why a rung and not a checklist item:** every other rung's gate proves its own slice works. Nothing in rungs
0–7 asks *"what happens when someone tries to break it"*, and this is a remote-control feature over a browser
holding live logged-in sessions. **[arc-owned]** — the spec's §9 table pre-registers the failure modes; this
rung is where they are attacked rather than asserted.

**Verify:** each §9 row attempted and observed to be refused, with the refusal quoted. A row that cannot be
attempted is a row whose guard is not real yet.

---

---

## Milestones — three, each falsifiable

*Added 2026-08-08 after the review asked whether this arc had testable milestones. The honest answer was: it had
per-rung **gates** (a slice behaves) but only one **milestone** (an outside observer can see it work), leaving
~5 days with nothing demonstrable. Three checkpoints fix that. Each states what must be true, how it fails, and
what it does NOT prove — the last column matters most, because a milestone read as more than it is becomes the
"success tally" this project has been burned by.*

### M1 — "the credential is real" · after rung 0 · no extension code required

**Claim:** an enrolled machine token can write `exec/<installId>` and **cannot** read `grounds`, and two
principals are distinguishable by label in the audit.
**Falsified by:** any 2xx on a record path with the machine token; or two enrolments the audit cannot tell apart.
**Does not prove:** that anything drives a browser. M1 is entirely cloud-side — it is the *permission* proven,
not the *channel*.
**Why it is first:** it is the arc's stop condition, and it can be reached without touching the extension at all.

### M2 — "one remote turn" · after rungs 4 + 5 · **the mid-arc demo**

**Claim:** `exercise.cjs remote-ask "<text>"` from a CLI causes a real turn in an armed panel, and a readable
result object comes back naming the conversation it landed in and the build that ran it.
**Falsified by:** `EXEC ▸ dispatched` with no matching turn in the same window (the spec §13 `FAIL` arm) · a
result that never appears · a command that re-executes on the next poll.
**Does not prove:** that the loop can do it unattended, that two lanes can coexist, or that any test gets graded.
**Why it exists:** this is the first point where the feature is *visible*. Without it the arc runs five days on
unit tests alone. Write it as a **bus test**, not a demo — the house currency, and it makes the mid-arc point
gradeable by the same loop the arc serves.

### M3 — "no human step" · after rung 7 · the arc's acceptance

**Claim:** an open test whose ACTION list is entirely `[auto]` reaches a graded verdict with **zero** `[human]`
steps run.
**Falsified by:** any `[human]` step required to reach the verdict; or a verdict reached on the dispatcher's
self-report rather than an observed turn.
**Does not prove:** that per-item correctness is automatable. It never will be — `BRANCH` redacts item text
before egress, so classification VALUE arms stay `[human]` for a privacy reason, not an automation gap.

### The abandon criterion **[arc-owned]**

Stop the arc — do not build the remaining rungs — if **M1 cannot be reached**, or if reaching **M2 requires
weakening any rule in spec §4**. The second is the one to watch: the temptation at rung 4 will be to relax the
seen-set, the TTL, or the arming gate to make the demo work. A demo bought that way proves the opposite of what
it appears to. If either happens, the local CDP exerciser remains the answer and the cloud channel is not worth
its cost.

---

## Status

*Update this table at each rung's landing — an arc doc with no status is a plan, not a tracker.*

| Rung | Slice | Repo | Size | State |
|---|---|---|---|---|
| 0 | EXC-C enrollment + scoping | orchard-cloud | ~2–3 days *(revised up)* | **BLOCKED on a design call** — see spec §7.0.2 · stop condition · **→ M1** |
| 1 | EXC-0 pure envelope | extension | ~half day | **built then TORN DOWN** 2026-08-08 (user ruling — see below) |
| 2 | EXC-1 arming | extension | ~half day | not started |
| 3 | EXC-2 disclosure | extension | ~half day | not started — **gated on rung 0** |
| 4 | EXC-3 dispatcher + issuer CLI | extension | ~1–2 days | not started |
| 5 | EXC-4 results | extension | ~half day | not started — **→ M2 (mid-arc demo)** |
| 6 | EXC-5 lease | both | ~1 day | not started |
| 7 | EXC-6 `[auto]` consumer | tools/glf | ~1 day | not started — **→ M3 (acceptance)** |
| 8 | security pass | — | ~half day | not started |

Rough total ~6–8 working days, of which rung 0 is the only one that can be blocked by something outside these
repos. Sizes are the author's estimate at spec time and have not survived contact with the build.

### Teardown — 2026-08-08, user ruling: *"the design is still underspecified"*

`Core/execCommand.js` and `Core/execCommand.test.js` (rung 1, 53 tests, green) were **deleted**. Nothing imported
them; `npm test` is 4504 passing / 0 failing without them. The design docs stay — an underspecified design needs
more specification, not less — and the whole slice is a half day to rebuild once the spec settles.

**Why it was wrong to have built it.** The arc's own text says rung 0 is the stop condition and that rung 1 "may
run parallel to 0" — and I took the parallel clause while rung 0's verdict was not merely unknown but *unasked*.
Within one turn of writing rung-1 code, rung 0 turned up §7.0.2: the single Cognito authorizer means the whole
credential model forks three ways, and option 2 moves the transport off `/objects` onto dedicated `/exec/*`
routes. The envelope I wrote encodes `execMailboxPath()` = `exec/<installId>` and a `/objects`-shaped fetch — a
detail the live fork may delete. Building it did not de-risk anything; it produced code whose central assumption
was still under negotiation.

**LESSON[parallel-is-not-permission-when-the-blocking-rung-is-unasked]:** "may run in parallel" is a scheduling
allowance, not a licence to start before the gating question has even been put to the person who answers it. The
arc had the right rule and I read it as looser than it was. The tell was available in advance: rung 0 is defined
as the rung that can fail for reasons outside the repo, so *nothing* downstream of it is de-risked by being
written first. This is the same class as the repo's recorded "DESIGN FIRST — twice over-built ahead of it".

**Before rung 1 is rebuilt, the spec owes:** the §7.0.2 fork resolved (1, 2 or 3) · the transport path settled
(`/objects/exec/<id>` vs a dedicated `/exec/mailbox` route) · `ARM_TTL` / `MAX_SKEW` / `MAILBOX_MAX` /
`MAX_REISSUE` confirmed (§12.5) · the enrolment ceremony's shape decided (§12.6) · the disclosure copy owned by
the user (§12.3).

## Rules that hold across the arc

- **Nothing lands in a release where EXC-C is absent.** Rungs 4–7 without rung 0 ship a disclosure that lies.
- **Default-off is the rollback.** Un-shipping is flipping a default, not reverting code — provided rung 2's
  kill-switch genuinely clears the alarm. Test that before relying on it.
- **The write gate is never duplicated.** This channel changes who *asks*, never who *approves*.
- **Two verbs.** A third is a spec change, not a config change.
- **Version discipline:** each rung bumps `manifest.json` and carries its own findings entry. The arc spans
  several passes; the version is the join key between them.

## Not in this arc

- Verbs beyond `ask`/`reload` · interactive/low-latency driving (MV3 alarm floor ≈ 60 s) · cross-identity driving
  (out of scope, different threat model) · retiring the local CDP exerciser (it keeps working with no cloud, no
  arming, no network, and is the right tool when you are at the machine).
- **Per-item correctness stays human-only.** `BRANCH` redacts item text before egress, so a trace can prove
  *13 items went into 3 arms with none left over* and never *item X went into the right arm*. `[human]` VALUE
  arms on classification features are human for a privacy reason, not an automation gap — this arc does not
  shrink that set and must not be sold as if it does.
