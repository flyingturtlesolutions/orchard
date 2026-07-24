# HANDOFF — building the hardening ladder (A · B.5 · C), as of v2.74.1719

**Specs:** `docs/DESIGN_hardening_ladder.md` (the frame; A/B/C rails) · `docs/DESIGN_decision_gate.md` (the B.5
authority) — both amended 2026-07-23 after critical review; read the Status blocks first, they correct the
original premises (not greenfield; no "one neck"; B is a milestone, not a rail). This document is the BUILD map:
the stage order, what each stage delivers, what blocks it, what "done" means per stage, and the two lifecycle
tables (new-leg effect, garbage pipeline) that show what the finished arc buys. Anchors are by SYMBOL where
possible — line numbers rot (this pass already re-anchored both specs once after a 14-line insert).

**Position:** Stages 0–4 are DONE — everything buildable without CD-1a, built.
**Stage 4 (C.1/C.2 scoreboard) landed v2.74.1729** — `tools/routing-scoreboard/` (local toolchain, never the
bundle): `score.mjs` (pure classifier — violation ≻ hit ≻ redirect ≻ miss precedence, per-site tallies,
calibration bins; 14-check standalone self-test) + `scoreboard.mjs` (the corpus live through the REAL pipeline:
`buildInterpretMessages` → API at temperature 0 → `parseInterpretOutput` → `interpret()`'s normalize+gate via
injected think; palette = the SAME hop chain the extension rides — `curatedRidesForConnections` →
`harvestedRecipeLegs` per host, 60 legs / 5 hosts verified; attribution stamped per run: manifest version +
promptSha over system+palette + model + temp; output `logs/run/scoreboard-<stamp>.json` + console summary;
fail-soft per call). Honest v0 scope: 67 runnable (connector surface + clause intents + negatives); the 23
builtin asks are OUT-OF-NECK (pre-door routed — the live palette offers panel:1) and are reported skipped,
never silently dropped. `--dry-run` proved the assembly without spending a token — and caught the first draft's
0-leg palette (records carry no `app`; hop 2 derives it). **First live run is the operator's call:**
`ANTHROPIC_API_KEY` in `.env`, then `node tools/routing-scoreboard/scoreboard.mjs` (~67 calls; `--limit 10` for
a cheap first pass). Thresholds are tuned from that first record, per spec §8.

