// Core/select.test.js — SG-2a unit tests (node --test). PURE: a fixture Locale, no page, no LLM.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { coverageBoundary, selectCandidates, buildSelection, coverGaps, reconcileMatches } from './select.js';

// A mini Locale modelled on the live BambooHR apply form: required fields, an optional field, a honeypot
// decoy, the real submit, a Cancel (effect:none after the cancel/reset fix), and non-form features.
function fixture() {
  const f = (o) => ({ a11yRole: null, ...o });
  const features = {
    firstName: f({ id: 'firstName', kind: 'input', required: true, selector: '#firstName', interaction: { pattern: 'type', effect: 'none' } }),
    email:     f({ id: 'email', kind: 'input', required: true, selector: '#email', interaction: { pattern: 'type', effect: 'none' } }),
    resume:    f({ id: 'resume', kind: 'input', required: true, fieldType: 'file', selector: '[aria-label="file-input"]', interaction: { pattern: 'upload', effect: 'none' } }),
    linkedin:  f({ id: 'linkedin', kind: 'input', required: false, selector: '#linkedinUrl', interaction: { pattern: 'type', effect: 'none' } }),
    nickname:  f({ id: 'nickname', kind: 'input', required: false, decoy: true, offscreen: true, selector: '#nickname_hpcsaf', interaction: { pattern: 'type', effect: 'none' } }),
    submit:    f({ id: 'submit', kind: 'action', label: 'Submit Application', selector: 'button.submit', interaction: { pattern: 'click', effect: 'submit' } }),
    cancel:    f({ id: 'cancel', kind: 'action', label: 'Cancel', selector: 'button.cancel', interaction: { pattern: 'click', effect: 'none' } }),
    viewdesc:  f({ id: 'viewdesc', kind: 'action', label: 'View Job Description', selector: 'button.view', interaction: { pattern: 'click', effect: 'none' } }),
    openings:  f({ id: 'openings', kind: 'navigation', label: 'Job Openings', selector: 'a.back', interaction: { pattern: 'click', effect: 'navigate' } }),
    dept:      f({ id: 'dept', kind: 'collection', label: 'Department', selector: 'div.dept' }),
  };
  return { features };
}

describe('coverageBoundary — page-required is the completeness set', () => {
  const b = coverageBoundary(fixture());

  it('includes every required, non-decoy field with a selector', () => {
    const ids = b.requiredFields.map((f) => f.id).sort();
    assert.deepEqual(ids, ['email', 'firstName', 'resume']);
  });

  it('excludes optional fields and honeypot decoys', () => {
    const ids = b.requiredFields.map((f) => f.id);
    assert.ok(!ids.includes('linkedin'), 'optional excluded');
    assert.ok(!ids.includes('nickname'), 'decoy excluded');
  });

  it('picks the success action by effect:submit, not the Cancel (effect:none)', () => {
    assert.equal(b.successActions.length, 1);
    assert.equal(b.successAction.id, 'submit');
  });
});

describe('selectCandidates — shape-narrowed retrieval', () => {
  const loc = fixture();

  it('complete → non-decoy inputs + all actions (no nav/collection, no honeypot)', () => {
    const ids = selectCandidates(loc, { shape: 'complete' }).map((f) => f.id).sort();
    assert.deepEqual(ids, ['cancel', 'email', 'firstName', 'linkedin', 'resume', 'submit', 'viewdesc']);
  });

  it('read → collections/regions/inputs', () => {
    const ids = selectCandidates(loc, { shape: 'read' }).map((f) => f.id);
    assert.ok(ids.includes('dept'));
    assert.ok(ids.includes('email'));
    assert.ok(!ids.includes('submit'));
  });

  it('navigate → actions/navigation/disclosures', () => {
    const ids = selectCandidates(loc, { shape: 'navigate' }).map((f) => f.id);
    assert.ok(ids.includes('openings'));
    assert.ok(ids.includes('submit'));     // actions included
    assert.ok(!ids.includes('email'));
  });
});

