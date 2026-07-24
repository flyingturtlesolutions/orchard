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
  interpretReactions, DECOMPOSER_REACTIONS, allReactions,
  PAYLOAD_VALIDATED_INTENTS, PALETTE_VALIDATED_INTENTS, TERMINAL_INTENTS,
  GARBAGE_DECISIONS, mintGarbage,
} from './reactionRegistry.js';
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
  it('the decomposer neck never throws on parse/sanitize/restore garbage', () => {
    for (const bad of ['', null, undefined, '{', '[[', '{"steps":42}', '{"steps":[{"a":1}]}', 'x'.repeat(5000)]) {
      assert.doesNotThrow(() => { const s = parseStepsOutput(bad); assert.ok(Array.isArray(s)); });
    }
    assert.doesNotThrow(() => { const { steps, dropped } = sanitizeSteps([null, 42, {}, 'ok fine']); assert.deepEqual(steps, ['ok fine']); assert.equal(dropped.length, 3); });
    assert.doesNotThrow(() => { assert.equal(restoreQuantifier(null, null).restored, null); assert.equal(restoreQuantifier(42, 'not-array').restored, null); });
  });
});
