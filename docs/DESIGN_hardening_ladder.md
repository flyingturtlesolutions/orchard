# DESIGN — The Hardening Ladder (A · B · B.5 · C)

**Status:** specced 2026-07-22, nothing built. Greenfield — no routing/eval test infrastructure exists today.
B.5's internals are specced separately in `docs/DESIGN_decision_gate.md`; this document owns the FRAME and the
full treatment of A, B, and C.

**Thesis:** an AI app is a **stochastic front** (the model's aim — does it pick the right thing) bolted to a
**deterministic back** (the code that catches what the model picks and acts on it). The two failure families are
independent, and every routing bug this project has shipped lived in the *back*, not the model. The ladder is four
instruments, each covering what the others structurally cannot, split by two axes: **is the model frozen or live**,
and **is it a gate (you pass it, it proves) or a scoreboard (you watch it, it warns)**. The frozen/live line IS
the gate/scoreboard line.

| Rail | Aims at | Model | Verdict | Green gate? | Catches |
|---|---|---|---|---|---|
| **A** — structural conformance | the catalog itself | none | gate | yes | malformed/incomplete leg declarations |
| **B** — one recorded decision | the back (happy path) | frozen, 1 point | gate | yes | the normal hand-off dropping a good decision |
| **B.5** — the Decision Gate | the back (all reactions) | frozen, derived set | gate | yes | any reaction — incl. catch-alls — mishandled |
| **C** — the live layer | the front (aim) + drift | live | scoreboard | no (watched) | the model aiming wrong, and quality rot |

Rule of the ladder: **never gate on C** (it flakes, and a flaky gate gets disabled), and **never read A/B/B.5
green as "the model is good"** (they say nothing about aim). Keeping the natures separate is the whole point — it
lets "the gate is green" keep meaning exactly one thing.

---

## 1. Rail A — structural conformance (proofread the menu)

**What it is.** A pure suite over the leg catalog and registries — no model, no network, no seam. It checks that
the *declarations the router depends on* are well-formed, before anyone types anything. It is the cheapest rail,
the most reliable, and it pays for itself before a single golden ask is written.

**Subject.** `Core/connectorRecipes.js` (`CONNECTOR_RECIPES`, organized per-site — ZD / SH / AC / VS / HubSpot
spreads), `Core/palette.js` (the `domain:'self'` legs), and `Core/interpret.js` (`INTENTS`).

**The checks** — each is a `Core/*.test.js` assertion over the catalog, and several map to real gaps this project
has actually shipped:

- **Coverage-by-construction:** every enabled leg has ≥1 golden ask in the corpus (§6). A new leg with no test is
  red. Same allow-list discipline as `_DECISION_RE`.
- **Gate-axis completeness:** **every `write: true` leg declares `reversible` AND `outward`.** This is the exact
  v1686 gap — 16 of 18 curated writes were undeclared and leaned on a fail-closed default; Rail A would have
  turned that red on the day the legs were added.
- **Safety-class conformance:** a non-GET method (`POST`/`PUT`/`DELETE`) is never `safety:'auto'`; `destructive`
  or `outward` legs floor at `gated`. (Note the real enum is `auto | confirm | gated` — there is no
  `forbidden`/`restricted` on a leg; Rail A asserts the enum, too.)
- **Identity conformance:** a `verifyIdentity: true` leg declares an `identityProbe` endpoint.
- **Router-legibility:** `does` is non-empty (the router reads it), params with a `gid` are consistently marked
  required-or-not, and no two legs on one site carry names close enough to confuse selection.

**What it proves and doesn't.** It proves the *catalog is internally well-formed and completely covered*. It says
nothing about whether the router *picks* the right leg (that's B.5/C) or whether the leg *works against the live
site* (never tested — see the seam discipline in §2). Its blind spot is semantic: a perfectly-formed leg that
describes the wrong thing passes.

**Build.** Pure `Core/` tests over the catalog; needs no model, no corpus authoring, no CD-1a. **This is the first
thing to build** — highest value per unit cost on the whole ladder.

---

## 2. Rail B — one recorded decision (rehearse with one line)

**What it is.** The minimal frozen-model test: record the model's ONE canonical decision for an ask, replay it
deterministically, and assert the code carries it through to the right action. It tests the *happy hand-off* — the
class of bug where the model said exactly the right thing and the plumbing dropped it (the case→Zendesk shape, the
v1651 payload-whitelist drop).

**The seam** — shared with B.5, and it already exists: `interpret(ask, ctx, deps)` (`Core/interpret.js:161`) takes
an injected `think`. Feed it the recorded decision; no live model runs. Frozen input → deterministic → gate.

**Relationship to B.5 — read this.** Rail B is the *degenerate case* of B.5: one decision (the correct one) is one
reaction class (the dispatch class). **B.5 subsumes it.** B is worth naming only as the first milestone inside
B.5's build — the moment one golden decision routes correctly end-to-end — not as a separate permanent rail with
its own infrastructure. Once B.5's derived reaction set exists, B is a subset of it. Do not build B as a distinct
suite; build B.5-0 and B falls out.

---

## 3. Rail B.5 — the Decision Gate (rehearse with a stack of lines)

**Full spec: `docs/DESIGN_decision_gate.md`.** Summarized here for the ladder; that document is the authority.

B.5 feeds the frozen seam a **derived set** of decisions spanning the environment's *finite reaction space*
(dispatch / teach / clarify / each clause kind / empty-prior stop / park / the confidence-gate degradations / the
malformed-payload fallbacks), and asserts the code's effect on each — **including the catch-alls that absorb every
un-enumerated output**, which are the bridge from an infinite input space to a finite, provable reaction set. The
reaction list is *derived from the registries and branch points* (not memory), sealed by a `_DECISION_RE`-style
meta-test and a derivation tripwire. Deterministic → a hard gate.

**The one grounding fact that governs its build** (`DESIGN_decision_gate.md` §10): the **normalize/gate half** of
the target is already pure in `Core/interpret.js` and gate-able **now**; the **dispatch/effect half** lives in
`chat.js`, is DOM-coupled, and is **not in the test glob** — so it needs the `DESIGN_cadence.md` **CD-1a** driver
extraction (injected reporter) before its reactions can be asserted headless. B.5 therefore splits: phase 1 over
the pure core now, phase 2 over the effects after CD-1a — where B.5 doubles as CD-1a's differential oracle (panel
reporter ≡ SW reporter, per reaction).

---

## 4. Rail C — the live layer (the scoreboard, plus gauges and backstops)

Everything past this line needs the **live** model, so all of it is *watched*, never a hard gate. Rail C has three
distinct parts — do not confuse them, and do not fold any of them back into B.5 (they are its complements, not its
components).

### 4.1 The routing-aim scoreboard
The honest end-to-end check: type a real ask, let the **live** model pick against the **real** palette, assert the
resolved leg matches the golden expectation. Because the model is live it is a bit random, so it is a **score, not
pass/fail** — a pass-rate per site, watched over time, with a **diff-on-regression** report (`{ask, expected, got,
why}`) when a previously-passing ask starts missing. Threshold-gated *pre-release*, never per-commit. This is where
"open a case → wrong site" and the field-name misclass surface as data instead of as a human noticing by hand.

### 4.2 The dashboard gauges
Three cheap derived signals that instrument B.5's blind spots (each turns a silent gap into a reading):

- **Calibration curve** — on the ground-truth corpus, plot the model's self-reported confidence against actual
  correctness. The only thing that answers "does *unsure* track *wrong*"; it tells you *where to set the confidence
  gate* and *whether to trust it at all*. Without it, a perfectly-tested gate can guard nothing (a confidently-wrong
  decision never trips it).
- **Redirect-rate + acceleration, on a FIXED corpus** — the fraction of decisions landing in the guard-rail
  classes (clarify / teach / gate / substitute) rather than clean dispatch, tracked over time on a *constant*
  question set so a rise is unambiguously model rot, not users asking harder things. A **leading** indicator: it
  catches decline *while the guard rails are still absorbing it*, before any wrong action. Blind to the confident-
  wrong tail (that doesn't redirect) — §4.1's score covers that.
- **Substitution log** — every time interpret redirects/teaches/substitutes on live traffic, recorded. Makes the
  demand-side gap visible: "user wanted something unbuilt, router grabbed the nearest built thing" (the case→Zendesk
  shape) stops being invisible and becomes a stream you can read.

### 4.3 The backstops (what no test can do)
The irreducible tail — the *rare*, the *individual*, the *unmodeled* — yields only to a *different kind* of check:

- **An independent verifier** for a specific confident-wrong decision: a second, independent opinion asked to
  *refute* the resolution (the adversarial-refute pattern the workflow tooling already carries), not the model's
  own confidence. A runtime check, not a gate.
- **A human partition audit**, on a cadence: "is the reaction list still honest — did a new response path ship
  unmodeled?" The one thing the gate structurally cannot check about itself; it must stay a human habit, triggered
  by construction whenever a new outcome enters the registry.

---

## 5. How the four compose — the division of labor

Each rail is bounded; together they tile the space:

| Question | Answered by |
|---|---|
| Is the catalog well-formed and fully covered? | **A** |
| When the model is right, does the code carry it through? | **B** (= B.5's dispatch class) |
| Across every reaction the code can reach — incl. safe-failure — does it do the right thing? | **B.5** |
| How often does the live model aim right, and where is it slipping? | **C.1** (scoreboard) |
| Does "unsure" mean "wrong"? Is the model rotting? Are unbuilt intents being substituted? | **C.2** (gauges) |
| Is this *specific* confident decision actually right? Is the reaction list still honest? | **C.3** (backstops) |

The load-bearing discipline: A/B/B.5 gate the **deterministic back** and can be trusted to mean one thing; C
watches the **stochastic front** and must never be a gate. The field's recurring error is collapsing these —
gating on a flaky eval (and disabling it), or reading green harness tests as certifying the model. The ladder
refuses the collapse.

---

## 6. The shared corpus economy — one oracle, four consumers

The rails are not four separate authoring efforts. They share one corpus and one oracle:

- **The oracle is the catalog.** A leg's declared params (`{name, required, gid}`) tell you the *expected binding
  shape* for an ask, so you author the ASK and the catalog tells you the expected RESULT — you are not hand-writing
  expected output per ask.
- **One golden-ask corpus, four consumers:** Rail A reads it for coverage (every leg has one); B/B.5 freeze real
  decisions for it (harvested from `gl`/`gc` traces — the `INTERPRET_ASK → …` lines) as fixtures; C runs it live
  and scores it. The negatives matter as much as the positives — `open a case` must NOT resolve to
  `zendesk_create_ticket`; `delete ticket 5` must resolve to `delete_ticket` AND `gate=gated`; `how many are open`
  must never resolve to a write.
- **Per-item pipeline intents belong in the corpus too**, not just connector legs — `which of those ask for X` →
  branch, `read the Y for each` → fieldRead, `open a case for each` → case. That is exactly where this project has
  bled.

---

## 7. Grounding and build dependencies

- **No eval infra exists** — greenfield, all four rails are new.
- **The frozen seam exists** — `interpret(ask, ctx, {think})`; A needs no seam, B/B.5 use this one, C uses the real
  model + real palette.
- **Rail A is pure now.** **B.5's normalize/gate half is pure now**; its effect half needs **CD-1a**. **C needs the
  live model + a ground-truth corpus.**
- **Test glob is `Core/` + `Services/`, not `background/handlers/`** — so every gate assertion lives in `Core/`;
  the dispatch effects become testable only once CD-1a lifts them out of `chat.js`.

**Build order (highest value per cost first):**

- **A-0** — the catalog conformance suite (coverage meta-test + axis/safety/identity checks). Pure, no model, no
  corpus. Catches structural rot immediately; would have caught the v1686 axis gap. **Start here.**
- **B5-0/1** (per `DESIGN_decision_gate.md`) — the derived reaction registry + meta-test + the catch-all totality
  corners, over the pure `Core/interpret.js` core. Closes the two nastiest classes (the forgotten reaction, the
  un-degrading catch-all) and green-gates today. Rail B falls out of B5-0.
- **C.1 scoreboard + C.2 redirect-rate** — cheap: the scoreboard is the corpus run live and scored; redirect-rate
  is a counter over the same corpus. The leading rot indicator lands early.
- **B5-2/3** — one-representative + structured-corner fixtures over the pure core.
- **C.2 calibration + C.3 verifier** — once there is a ground-truth corpus and a reason to trust the gate's
  threshold.
- **B5-5/6** (after CD-1a) — the effect reactions + the composition/seam layer.

---

## 8. What this deliberately does NOT decide

- **Corpus storage and harvest tooling** — a sibling corpus keyed by leg/reaction, with the A-0 meta-test enforcing
  1:1, is the presumed shape; the harvest-from-traces mechanics are a build-time choice.
- **Rail C's judge** — exact-leg-match is the default oracle; whether a fuzzier LLM-as-judge is ever needed is
  deferred until an ask has no single correct leg.
- **Thresholds** — the C.1 pre-release pass-rate bar and the C.2 rot-alarm baseline are tuned from the first live
  runs, not guessed here.
- **The confidence-gate value** (`minConfidence = 0.6`, `Core/interpret.js:120`) — C.2's calibration curve sets it;
  this document does not.

---

## 9. How this document was reached

The ladder grew from the "usability tests per leg" hardening pivot — the instinct that a leg like *search customer
by id* should have a corresponding *find customer {id}* test. Pressure-testing that instinct produced the four
rungs and, more importantly, the discipline that separates them.

**LESSON[a-gate-and-a-scoreboard-are-different-instruments]:** the frozen/live line is the gate/scoreboard line.
Anything needing the live model over time is a gauge you *watch*, not a gate you *pass*; conflating them yields a
green light with two incompatible meanings. A/B/B.5 are gates; all of C is watched.

**LESSON[test-the-back-the-field-only-tests-the-front]:** nearly every named AI-testing method (benchmarks,
LLM-judge, red-teaming, monitoring) aims at the model. Every routing bug this project shipped was in the code
*around* the model. The ladder's centre of gravity — A, B, B.5 — is the deterministic back that the field's
attention leaves untested, and it is a *gate* precisely because that half can be made certain while the model's
half cannot.

**LESSON[negatives-harden-more-than-positives]:** the worst bugs were *wrong* resolutions, not missing ones. A
corpus of happy-path asks is half a suite; the adversarial asks — the write that must gate, the case that must not
become a ticket, the count that must not become a write — are where the hardening actually happens.
