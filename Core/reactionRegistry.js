/**
 * Core/reactionRegistry.js — B5-0: the REACTION REGISTRY over the two frozen necks (v2.74.1727). PURE.
 *
 * Spec: docs/DESIGN_decision_gate.md §4/§5 (amended) · docs/HANDOFF_hardening_arc.md §5.
 *
 * The registry is the derivable half of "derive, never remember" (§5.1 amended: derive where the code is DATA,
 * seal where it is not):
 *   · DERIVED rows — built programmatically from `INTENTS` and the v1718 confidence-disposition tables. Add an
 *     intent and rows appear; the fixture meta-test (decisionGate.test.js) then demands fixtures for them → red
 *     until covered. That IS the §5.4 tripwire, sensor #2.
 *   · SEALED rows — the decomposer/classify/router/wfmatch/judge/sweep/seeddir/stepil surfaces are
 *     if-chain-shaped, so their rows are hand-frozen HERE, each thin-fixtured on its real functions. The
 *     normalize-validation partition itself is code-owned since B5-4 (v2.74.1736, tables in interpret.js) and
 *     sealed by `PAYLOAD_VALIDATED ∪ PALETTE_VALIDATED ∪ TERMINAL === INTENTS` — an intent without a validation
 *     class is unrepresentable (partition seal #2, the v1718 pattern reapplied).
 *
 * Also here: B5-1's garbage factories (HANDOFF §12). RULE ZERO — the gate REPLAYS garbage, never GENERATES it at
 * random: `GARBAGE_DECISIONS` is a frozen structured list (constructed, never rots), and `mintGarbage(seed, n)`
 * is a SEEDED deterministic mutator (same seed → same garbage, forever — no Math.random, which the workflow
 * runtime bans for exactly this reason).
 */

import {
  INTENTS, GATED_INTENTS, FLAGGED_INTENTS, UNGATED_INTENTS,
  PAYLOAD_VALIDATED_INTENTS, PALETTE_VALIDATED_INTENTS, TERMINAL_INTENTS,
} from './interpret.js';

// ── Partition seal #2 — every intent belongs to exactly ONE normalize-validation class ─────────────────────────
// B5-4 DONE (v2.74.1736): the three validation-class tables moved INTO Core/interpret.js — the code owns its own
// partition now, beside the if-chain it classifies; this module re-exports them so the registry surface is
// unchanged. What was "sealed memory" (a hand-copy here, cross-checked) is now true derivation.
export { PAYLOAD_VALIDATED_INTENTS, PALETTE_VALIDATED_INTENTS, TERMINAL_INTENTS };

/** The INTERPRET neck's reaction rows — derived from INTENTS + the disposition tables. PURE. */
export function interpretReactions() {
  const rows = [];
  // normalize, the happy arm per intent (the dispatch classes — Rail B lives in `normalize:act:valid`)
  for (const i of INTENTS) rows.push({ id: `normalize:${i}:valid`, subject: 'interpret', kind: 'pass' });
  // normalize, the fail-closed arms
  for (const i of PAYLOAD_VALIDATED_INTENTS) rows.push({ id: `normalize:${i}:malformed→clarify`, subject: 'interpret', kind: 'catchall' });
  rows.push({ id: 'normalize:act:out-of-palette→teach', subject: 'interpret', kind: 'catchall' });   // anti-hallucination (:63)
  rows.push({ id: 'normalize:unknown-intent→clarify', subject: 'interpret', kind: 'catchall' });     // the :49 default — the totality bridge
  rows.push({ id: 'normalize:map:degrade→decompose', subject: 'interpret', kind: 'catchall' });      // malformed map WITH subAsks degrades, never half-maps
  // the confidence gate — one row per intent, disposition from the v1718 tables (fully derived)
  for (const i of GATED_INTENTS) rows.push({ id: `gate:${i}:low→clarify`, subject: 'interpret', kind: 'gate' });
  for (const i of FLAGGED_INTENTS) rows.push({ id: `gate:${i}:low→flag`, subject: 'interpret', kind: 'gate' });
  for (const i of UNGATED_INTENTS) rows.push({ id: `gate:${i}:low→pass`, subject: 'interpret', kind: 'gate' });
  rows.push({ id: 'gate:threshold:at-0.6→pass', subject: 'interpret', kind: 'gate' });               // the boundary corner: `<` not `<=`
  // the interpret() orchestration shell
  rows.push({ id: 'interpret:empty-ask→clarify', subject: 'interpret', kind: 'catchall' });
  rows.push({ id: 'interpret:think-throws→clarify', subject: 'interpret', kind: 'catchall' });
  return rows;
}

