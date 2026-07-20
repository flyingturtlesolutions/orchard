// Core/workflowWizard.test.js — WW-1 (v2.74.1610): the ＋ Workflow wizard's pure logic.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyStepOutcome, outcomeWantsTeach, outcomeIsTransient, stepProvenance,
  targetSplitSuggestion, intentSplitSuggestion, buildWorkflowSave, wizardProgress,
} from './workflowWizard.js';

describe('workflowWizard — classifyStepOutcome (§3: the empirical outcome ladder)', () => {
  it('a completed run is always "completed" — the HUMAN judges it (never a predicted score)', () => {
    assert.equal(classifyStepOutcome({ ok: true }), 'completed');
    assert.equal(classifyStepOutcome({ ok: true, error: 'ignored when ok' }), 'completed');
  });
  it('a decompose verdict → split-suggested (§10.C intent split, qualify-time)', () => {
    assert.equal(classifyStepOutcome({ ok: false, decomposed: true }), 'split-suggested');
  });
  it('auth / rate / network → transient (retry-after-signin, never teach)', () => {
    assert.equal(classifyStepOutcome({ ok: false, error: 'session-expired' }), 'transient');
    assert.equal(classifyStepOutcome({ ok: false, status: 401 }), 'transient');
    assert.equal(classifyStepOutcome({ ok: false, error: 'http-429 rate limited' }), 'transient');
    assert.equal(classifyStepOutcome({ ok: false, error: 'network timeout' }), 'transient');
    assert.ok(outcomeIsTransient('transient') && !outcomeWantsTeach('transient'));
  });
  it('an honest gap → cant-engage (→ "show me"); a named gapKind wins', () => {
    assert.equal(classifyStepOutcome({ ok: false, error: 'no leg for this' }), 'cant-engage');
    assert.equal(classifyStepOutcome({ ok: false, error: 'op-not-captured' }), 'cant-engage');
    assert.equal(classifyStepOutcome({ ok: false, gapKind: 'no-candidate', error: 'anything' }), 'cant-engage');
    assert.ok(outcomeWantsTeach('cant-engage'));
  });
  it('an unclassified failure → hard-fail', () => {
    assert.equal(classifyStepOutcome({ ok: false, error: 'weird internal boom' }), 'hard-fail');
    assert.equal(classifyStepOutcome({}), 'hard-fail');
  });
});

describe('workflowWizard — stepProvenance (body-blind: method for display, never a value)', () => {
  it('extracts {text, via:{kind,host,name}, bankedAt} — kind + a label, NO captured value', () => {
    const ran = { capabilityId: 'cap-9', kind: 'ride', clause: 'get my open tickets', intent: 'list open tickets', groundId: 'g-1' };
    const p = stepProvenance(ran, 'get my open tickets', 'deako.zendesk.com', 500);
    assert.equal(p.text, 'get my open tickets');
    assert.equal(p.via.kind, 'ride');
    assert.equal(p.via.host, 'deako.zendesk.com');
    assert.equal(p.via.name, 'list open tickets');
    assert.equal(p.bankedAt, 500);
    assert.ok(!('value' in p) && !('capabilityId' in p), 'no captured value, no raw id leaks into the syncable record');
  });
  it('degrades: falls back to the step text; missing via → nulls', () => {
    const p = stepProvenance({}, 'do the thing');
    assert.equal(p.text, 'do the thing');
    assert.deepEqual(p.via, { kind: null, host: null, name: null });
  });
});

describe('workflowWizard — split suggestions (§10.C: target at capture, intent at qualify)', () => {
  it('target split fires only on ≥2 distinct systems, deduped/lowercased', () => {
    assert.deepEqual(targetSplitSuggestion(['VendorSuite', 'Shopify']), { split: true, systems: ['vendorsuite', 'shopify'] });
    assert.deepEqual(targetSplitSuggestion(['zendesk', 'Zendesk']), { split: false, systems: ['zendesk'] });
    assert.deepEqual(targetSplitSuggestion([]), { split: false, systems: [] });
  });
  it('intent split adopts the decompose verdict subAsks (≥2)', () => {
    assert.deepEqual(intentSplitSuggestion(['get tickets', 'summarize each']), { split: true, steps: ['get tickets', 'summarize each'] });
    assert.deepEqual(intentSplitSuggestion(['one thing']), { split: false, steps: ['one thing'] });
  });
});

describe('workflowWizard — buildWorkflowSave + wizardProgress (§2.4/§10.E)', () => {
  const STEP = (text, approved, prov) => ({ text, approved, provenance: prov });
  it('ask = the UMBRELLA intent, not the name; subAsks = step texts; all-approved → ready+qualifiedAt', () => {
    const w = { ask: 'reconcile the homeowner record', name: 'Reconcile', steps: [STEP('get vendorsuite tasks', true, { text: 'get vendorsuite tasks', via: { kind: 'ride' } }), STEP('check each in shopify', true)] };
    const save = buildWorkflowSave(w, 999);
    assert.equal(save.ask, 'reconcile the homeowner record', 'recall matches the umbrella intent (§10.E)');
    assert.equal(save.name, 'Reconcile');
    assert.deepEqual(save.subAsks, ['get vendorsuite tasks', 'check each in shopify']);
    assert.equal(save.status, 'ready');
    assert.equal(save.qualifiedAt, 999);
    assert.equal(save.steps[0].via.kind, 'ride', 'provenance rides');
  });
  it('any unproven step → draft (status draft, qualifiedAt 0) — never on the launch page', () => {
    const w = { name: 'Half', steps: [STEP('a', true), STEP('b', false)] };
    const save = buildWorkflowSave(w, 999);
    assert.equal(save.status, 'draft');
    assert.equal(save.qualifiedAt, 0);
    assert.equal(save.ask, 'Half', 'no explicit ask → falls back to name');
  });
  it('<2 steps → null (the store rejects it anyway — fail early)', () => {
    assert.equal(buildWorkflowSave({ steps: [STEP('only one', true)] }), null);
  });
  it('wizardProgress: ready needs ≥2 steps all approved; draft when any unproven', () => {
    assert.deepEqual(wizardProgress([STEP('a', true), STEP('b', true)]), { total: 2, approved: 2, unproven: 0, canSaveReady: true, canSaveDraft: false });
    assert.deepEqual(wizardProgress([STEP('a', true), STEP('b', false)]), { total: 2, approved: 1, unproven: 1, canSaveReady: false, canSaveDraft: true });
    assert.equal(wizardProgress([STEP('a', true)]).canSaveReady, false, 'one step is not a workflow');
  });
});