describe('buildSelection + coverGaps — the Cover seed', () => {
  const loc = fixture();
  const sel = buildSelection(loc, { shape: 'complete' });

  it('only computes a boundary for complete intents', () => {
    assert.equal(sel.shape, 'complete');
    assert.equal(sel.boundary.requiredFields.length, 3);
    assert.equal(sel.matches, null);
    const readSel = buildSelection(loc, { shape: 'read' });
    assert.equal(readSel.boundary.requiredFields.length, 0);
  });

  it('reports gaps when required fields are unbound', () => {
    const g = coverGaps(sel.boundary, ['firstName']);   // email, resume, submit missing
    assert.equal(g.complete, false);
    assert.deepEqual(g.missingFields.map((f) => f.id).sort(), ['email', 'resume']);
    assert.equal(g.successBound, false);
  });

  it('is complete only when all required fields AND the success action are bound', () => {
    const g = coverGaps(sel.boundary, ['firstName', 'email', 'resume', 'submit']);
    assert.equal(g.missingFields.length, 0);
    assert.equal(g.successBound, true);
    assert.equal(g.complete, true);
  });
});

describe('reconcileMatches — LLM proposes, code disposes', () => {
  // A locale with a required `city` no subGoal will claim (the orphan the prior misses).
  function loc2() {
    const f = (o) => ({ a11yRole: null, ...o });
    return { features: {
      firstName: f({ id: 'firstName', kind: 'input', required: true, selector: '#firstName', interaction: { effect: 'none' } }),
      email:     f({ id: 'email', kind: 'input', required: true, selector: '#email', interaction: { effect: 'none' } }),
      resume:    f({ id: 'resume', kind: 'input', required: true, selector: '[aria-label="file-input"]', interaction: { effect: 'none' } }),
      city:      f({ id: 'city', kind: 'input', required: true, selector: '#city', interaction: { effect: 'none' } }),
      linkedin:  f({ id: 'linkedin', kind: 'input', required: false, selector: '#linkedinUrl', interaction: { effect: 'none' } }),
      submit:    f({ id: 'submit', kind: 'action', label: 'Submit', selector: 'button.s', interaction: { effect: 'submit' } }),
    } };
  }
  const spec = { shape: 'complete', subGoals: [
    { id: 'identity', label: 'identity', shape: 'complete', scope: 'required' },
    { id: 'docs', label: 'docs', shape: 'act', scope: 'optional' },     // prior optional → maps to required resume
    { id: 'extra', label: 'extra', shape: 'complete', scope: 'optional' }, // prior optional → maps to optional linkedin
  ] };
  const raw = { identity: ['firstName', 'email', 'ghost'], docs: ['resume'], extra: ['linkedin'], nope: ['submit'] };
  const r = reconcileMatches(loc2(), spec, raw);

  it('validates ids — drops hallucinated featureIds and unknown subGoalIds', () => {
    assert.deepEqual(r.matches.identity, ['firstName', 'email']);   // 'ghost' dropped
    assert.deepEqual(r.matches.docs, ['resume']);
    assert.ok(!('nope' in r.matches));                               // unknown subGoal dropped
    assert.equal(r.featureToSubGoal.firstName, 'identity');
  });

  it('reconciles scope — page required overrides the prior optional', () => {
    const byId = Object.fromEntries(r.reconciledSubGoals.map((s) => [s.id, s]));
    assert.equal(byId.docs.effectiveScope, 'required');   // maps to required `resume`
    assert.equal(byId.docs.scopeChanged, true);
    assert.equal(byId.extra.effectiveScope, 'optional');  // maps only to optional `linkedin`
    assert.equal(byId.extra.scopeChanged, false);
    assert.equal(byId.identity.effectiveScope, 'required');
  });

  it('surfaces orphan required features the prior never claimed', () => {
    assert.deepEqual(r.orphanRequired.map((f) => f.id), ['city']);
  });

  it('a feature serves at most one subGoal', () => {
    const r2 = reconcileMatches(loc2(), spec, { identity: ['firstName'], docs: ['firstName', 'resume'] });
    assert.deepEqual(r2.matches.identity, ['firstName']);
    assert.deepEqual(r2.matches.docs, ['resume']);        // firstName already taken by identity
  });

  it('tolerates null/garbage matches — all required become orphans', () => {
    const r3 = reconcileMatches(loc2(), spec, null);
    assert.deepEqual(r3.orphanRequired.map((f) => f.id).sort(), ['city', 'email', 'firstName', 'resume']);
  });
});
