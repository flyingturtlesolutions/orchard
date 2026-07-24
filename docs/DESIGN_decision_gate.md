# DESIGN — The Decision Gate (the "B.5" rail)

**Status:** specced 2026-07-22, amended 2026-07-23 (critical review), not yet built AS A NAMED SUITE — but **not
greenfield**: `Core/interpret.test.js` already exercises this exact seam (injected `think`, incl. the v1650
INTENTS-token, v1651 payload-whitelist and v1686 case-reachability fixtures — v1651 being this doc's own §-B
canonical example), and the §4.1 disposition tables + seal test landed **v2.74.1718**. The build path is
**harvest and formalize** — map existing fixtures into the registry — not stand-up-parallel-infrastructure.
**Parent:** `docs/DESIGN_hardening_ladder.md` (the A·B·B.5·C ladder, amended 2026-07-23) — this doc is the
authority on the B.5 rail; the ladder owns the frame and the A/B/C rails. Parent amendments reflected here:
B is a **milestone inside B5-0**, not a peer rail; the **decomposer is B.5's second subject** (§3); fixtures are
**stamped** with the manifest version that produced them (§6).

**Thesis:** an AI app is a **stochastic front** (the model's aim) bolted to a **deterministic back** (the code that
catches what the model says and acts on it). Almost all AI testing aims at the front and is therefore a *scoreboard*
— live, sampled, watched. The Decision Gate aims at the **back** with the model **frozen**, which makes it a real
**gate** — deterministic, pass/fail, in the green suite. It proves a bounded, honest claim:

> *For every reaction the decision-handling code can reach — as derived from its own branch points and registries —
> we have shown it does the right thing, including the catch-alls that absorb everything else.*

Every clause of that sentence is a fence. §8 is where the fence is drawn.

---

## 1. The ladder, and where this sits

Four rails, established as the hardening frame. Two axes separate them: **model frozen vs live**, and **gate vs
scoreboard** (a gate you *pass* and it *proves*; a scoreboard you *watch* and it *warns*).

| Rail | Aims at | Model | Verdict | In the green gate? |
|---|---|---|---|---|
| **A** — structural conformance | the catalog itself | — (no model) | gate | yes |
| **B** — one recorded decision | the back | frozen (one point) | milestone | inside B5-0 — not a separate suite |
| **B.5 — the Decision Gate** *(this doc)* | the back | **frozen (a derived set)** | **gate** | **yes** |
| **C** — live routing eval | the front (aim) | live | scoreboard | no — watched |

**The frozen/live line IS the gate/scoreboard line.** The instant an instrument needs the live model to produce
its reading, it has left this rail and become Rail C. This document specifies a gate and only a gate. What it is
NOT — the dashboard, the verifier, the audit — is §9.

---

## 2. The claim, and its exact scope

The Decision Gate does not test what the AI *outputs* (infinite). It tests what the code *does with* those
outputs, which is finite. It proves **completeness over the reachable reaction set**, and it is deliberately silent
on four things it cannot see from inside (§8): whether that set is the *right* set, whether one test per reaction
covers it, what happens across *chained* decisions, and whether the model's *aim* is any good (that is Rail C).

---

## 3. The seam — and the correction: there is no "one neck"

**Correction (2026-07-23).** The first draft claimed every AI output funnels through `interpret()`. Verified
against the code: `Services/AnthropicService.js` carries ~23 distinct model-call operations, each with its own
parse/sanitize bracket, and at least FOUR are **routing-grade** — their output picks what runs: `interpret`,
`route-ask` (the neck that mis-sent "open a case showing each…" → demonstrate, trace 164717), `decompose-steps`
(v1708/1712/1714), and `branch-classify` (the vendor-explanation misclass). Three of the last five live routing
bugs entered through necks the first draft's gate never saw.

