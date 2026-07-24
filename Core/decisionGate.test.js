// Core/decisionGate.test.js — B5-0/1: the Decision Gate spine (Stage 3, v2.74.1727).
//
// B5-0 — the coverage META-TEST: every registered reaction (Core/reactionRegistry.js) has EXACTLY one fixture
// here, both directions — a registry row with no fixture is red (the forgotten reaction), and a fixture with no
// row is red (the derivation drifted). Every fixture runs the REAL functions (frozen input → deterministic).
// B5-1 — TOTALITY: the garbage factories (structured list + seeded mutator) prove the catch-alls absorb every
// unlisted shape — landing in a LEGAL reaction, recoverably (clarify carries a question), and NEVER throwing.
//
// RAIL B lives here as a milestone, not a suite: `normalize:act:valid` + the high-confidence pass IS the one
// recorded decision routed end-to-end (ladder §2 — "build B5-0 and B falls out").

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  interpretReactions, DECOMPOSER_REACTIONS, CLASSIFY_REACTIONS, ROUTER_REACTIONS, allReactions,
  PAYLOAD_VALIDATED_INTENTS, PALETTE_VALIDATED_INTENTS, TERMINAL_INTENTS,
  GARBAGE_DECISIONS, mintGarbage,
} from './reactionRegistry.js';
import { parseClassifyOutput } from './branchClassify.js';   // subject #3 (v2.74.1734) — the couldn't-tell-22 neck
import { parseRouterOutput } from './routerPrompt.js';       // subject #4 (v2.74.1734) — the pre-door router
import { parseWorkflowMatchOutput } from './workflowMatchPrompt.js';                        // subject #5 (v2.74.1734)
import { resolveWorkflowMatch, workflowSharesVocab } from './workflowMemory.js';            // #5's trust gate + cost pre-gate
import { parseJudgeDecision } from './judgePrompt.js';                                      // subject #6 (v2.74.1734)
import { parseSweepReads } from './sweepPrompt.js';                                         // subject #7 (v2.74.1734)
import { parseSeedDirectives } from './fleetSchedule.js';                                   // subject #8 (v2.74.1734)
import { parseStepDecision } from './stepPrompt.js';                                        // subject #9 (v2.74.1734)
import { runWorkflow, normalizeReporter, makeAccumulatorReporter, makeResumeReporter, DRIVER_VERDICTS } from './runDriver.js';   // THE EFFECT HALF, slice 1 (v2.74.1754 — CD-1a landed the driver core)
import {
  normalizeInterpretDecision, applyConfidenceGate, interpret,
  INTENTS, GATED_INTENTS, FLAGGED_INTENTS, UNGATED_INTENTS,
} from './interpret.js';
import {
  parseStepsOutput, sanitizeSteps, deriveStepSpec, assessStepCoverage, restoreQuantifier, MAX_STEPS,
} from './stepsPrompt.js';
import { isFanoutAsk, isFieldDisplayAsk } from './orchChain.js';

const RETRIEVED = [{ id: 'cap-x' }];
const PRIMS = ['OPEN_URL', 'CLICK'];
const norm = (raw, ctx = {}) => normalizeInterpretDecision(raw, ctx);
const gate = (d, min = 0.6) => applyConfidenceGate(d, { minConfidence: min });
const MAP_OK = { itemField: 'email', target: { system: 'shopify', readAsk: 'find {value}' } };
const BRANCH_OK = { arms: [{ label: 'replacement', when: { type: 'classify', label: 'replacement' } }] };
const LIVE_ASK = "get open warranty tasks and for each, show primary homeowner's contact information in new case";
const LIVE_STEPS = ['get open warranty tasks', "show primary homeowner's contact information in new case"];

// ── The fixture library — ONE per registry row (the meta-test enforces exact parity) ─────────────────────────
const FIXTURES = {};

