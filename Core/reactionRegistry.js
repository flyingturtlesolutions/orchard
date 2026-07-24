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
 *   · SEALED rows — the normalize catch-alls and the decomposer surface are if-chain-shaped (not yet
 *     table-driven; B5-4 owes that), so their rows are hand-frozen HERE and sealed by partition:
 *     `PAYLOAD_VALIDATED ∪ PALETTE_VALIDATED ∪ TERMINAL === INTENTS` — an intent added without a validation
 *     class is unrepresentable (partition seal #2, the v1718 pattern reapplied).
 *
 * Also here: B5-1's garbage factories (HANDOFF §12). RULE ZERO — the gate REPLAYS garbage, never GENERATES it at
 * random: `GARBAGE_DECISIONS` is a frozen structured list (constructed, never rots), and `mintGarbage(seed, n)`
 * is a SEEDED deterministic mutator (same seed → same garbage, forever — no Math.random, which the workflow
 * runtime bans for exactly this reason).
 */

import { INTENTS, GATED_INTENTS, FLAGGED_INTENTS, UNGATED_INTENTS } from './interpret.js';

// ── Partition seal #2 — every intent belongs to exactly ONE normalize-validation class ─────────────────────────
// (sealed against INTENTS by decisionGate.test.js; B5-4 will table-drive normalize itself and retire the seal
// into true derivation)
export const PAYLOAD_VALIDATED_INTENTS = Object.freeze(['navigate', 'decompose', 'fieldread', 'map', 'branch', 'write', 'case']);   // a malformed payload → its own clarify (:67..:119)
export const PALETTE_VALIDATED_INTENTS = Object.freeze(['act']);                                  // validated against the OFFERED palette → teach on invention (:63)
export const TERMINAL_INTENTS = Object.freeze(['clarify', 'teach', 'answer']);                    // no payload to validate — they ARE the degradations

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

/** Every registered reaction, both necks. PURE. */
export function allReactions() { return [...interpretReactions(), ...DECOMPOSER_REACTIONS]; }

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