/** The DECOMPOSER neck's reaction rows — sealed by hand until stepsPrompt grows its own tables. PURE DATA. */
export const DECOMPOSER_REACTIONS = Object.freeze([
  { id: 'parse:valid→steps', subject: 'decomposer', kind: 'pass' },
  { id: 'parse:non-string-dropped', subject: 'decomposer', kind: 'catchall' },        // the v1666 [object Object] class
  { id: 'parse:object-object-dropped', subject: 'decomposer', kind: 'catchall' },
  { id: 'parse:numbering-stripped', subject: 'decomposer', kind: 'pass' },
  { id: 'parse:dedupe+cap', subject: 'decomposer', kind: 'pass' },
  { id: 'parse:unparseable→empty', subject: 'decomposer', kind: 'catchall' },
  { id: 'sanitize:machinery-dropped', subject: 'decomposer', kind: 'catchall' },      // leg ids / endpoints never reach the plan page
  { id: 'sanitize:short-dropped+long-clamped', subject: 'decomposer', kind: 'catchall' },
  { id: 'coverage:under-split-flagged', subject: 'decomposer', kind: 'pass' },
  { id: 'coverage:compound-flagged', subject: 'decomposer', kind: 'pass' },
  { id: 'quantifier:restored', subject: 'decomposer', kind: 'pass' },                 // the v1714 backstop fires
  { id: 'quantifier:kept→no-op', subject: 'decomposer', kind: 'pass' },
  { id: 'quantifier:none→no-op', subject: 'decomposer', kind: 'pass' },
  { id: 'quantifier:no-owner→no-op', subject: 'decomposer', kind: 'pass' },           // thin overlap AND tie both refuse
  { id: 'cross-stage:restored-step-fires-fanout', subject: 'decomposer', kind: 'pass' },   // emitted TEXT is the next stage's ROUTING INPUT
]);

/** Subject #3 — the BRANCH-CLASSIFY neck (v2.74.1734): parseClassifyOutput's finite dispositions. The live
 *  "couldn't tell 22" vendor-explanation misclass lived here. Sealed rows; deep coverage stays in
 *  branchClassify.test.js — these are the B5 spine's thin representatives. PURE DATA. */
export const CLASSIFY_REACTIONS = Object.freeze([
  { id: 'classify:valid-verdicts', subject: 'classify', kind: 'pass' },
  { id: 'classify:invented-label→unknown', subject: 'classify', kind: 'catchall' },   // a made-up arm label downgrades, counted invalid — never routes an item
  { id: 'classify:unknown-or-dup-id→invalid', subject: 'classify', kind: 'catchall' },
  { id: 'classify:skipped-item→unknown+missing', subject: 'classify', kind: 'catchall' },   // silence is REPORTED — never reads as "no arm matched"
  { id: 'classify:unparseable→all-missing', subject: 'classify', kind: 'catchall' },
]);

/** Subject #4 — the ROUTE-ASK neck (v2.74.1734): parseRouterOutput's dispositions, incl. the v963 decompose
 *  confidence floor (a frozen live lesson). Deep coverage in routerPrompt.test.js. PURE DATA. */
export const ROUTER_REACTIONS = Object.freeze([
  { id: 'router:valid-tool→route', subject: 'router', kind: 'pass' },
  { id: 'router:tool-object-forms', subject: 'router', kind: 'pass' },                // {ref|op|capabilityId|id} all accepted
  { id: 'router:unparseable→demonstrate', subject: 'router', kind: 'catchall' },      // the fail-safe: no tool, needs_demonstration, reason 'unparseable'
  { id: 'router:decompose-floor', subject: 'router', kind: 'gate' },                  // v963: real 2-way split at conf 0 → floored 0.5
  { id: 'router:explicit-low-honored', subject: 'router', kind: 'gate' },             // an honest 0.2 stays 0.2 — the floor never inflates a stated doubt
]);

/** Subject #5 — the MATCH-WORKFLOW neck (v2.74.1734): a wrong match replays someone else's steps. Three pure
 *  layers: parseWorkflowMatchOutput (proposes), resolveWorkflowMatch (the TRUST GATE — the id must name a real,
 *  live candidate; a hallucinated/stale/suppressed id dies here), workflowSharesVocab (the cost pre-gate). PURE DATA. */