// normalize:<intent>:valid — the eleven dispatch classes (payloads pinned by probe against the real validators)
const VALID = {
  act: () => { const d = norm({ intent: 'act', capabilityId: 'cap-x', confidence: 0.9 }, { retrieved: RETRIEVED }); assert.equal(d.intent, 'act'); assert.equal(d.capabilityId, 'cap-x'); },
  navigate: () => { const d = norm({ intent: 'navigate', params: { url: 'https://example.com' }, confidence: 0.9 }); assert.equal(d.intent, 'navigate'); assert.equal(d.op, 'OPEN_URL'); },
  decompose: () => { const d = norm({ intent: 'decompose', subAsks: ['get tasks', 'sort them'], confidence: 0.9 }); assert.equal(d.intent, 'decompose'); assert.equal(d.subAsks.length, 2); },
  clarify: () => { const d = norm({ intent: 'clarify' }); assert.equal(d.intent, 'clarify'); assert.ok(d.question); },
  teach: () => assert.equal(norm({ intent: 'teach', confidence: 0.9 }).intent, 'teach'),
  answer: () => assert.equal(norm({ intent: 'answer', confidence: 0.9 }).intent, 'answer'),
  map: () => { const d = norm({ intent: 'map', map: MAP_OK, confidence: 0.9 }); assert.equal(d.intent, 'map'); assert.equal(d.map.kind, 'map'); },
  fieldread: () => { const d = norm({ intent: 'fieldread', fieldRead: { field: 'vendor note' }, confidence: 0.9 }); assert.equal(d.intent, 'fieldread'); assert.equal(d.fieldRead.kind, 'fieldRead'); },
  branch: () => { const d = norm({ intent: 'branch', branch: BRANCH_OK, confidence: 0.9 }); assert.equal(d.intent, 'branch'); assert.equal(d.branch.arms.length, 1); },
  write: () => { const d = norm({ intent: 'write', write: {}, confidence: 0.9 }); assert.equal(d.intent, 'write'); assert.equal(d.write.kind, 'write'); },
  case: () => { const d = norm({ intent: 'case', case: {}, confidence: 0.9 }); assert.equal(d.intent, 'case'); assert.equal(d.case.kind, 'case'); },
};
for (const i of INTENTS) FIXTURES[`normalize:${i}:valid`] = VALID[i];

// normalize:<intent>:malformed→clarify — the seven fail-closed payload arms (each also asserts RECOVERABILITY:
// the clarify carries a question a person can answer)
const MALFORMED = {
  navigate: { intent: 'navigate', params: {}, confidence: 0.9 },
  decompose: { intent: 'decompose', subAsks: ['only one'], confidence: 0.9 },
  fieldread: { intent: 'fieldread', fieldRead: {}, confidence: 0.9 },
  map: { intent: 'map', map: {}, confidence: 0.9 },
  branch: { intent: 'branch', branch: { arms: [{ label: 'x' }] }, confidence: 0.9 },   // an arm without a `when` ASSERTION is no arm
  write: { intent: 'write', write: 42, confidence: 0.9 },
  case: { intent: 'case', case: 42, confidence: 0.9 },
};
for (const i of PAYLOAD_VALIDATED_INTENTS) {
  FIXTURES[`normalize:${i}:malformed→clarify`] = () => { const d = norm(MALFORMED[i]); assert.equal(d.intent, 'clarify', i); assert.ok(d.question, `${i} clarify must carry a question`); };
}

FIXTURES['normalize:act:out-of-palette→teach'] = () => { const d = norm({ intent: 'act', capabilityId: 'cap-ghost', confidence: 0.9 }, { retrieved: RETRIEVED, primitives: PRIMS }); assert.equal(d.intent, 'teach'); };
FIXTURES['normalize:unknown-intent→clarify'] = () => { const d = norm({ intent: 'frobnicate', confidence: 0.9 }); assert.equal(d.intent, 'clarify'); assert.ok(d.question); };
FIXTURES['normalize:map:degrade→decompose'] = () => { const d = norm({ intent: 'map', map: {}, subAsks: ['get tasks', 'look each up'], confidence: 0.9 }); assert.equal(d.intent, 'decompose'); assert.equal(d.subAsks.length, 2); };

// gate:<intent>:low→… — fully DERIVED from the v1718 disposition tables (add an intent → a row + this loop
// demand a fixture automatically; the fixture itself is derived too — the tables are the spec)
for (const i of GATED_INTENTS) FIXTURES[`gate:${i}:low→clarify`] = () => { const d = gate({ intent: i, params: {}, subAsks: ['a', 'b'], confidence: 0.2 }); assert.equal(d.intent, 'clarify'); assert.ok(d.question); };
for (const i of FLAGGED_INTENTS) FIXTURES[`gate:${i}:low→flag`] = () => { const d = gate({ intent: i, params: {}, subAsks: ['a', 'b'], confidence: 0.2 }); assert.equal(d.intent, i); assert.equal(d.lowConfidence, true); };
for (const i of UNGATED_INTENTS) FIXTURES[`gate:${i}:low→pass`] = () => { const d = gate({ intent: i, params: {}, subAsks: [], confidence: 0.2 }); assert.equal(d.intent, i); assert.ok(!d.lowConfidence); };
FIXTURES['gate:threshold:at-0.6→pass'] = () => assert.equal(gate({ intent: 'act', capabilityId: 'x', confidence: 0.6 }).intent, 'act');   // `<`, not `<=`

FIXTURES['interpret:empty-ask→clarify'] = async () => { const d = await interpret('   ', {}, { think: () => { throw new Error('must not be called'); } }); assert.equal(d.intent, 'clarify'); };
FIXTURES['interpret:think-throws→clarify'] = async () => { const d = await interpret('do a thing', { retrieved: RETRIEVED }, { think: () => { throw new Error('boom'); } }); assert.equal(d.intent, 'clarify'); };

