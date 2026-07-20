// Core/interpret.test.js — F-1 (DESIGN_llm_front_door.md §9): the interpret decision core.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeInterpretDecision, applyConfidenceGate, interpret, INTENTS } from './interpret.js';

const RETRIEVED = [{ id: 'cap-search' }, { capabilityId: 'cap-filter' }];
const PRIMS = ['OPEN_URL', { op: 'CLICK' }];

describe('interpret — normalizeInterpretDecision', () => {
  it('act on an OFFERED capability passes; clamps confidence', () => {
    const d = normalizeInterpretDecision({ intent: 'act', capabilityId: 'cap-search', confidence: 1.7 }, { retrieved: RETRIEVED });
    assert.equal(d.intent, 'act');
    assert.equal(d.capabilityId, 'cap-search');
    assert.equal(d.confidence, 1);   // clamped to [0,1]
  });

  it('act on an UNOFFERED tool → teach (anti-hallucination, never dispatch an invented tool)', () => {
    const d = normalizeInterpretDecision({ intent: 'act', capabilityId: 'cap-ghost', confidence: 0.9 }, { retrieved: RETRIEVED });
    assert.equal(d.intent, 'teach');
  });

  it('act may select an offered PRIMITIVE op', () => {
    const d = normalizeInterpretDecision({ intent: 'act', op: 'click', confidence: 0.8 }, { retrieved: RETRIEVED, primitives: PRIMS });
    assert.equal(d.intent, 'act');
    assert.equal(d.op, 'CLICK');
  });

  it('v1342: act with capabilityId OPEN_URL (primitive op in wrong field) → act op', () => {
    const d = normalizeInterpretDecision({ intent: 'act', capabilityId: 'OPEN_URL', confidence: 0.8 }, { retrieved: RETRIEVED, primitives: PRIMS });
    assert.equal(d.intent, 'act');
    assert.equal(d.op, 'OPEN_URL');
  });

  it('navigate needs a real url; without one → clarify', () => {
    assert.equal(normalizeInterpretDecision({ intent: 'navigate', params: { url: 'https://youtube.com' }, confidence: 0.9 }).op, 'OPEN_URL');
    assert.equal(normalizeInterpretDecision({ intent: 'navigate', params: {}, confidence: 0.9 }).intent, 'clarify');
  });

  it('decompose needs ≥2 sub-asks; a thin one → clarify', () => {
    assert.equal(normalizeInterpretDecision({ intent: 'decompose', subAsks: ['a', 'b'], confidence: 0.8 }).subAsks.length, 2);
    assert.equal(normalizeInterpretDecision({ intent: 'decompose', subAsks: ['only one'] }).intent, 'clarify');
  });

  it('an unparseable / unknown intent defaults to clarify (the safe ask)', () => {
    assert.equal(normalizeInterpretDecision(null).intent, 'clarify');
    assert.equal(normalizeInterpretDecision({ intent: 'frobnicate' }).intent, 'clarify');
    assert.ok(INTENTS.includes('answer') && INTENTS.includes('teach'));
  });
});

describe('interpret — applyConfidenceGate (the §9.3 trust mechanism)', () => {
  it('a LOW-confidence navigate becomes a clarify — does not fire', () => {
    const d = applyConfidenceGate({ intent: 'navigate', op: 'OPEN_URL', params: { url: 'https://youtube.com' }, confidence: 0.3 });
    assert.equal(d.intent, 'clarify');
    assert.ok(d.question);
  });

  it('a LOW-confidence act becomes a clarify', () => {
    assert.equal(applyConfidenceGate({ intent: 'act', capabilityId: 'x', confidence: 0.2 }).intent, 'clarify');
  });

  it('a CONFIDENT act/navigate passes; a non-act intent is never gated', () => {
    assert.equal(applyConfidenceGate({ intent: 'act', capabilityId: 'x', confidence: 0.9 }).intent, 'act');
    assert.equal(applyConfidenceGate({ intent: 'answer', confidence: 0.1 }).intent, 'answer');
  });

  it('v1342: a LOW-confidence decompose carries lowConfidence (dispatch guard reads it)', () => {
    const d = applyConfidenceGate({ intent: 'decompose', subAsks: ['a', 'b'], confidence: 0.1 });
    assert.equal(d.intent, 'decompose');
    assert.equal(d.lowConfidence, true);
  });
});

describe('interpret — orchestration over an injected think', () => {
  it('empty ask → clarify (no LLM call)', async () => {
    const d = await interpret('   ', {}, { think: () => { throw new Error('should not be called'); } });
    assert.equal(d.intent, 'clarify');
  });

  it('think throws → clarify (fail-safe)', async () => {
    const d = await interpret('do a thing', { retrieved: RETRIEVED }, { think: () => { throw new Error('boom'); } });
    assert.equal(d.intent, 'clarify');
  });

  it('"if go to youtube" — a confident-looking but low-confidence nav is GATED to clarify (the bug F-1 fixes)', async () => {
    const think = () => ({ intent: 'navigate', params: { url: 'https://youtube.com' }, confidence: 0.4, why: 'maybe nav' });
    const d = await interpret('if go to youtube', { retrieved: [], primitives: PRIMS }, { think, minConfidence: 0.6 });
    assert.equal(d.intent, 'clarify');   // asks instead of navigating — the trust property
  });

  it('a clean confident nav passes through', async () => {
    const think = () => ({ intent: 'navigate', params: { url: 'https://youtube.com' }, confidence: 0.95 });
    const d = await interpret('go to youtube', {}, { think });
    assert.equal(d.intent, 'navigate');
    assert.equal(d.params.url, 'https://youtube.com');
  });
});

describe('interpret — the map intent (PM-1, DESIGN_peritem_map.md)', () => {
  const MAP = { itemField: 'homeowner email', target: { system: 'shopify', readAsk: 'search Shopify for {value}' } };
  it('a valid map verdict normalizes + carries the clause', () => {
    const d = normalizeInterpretDecision({ intent: 'map', map: MAP, confidence: 0.9 });
    assert.equal(d.intent, 'map');
    assert.equal(d.map.kind, 'map');
    assert.equal(d.map.itemField, 'homeowner email');
    assert.equal(d.map.target.system, 'shopify');
    assert.equal(d.map.join, 'table');
  });
  it('map fields at the top level (no nested .map) are also accepted', () => {
    const d = normalizeInterpretDecision({ intent: 'map', ...MAP, confidence: 0.9 });
    assert.equal(d.intent, 'map');
    assert.equal(d.map.itemField, 'homeowner email');
  });
  it('an underspecified map with subAsks DEGRADES to decompose', () => {
    const d = normalizeInterpretDecision({ intent: 'map', map: { itemField: 'x' }, subAsks: ['get tasks', 'look each up'], confidence: 0.9 });
    assert.equal(d.intent, 'decompose');
    assert.deepEqual(d.subAsks, ['get tasks', 'look each up']);
  });
  it('an underspecified map with no subAsks becomes clarify', () => {
    const d = normalizeInterpretDecision({ intent: 'map', map: {}, confidence: 0.9 });
    assert.equal(d.intent, 'clarify');
    assert.ok(d.question);
  });
  it('a low-confidence map becomes clarify (never fires N reads on a shaky read)', () => {
    const d = applyConfidenceGate(normalizeInterpretDecision({ intent: 'map', map: MAP, confidence: 0.3 }), { minConfidence: 0.6 });
    assert.equal(d.intent, 'clarify');
  });
  it('map is in the INTENTS vocabulary', () => { assert.ok(INTENTS.includes('map')); });
});
