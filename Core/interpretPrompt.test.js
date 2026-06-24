// Core/interpretPrompt.test.js — F-2 (DESIGN_llm_front_door.md §9): the interpret prompt + parse.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildInterpretMessages, parseInterpretOutput } from './interpretPrompt.js';
import { normalizeInterpretDecision } from './interpret.js';

describe('interpretPrompt — buildInterpretMessages', () => {
  it('system states the intents + the clarify-when-unsure trust rule; user carries the ask', () => {
    const { system, user } = buildInterpretMessages('go to youtube', { retrieved: [], primitives: ['OPEN_URL'] });
    assert.match(system, /reasoning front door/i);
    assert.match(system, /"clarify"/);
    assert.match(system, /asking is better/i);   // the §9.3 trust rule (phrase wraps a line in SYSTEM)
    assert.match(user, /USER ASK: go to youtube/);
  });

  it('fences the seed as CONVERSATION_INTENT (never SYSTEM) and the catalog as data', () => {
    const { system, user } = buildInterpretMessages('do it', { retrieved: [{ capabilityId: 'cap-x', intent: 'Search videos' }], seed: 'You are a video librarian.' });
    assert.doesNotMatch(system, /video librarian/);   // seed never leaks into SYSTEM
    assert.match(user, /<CONVERSATION_INTENT/);
    assert.match(user, /video librarian/);
    assert.match(user, /ref: cap-x/);
    assert.match(user, /Search videos/);
  });

  it('marks an irreversible capability for the model', () => {
    const { user } = buildInterpretMessages('x', { retrieved: [{ capabilityId: 'cap-buy', name: 'Buy it', reversible: false }] });
    assert.match(user, /IRREVERSIBLE/);
  });

  it('includes NO raw DOM — only the fenced summary affordances', () => {
    const { user } = buildInterpretMessages('x', { affordances: 'search box, results list' });
    assert.match(user, /<PAGE_AFFORDANCES/);
    assert.match(user, /search box, results list/);
  });
});

describe('interpretPrompt — parseInterpretOutput', () => {
  it('extracts a JSON object even wrapped in prose; clamps confidence', () => {
    const o = parseInterpretOutput('Sure! {"intent":"navigate","params":{"url":"https://x.com"},"confidence":3} done');
    assert.equal(o.intent, 'navigate');
    assert.equal(o.params.url, 'https://x.com');
    assert.equal(o.confidence, 1);
  });

  it('maps a legacy "tool" field onto capabilityId; lowercases intent', () => {
    const o = parseInterpretOutput({ intent: 'ACT', tool: 'cap-x', confidence: 0.8 });
    assert.equal(o.intent, 'act');
    assert.equal(o.capabilityId, 'cap-x');
  });

  it('unparseable → clarify (fail safe)', () => {
    assert.equal(parseInterpretOutput('not json').intent, 'clarify');
    assert.equal(parseInterpretOutput(null).intent, 'clarify');
  });

  it('composes with normalizeInterpretDecision: parsed act on an offered cap survives', () => {
    const raw = parseInterpretOutput('{"intent":"act","capabilityId":"cap-x","confidence":0.9}');
    const d = normalizeInterpretDecision(raw, { retrieved: [{ id: 'cap-x' }] });
    assert.equal(d.intent, 'act');
    assert.equal(d.capabilityId, 'cap-x');
  });
});