export const WFMATCH_REACTIONS = Object.freeze([
  { id: 'wfmatch:valid-id+confidence', subject: 'wfmatch', kind: 'pass' },
  { id: 'wfmatch:null-id→no-match', subject: 'wfmatch', kind: 'catchall' },            // null / false / "null" all read as no-match
  { id: 'wfmatch:unparseable→no-match', subject: 'wfmatch', kind: 'catchall' },
  { id: 'wfmatch:resolve:real-id→record', subject: 'wfmatch', kind: 'pass' },
  { id: 'wfmatch:resolve:hallucinated-id→null', subject: 'wfmatch', kind: 'catchall' },   // THE trust gate — proposes-only can never replay
  { id: 'wfmatch:vocab-pregate', subject: 'wfmatch', kind: 'gate' },                   // zero shared vocabulary → no LLM round-trip at all
]);

/** Subject #6 — the JUDGE-MATCH neck (v2.74.1734): accept/reject a capability match. Fails safe to ref:null
 *  (reject → ask) so it never runs the wrong capability. PURE DATA. */
export const JUDGE_REACTIONS = Object.freeze([
  { id: 'judge:valid-ref→accept', subject: 'judge', kind: 'pass' },
  { id: 'judge:ref-object-forms', subject: 'judge', kind: 'pass' },                    // {id|ref} both accepted
  { id: 'judge:unparseable→reject', subject: 'judge', kind: 'catchall' },              // ref:null, reason 'unparseable' → the caller asks
]);

/** Subject #7 — the SWEEP-READS neck (v2.74.1734): picks which READ legs a fleet sweep runs. parseSweepReads
 *  is offered-only by construction (legRef membership), deduped, capped. PURE DATA. */
export const SWEEP_REACTIONS = Object.freeze([
  { id: 'sweep:valid-offered-reads', subject: 'sweep', kind: 'pass' },
  { id: 'sweep:unoffered-key-dropped', subject: 'sweep', kind: 'catchall' },           // anti-hallucination — an invented read never runs
  { id: 'sweep:dup-dropped+cap', subject: 'sweep', kind: 'pass' },
  { id: 'sweep:unparseable→empty', subject: 'sweep', kind: 'catchall' },
]);

/** Subject #8 — the SEED-DIRECTIVES neck (v2.74.1734): proposes cadence — schedules future acts. parseSeedDirectives
 *  (Core/fleetSchedule.js) bounds the quota (1..200), requires BOTH routine fields, fails to the none-shape. PURE DATA. */
export const SEEDDIR_REACTIONS = Object.freeze([
  { id: 'seeddir:valid-every+quota', subject: 'seeddir', kind: 'pass' },
  { id: 'seeddir:quota-bounds', subject: 'seeddir', kind: 'gate' },                    // 0 / 201 / NaN / object → null, never a runaway quota
  { id: 'seeddir:routine-requires-both', subject: 'seeddir', kind: 'catchall' },       // {every} without {ask} (or vice versa) → no routine
  { id: 'seeddir:unparseable→none', subject: 'seeddir', kind: 'catchall' },
]);

/** Subject #9 — the STEP-IL neck (v2.74.1734): the IL step executor's per-step decision. parseStepDecision
 *  whitelists kind + needs.kind, resolves the leg AGAINST THE PALETTE (unknown ref → leg:null; agentLoop
 *  re-checks membership — defense in depth). PURE DATA. */
export const STEPIL_REACTIONS = Object.freeze([
  { id: 'stepil:act-resolves-offered-leg', subject: 'stepil', kind: 'pass' },
  { id: 'stepil:unoffered-leg→null', subject: 'stepil', kind: 'catchall' },            // anti-hallucination — an invented leg resolves to nothing
  { id: 'stepil:done-carries-answer', subject: 'stepil', kind: 'pass' },
  { id: 'stepil:unknown-kind→needs-clarify', subject: 'stepil', kind: 'catchall' },
  { id: 'stepil:needs-kind-whitelist', subject: 'stepil', kind: 'catchall' },          // an invented needs.kind degrades to clarify
  { id: 'stepil:unparseable→needs-clarify', subject: 'stepil', kind: 'catchall' },
]);