The consequence is a **NECK REGISTRY**, not one wider gate: the `#call` sites self-declare `role: 'routing' | …`
plus an `operation` label — so the CANDIDATE list is **derived from the code**, while the GRADE is **sealed
judgment**. (Built 2026-07-23, and the build corrected this paragraph's first draft: `role: 'routing'` is the
MODEL-TIERING role, not a blast-radius grade — `case-brief` carries the tag yet is presentation by function.
`Core/neckRegistry.js` records the grades; its seal test derives the candidates from the source and demands
exact parity, so a new routing-tagged operation without a graded row is red. A routing-GRADE row can never be
waived — built or owed only.) Routing-grade necks get a gate; shaping/presentation necks are waived naming the
bracket that re-validates them. **This document scopes to the `interpret` neck.** The DECOMPOSER is subject #2
(parent §3): same method, its own reaction space (N steps · floor · compound · dropped · quantifier-restored),
plus the cross-stage class — one stage's TEXT is the next stage's ROUTING INPUT (`stepsPrompt.test.js` already
freezes `isFanoutAsk(repairedStep) === true`). `route-ask` and `branch-classify` are subjects #3/#4,
method-identical, specced when their turn comes.

The interpret neck itself:

- `interpret(ask, ctx, deps)` — `Core/interpret.js:174` — takes an **injected `think`**. Feed it a frozen decision
  and no live model runs. (With `think` injected the ask is nearly inert — the DECISION is the real input; §6's
  fixture shape reflects that.)
- The gate tests `decision → reaction`, **never `INVOKE_SESSION`.** This is load-bearing: 18 of the 60 curated
  legs are writes, so testing *resolution* rather than *execution* is the only way an exhaustive suite over
  `delete_ticket` / `create_order` / `send_sms` is safe to run — nothing is sent, no auth, no mutation, no live
  site.
- Frozen input → deterministic output → a hard gate.

---

## 4. The unit under test: a REACTION, not an output

A "reaction" is a terminal branch of the decision-handling path — the finite set of distinct things the code can
*do* with a decision. The branch points, with anchors:

- **`normalizeInterpretDecision`** (`Core/interpret.js:47`) — one arm per intent; an unrecognized intent falls to
  the catch-all `INTENTS.includes(d.intent) ? d.intent : 'clarify'` (`:49`); an out-of-palette leg → `teach`
  (`:63`); a malformed clause payload → `clarify` (`:67,:72,:82,:92,:100,:108,:119`).