// ── the DECOMPOSER neck (thin fixtures over the same pure surface stepsPrompt.test.js covers in depth) ────────
FIXTURES['parse:valid→steps'] = () => assert.deepEqual(parseStepsOutput('{"steps":["get the tasks","sort them"]}'), ['get the tasks', 'sort them']);
FIXTURES['parse:non-string-dropped'] = () => assert.deepEqual(parseStepsOutput('{"steps":["get the tasks",{"text":"x"},null,42]}'), ['get the tasks']);
FIXTURES['parse:object-object-dropped'] = () => assert.deepEqual(parseStepsOutput('{"steps":["[object Object]","get the tasks"]}'), ['get the tasks']);
FIXTURES['parse:numbering-stripped'] = () => assert.deepEqual(parseStepsOutput('{"steps":["1. get the tasks","2) sort them"]}'), ['get the tasks', 'sort them']);
FIXTURES['parse:dedupe+cap'] = () => {
  assert.deepEqual(parseStepsOutput('{"steps":["Get tasks","get tasks"]}'), ['Get tasks']);
  assert.equal(parseStepsOutput(JSON.stringify({ steps: Array.from({ length: 30 }, (_, i) => `step number ${i}`) })).length, MAX_STEPS);
};
FIXTURES['parse:unparseable→empty'] = () => { for (const bad of ['the model wandered off', '', null, undefined, '{}', '{"steps":"not an array"}']) assert.deepEqual(parseStepsOutput(bad), []); };
FIXTURES['sanitize:machinery-dropped'] = () => { const { steps, dropped } = sanitizeSteps(['ping the zendesk_create_ticket leg']); assert.deepEqual(steps, []); assert.equal(dropped.length, 1); };
FIXTURES['sanitize:short-dropped+long-clamped'] = () => { const { steps, dropped } = sanitizeSteps(['ok', `${'x'.repeat(250)}`]); assert.equal(dropped.length, 1); assert.equal(steps[0].length, 198); assert.ok(steps[0].endsWith('…')); };   // 197 + the ellipsis
FIXTURES['coverage:under-split-flagged'] = () => { const spec = deriveStepSpec('find the tasks where a replacement is requested and email each vendor'); assert.equal(assessStepCoverage(['one step'], spec).underSplit, true); };
FIXTURES['coverage:compound-flagged'] = () => assert.equal(assessStepCoverage(['look it up. create it if missing'], deriveStepSpec('x')).compound.length, 1);
FIXTURES['quantifier:restored'] = () => { const { restored, steps } = restoreQuantifier(LIVE_ASK, LIVE_STEPS); assert.deepEqual(restored, { quantifier: 'for each', stepIndex: 1 }); assert.match(steps[1], /^for each, /); };
FIXTURES['quantifier:kept→no-op'] = () => assert.equal(restoreQuantifier(LIVE_ASK, ['get open warranty tasks', "show each homeowner's contact info in a new case"]).restored, null);
FIXTURES['quantifier:none→no-op'] = () => assert.equal(restoreQuantifier('get the tasks and show the summary', ['get the tasks', 'show the summary']).restored, null);
FIXTURES['quantifier:no-owner→no-op'] = () => {
  assert.equal(restoreQuantifier('for each, review it', ['get the tickets', 'send the report']).restored, null, 'thin overlap refuses');
  assert.equal(restoreQuantifier('for each, show the ticket status note', ['file the ticket status note', 'mail the ticket status note']).restored, null, 'a tie refuses');
};
FIXTURES['cross-stage:restored-step-fires-fanout'] = () => {
  const { steps } = restoreQuantifier(LIVE_ASK, LIVE_STEPS);
  assert.equal(isFanoutAsk(steps[1]), true, 'the repaired TEXT routes to the fan-out');
  assert.equal(isFieldDisplayAsk(steps[1]), true, 'and keeps the raw field card (v1712)');
  assert.equal(isFanoutAsk(LIVE_STEPS[1]), false, 'the un-repaired text misses — the live misroute, pinned');
};