/** THE EFFECT HALF, slice 1 (v2.74.1754 — B5-5 opens): Core/runDriver landed via CD-1a (extraction 1 of 5),
 *  so the DISPATCH loop's reactions are pure and gate-able — the half the spec said had to wait. These rows
 *  cover the DRIVER CORE (verdicts · park/resume · the reporter contract · the fail-safes); per-CLAUSE effect
 *  reactions accrue as extractions 2–5 land. Depth stays in runDriver.test.js — thin representatives here. */
export const DRIVER_REACTIONS = Object.freeze([
  { id: 'driver:complete', subject: 'driver', kind: 'pass' },
  { id: 'driver:loose-chain→partial', subject: 'driver', kind: 'pass' },               // one flaky step never sinks the rest; firstFailure is the audit story
  { id: 'driver:hard-stop→failed|partial', subject: 'driver', kind: 'catchall' },
  { id: 'driver:step-throw→soft-fail', subject: 'driver', kind: 'catchall' },          // a throwing step becomes {ok:false}; the loop never dies
  { id: 'driver:no-reporter→gate-parks', subject: 'driver', kind: 'catchall' },        // THE §11.2 row: no surface ⇒ nobody watching ⇒ never auto-write
  { id: 'driver:reporter-throw-never-changes-verdict', subject: 'driver', kind: 'catchall' },
  { id: 'driver:park→resumable', subject: 'driver', kind: 'gate' },                    // parkedAt + carried state = the §8 resume seam
  { id: 'driver:resume-one-approval', subject: 'driver', kind: 'gate' },               // the approved write proceeds; the NEXT write re-parks
  { id: 'driver:empty→empty', subject: 'driver', kind: 'catchall' },
  { id: 'driver:verdict-enum-sealed', subject: 'driver', kind: 'gate' },
  { id: 'driver:differential-oracle-seed', subject: 'driver', kind: 'pass' },          // panel ≡ SW per reaction — B5-5's double duty, seeded at the driver core
]);

/** B5-6 slice 1 (v2.74.1761) — the COMPOSITION layer: not one decision's effect, but the HANDOFF BETWEEN steps.
 *  Spec §11's "frozen sequences asserting state handoff" — seam bugs disguise themselves as late aim errors, so
 *  they need sequence fixtures, not more single-step coverage. The park/resume round-trip is the load-bearing
 *  one: a resume that re-ran completed steps would re-fire an already-approved WRITE. PURE DATA. */
export const COMPOSITION_REACTIONS = Object.freeze([
  { id: 'compose:state-threads-forward', subject: 'composition', kind: 'pass' },       // step N's state reaches N+1 AND the final result
  { id: 'compose:resume-never-reruns', subject: 'composition', kind: 'gate' },         // THE row: startIndex skips completed steps — a resumed write never double-fires
  { id: 'compose:park-resume-roundtrip', subject: 'composition', kind: 'gate' },       // park at i → resume from i with carried state → complete; steps run exactly once across both halves
  { id: 'compose:verdict-composes', subject: 'composition', kind: 'pass' },            // a failure in half 1 + success in half 2 reads honestly per half
]);

/** THE EFFECT HALF, slice 2 (v2.74.1762) — the HEADLESS FIELD READ (`Core/headlessClause.runFieldReadStep`,
 *  CD-1a extraction 1 of 5). The first per-CLAUSE effect to become gate-able. Its governing discipline is
 *  FAIL-HONESTLY: a banked field that drifted or turned ambiguous STOPS the step — it never re-interprets,
 *  because a confidently-wrong field read is this area's recurring failure (the §1626 rule). Deep coverage in
 *  headlessClause.test.js; these are the spine's representatives, plus the integration row no unit test has. */
export const HEADLESS_FIELDREAD_REACTIONS = Object.freeze([
  { id: 'hlfr:valid→enriched+tally', subject: 'hl-fieldread', kind: 'pass' },
  { id: 'hlfr:term-narrows', subject: 'hl-fieldread', kind: 'pass' },
  { id: 'hlfr:key-resolved-once', subject: 'hl-fieldread', kind: 'gate' },        // resolved on the FIRST record, applied to all — per-row re-resolution could read DIFFERENT fields from different rows
  { id: 'hlfr:not-banked→fail', subject: 'hl-fieldread', kind: 'catchall' },      // a legacy pin needs the panel's interpreter; headless refuses rather than guessing
  { id: 'hlfr:no-prior-rows→fail', subject: 'hl-fieldread', kind: 'catchall' },
  { id: 'hlfr:rows-not-records→fail', subject: 'hl-fieldread', kind: 'catchall' },
  { id: 'hlfr:field-gone→fail', subject: 'hl-fieldread', kind: 'gate' },          // the §2.1 drift rule one level down: a banked field that no longer resolves stops the run
  { id: 'hlfr:field-ambiguous→fail', subject: 'hl-fieldread', kind: 'gate' },     // two candidates ⇒ refuse + NAME them; never pick one
  { id: 'hlfr:rowsOf-shapes', subject: 'hl-fieldread', kind: 'pass' },
  { id: 'hlfr:composes-with-driver', subject: 'hl-fieldread', kind: 'pass' },     // the CD-1a point: the extraction really plugs into runWorkflow's runStep contract
]);

