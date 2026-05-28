// Core/intentSpec.test.js — SG-1a unit tests (node --test). PURE: no page, no LLM.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildIntentSpec, scopeBreadth, SHAPES } from './intentSpec.js';

describe('buildIntentSpec — offline (lexical fallback, no comprehension)', () => {
  it('classifies a read intent into a thin but valid spec, no page involved', () => {
    const s = buildIntentSpec('find the cheapest flight to NYC');
    assert.equal(s.shape, 'read');
    assert.equal(s.decidedBy, 'lexical');
    assert.equal(s.intent, 'find the cheapest flight to NYC');
    assert.deepEqual(s.subGoals, []);            // decomposition is the LLM's job — empty offline
    assert.deepEqual(s.successCondition, []);
    assert.deepEqual(s.constraints, {});
    assert.equal(s.safety, 'benign');
  });

  it('defaults a complete intent to conservative safety', () => {
    const s = buildIntentSpec('apply for this job');
    assert.equal(s.shape, 'complete');
    assert.equal(s.safety, 'consequential');     // complete likely commits → trial errs cautious
  });

  it('always returns the full contract shape', () => {
    const s = buildIntentSpec('sign in');
    for (const k of ['intent', 'shape', 'target', 'constraints', 'dataNeeded', 'subGoals', 'successCondition', 'safety', 'confidence', 'decidedBy']) {
      assert.ok(k in s, `missing key ${k}`);
    }
    assert.ok(SHAPES.includes(s.shape));
  });
});

describe('buildIntentSpec — with LLM comprehension', () => {
  const comp = {
    shape: 'complete',
    target: 'the job application for Technical Support Specialist',
    constraints: { position: 'Technical Support Specialist', remote: true, junk: { nested: 1 } },
    dataNeeded: ['full name', 'resume file', 'address', 'full name'],   // dup dropped
    subGoals: [
      { id: 'identity', label: 'provide identity', shape: 'complete', scope: 'required' },
      { id: 'resume', label: 'attach resume', shape: 'complete', scope: 'required', dependsOn: ['identity'] },
      { label: 'submit the application', shape: 'act', scope: 'required', dependsOn: ['resume', 'ghost', 'submit'] },
    ],
    successCondition: [
      { signal: 'url', match: '/thank-you' },
      { signal: 'text', match: 'Application submitted' },
      { signal: 'bogus', match: 'ignored' },     // bad signal dropped
    ],
    safety: 'irreversible',
    confidence: 0.9,
  };
  const s = buildIntentSpec('apply for the Technical Support Specialist position', comp);

  it('takes LLM shape/target/safety/confidence', () => {
    assert.equal(s.shape, 'complete');
    assert.equal(s.decidedBy, 'llm');
    assert.equal(s.target, 'the job application for Technical Support Specialist');
    assert.equal(s.safety, 'irreversible');
    assert.equal(s.confidence, 0.9);
  });

  it('normalizes the ordered subGoal program: assigns a missing id, drops dangling/self deps', () => {
    assert.equal(s.subGoals.length, 3);
    const submit = s.subGoals[2];
    assert.ok(submit.id && submit.id.length, 'submit got an assigned id');
    assert.deepEqual(submit.dependsOn, ['resume']);     // 'ghost' (phantom) + self dropped
    assert.equal(s.subGoals[1].dependsOn[0], 'identity');
  });

  it('keeps only valid observable successConditions', () => {
    assert.equal(s.successCondition.length, 2);
    assert.deepEqual(s.successCondition[0], { signal: 'url', match: '/thank-you' });
  });

  it('flattens constraints (drops nested) + dedups dataNeeded', () => {
    assert.equal(s.constraints.position, 'Technical Support Specialist');
    assert.equal(s.constraints.remote, true);
    assert.ok(!('junk' in s.constraints));               // nested object dropped
    assert.equal(s.dataNeeded.filter((d) => d === 'full name').length, 1);
  });

  it('reports multi scope breadth for a full application (page-independent)', () => {
    assert.equal(scopeBreadth(s), 'multi');
  });
});

describe('buildIntentSpec — navigate shape + lenient coercions', () => {
  it('accepts the navigate shape (LLM-only — lexical never emits it)', () => {
    const s = buildIntentSpec('go to the pricing page', { shape: 'navigate', subGoals: [] });
    assert.equal(s.shape, 'navigate');
    assert.equal(scopeBreadth(s), 'single');
  });

  it('coerces a prose successCondition string into a text observable', () => {
    const s = buildIntentSpec('toggle dark mode', { shape: 'act', successCondition: 'dark mode is on' });
    assert.deepEqual(s.successCondition, [{ signal: 'text', match: 'dark mode is on' }]);
  });

  it('drops label-less subGoals and rejects an unknown shape (falls back to lexical)', () => {
    const s = buildIntentSpec('apply for this job', { shape: 'totally-bogus', subGoals: [{ foo: 1 }, { label: 'ok' }] });
    assert.equal(s.shape, 'complete');           // bogus shape ignored → lexical classifies "apply"
    assert.equal(s.decidedBy, 'lexical');
    assert.equal(s.subGoals.length, 1);
    assert.equal(s.subGoals[0].label, 'ok');
    assert.ok(s.subGoals[0].id);                 // id assigned
  });
});