// ── subject #3 — the BRANCH-CLASSIFY neck (thin representatives; depth lives in branchClassify.test.js) ──────
const CX_ITEMS = [{ id: 'a' }, { id: 'b' }];
const CX_ARMS = ['replacement', 'repair'];
FIXTURES['classify:valid-verdicts'] = () => {
  const { byId, invalid, missing } = parseClassifyOutput('{"verdicts":[{"id":"a","group":"replacement"},{"id":"b","group":"none"}]}', { items: CX_ITEMS, armLabels: CX_ARMS });
  assert.equal(byId.get('a').group, 'replacement');
  assert.equal(byId.get('b').group, 'none');
  assert.equal(invalid, 0); assert.deepEqual(missing, []);
};
FIXTURES['classify:invented-label→unknown'] = () => {
  const { byId, invalid } = parseClassifyOutput('{"verdicts":[{"id":"a","group":"Replacements!"},{"id":"b","group":"repair"}]}', { items: CX_ITEMS, armLabels: CX_ARMS });
  assert.equal(byId.get('a').group, 'unknown', 'a made-up arm label downgrades — never routes an item');
  assert.equal(invalid, 1);
};
FIXTURES['classify:unknown-or-dup-id→invalid'] = () => {
  const { byId, invalid } = parseClassifyOutput('{"verdicts":[{"id":"ghost","group":"repair"},{"id":"a","group":"repair"},{"id":"a","group":"replacement"}]}', { items: CX_ITEMS, armLabels: CX_ARMS });
  assert.equal(invalid, 2, 'the ghost id and the duplicate both counted');
  assert.equal(byId.get('a').group, 'repair', 'first verdict wins; the duplicate is dropped');
};
FIXTURES['classify:skipped-item→unknown+missing'] = () => {
  const { byId, missing } = parseClassifyOutput('{"verdicts":[{"id":"a","group":"repair"}]}', { items: CX_ITEMS, armLabels: CX_ARMS });
  assert.deepEqual(missing, ['b'], 'silence is REPORTED');
  assert.equal(byId.get('b').group, 'unknown', 'a missing verdict never reads as "no arm matched"');
};
FIXTURES['classify:unparseable→all-missing'] = () => {
  const { byId, missing } = parseClassifyOutput('the model wandered off', { items: CX_ITEMS, armLabels: CX_ARMS });
  assert.equal(missing.length, 2);
  assert.equal(byId.get('a').group, 'unknown');
};

// ── subject #4 — the ROUTE-ASK neck (thin representatives; depth lives in routerPrompt.test.js) ──────────────
FIXTURES['router:valid-tool→route'] = () => {
  const r = parseRouterOutput('{"tool":"cap-search","confidence":0.9}');
  assert.equal(r.tool, 'cap-search'); assert.equal(r.confidence, 0.9); assert.ok(!r.needs_demonstration);
};
FIXTURES['router:tool-object-forms'] = () => {
  for (const form of [{ ref: 'cap-x' }, { op: 'cap-x' }, { capabilityId: 'cap-x' }, { id: 'cap-x' }]) {
    assert.equal(parseRouterOutput({ tool: form, confidence: 0.8 }).tool, 'cap-x', JSON.stringify(form));
  }
};
FIXTURES['router:unparseable→demonstrate'] = () => {
  const r = parseRouterOutput('no json here at all');
  assert.equal(r.tool, null); assert.equal(r.needs_demonstration, true); assert.equal(r.reason, 'unparseable');
};
FIXTURES['router:decompose-floor'] = () => {
  const r = parseRouterOutput({ needs_decompose: true, subAsks: ['get the tasks', 'open each in a case'], confidence: 0 });
  assert.equal(r.confidence, 0.5, 'a REAL 2-way split at conf 0 floors to 0.5 (v963 — "I picked no tool" is not garbage)');
};
FIXTURES['router:explicit-low-honored'] = () => {
  const r = parseRouterOutput({ needs_decompose: true, subAsks: ['a', 'b'], confidence: 0.2 });
  assert.equal(r.confidence, 0.2, 'an honest stated doubt is never inflated');
};

