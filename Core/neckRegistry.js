/**
 * Core/neckRegistry.js — the NECK REGISTRY (hardening arc Stage 7 slice 1; v2.74.1734). PURE DATA + helpers.
 *
 * Spec: docs/DESIGN_decision_gate.md §3 (amended) · docs/HANDOFF_hardening_arc.md §9.
 *
 * One row per model-call operation tagged `role: 'routing'` in Services/AnthropicService.js. The seal test
 * (neckRegistry.test.js) derives the operation list FROM THE SOURCE TEXT and asserts exact parity both ways —
 * a new routing-tagged operation without a row here is red; a stale row whose operation vanished is red.
 *
 * CORRECTION the build surfaced (2026-07-23): `role: 'routing'` is the MODEL-TIERING role, not a blast-radius
 * grade — `case-brief` carries it and is presentation by function. So the honest split is: the CANDIDATE LIST
 * is derived (the tag), the GRADE is sealed judgment (this table), reviewed by the §4.3 audit. That refines
 * the amended spec's "the routing-grade neck list is derived from the code" — the list is derived; the grading
 * cannot be.
 *
 *   grade — what the operation's output DOES:
 *     'routing'      it picks what runs (a leg, a workflow, a step, an arm, a schedule) → MUST be gated (built or owed)
 *     'shaping'      it transforms content that downstream brackets re-validate → may be waived WITH the bracket named
 *     'presentation' it renders for a human; execution never flows through it → may be waived
 *   gate — 'built' (names its suite) | 'owed' (routing-grade, not yet gated) | 'waived' (never on routing-grade)
 */

export const NECK_GRADES = Object.freeze(['routing', 'shaping', 'presentation']);
export const NECK_GATES = Object.freeze(['built', 'owed', 'waived']);

export const NECKS = Object.freeze([
  // ── gated (the B5 spine, Core/decisionGate.test.js) ─────────────────────────────────────────────────────────
  { operation: 'interpret', grade: 'routing', gate: 'built', suite: 'Core/decisionGate.test.js', why: 'the leg/clause selector — B5-0 subject #1' },
  { operation: 'decompose-steps', grade: 'routing', gate: 'built', suite: 'Core/decisionGate.test.js', why: 'emits step TEXT that routes downstream (v1708/1712/1714) — subject #2' },
  { operation: 'branch-classify', grade: 'routing', gate: 'built', suite: 'Core/decisionGate.test.js', why: 'sorts items into arms that can carry writes (the couldn\'t-tell-22 class) — subject #3' },
  { operation: 'route-ask', grade: 'routing', gate: 'built', suite: 'Core/decisionGate.test.js', why: 'the pre-door router (mis-sent "open a case showing each…" → demonstrate) — subject #4' },
  { operation: 'match-workflow', grade: 'routing', gate: 'built', suite: 'Core/decisionGate.test.js', why: 'picks which BANKED workflow replays — parse proposes, resolveWorkflowMatch is the trust gate (hallucinated id → null) — subject #5 (v2.74.1734)' },
  { operation: 'judge-match', grade: 'routing', gate: 'built', suite: 'Core/decisionGate.test.js', why: 'accepts/rejects a capability match; fails safe to ref:null → ask — subject #6 (v2.74.1734)' },
  { operation: 'sweep-reads', grade: 'routing', gate: 'built', suite: 'Core/decisionGate.test.js', why: 'selects which READ legs a sweep runs; parseSweepReads is offered-only, deduped, capped — subject #7 (v2.74.1734)' },
  { operation: 'seed-directives', grade: 'routing', gate: 'built', suite: 'Core/decisionGate.test.js', why: 'proposes cadence — parseSeedDirectives bounds the quota (1..200) and requires both routine fields — subject #8 (v2.74.1734)' },
  { operation: 'step-il', grade: 'routing', gate: 'built', suite: 'Core/decisionGate.test.js', why: 'the IL per-step decision — kind/needs whitelists, leg resolved against the palette (invented → null) — subject #9 (v2.74.1734)' },
  // ── shaping — waived, each naming the bracket that re-validates its output ─────────────────────────────────
  { operation: 'resplit-step', grade: 'shaping', gate: 'waived', why: 'output re-enters the decomposer\'s own parse+sanitize brackets (subject #2 covers the seam)' },
  { operation: 'fanout-spec', grade: 'shaping', gate: 'waived', why: 'splits {task, persona} into child SEED text; no direct dispatch' },
  { operation: 'answer-shape', grade: 'shaping', gate: 'waived', why: 'shapes an already-fetched answer; code counts, LLM phrases (the shaper-minimization rule)' },
  { operation: 'recipe-polish', grade: 'shaping', gate: 'waived', why: 'names/describes a harvested recipe; the §18 arm gate + HITL review own safety' },
  // ── presentation — waived ───────────────────────────────────────────────────────────────────────────────────
  { operation: 'case-brief', grade: 'presentation', gate: 'waived', why: 'renders the requestor\'s-voice narrative; the v1712 field-display guard keeps it off display paths — routing-TAGGED (model tier) but presentation by function, the correction this registry exists to record' },
  { operation: 'setup-example', grade: 'presentation', gate: 'waived', why: 'example text for the setup surface; nothing executes from it' },
  { operation: 'workflow-blurb', grade: 'presentation', gate: 'waived', why: 'one-line rail-card caption (v2.74.2056); escape-first render (escHtml/textContent), nothing executes from it' },
]);

/** Registry rows by gate status. PURE. */
export function necksByGate(gate) { return NECKS.filter((n) => n.gate === gate); }

/** The audit's shrink-list: routing-grade operations still owed a gate. PURE. */
export function owedNecks() { return NECKS.filter((n) => n.grade === 'routing' && n.gate === 'owed'); }