**Remaining:** Stage 5 (B5-2/3/4 fill-out, incremental) · Stage 6 (B5-5/6 — WAITS on CD-1a, cadence lane in
flight) · Stage 7 (necks #3/#4) · the ongoing disciplines (§10; first audit item: `fieldread`).
**Stage 3 (B5-0/1) landed v2.74.1727** — `Core/reactionRegistry.js` (the reaction registry over BOTH frozen
necks: interpret rows DERIVED from `INTENTS` × the v1718 disposition tables + sealed catch-all rows under
partition seal #2 `PAYLOAD_VALIDATED ∪ PALETTE_VALIDATED ∪ TERMINAL === INTENTS`; the decomposer's 15 sealed
rows; the two garbage factories — `GARBAGE_DECISIONS` structured list + `mintGarbage` seeded deterministic
mutator) + `Core/decisionGate.test.js` (the B5-0 meta-test: fixtures ⟷ rows exact parity BOTH directions; all
50 reactions each proven on the real functions as its own test line; the RAIL B milestone fixture — one golden
decision end-to-end; the B5-1 totality sweeps: 26 structured shapes + 40 minted mutations absorbed — never
throw, land in a legal intent, clarify always carries a question — plus the scheme fence and the decomposer
parse-garbage no-throw). Gate 3108/0. **Remaining: Stage 4 (C.1 scoreboard — corpus ready, tokens gate it) ·
Stage 5 fill-out · Stage 6 after CD-1a · Stage 7 necks.**

**Stage 2 (corpus v0 + A-0b) landed v2.74.1726** —
`Core/goldenAsks.js` (89 stamped entries: every one of the 60 curated recipes AND all 23 builtin legs covered —
**zero waivers on day one**, stronger than the tranche plan; the negatives seed set incl. the case→Zendesk
canonical, `delete ticket 5` mustBeGated, counts-never-write; the five per-item clause asks) +
`Core/goldenAsks.test.js` (A-0b both directions: catalog→corpus coverage AND corpus→catalog anti-rot, plus the
class cross-checks — every `mustBeGated` target verified non-auto against the catalog's own derivation).
Negative keying SETTLED: both forms (`mustNotResolve` precise + `mustNotWrite`/`mustBeGated` class-robust), an
entry may be positive+negative at once. Gate 3049/0. **Stage 4 (C.1 scoreboard) is now unblocked** — the corpus
exists; only tokens gate it. Stage 3 (B5-0/1) unchanged-next by dependency order.

**Stage 1 (A-0a) landed v2.74.1725** — `Core/catalogConformance.js`
(pure auditors: gate axes · identity · recipe legibility · palette safety, each data-in → violations-out) +
`Core/catalogConformance.test.js` (real catalog clean + STANDING test-the-test red-proofs + the derivation/enum
seals). Born green as specced, and the build itself validated the stage's method twice: calibration found
**27/84 params without an explicit `required`** (backfilled `required: false` same commit, behavior-neutral —
consumers read truthily), and the test-the-test caught the auditor's own regex missing UNDERSCORE keys
(`\bclose\b` cannot match inside `CLOSE_CASE` — fixed via `isWriteShaped` separator normalization). Gate 3037/0.

Stage 0 recap: the suite holds the embryonic rails — the frozen-seam
fixtures in `Core/interpret.test.js` (injected `think`; the v1650 INTENTS-token, v1651 payload-whitelist, v1686
case-reachability regressions), the live-trace routing pins in `Core/orchChain.test.js` / `Core/stepsPrompt.test.js`
(v1543–1549, v1712, v1714), and the §4.1 confidence-disposition tables + seal test (v2.74.1718 —
`GATED_INTENTS` / `FLAGGED_INTENTS` / `UNGATED_INTENTS` in `Core/interpret.js`, chain ≡ tables, tables ∪ ===
`INTENTS`). Everything below HARVESTS this; nothing starts from zero.

---

## 1. The arc at a glance

```
A-0a ──► corpus v0 + A-0b ──► B5-0/1 ──► B5-2/3/4 ──┐
                     │                              ├──► B5-5 ──► B5-6 ──► necks #3/#4
                     └──► C.1 + C.2 (live scoreboard)│
    CD-1a (cadence lane, in flight: 1/5 landed) ────┘
```

| Stage | Name | Blocks on | Effort | Deliverable |
|---|---|---|---|---|
| 0 | seed (DONE, v1718) | — | — | disposition tables + seal; existing fixtures |
| 1 | **A-0a** structural conformance | nothing | ~half a day | one new `Core/*.test.js`, born green |
| 2 | **corpus v0 + A-0b** | nothing (human judgment) | days, amortizable | the golden-ask corpus + coverage meta-test |
| 3 | **B5-0/1** registry + totality | nothing | ~1–2 days | reaction registry, meta-test, garbage corners |
| 4 | **C.1 + C.2** live scoreboard | corpus, tokens | ~1 day tool + per-run cost | `tools/` runner, score/redirect/calibration |
| 5 | **B5-2/3/4** fill-out | B5-0 | incremental | representatives, corners, more tables |
| 6 | **B5-5/6** effect half | **CD-1a** (in flight) | ~2 days after CD-1a | effect reactions + composition fixtures |
| 7 | **necks #3/#4** | B5-0 pattern | ~1 day each | route-ask + branch-classify gates |
| ∞ | ongoing disciplines | — | calendar | audit, re-harvest, backstop-conversion |

Everything left of B5-5 is buildable NOW with zero new plumbing. The only hard dependency in the whole arc is
CD-1a, and the cadence lane is building it anyway (extraction 1 of 5 landed v2.74.1717).

---

## 2. Stage 0 — the seed (done; inventory, so nothing is rebuilt)

| Exists today | Where | It is the embryo of |
|---|---|---|
| injected-`think` seam tests | `Core/interpret.test.js` ("orchestration over an injected think") | B5-2 representatives |
| harvested-garbage regressions | v1650 camelCase intent · v1651 payload whitelist · v1666 `[object Object]` (parse layer) · v1342 op-in-wrong-field | B5-1 totality corners, factory 2 |
| live-trace routing pins | `orchChain.test.js` (v1543/1544/1547/1549 fan-out grammar), `stepsPrompt.test.js` (v1714 `restoreQuantifier` + the `isFanoutAsk(repairedStep)` cross-stage contract) | the decomposer subject + the cross-stage reaction class |
| disposition tables + seal | `Core/interpret.js` exports + the v1718 test block | B5-0's first slice; the §5.4 tripwire's first sensor |
| catalog probes (one-off, this review) | 18/18 write axes · 39/39 identityProbe · enum split verified | A-0a's checks, currently un-frozen — Stage 1 freezes them |

---

## 3. Stage 1 — A-0a: structural catalog conformance

**Deliverable:** one new pure test file (suggested: `Core/catalogConformance.test.js`) over
`CONNECTOR_RECIPES` + `Core/palette.js` + the enums. No model, no corpus, no network.

**The checks** (each maps to a bled-and-closed gap; the suite's job is KEEPING them closed):

1. Gate-axis completeness — every `write: true` recipe declares BOTH `reversible` and `outward` (the v1686 gap;
   18/18 today).
2. Identity conformance — every `verifyIdentity: true` recipe declares `identityProbe` (39/39 today).
3. Safety, per subject (the two-enums correction, ladder §1): palette `safety` values ∈ `{auto, confirm, gated}`;
   no write-shaped self leg is `'auto'`; `safetyClassForMethod` floors non-GET at `'gated'` (unit-test the
   derivation); `SAFETY_CLASSES` stays `['auto','gated','destructive']`. Never assert per-Ground `safetyClass`
   values — user state.
4. Router-legibility, decidable half — `does` non-empty everywhere; every declared param carries an explicit
   `required` boolean. (Name-similarity is NOT here — human audit, §10.)
5. Enum/vocabulary seals not yet frozen elsewhere — `INTENTS` all-lowercase already lives in `interpret.test.js`;
   move nothing, duplicate nothing, only add what has no home.

**Test-the-test (required):** each check verified red once against a synthetic bad entry (a local mutated copy —
never a committed bad leg) before the green version lands. A conformance suite that has never been seen red is a
hope, not a check.

**Acceptance:** lands green in the same commit as its red-proof notes; `npm test` cost imperceptible.

---

## 4. Stage 2 — corpus v0 + A-0b: the golden-ask library

**Deliverable:** the corpus module + the coverage meta-test, landing TOGETHER (A-0b cannot precede the corpus —
the born-red paradox both specs now document).

- **Shape (presumed, per spec §8/§12):** an importable sibling data module (e.g. `Core/goldenAsks.js`), entries
  keyed by leg id / reaction:
  `{ ask, expect: { legId | reaction }, negatives?: [{ mustNotResolve | mustLandIn }], mintedAt: 'v2.74.NNNN' }`.
  Every entry STAMPED (`mintedAt`) — parent §8's fixture-provenance rule.
- **Authoring scope:** ≥1 ask per enabled curated leg (60) + the `domain:'self'` palette legs; the negatives seed
  set from ladder §6 — `open a case` must NOT → `zendesk_create_ticket`; `delete ticket 5` → `delete_ticket` AND
  gated; `how many are open` must never → a write; the per-item clause asks (branch / fieldRead / case) — the
  family this project has actually bled on.
- **A-0b meta-test:** every enabled leg ↔ ≥1 corpus entry; a new leg with no ask is red. Same allow-list
  discipline as `_DECISION_RE`.
- **Negative keying** is an open decision (spec §8) — settle it when authoring the first negatives: by
  forbidden-leg, by required-reaction-class, or both.

**Honest cost note (ladder §6, amended):** the catalog is the oracle for BINDINGS only. The ask→leg pairs and all
negatives are hand-authored — this stage is the arc's main human-judgment spend. Amortizable: author per-site
tranches (VS first — it is the daily driver), let A-0b's red list drive the rest.

**Acceptance:** A-0b green over the authored tranche with un-authored legs explicitly waivered (a visible,
shrinking allow-list — never a silent skip), then the waiver list driven to zero.

---

## 5. Stage 3 — B5-0/1: the Decision-Gate spine + totality

**Deliverable 1 — the reaction registry + meta-test (B5-0),** over BOTH frozen subjects:

- **interpret neck:** reactions derived from `INTENTS` × the disposition tables × the normalize catch-alls
  (intent-default → clarify · out-of-palette → teach · the seven malformed-payload clarifies · the confidence
  degradations · the v1342 decompose flag · the asserted absences: `case` decided, `fieldread` undecided).
- **decomposer neck:** reactions from `stepsPrompt.js`'s pure surface — N steps · the lexical floor · compound
  flags · dropped · quantifier-restored — plus the CROSS-STAGE class: routing-relevant properties of emitted text
  (quantifier preserved, case-target preserved).
- The meta-test asserts every registered reaction has ≥1 fixture. **Born-red rule:** B5-0 lands in the SAME
  commit as its minimal fixture set, seeded by MAPPING the Stage-0 inventory into the registry (harvest, not
  authoring). Rail B is this stage's first passing dispatch fixture — a milestone line in the commit message,
  not a suite.

**Deliverable 2 — the totality corners (B5-1),** built by the garbage pipeline (§12 below): per BRANCH POINT
(not per reaction), feed garbage and assert (a) it lands in the right fallback and (b) **it never throws** —
landing at all is part of the proof. Includes the boundary corners: confidence exactly at 0.6, empty/null/missing
payloads, the fused/spaced foreach forms.

**Acceptance:** registry meta-test green; a deliberately unregistered reaction (local mutation) goes red; the
tripwire fires loudly on an unrecognized disposition (the tables ∪ === `INTENTS` assertion already does this for
intents — extend the pattern to each new table).

---

## 6. Stage 4 — C.1 + C.2: the live scoreboard, first light

**Deliverable:** a LOCAL tool (suggested: `tools/routing-scoreboard/` — the `tools/progress-digest` precedent:
local toolchain, never the shipped bundle), run manually at first.

One run = the corpus replayed against the **live** model with the **real** palette, producing three readings:

1. **C.1 aim score** — resolved leg vs expected, per site; diff-on-regression report `{ask, expected, got, why}`.
2. **C.2 redirect-rate** — fraction landing in guard-rail classes (clarify/teach/gate/substitute) on the FIXED
   corpus; the leading rot indicator.
3. **C.2 calibration curve** — self-reported confidence vs actual correctness, binned. This is what VALIDATES
   (or moves) `minConfidence = 0.6` — deliberately pulled EARLY in the arc because B5's degradation fixtures
   freeze behavior around that constant (the circularity the review broke).

**Attribution is non-negotiable from run one:** every run records the manifest version + a hash of the interpret
prompt; prompt-touching commits get a re-run. Without it a score move cannot be blamed on our change vs provider
drift, and the gauge is noise.

**Plumbing decisions owed at build time** (spec §8): output location (`logs/run/scoreboard-*.json` presumed —
git-ignored, version-stamped, `findings.md` gets the digest line), cadence + owner (manual pre-release first;
cron later), thresholds (tuned from the first runs, never guessed). **Never gates a commit** — a number in front
of a person at release time is judgment, not a gate.

**Cost:** ~120–200 corpus entries × 1 interpret call each per run — the only recurring token spend in the arc.

---

## 7. Stage 5 — B5-2/3/4: filling the gate out

- **B5-2** — one representative fixture per registered reaction (harvest first: mine `gl`/`gc` traces for real
  `INTERPRET_ASK → …` decisions; author only what harvest can't reach).
- **B5-3** — structured corners per named axis: value · bundle · empty · null · missing · out-of-palette ·
  at-threshold. Constructed, not sampled; they do not rot.
- **B5-4** — extend table-driving to the remaining branch-shaped routers (candidates: the per-intent
  malformed-payload validators; each new table gets its own ∪-completeness seal). Every table added converts a
  slice of "sealed memory" back into true derivation — the §5.1 amended discipline.

---

## 8. Stage 6 — CD-1a lands → B5-5/6: the effect half

**Dependency status:** CD-1a (the driver extraction with injected reporters, `DESIGN_cadence.md`) is IN FLIGHT on
the cadence lane — "extraction 1 of 5" landed v2.74.1717 (`Core/rideStep`). Do not build ahead of it; the specs
already record why (`chat.js` is DOM-coupled and outside the glob).

- **B5-5** — extend the registry to the dispatch/effect reactions (each clause kind's outcomes, the empty-prior
  stop, the write park, nav, fan-out spawn) via the injected reporter; assert effects with no DOM. The fixture
  shape GROWS here to `{decision, expectedReaction, expectedEffect}` (phase 1's honest shape is
  `{rawDecision → normalizedDecision}` — spec §6, amended). **Doubles as CD-1a's differential oracle:** panel
  reporter ≡ SW reporter, per reaction — one suite proves both.
- **B5-6** — the composition layer: frozen SEQUENCES asserting state handoff between steps (empty-prior →
  stop; read → fan-out consumes `st.lastValue`; write park → approval spine). Seam bugs disguise themselves as
  late aim errors — they need sequence fixtures, not more single-decision coverage.

---

## 9. Stage 7 — necks #3 and #4: route-ask + branch-classify

Method-identical instantiations of the B5 pattern (registry + totality + representatives) over the remaining
routing-grade necks:

- **route-ask** — the pre-door router (mis-sent "open a case showing each…" → demonstrate, trace 164717).
- **branch-classify** — the per-item arm router (the "couldn't tell 22" vendor-explanation misclass); its
  reactions include the per-arm verdicts and the couldn't-tell fallback.

**The neck-registry seal comes first:** a small table of `{operation, grade: routing|presentation, gate:
built|owed|waived}` sealed against the `role: 'routing'` tags in `AnthropicService.js` — a new routing-tagged
operation without a registry row goes red. That makes "which necks have gates" a derived fact, not a memory.

---

## 10. Ongoing disciplines (no end state)

- **The partition audit**, on a CALENDAR (registry events cannot trigger it — amended spec §4.3). First agenda
  item, already queued: decide `fieldread`'s confidence-gate disposition (recorded UNDECIDED in
  `UNGATED_INTENTS`, v1718).
- **Re-harvest ADDS, never replaces** — a shape the model ever emitted is forever a legitimate back-test; only
  representativeness decays (a Rail C concern).
- **Backstop-conversion** (ladder §9 lesson): every recurring FRONT failure gets a narrow deterministic backstop
  that restores the user's own signal, gated + logged (`restoreQuantifier` / `STEPS ▸ quantifier restored` is the
  type specimen). This is the arc's only mechanism for MOVING a failure class from C's scoreboard into B5's gate.
- **Scoreboard watching** — C runs pre-release; redirect-rate acceleration is the early alarm; the substitution
  log is the internal missing-bucket antidote (amended spec §8.2).

---

## 11. What the finished arc buys — the new-addition lifecycle

The point of the whole build, as a checklist the suite ENFORCES rather than a convention someone must remember:

| You add… | What goes red, same `npm test` run | What you are forced to do |
|---|---|---|
| a new **leg** | A-0a (if declaration incomplete) + A-0b (no golden ask) | complete the declaration; author ≥1 ask (+negatives) |
| a new **field** on legs | (invariant #3, CLAUDE.md — the three-hop threading; A-0a can check presence) | thread catalog→record→leg + merge |
| a new **intent** | the §4.1 seal: tables ∪ === `INTENTS` | explicitly disposition it: gated / flagged / ungated-by-design — the `fieldread` omission is now unrepresentable |
| a new **reaction** (branch arm, clause outcome) | B5-0 registry meta-test | register it + give it a fixture (incl. its fail-closed arm) |
| a new **routing-grade model call** | the neck-registry seal (Stage 7) | add the registry row: gate built, owed, or waived — visibly |
| a new **decision marker** | (invariant #1 — `_DECISION_RE`; unchanged, sibling discipline) | add it to the allow-list |
| nothing — the **model drifts** | nothing red (correctly); C.2 redirect-rate moves | read the scoreboard; convert recurring failures via backstops |

The last row is the honest one: the gate never pretends to catch aim. That is the scoreboard's job, and the
backstop-conversion loop is how scoreboard findings become gate rows over time.

---

## 12. The garbage pipeline (B5-1's factory floor)

**Rule zero: the gate REPLAYS garbage; it never GENERATES it.** All generation is offline, at authoring time;
survivors are frozen, stamped, and replayed deterministically forever. No `Math.random`, no LLM, no network in
the gate itself.

Three factories, one triage:

1. **The code mutator** (schema-level garbage): a seeded, deterministic mutator over the decision schema — wrong
   types, nulls, missing/extra fields, strings-for-numbers. Exhaustive over its mutation grammar, free,
   reproducible. Better than an LLM at this class.
2. **Harvest** (garbage that actually happened): the v1650/v1651/v1666/v1342 class — real model sloppiness from
   traces, frozen. Already running; keep mining `gl`/`gc`.
3. **An LLM, prompted per garbage CLASS** (plausible garbage code can't imagine): classes DERIVED from the
   registries, one prompt each — "outputs naming tools not in this palette", "malformed map clauses", "instruction-
   shaped text inside params" (the injection class). Offline only.

```
derive classes from registries
  → generate candidates (mutator + LLM-per-class + harvest)
  → run each through the REAL code once, at authoring time
  → triage: lands in the right catch-all → freeze (stamped) as a fixture
            lands anywhere else          → A FOUND BUG, today, at prompt price
  → the gate replays frozen survivors forever
```

The triage row is the payoff: a candidate that escapes the catch-alls at authoring time is a discovered defect,
not a broken fixture. Factory 3's find-rate decays as the catch-alls harden — expected; its frozen output keeps
its regression value forever.

---

## 13. Open decisions carried (owed to build time, deliberately)

| Decision | Owed at | Note |
|---|---|---|
| corpus storage shape + harvest tooling | Stage 2 | importable sibling module presumed |
| negative keying (forbidden-leg vs required-class vs both) | Stage 2, first negatives | spec §8 |
| fixture invalidation rule (which prompt changes invalidate what) | Stage 3+ | stamping is already fixed; only the rule is open |
| C plumbing: output home, cadence, owner, thresholds | Stage 4 | attribution is NOT open — fixed from run one |
| `fieldread` confidence disposition | first partition audit | recorded UNDECIDED in code, v1718 |
| LLM-as-judge for C.1 | deferred until an ask has no single correct leg | exact-match is the default oracle |

---

## 14. Definition of done (for the arc, not the disciplines)

- Every enabled leg has a stamped golden ask; a new leg without one cannot land green (A green).
- Every intent carries an explicit confidence disposition; every registered reaction has a fixture; every branch
  point has a proven, never-throwing fail-closed arm (B5 phases 1–2 green, incl. effects post-CD-1a).
- All four routing-grade necks are gated or visibly waived in the neck registry.
- The scoreboard produces attributed runs (score + redirect + calibration) on a stated cadence, and the 0.6
  threshold is either validated or replaced by its curve.
- The audit calendar exists and has consumed its first item (`fieldread`).

End state in one sentence: **every routing bug ever hit is a permanent fixture; every new leg, intent, reaction,
or routing neck is red until covered or visibly waived; and the one thing that cannot be gated — the model's
aim — has an attributed scoreboard honestly watching it instead of a test pretending to.**