- **`applyConfidenceGate`** (`Core/interpret.js:133`) — a below-threshold `act`/`navigate`/`map`/`write`/`branch`
  → `clarify`. TWO deviations the first draft missed, both load-bearing for fixtures: a below-threshold
  `decompose` does NOT become clarify — it passes through carrying `lowConfidence: true` (v1342; the dispatch
  guard reads the flag) — and `case` is DELIBERATELY ungated (PP-3: "the absence is a decision rather than an
  omission" — a wrongly-opened case costs a click). A registry seeded from the first draft's summary would have
  minted two wrong fixtures. Deliberate pass-throughs are therefore a fixture CATEGORY — **asserted absences** —
  not omissions.
- **The `fieldread` finding (2026-07-23, surfaced by performing §5.1's derivation by hand):** a below-threshold
  `fieldread` passes ungated with NO recorded decision either way — unlike `case`, no comment marked the absence
  as chosen. It fans N per-item reads (the gated `map`'s rationale, weakened by same-record cheapness). Now
  recorded in code as UNDECIDED in the §4.1 disposition tables, owed to the partition audit — the gate asserts
  CURRENT behavior with provenance; it does not invent the decision.
- **The dispatch half** — `_orchRunChain` and the clause runners (`_runBranchClause` etc.) in `chat.js` — run each
  clause kind, the empty-prior stop, the write-gate park, nav, fanout. (These are the reactions §10 says are not
  yet gate-able and why.)

The reaction set is read **off the code**, not brainstormed. `INTENTS` (`Core/interpret.js:21`) plus the leg
catalog plus the clause-outcome sets are its registry.

### 4.1 The disposition tables — making the branch points derivable (LANDED v2.74.1718)

§5.1 commands "derive, never remember," and §8.1 funnels all residual risk to the §5.4 tripwire — but an if-chain
is not derivable: no data structure said which intents the confidence gate covers, which is exactly how the
`fieldread` hole went unrecorded. The fix is in the CODE. `Core/interpret.js` now exports frozen
confidence-disposition tables:

- **`GATED_INTENTS`** (below threshold → clarify): `act · navigate · map · write · branch`
- **`FLAGGED_INTENTS`** (below threshold → `lowConfidence` flag, passes through): `decompose` (v1342)
- **`UNGATED_INTENTS`** (passes by design or by record): `clarify · teach · answer` (terminal/safe — they ARE the
  degradations), `case` (DECIDED, PP-3), `fieldread` (UNDECIDED — recorded 2026-07-23, owed to the audit)

A **seal test** (`interpret.test.js`) derives fixtures from the tables and runs the real `applyConfidenceGate`
against every intent at low and high confidence, plus the completeness assertion **tables ∪ === `INTENTS`** — add
an intent anywhere without placing it in a table and the suite goes red, by construction. The if-chain keeps its
exact behavior (zero refactor risk); the tables make forgetting LOUD. This is B5-0's first real slice, landed
ahead of the registry.

---

## 5. The proof structure

"Prove every reaction" is three sub-proofs plus a seal. None rests on enumerating inputs.

### 5.1 Enumerate — derive where the code is data, seal where it is not
The reaction checklist is **generated from the registries and branch points**, not hand-listed. Enumerating from
memory guarantees a forgotten reaction, and the forgotten reaction is where the bug hides (the case→Zendesk class
was a reaction that did not exist yet). Derivation makes "every" checkable instead of hopeful.

**Honesty about the sensor (2026-07-23):** derivation can only READ what is data. `INTENTS`, the frozen outcome
enums (`ITEM_OUTCOMES`, `SAFETY_CLASSES`) and the §4.1 disposition tables are derivable; an if-chain is not — and
"derived from the code" quietly degrades into "remembered" wherever the code is branch-shaped (the `fieldread`
hole is the proof: a registry cross-checked against `INTENTS` alone would still have missed it, because no enum
encoded gate membership). The discipline is therefore twofold: **table-drive the branch points that route** (make
them data — §4.1 is the type specimen), and where a branch stays code, keep a hand-registry SEALED against the
nearest data structure so forgetting is loud. "Derive, never remember" is the goal; "sealed memory, loud when
stale" is the honest floor.

### 5.2 Totality — the catch-alls are the bridge, not just extra rows
The reason no output can escape into undefined behavior is that **every branch point has a fail-closed arm**: the
`:36` intent default, the `:63` out-of-palette `teach`, the `:67…:119` malformed-payload `clarify`s. These are the
mathematical bridge from an *infinite, un-enumerable input space* to a *finite, enumerable reaction set*: you can
never list every weird thing the model might emit, but you can prove (a) anything unmatched falls to a catch-all,
and (b) the catch-all degrades safely — and those two together handle every unlisted input **without listing it**.
So the catch-alls are proven by **deliberately feeding garbage** (a nonsense intent, an invented leg, a malformed
payload) and asserting each lands in the right fallback. Leave them untested and "every reaction" collapses to
"every reaction we happened to think of" — the weak version this rail exists to escape.

**Two sharpenings (2026-07-23):** totality's enumeration unit is the **BRANCH POINT**, not the reaction — the
proof needs "every branch point has a fail-closed arm," and a new validator that THROWS instead of clarifying
escapes the reaction set entirely (a throw is not a reaction). So the garbage assertions include, explicitly:
**never throws on arbitrary JSON-shaped garbage** — landing in the right fallback AND landing at all.

### 5.3 Correctness — one representative, plus structured corners
For each reaction, feed a frozen decision that lands there and assert the effect. One representative for the common
shape; structured corners (§6) for the sub-shapes.

### 5.4 The seal — coverage by construction, and a tripwire
A meta-test reads the registries and asserts **every intent and every declared outcome has ≥1 fixture** — the same
allow-list discipline as `_DECISION_RE` (`studio.js`). Add a reaction with no fixture → red. This converts "the
ones we tested" into "every one the code can reach." The residual risk (a reachable branch the derivation didn't
*see*) is closed by a **derivation tripwire**: if the derivation meets a decision-outcome shape it does not
recognize, it must **fail loudly**, never skip silently — otherwise "derived from the registries" quietly degrades
back into "the ones we remembered." The tripwire's SENSOR is concrete, not aspirational: the §4.1 completeness
assertion (tables ∪ === `INTENTS`) is its first instance — an intent added anywhere without a disposition lands
red, by construction.

---

## 6. Fixtures

**Phase-1 shape** (the pure half): `{ rawDecision → expectedNormalizedDecision }` — intent, flags
(`lowConfidence`), question, why. There ARE no effects in phase 1 (`chat.js` is outside the glob — §10); the
`{ decision, expectedReaction, expectedEffect }` shape arrives with **B5-5**, when the injected reporter gives
effects a pure surface. Every fixture is **STAMPED with the manifest version** that produced it (parent §8).

Two sources, one library:
- **Harvested** — mined from `gl`/`gc` traces (real `INTERPRET_ASK → …` decisions), frozen. Realistic spread,
  calibrated to what the live model actually emits. **Correction (2026-07-23): harvested fixtures never rot as
  BACK-tests** — a shape the model once emitted is forever a legitimate robustness input, and deleting old
  fixtures deletes regression coverage. What decays is their REPRESENTATIVENESS (evidence about today's model — a
  Rail C concern). So re-harvest **adds, never replaces**.
- **Structured corners** — hand-authored to hit the named rare axes the harvested set won't reliably reach:
  *value · bundle · empty · null · missing · out-of-palette · confidence-exactly-at-threshold*. **Structured beats
  statistical here** — you cover the rare-but-dangerous shape by *construction*, not by sampling and hoping. Does
  not rot.

---

## 7. What "does the right thing" means — and why it differs for a catch-all

- **A normal reaction** → correct *success*: dispatched to the right leg with the right bindings.
- **A catch-all** → correct *failure*: degraded safely and recoverably — a question, a refusal, a teach-offer —
  **never a crash and never a confident wrong move.** This is a different criterion (safe failure, not correct
  success) and the more important one, because the catch-all is the behavior under the *unanticipated*, which is
  where real incidents come from.

---

## 8. The fence — what this gate does NOT prove

Stated plainly so a green board is never mistaken for more than it is:

1. **"Reachable as derived" is a set-equality.** The claim is airtight only where {branches the code can actually
   reach} = {branches the derivation reads}. Drift has two directions: a reachable-but-unread branch (a silent
   hole — the list was short) and a read-but-unreachable branch (a handler nothing can trigger — a smell). All
   residual risk funnels here; the §5.4 tripwire is its only guard.
2. **The missing-bucket gap is invisible from inside.** The gate proves the reactions the code HAS are correct; it
   cannot know a reaction the system SHOULD have is absent (case→Zendesk). That gap is a product judgment with
   TWO antidotes, not one: the INTERNAL instrument is §9's substitution log (unbuilt-intent demand recorded on
   live traffic — the case→Zendesk shape as a stream), and the external one is red-teaming and live usage. Both
   discover forgotten buckets that then become fixtures.
3. **One representative may not represent.** A hidden sub-shape inside a reaction (the `[object Object]` class)
   passes the representative and fails its sibling. Corners chip at this; they do not eliminate it.
4. **Single-decision, not chains.** The gate tests one decision → one effect. Seam bugs between chained steps
   (empty-prior → dispatch) are a *separate* layer (§11 phase 2), and they disguise themselves as late aim errors,
   so they need their own fixtures — not more single-decision coverage.
5. **It does not test aim.** Whether the model *lands in the right reaction* is Rail C. This gate assumes the
   decision as given and tests only the handling.

---

## 9. What is explicitly NOT part of this gate

The last conceptual correction, recorded so it is not re-blurred: the following are real and worth building, but
they are **not** the Decision Gate and most are Rail C by nature.

- **The dashboard** — calibration curve (does confidence track correctness), redirect-rate + acceleration (is the
  model rotting behind the guard rails), substitution log (unbuilt-intent demand). All need the **live** model
  over **time** → gauges, not gates → Rail C.
- **The verifier** — an independent second opinion on a specific confident-wrong decision (the adversarial-refute
  pattern). A runtime check, not a gate.
- **The partition audit** — a human, on a cadence, asking "is the reaction list still honest." The one thing the
  gate cannot do about itself.

A gate you pass; a dashboard you watch; a verifier you invoke; an audit you perform. Four natures. This document is
only the first.

---

## 10. Grounding — and the CD-1a coupling that splits the build

The verification that shapes everything: **the two halves of the target have different testability today.**

- **The normalize/gate half is already pure** — `normalizeInterpretDecision`, `applyConfidenceGate`, `interpret`
  live in `Core/interpret.js`, which is in the `npm test` glob. Its reactions (dispatch-selection, teach, clarify,
  the confidence degradations, the malformed-payload fallbacks) are **gate-able now**, no new plumbing.
- **The dispatch/effect half is not** — `_orchRunChain` and the clause runners live in `chat.js`, coupled to the
  DOM (`_setMessageBody`/`_orchFinalize`), and `chat.js` is **not** in the test glob. Their reactions (the clause
  effects, the empty-prior stop, the write park) cannot be asserted deterministically until the runner is lifted
  into a Core driver with an **injected reporter** — which is exactly **`DESIGN_cadence.md` CD-1a**.

So the Decision Gate and the cadence driver-extraction are the same lever seen twice: CD-1a makes the *effect* half
testable, and this gate is one of the things that makes CD-1a *safe* (a complete gate over the effect reactions is
the differential oracle proving the panel reporter and SW reporter agree on every reaction). Build order follows
from the split.

---

## 11. Build ladder

**Phase 1 — now, over the pure normalize/gate core** (`Core/interpret.js`, in the test glob):

- **B5-0** — the reaction registry + derivation + meta-test (the coverage spine). Fails if a normalize/gate
  reaction has no fixture. **Born-red honesty** (the parent's A-0 lesson, applied to itself): a meta-test
  demanding ≥1 fixture per reaction is RED by construction until the fixtures exist — so B5-0 lands in the same
  commit as its minimal fixture set, seeded by MAPPING the existing `interpret.test.js` coverage into the
  registry (harvest, not authoring). The §4.1 disposition seal (landed v2.74.1718) is its first slice, already
  green in the suite.
- **B5-1** — the catch-all/totality corners (§5.2): intent default, out-of-palette teach, malformed-payload
  clarifies. These are the totality proof.
- **B5-2** — one-representative fixtures per normalize/gate reaction (harvested + authored).
- **B5-3** — structured corners per named axis (§6).
- **B5-4** — the derivation tripwire (§5.4): fail loud on an unrecognized outcome shape.

**Phase 2 — after CD-1a** (the effect half becomes assertable):

- **B5-5** — extend the seam to the dispatch/effect reactions via the injected reporter; assert effects with no
  DOM. Doubles as CD-1a's differential oracle (panel reporter ≡ SW reporter, per reaction).
- **B5-6** — the composition/seam layer: frozen *sequences* asserting state handoff between steps (empty-prior,
  narrowing, prior threading). A different fixture shape, keyed to the "distance-from-handoff" attribution rule.

Livability: after **B5-0/1** the coverage spine and the totality proofs exist and gate green — the forgotten
reaction and the un-degrading catch-all, the two nastiest classes, are closed over the pure core immediately.

---

## 12. What this deliberately does NOT decide

- **Fixture storage location and the harvest tooling** — a build-time choice; a sibling corpus keyed by reaction,
  with the meta-test enforcing 1:1, is the presumed shape.
- **The exact reaction taxonomy** — it is *derived* at build time from the registries, not frozen here; freezing
  it would re-introduce the memory-enumeration this rail rejects.
- **The composition layer's fixture shape** (B5-6) — deferred until CD-1a lands and there is an effect half to
  chain.

---

## 13. How this document was reached

The rail was named in the A/B/B.5/C hardening ladder (from the "usability tests per leg" pivot), then pressure-
tested. Two corrections are load-bearing and are kept visible:

- **It is a gate, not a dashboard.** An earlier synthesis bundled the calibration/redirect gauges *into* B.5 and
  called the whole thing B.5. That erased the frozen/live boundary the ladder is built on. The gauges are Rail C;
  this rail stays a gate (§9).
- **Completeness comes from the finite reaction space, not from covering inputs.** The proof is a funnel: infinite
  outputs → one decision object → a finite, derivable reaction set, with catch-alls bridging the un-enumerable
  remainder (§5.2).

**LESSON[a-gate-and-a-scoreboard-are-different-instruments]:** the frozen/live line is the gate/scoreboard line.
Anything that needs the live model over time is a gauge you watch, not a gate you pass; conflating them gives you a
green light with two incompatible meanings.

**LESSON[certify-a-finite-space-completely-not-an-infinite-one-badly]:** you cannot test everything a model emits,
and trying makes "coverage" a wish. Partitioning by the environment's *finite* reaction surface — derived from the
code, sealed by catch-alls and a meta-test — trades an impossible goal for an achievable, checkable one. The power
is in the limit.
