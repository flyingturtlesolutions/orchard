# DESIGN — The Decision Gate (the "B.5" rail)

**Status:** specced 2026-07-22, nothing built. Greenfield — no routing/eval test infrastructure exists today.
**Parent:** `docs/DESIGN_hardening_ladder.md` (the A·B·B.5·C ladder) — this doc is the authority on the B.5 rail;
the ladder owns the frame and the A/B/C rails.

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
| **B** — one recorded decision | the back | frozen (one point) | gate | yes |
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

## 3. The seam — already present

Every AI output funnels through one neck before the code reacts: `interpret()` turns it into a structured decision
object, and the code branches on *that*.

- `interpret(ask, ctx, deps)` — `Core/interpret.js:161` — takes an **injected `think`**. Feed it a frozen decision
  and no live model runs.
- The gate tests `ask → {reaction, effect}`, **never `INVOKE_SESSION`.** This is load-bearing: half the legs are
  writes, so testing *resolution* rather than *execution* is the only way an exhaustive suite over `delete_ticket`
  / `create_order` / `send_sms` is safe to run — nothing is sent, no auth, no mutation, no live site.
- Frozen input → deterministic output → a hard gate.

---

## 4. The unit under test: a REACTION, not an output

A "reaction" is a terminal branch of the decision-handling path — the finite set of distinct things the code can
*do* with a decision. The branch points, with anchors:

- **`normalizeInterpretDecision`** (`Core/interpret.js:34`) — one arm per intent; an unrecognized intent falls to
  the catch-all `INTENTS.includes(d.intent) ? d.intent : 'clarify'` (`:36`); an out-of-palette leg → `teach`
  (`:50`); a malformed clause payload → `clarify` (`:54,:59,:69,:79,:87,:95,:106`).
- **`applyConfidenceGate`** (`Core/interpret.js:120`) — a below-threshold act/nav/map/write/branch → `clarify`.
- **The dispatch half** — `_orchRunChain` and the clause runners (`_runBranchClause` etc.) in `chat.js` — run each
  clause kind, the empty-prior stop, the write-gate park, nav, fanout. (These are the reactions §10 says are not
  yet gate-able and why.)

The reaction set is read **off the code**, not brainstormed. `INTENTS` (`Core/interpret.js:21`) plus the leg
catalog plus the clause-outcome sets are its registry.

---

## 5. The proof structure

"Prove every reaction" is three sub-proofs plus a seal. None rests on enumerating inputs.

### 5.1 Enumerate — derive, never remember
The reaction checklist is **generated from the registries and branch points**, not hand-listed. Enumerating from
memory guarantees a forgotten reaction, and the forgotten reaction is where the bug hides (the case→Zendesk class
was a reaction that did not exist yet). Derivation makes "every" checkable instead of hopeful.

### 5.2 Totality — the catch-alls are the bridge, not just extra rows
The reason no output can escape into undefined behavior is that **every branch point has a fail-closed arm**: the
`:36` intent default, the `:50` out-of-palette `teach`, the `:54…:106` malformed-payload `clarify`s. These are the
mathematical bridge from an *infinite, un-enumerable input space* to a *finite, enumerable reaction set*: you can
never list every weird thing the model might emit, but you can prove (a) anything unmatched falls to a catch-all,
and (b) the catch-all degrades safely — and those two together handle every unlisted input **without listing it**.
So the catch-alls are proven by **deliberately feeding garbage** (a nonsense intent, an invented leg, a malformed
payload) and asserting each lands in the right fallback. Leave them untested and "every reaction" collapses to
"every reaction we happened to think of" — the weak version this rail exists to escape.

### 5.3 Correctness — one representative, plus structured corners
For each reaction, feed a frozen decision that lands there and assert the effect. One representative for the common
shape; structured corners (§6) for the sub-shapes.

### 5.4 The seal — coverage by construction, and a tripwire
A meta-test reads the registries and asserts **every intent and every declared outcome has ≥1 fixture** — the same
allow-list discipline as `_DECISION_RE` (`studio.js`). Add a reaction with no fixture → red. This converts "the
ones we tested" into "every one the code can reach." The residual risk (a reachable branch the derivation didn't
*see*) is closed by a **derivation tripwire**: if the derivation meets a decision-outcome shape it does not
recognize, it must **fail loudly**, never skip silently — otherwise "derived from the registries" quietly degrades
back into "the ones we remembered."

---

## 6. Fixtures

Shape: `{ decision, expectedReaction, expectedEffect }`, fed through the injected `think`.

Two sources, one library:
- **Harvested** — mined from `gl`/`gc` traces (real `INTERPRET_ASK → …` decisions), frozen. Realistic spread,
  calibrated to what the live model actually emits. Rots as the model changes → periodic re-harvest.
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
   cannot know a reaction the system SHOULD have is absent (case→Zendesk). That gap is a product judgment, and its
   only antidote is *external* — red-teaming and live usage, which discover forgotten buckets that then become
   fixtures.
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
  reaction has no fixture. This is the highest-value, lowest-cost item and it lands green today.
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
