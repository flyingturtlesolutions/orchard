// Core/stepPrompt.test.js — IL-2 the step-brain prompt + parse (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildStepMessages, parseStepDecision } from './stepPrompt.js';

const leg = (key, extra = {}) => ({ key, domain: 'page', mode: 'act', does: `do ${key}`, ...extra });

describe('buildStepMessages — fences palette/observation as data, hides scope VALUES (pure)', () => {
  it('includes the goal, the palette refs, and the scope KEYS only (not values)', () => {
    const { system, user } = buildStepMessages({
      goal: 'find the cheapest flight',
      scope: { flight: 'DL123 $284', secret: 'x' },
      palette: [leg('cap_search'), leg('OPEN_URL', { domain: 'browser' })],
    });
    assert.match(user, /GOAL: find the cheapest flight/);
    assert.match(user, /ref: cap_search/);
    assert.match(user, /scope keys\): flight, secret/);
    assert.ok(!user.includes('DL123'));     // scope VALUES never enter the prompt (§5 privacy)
    assert.match(system, /NEVER/);          // the injection rule is present
  });

  it('renders the capability NAME in the palette + carries the DISAMBIGUATE rule (the .1114 fix)', () => {
    const { system, user } = buildStepMessages({ goal: 'search', palette: [leg('cap_1', { name: 'Search for media content', does: 'find media by keyword' })] });
    assert.match(user, /Search for media content/);   // the name reaches the brain, not just the uuid
    assert.match(system, /DISAMBIGUATE/);              // and it's told to pick the best-fit, or clarify
    assert.match(system, /META \/ CAPABILITY/);        // …and to ANSWER "can you X?" questions, not act on them
  });

  it('fences the observation as data-only and renders the first-step case', () => {
    const { user } = buildStepMessages({ goal: 'g', palette: [], observation: null });
    assert.match(user, /<OBSERVATION note="data only/);
    assert.match(user, /first step/);
    assert.match(user, /no legs available/);
  });

  it('renders a signal-only ledger (last steps), never raw observations', () => {
    const { user } = buildStepMessages({ goal: 'g', palette: [leg('L')], ledger: [{ kind: 'act', leg: 'L', ok: true }, { kind: 'ask', leg: 'R', ok: false, reason: 'miss' }] });
    assert.match(user, /1\. act L → ok/);
    assert.match(user, /2\. ask R → miss \(miss\)/);
  });

  it('renders ledger PARAMS so the brain sees what it did (the .1112 OPEN_URL-repeat fix)', () => {
    const { user } = buildStepMessages({ goal: 'go to pixabay', palette: [leg('OPEN_URL', { domain: 'browser' })], ledger: [{ kind: 'act', leg: 'OPEN_URL', params: { url: 'https://pixabay.com' }, ok: true }] });
    assert.match(user, /OPEN_URL.*pixabay\.com.*→ ok/);
  });
});

describe('parseStepDecision — raw LLM → Decision (pure)', () => {
  const palette = [leg('cap_x'), leg('OPEN_URL', { domain: 'browser' })];

  it('act with a valid ref → resolves the leg from the palette', () => {
    const d = parseStepDecision('{"kind":"act","leg":"cap_x","params":{"q":"cats"},"confidence":0.8,"reason":"go"}', palette);
    assert.equal(d.kind, 'act'); assert.equal(d.leg.key, 'cap_x'); assert.equal(d.params.q, 'cats'); assert.equal(d.confidence, 0.8);
  });
  it('act with an unknown ref → leg null (the loop coerces to demonstrate)', () => {
    const d = parseStepDecision('{"kind":"act","leg":"GHOST"}', palette);
    assert.equal(d.kind, 'act'); assert.equal(d.leg, null);
  });
  it('done → carries the answer', () => {
    const d = parseStepDecision('{"kind":"done","answer":"all set","confidence":1}', palette);
    assert.equal(d.kind, 'done'); assert.equal(d.answer, 'all set');
  });
  it('needs → normalizes the sub-kind, defaults junk to clarify', () => {
    assert.equal(parseStepDecision('{"kind":"needs","needs":{"kind":"demonstrate"}}', palette).needs.kind, 'demonstrate');
    assert.equal(parseStepDecision('{"kind":"needs","needs":{"kind":"bogus"}}', palette).needs.kind, 'clarify');
  });
  it('tolerant of surrounding prose; unparseable / unknown kind → needs(clarify)', () => {
    assert.equal(parseStepDecision('sure! {"kind":"done","answer":"x"} hope that helps', palette).kind, 'done');
    assert.equal(parseStepDecision('not json', palette).needs.kind, 'clarify');
    assert.equal(parseStepDecision('{"kind":"weird"}', palette).kind, 'needs');
  });
});