// ── subject #5 — the MATCH-WORKFLOW neck (parse proposes · resolve is the trust gate · vocab is the pre-gate) ──
const WF_CANDIDATES = [
  { id: 'wf_1', name: 'Morning triage', ask: 'get open warranty tasks and open each in a case', steps: [{ clause: 'get open warranty tasks' }, { clause: 'open each in a case' }], schema: 2, createdAt: 1, subAsks: ['a', 'b'] },
];
FIXTURES['wfmatch:valid-id+confidence'] = () => {
  assert.deepEqual(parseWorkflowMatchOutput('{"id":"wf_1","confidence":0.8}'), { id: 'wf_1', confidence: 0.8 });
  assert.equal(parseWorkflowMatchOutput('{"id":"wf_1"}').confidence, 0.6, 'omitted confidence defaults, never NaN');
  assert.equal(parseWorkflowMatchOutput('{"id":"wf_1","confidence":7}').confidence, 1, 'clamped');
};
FIXTURES['wfmatch:null-id→no-match'] = () => {
  for (const raw of ['{"id":null}', '{"id":false}', '{"id":"null"}', '{}']) {
    assert.deepEqual(parseWorkflowMatchOutput(raw), { id: null, confidence: 0 }, raw);
  }
};
FIXTURES['wfmatch:unparseable→no-match'] = () => assert.deepEqual(parseWorkflowMatchOutput('the model wandered off'), { id: null, confidence: 0 });
FIXTURES['wfmatch:resolve:real-id→record'] = () => {
  const w = resolveWorkflowMatch(WF_CANDIDATES, 'wf_1');
  assert.ok(w && w.id === 'wf_1', 'a real live candidate resolves to its full record');
};
FIXTURES['wfmatch:resolve:hallucinated-id→null'] = () => {
  assert.equal(resolveWorkflowMatch(WF_CANDIDATES, 'wf_ghost'), null, 'an invented id NEVER resolves — proposes-only can never replay');
  assert.equal(resolveWorkflowMatch(WF_CANDIDATES, ''), null);
  assert.equal(resolveWorkflowMatch(null, 'wf_1'), null);
};
FIXTURES['wfmatch:vocab-pregate'] = () => {
  assert.equal(workflowSharesVocab('warranty tasks this morning', [{ id: 'wf_1', name: 'Morning triage', ask: 'get open warranty tasks' }]), true);
  assert.equal(workflowSharesVocab('zebra xylophone', [{ id: 'wf_1', name: 'Morning triage', ask: 'get open warranty tasks' }]), false, 'zero shared vocabulary → skip the LLM round-trip entirely');
};

// ── subject #6 — the JUDGE-MATCH neck (accept/reject; fails safe to reject → ask) ────────────────────────────
FIXTURES['judge:valid-ref→accept'] = () => {
  const j = parseJudgeDecision('{"ref":"cap-search","reason":"exact goal match"}');
  assert.equal(j.ref, 'cap-search'); assert.ok(j.reason);
};
FIXTURES['judge:ref-object-forms'] = () => {
  assert.equal(parseJudgeDecision({ ref: { id: 'cap-x' } }).ref, 'cap-x');
  assert.equal(parseJudgeDecision({ ref: { ref: 'cap-y' } }).ref, 'cap-y');
};
FIXTURES['judge:unparseable→reject'] = () => {
  const j = parseJudgeDecision('no json at all');
  assert.equal(j.ref, null, 'reject → the caller ASKS; the wrong capability never runs');
  assert.equal(j.reason, 'unparseable');
};

// ── subject #7 — the SWEEP-READS neck (offered-only by construction) ─────────────────────────────────────────
const SWEEP_LEGS = [{ key: 'me.zd.my_open_tickets@zd' }, { key: 'me.vs.vs_warranty_tasks@vs' }];
FIXTURES['sweep:valid-offered-reads'] = () => {
  const out = parseSweepReads('{"reads":[{"key":"me.zd.my_open_tickets@zd","params":{"status":"open"}}]}', { legs: SWEEP_LEGS });
  assert.deepEqual(out, [{ key: 'me.zd.my_open_tickets@zd', params: { status: 'open' } }]);
};
FIXTURES['sweep:unoffered-key-dropped'] = () => {
  const out = parseSweepReads('{"reads":[{"key":"me.zd.delete_ticket@zd"},{"key":"me.vs.vs_warranty_tasks@vs"}]}', { legs: SWEEP_LEGS });
  assert.deepEqual(out.map((r) => r.key), ['me.vs.vs_warranty_tasks@vs'], 'an un-offered read NEVER runs — anti-hallucination lives with the palette');
};
FIXTURES['sweep:dup-dropped+cap'] = () => {
  const raw = JSON.stringify({ reads: [{ key: 'me.zd.my_open_tickets@zd' }, { key: 'me.zd.my_open_tickets@zd' }, { key: 'me.vs.vs_warranty_tasks@vs' }] });
  assert.equal(parseSweepReads(raw, { legs: SWEEP_LEGS }).length, 2, 'dup dropped');
  assert.equal(parseSweepReads(raw, { legs: SWEEP_LEGS, maxReads: 1 }).length, 1, 'cap enforced');
};
FIXTURES['sweep:unparseable→empty'] = () => { for (const bad of ['prose', null, '{}', '{"reads":42}']) assert.deepEqual(parseSweepReads(bad, { legs: SWEEP_LEGS }), []); };