/** Every registered reaction: nine gated necks + the effect half's first slice. PURE. */
export function allReactions() { return [...interpretReactions(), ...DECOMPOSER_REACTIONS, ...CLASSIFY_REACTIONS, ...ROUTER_REACTIONS, ...WFMATCH_REACTIONS, ...JUDGE_REACTIONS, ...SWEEP_REACTIONS, ...SEEDDIR_REACTIONS, ...STEPIL_REACTIONS, ...DRIVER_REACTIONS, ...COMPOSITION_REACTIONS, ...HEADLESS_FIELDREAD_REACTIONS]; }

// ── B5-1 — factory 1a: the STRUCTURED garbage list (constructed, never rots; decision-gate §6) ────────────────
// Each shape is a way a model output could be wrong that code must absorb: land in a legal reaction, never throw.
export const GARBAGE_DECISIONS = Object.freeze([
  null, undefined, 42, 'a string', [], {},
  { intent: null }, { intent: 42 }, { intent: 'frobnicate' },
  { intent: 'ACT' },                                                            // the v1650 case class — never matches, must default
  { intent: 'act' },                                                            // act with NO tool at all
  { intent: 'act', capabilityId: {} },
  { intent: 'act', capabilityId: 'cap-ghost' },                                 // invented tool (out-of-palette when retrieved=[])
  { intent: 'act', op: ['CLICK'] },
  { intent: 'navigate', params: null },
  { intent: 'navigate', params: { url: 'javascript:alert(1)' } },               // scheme fence: non-http never navigates
  { intent: 'navigate', params: { url: 'example.com' } },                       // schemeless → clarify, never a guessed https
  { intent: 'decompose', subAsks: 'not an array' },
  { intent: 'decompose', subAsks: [null, '', 42] },
  { intent: 'map', map: {} },
  { intent: 'map', map: { itemField: 42 } },
  { intent: 'branch', branch: { arms: [{ label: 'x' }] } },                     // arm without a `when` assertion
  { intent: 'branch', branch: { arms: 'x' } },
  { intent: 'write', write: 42 },
  { intent: 'case', case: 42 },
  { intent: 'fieldread', fieldRead: {} },
  { intent: 'answer', confidence: -5 },
  { intent: 'answer', confidence: 'high' },
  { intent: 'clarify', question: { nested: true } },
]);

// ── B5-1 — factory 1b: the SEEDED mutator (deterministic breadth; same seed → same garbage forever) ───────────
const _BASE = { intent: 'map', map: { itemField: 'email', target: { system: 'shopify', readAsk: 'find {value}' } }, params: {}, subAsks: [], confidence: 0.9 };
const _JUNK = [null, 42, 'x', [], {}, true, -1, '', { deep: { deeper: [] } }];

/** Deterministic LCG — the no-Math.random rule (a gate must replay identically forever). PURE. */
function _lcg(seed) { let s = (seed >>> 0) || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** Mint `n` deterministic mutations of a valid decision. PURE — same (seed, n) → same list, forever. */
export function mintGarbage(seed = 7, n = 40) {
  const rnd = _lcg(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = JSON.parse(JSON.stringify(_BASE));
    const keys = Object.keys(d);
    const k = keys[Math.floor(rnd() * keys.length)];
    const roll = rnd();
    if (roll < 0.34) delete d[k];                                        // field deletion
    else if (roll < 0.68) d[k] = _JUNK[Math.floor(rnd() * _JUNK.length)];  // type swap
    else d[`extra_${i}`] = _JUNK[Math.floor(rnd() * _JUNK.length)];        // additive junk
    if (rnd() < 0.25 && typeof d.intent === 'string') d.intent = d.intent.toUpperCase();   // the case class rides along
    out.push(d);
  }
  return out;
}