// ── subject #8 — the SEED-DIRECTIVES neck (cadence proposals, bounded) ───────────────────────────────────────
FIXTURES['seeddir:valid-every+quota'] = () => {
  const d = parseSeedDirectives('{"every":"weekday 9am","assignQuota":25,"routine":{"every":"daily","ask":"list new warranty tasks"}}');
  assert.equal(d.every, 'weekday 9am'); assert.equal(d.assignQuota, 25);
  assert.deepEqual(d.routine, { every: 'daily', ask: 'list new warranty tasks' });
};
FIXTURES['seeddir:quota-bounds'] = () => {
  for (const q of [0, 201, -5, 'lots', {}, NaN]) {
    assert.equal(parseSeedDirectives(JSON.stringify({ assignQuota: q })).assignQuota, null, `quota ${String(q)} must not survive`);
  }
  assert.equal(parseSeedDirectives('{"assignQuota":200}').assignQuota, 200, 'the ceiling itself is legal');
};
FIXTURES['seeddir:routine-requires-both'] = () => {
  assert.equal(parseSeedDirectives('{"routine":{"every":"daily"}}').routine, null, 'every without ask → no routine');
  assert.equal(parseSeedDirectives('{"routine":{"ask":"do the thing"}}').routine, null, 'ask without every → no routine');
  assert.equal(parseSeedDirectives('{"routine":["daily","x"]}').routine, null, 'an array is not a routine');
};
FIXTURES['seeddir:unparseable→none'] = () => {
  for (const bad of ['no json', null, '']) assert.deepEqual(parseSeedDirectives(bad), { every: null, assignQuota: null, routine: null });
};

// ── subject #9 — the STEP-IL neck (kind whitelists + palette-resolved leg) ───────────────────────────────────
const STEP_PALETTE = [{ key: 'me.zd.my_open_tickets@zd', name: 'My open tickets' }];
FIXTURES['stepil:act-resolves-offered-leg'] = () => {
  const d = parseStepDecision('{"kind":"act","leg":"me.zd.my_open_tickets@zd","confidence":0.9}', STEP_PALETTE);
  assert.equal(d.kind, 'act'); assert.ok(d.leg && d.leg.key === 'me.zd.my_open_tickets@zd');
};
FIXTURES['stepil:unoffered-leg→null'] = () => {
  const d = parseStepDecision('{"kind":"act","leg":"me.zd.delete_everything@zd","confidence":0.99}', STEP_PALETTE);
  assert.equal(d.leg, null, 'an invented leg resolves to NOTHING (agentLoop re-checks membership — defense in depth)');
};
FIXTURES['stepil:done-carries-answer'] = () => {
  const d = parseStepDecision('{"kind":"done","answer":"8 open tasks","confidence":0.8}', STEP_PALETTE);
  assert.equal(d.kind, 'done'); assert.equal(d.answer, '8 open tasks');
};
FIXTURES['stepil:unknown-kind→needs-clarify'] = () => {
  const d = parseStepDecision('{"kind":"frobnicate"}', STEP_PALETTE);
  assert.equal(d.kind, 'needs'); assert.equal(d.needs.kind, 'clarify');
};
FIXTURES['stepil:needs-kind-whitelist'] = () => {
  const d = parseStepDecision('{"kind":"needs","needs":{"kind":"self-destruct"}}', STEP_PALETTE);
  assert.equal(d.needs.kind, 'clarify', 'an invented needs.kind degrades to clarify');
  assert.equal(parseStepDecision('{"kind":"needs","needs":{"kind":"confirm"}}', STEP_PALETTE).needs.kind, 'confirm', 'the whitelist itself passes');
};
FIXTURES['stepil:unparseable→needs-clarify'] = () => {
  const d = parseStepDecision('no json at all', STEP_PALETTE);
  assert.equal(d.kind, 'needs'); assert.equal(d.needs.kind, 'clarify'); assert.equal(d.reason, 'unparseable'); assert.equal(d.confidence, 0);
};

// ── THE EFFECT HALF, slice 1 — the driver core (thin representatives; depth in runDriver.test.js) ────────────
const CL = (n) => Array.from({ length: n }, (_, i) => ({ text: `step ${i + 1}` }));
const OK = async () => ({ ok: true, value: 'v' });
FIXTURES['driver:complete'] = async () => {
  const acc = makeAccumulatorReporter();
  const r = await runWorkflow({ clauses: CL(3), reporter: acc, runStep: OK });
  assert.equal(r.verdict, 'complete'); assert.equal(r.ranSteps, 3); assert.equal(acc.snapshot().results.length, 3);
};
FIXTURES['driver:loose-chain→partial'] = async () => {
  const r = await runWorkflow({ clauses: CL(3), reporter: null, runStep: async (c, { index }) => (index === 1 ? { ok: false, error: 'flaky' } : { ok: true }) });
  assert.equal(r.verdict, 'partial'); assert.equal(r.ranSteps, 2); assert.equal(r.failedStep.i, 1, 'the FIRST failure is the audit story');
};
FIXTURES['driver:hard-stop→failed|partial'] = async () => {
  const stopAt0 = await runWorkflow({ clauses: CL(2), runStep: async () => ({ ok: false, stop: true, error: 'auth' }) });
  assert.equal(stopAt0.verdict, 'failed', 'nothing ran → failed');
  const stopAt1 = await runWorkflow({ clauses: CL(2), runStep: async (c, { index }) => (index === 0 ? { ok: true } : { ok: false, stop: true }) });
  assert.equal(stopAt1.verdict, 'partial', 'something ran → partial');
};
FIXTURES['driver:step-throw→soft-fail'] = async () => {
  const r = await runWorkflow({ clauses: CL(2), runStep: async (c, { index }) => { if (index === 0) throw new Error('boom'); return { ok: true }; } });
  assert.equal(r.verdict, 'partial', 'the throw became a soft fail; the chain continued');
};
FIXTURES['driver:no-reporter→gate-parks'] = async () => {
  const rep = normalizeReporter(null);
  assert.equal(await rep.gate({ preview: 'send email' }), 'park', 'no surface ⇒ nobody watching ⇒ NEVER auto-write');
  assert.equal(await normalizeReporter({}).gate(), 'park', 'a reporter without gate parks too');
};
FIXTURES['driver:reporter-throw-never-changes-verdict'] = async () => {
  const evil = { step() { throw new Error('x'); }, result() { throw new Error('x'); }, done() { throw new Error('x'); }, gate() { throw new Error('x'); } };
  const r = await runWorkflow({ clauses: CL(2), reporter: evil, runStep: OK });
  assert.equal(r.verdict, 'complete', 'a throwing reporter is swallowed');
  assert.equal(await normalizeReporter(evil).gate(), 'park', 'a THROWING gate fails safe to park');
};
FIXTURES['driver:park→resumable'] = async () => {
  const r = await runWorkflow({ clauses: CL(3), runStep: async (c, { index, state }) => (index === 1 ? { park: true, parkedRunId: 'run_1', state: { ...state, mark: 1 } } : { ok: true, state }) });
  assert.equal(r.verdict, 'parked'); assert.equal(r.parkedAt, 1); assert.equal(r.parkedRunId, 'run_1'); assert.equal(r.state.mark, 1, 'state carries across the park');
};
FIXTURES['driver:resume-one-approval'] = async () => {
  const rep = makeResumeReporter();
  assert.equal(await rep.gate('the approved write'), true, 'the write the human saw proceeds');
  assert.equal(await rep.gate('a SECOND write'), 'park', 'one approval per write — never blanket');
  assert.equal(rep.snapshot().approvedWrite, true);
};
FIXTURES['driver:empty→empty'] = async () => {
  assert.equal((await runWorkflow({ clauses: [], runStep: OK })).verdict, 'empty');
  assert.equal((await runWorkflow({ clauses: CL(1) })).verdict, 'failed', 'no runStep at all is a failure, not a crash');
};
FIXTURES['driver:verdict-enum-sealed'] = async () => {
  assert.deepEqual([...DRIVER_VERDICTS], ['complete', 'partial', 'failed', 'empty', 'parked']);
  assert.ok(Object.isFrozen(DRIVER_VERDICTS));
  for (const v of ['complete', 'partial', 'failed', 'empty', 'parked']) assert.ok(DRIVER_VERDICTS.includes(v));
};
FIXTURES['driver:differential-oracle-seed'] = async () => {
  // B5-5's double duty: the SAME workflow through the SW reporter and a DOM-like recording reporter must agree
  // on verdict + step count — panel ≡ SW, per reaction. Seeded at the driver core; grows per extraction.
  const mk = () => async (c, { index }) => (index === 2 ? { ok: false, error: 'x' } : { ok: true, value: index });
  const acc = makeAccumulatorReporter();
  const domish = []; const dom = { step: (i) => domish.push(`s${i}`), result: (v) => domish.push(`r${v}`), done: (v) => domish.push(`d${v}`) };
  const a = await runWorkflow({ clauses: CL(4), reporter: acc, runStep: mk() });
  const b = await runWorkflow({ clauses: CL(4), reporter: dom, runStep: mk() });
  assert.equal(a.verdict, b.verdict); assert.equal(a.ranSteps, b.ranSteps); assert.equal(a.failedSteps, b.failedSteps);
  assert.equal(acc.snapshot().verdict, 'partial'); assert.ok(domish.includes('dpartial'));
};

// ── B5-0 — the coverage seal ──────────────────────────────────────────────────────────────────────────────────
describe('decisionGate — B5-0 META-TEST: registry rows ⟷ fixtures, exact parity both directions', () => {
  it('every registered reaction has a fixture (a row with none = the forgotten reaction, red)', () => {
    const missing = allReactions().map((r) => r.id).filter((id) => typeof FIXTURES[id] !== 'function');
    assert.deepEqual(missing, [], `rows without fixtures: ${missing.join(' · ')}`);
  });
  it('every fixture has a registered reaction (an orphan fixture = derivation drift, red)', () => {
    const ids = new Set(allReactions().map((r) => r.id));
    const orphans = Object.keys(FIXTURES).filter((id) => !ids.has(id));
    assert.deepEqual(orphans, [], `fixtures without rows: ${orphans.join(' · ')}`);
  });
  it('PARTITION SEAL #2: payload-validated ∪ palette-validated ∪ terminal === INTENTS (no intent unclassed)', () => {
    const union = [...PAYLOAD_VALIDATED_INTENTS, ...PALETTE_VALIDATED_INTENTS, ...TERMINAL_INTENTS];
    assert.equal(new Set(union).size, union.length, 'no intent in two classes');
    assert.deepEqual([...union].sort(), [...INTENTS].sort(), 'add an intent → place it in a validation class, or red');
  });
  it('registry sanity: ids unique; both subjects present; the gate rows are DERIVED (count = INTENTS + 1)', () => {
    const ids = allReactions().map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(interpretReactions().length >= 30 && DECOMPOSER_REACTIONS.length >= 15);
    assert.equal(interpretReactions().filter((r) => r.kind === 'gate').length, INTENTS.length + 1);
  });
});

// ── every fixture runs — one test line per reaction ──────────────────────────────────────────────────────────
describe('decisionGate — the reactions, each proven on the real functions', () => {
  for (const row of allReactions()) {
    it(`${row.subject} · ${row.id} [${row.kind}]`, async () => { await FIXTURES[row.id](); });
  }
  it('RAIL B MILESTONE — one golden decision routes end-to-end (normalize → gate → dispatchable act)', () => {
    const d = gate(norm({ intent: 'act', capabilityId: 'cap-x', confidence: 0.92 }, { retrieved: RETRIEVED }));
    assert.equal(d.intent, 'act');
    assert.equal(d.capabilityId, 'cap-x');
    assert.ok(!d.lowConfidence);
  });
});

// ── B5-1 — TOTALITY: garbage lands legally, recoverably, and NEVER throws ────────────────────────────────────
describe('decisionGate — B5-1 totality: the catch-alls absorb everything (never throw, land legal, degrade recoverably)', () => {
  const _absorb = (shape, label) => {
    let d;
    assert.doesNotThrow(() => { d = gate(norm(shape, { retrieved: RETRIEVED, primitives: PRIMS })); }, `THREW on ${label}`);
    assert.ok(INTENTS.includes(d.intent), `${label} escaped to intent "${d.intent}"`);
    if (d.intent === 'clarify') assert.ok(typeof d.question === 'string' && d.question.length, `${label} → clarify without a question (unrecoverable)`);
  };

  it('factory 1a — every STRUCTURED garbage shape is absorbed', () => {
    GARBAGE_DECISIONS.forEach((g, i) => _absorb(g, `structured#${i} ${JSON.stringify(g)?.slice(0, 60)}`));
  });
  it('factory 1b — 40 SEEDED mutations are absorbed, and the mint is deterministic (same seed → same garbage)', () => {
    const a = mintGarbage(7, 40);
    assert.deepEqual(a, mintGarbage(7, 40), 'a gate must replay identically forever');
    a.forEach((g, i) => _absorb(g, `minted#${i}`));
  });
  it('the scheme fence holds inside the sweep: javascript:/schemeless URLs clarify, never navigate', () => {
    for (const url of ['javascript:alert(1)', 'example.com', 'ftp://x', '']) {
      assert.equal(norm({ intent: 'navigate', params: { url }, confidence: 0.99 }).intent, 'clarify', url);
    }
  });
  it('the decomposer, classify and router necks never throw on parse garbage', () => {
    for (const bad of ['', null, undefined, '{', '[[', '{"steps":42}', '{"steps":[{"a":1}]}', 'x'.repeat(5000)]) {
      assert.doesNotThrow(() => { const s = parseStepsOutput(bad); assert.ok(Array.isArray(s)); });
      assert.doesNotThrow(() => { const c = parseClassifyOutput(bad, { items: CX_ITEMS, armLabels: CX_ARMS }); assert.ok(c.byId instanceof Map); });
      assert.doesNotThrow(() => { const r = parseRouterOutput(bad); assert.ok(typeof r === 'object' && 'tool' in r); });
    }
    assert.doesNotThrow(() => { const { steps, dropped } = sanitizeSteps([null, 42, {}, 'ok fine']); assert.deepEqual(steps, ['ok fine']); assert.equal(dropped.length, 3); });
    assert.doesNotThrow(() => { assert.equal(restoreQuantifier(null, null).restored, null); assert.equal(restoreQuantifier(42, 'not-array').restored, null); });
    assert.doesNotThrow(() => { parseClassifyOutput('{"verdicts":[null,42,{"id":null}]}', { items: CX_ITEMS, armLabels: CX_ARMS }); });
  });
});
