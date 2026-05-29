// Core/bind.test.js — SG-4a unit tests (node --test). PURE: synthetic selections, no page, no LLM.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { selectionToTrialRoles } from './bind.js';

const field = (id, label, selector = `#${id}`, extra = {}) =>
  ({ id, label, kind: 'input', required: true, selector, interaction: { pattern: 'type', effect: 'none' }, ...extra });
const submit = { id: 'submit', label: 'Submit Application', kind: 'action', selector: 'button.s', interaction: { pattern: 'click', effect: 'submit' } };

describe('selectionToTrialRoles — complete intent', () => {
  it('maps required fields + the success action to roles, carrying featureId', () => {
    const sel = { boundary: { requiredFields: [field('firstName', 'First Name'), field('email', 'Email')], successAction: submit } };
    const roles = selectionToTrialRoles({ shape: 'complete' }, sel);
    assert.equal(roles.length, 3);
    // v2.74.594 — roles now carry the substrate-derived `kind` (self-contained for replay). A `type`
    // input has no fieldType (text is the fillOpFor default → omitted). SG-LM-2 also attaches a proto
    // `landmark` (recoverable identity), so compare the core fields and assert the landmark separately.
    const { landmark, ...core0 } = roles[0];
    assert.deepEqual(core0, { role: 'First Name', selector: '#firstName', featureId: 'firstName', multiplicity: 'one', kind: 'input' });
    assert.ok(landmark && landmark.selector === '#firstName', 'role carries a proto-landmark (SG-LM-2)');
    const last = roles[roles.length - 1];
    assert.equal(last.role, 'Submit Application');
    assert.equal(last.featureId, 'submit');
    assert.equal(last.kind, 'action');
    roles.forEach((r) => assert.ok(r.featureId, 'every role carries featureId for kind lookup'));
  });

  it('carries kind + fieldType so a select/file role replays without the live feature (self-contained)', () => {
    const sel = { boundary: { requiredFields: [
      { id: 'country', label: 'Country', kind: 'input', required: true, selector: 'select[name="c"]', interaction: { pattern: 'select', effect: 'none' } },
      { id: 'resume', label: 'Resume', kind: 'input', required: true, selector: 'input[name="r"]', interaction: { pattern: 'upload', effect: 'none' } },
    ], successAction: submit } };
    const roles = selectionToTrialRoles({ shape: 'complete' }, sel);
    const byId = Object.fromEntries(roles.map((r) => [r.featureId, r]));
    assert.equal(byId.country.kind, 'input');
    assert.equal(byId.country.fieldType, 'select');
    assert.equal(byId.resume.fieldType, 'file');
  });

  it('drops a required field with no selector', () => {
    const sel = { boundary: { requiredFields: [field('firstName', 'First Name'), { id: 'x', label: 'X', kind: 'input', selector: null }], successAction: submit } };
    const roles = selectionToTrialRoles({ shape: 'complete' }, sel);
    assert.deepEqual(roles.map((r) => r.featureId), ['firstName', 'submit']);
  });

  it('falls back to the feature id when the label is empty', () => {
    const sel = { boundary: { requiredFields: [field('FabricTextField-5', '')], successAction: null } };
    const roles = selectionToTrialRoles({ shape: 'complete' }, sel);
    assert.equal(roles[0].role, 'FabricTextField-5');
  });
});

describe('selectionToTrialRoles — minimal completion (search): bind matched, not just required', () => {
  it('binds Select-matched fields even when none are page-required (so the plan is runnable)', () => {
    // A job SEARCH form: title + location are NOT required; the floor (required fields) is EMPTY.
    const locale = { features: {
      title: { id: 'title', label: 'Job title', kind: 'input', required: false, selector: '#title', interaction: { pattern: 'type', effect: 'none' } },
      loc: { id: 'loc', label: 'Location', kind: 'input', required: false, selector: '#loc', interaction: { pattern: 'type', effect: 'none' } },
      go: { id: 'go', label: 'Search', kind: 'action', selector: '#search', interaction: { pattern: 'click', effect: 'submit' } },
    } };
    const sel = {
      boundary: { requiredFields: [], successAction: locale.features.go },
      matches: { 'enter-title': ['title'], 'enter-location': ['loc'] },
    };
    const roles = selectionToTrialRoles({ shape: 'complete' }, sel, locale);
    // required floor is empty, but the matched fields + the search action are bound → runnable
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['go', 'loc', 'title']);
    assert.ok(roles.length >= 2, 'plan has actionable fill steps');
  });
});

describe('selectionToTrialRoles — hidden field reveal sequencing', () => {
  it('includes the trigger first and rewrites revealedBy to the trigger ROLE NAME', () => {
    const locale = { features: {
      trigBtn: { id: 'trigBtn', label: 'Show more', kind: 'disclosure', selector: '#more', interaction: { pattern: 'click', effect: 'reveal' } },
      hidden1: { id: 'hidden1', label: 'Promo code', kind: 'input', required: true, selector: '#promo', hidden: true, revealedBy: 'trigBtn', interaction: { pattern: 'type', effect: 'none' } },
    } };
    const sel = { boundary: { requiredFields: [locale.features.hidden1], successAction: submit } };
    const roles = selectionToTrialRoles({ shape: 'complete' }, sel, locale);
    // trigger injected before the hidden field
    assert.deepEqual(roles.map((r) => r.featureId), ['trigBtn', 'hidden1', 'submit']);
    const hidden = roles.find((r) => r.featureId === 'hidden1');
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.revealedBy, 'Show more');   // trigger's role NAME, not its id
  });
});

describe('selectionToTrialRoles — goal-grounded membership (SG-RES-7): a matched feature anchors its whole goal', () => {
  it('binds the goal-sibling inputs when the matcher returns ONLY the submit (Indeed search regression)', () => {
    // The lossy per-sub-goal matcher returned just the Search button; q + location were dropped, so the
    // trial used to click Search on an empty form. The Locale's goal grouping is the ground-truth form.
    const locale = { features: {
      q:   { id: 'q', label: 'Job title, keywords', kind: 'input', goals: ['g_search'], selector: 'input[name="q"]', interaction: { pattern: 'type', effect: 'none' } },
      l:   { id: 'l', label: 'Location', kind: 'input', goals: ['g_search'], selector: 'input[name="l"]', interaction: { pattern: 'type', effect: 'none' } },
      go:  { id: 'go', label: 'Search', kind: 'action', goals: ['g_search'], selector: 'button.search', interaction: { pattern: 'click', effect: 'submit' } },
      junk:{ id: 'junk', label: 'Clear', kind: 'action', decoy: true, goals: ['g_search'], selector: 'button.clear', interaction: { pattern: 'click', effect: 'none' } },
    } };
    const sel = { matches: { 'execute-search': ['go'] } };   // ONLY the submit matched
    const roles = selectionToTrialRoles({ shape: 'act' }, sel, locale);
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['go', 'l', 'q'], 'q + location inputs expanded in from the form goal');
  });

  it('anchors on an INPUT too: matching just a field pulls in its goal-sibling submit (reverse direction)', () => {
    // SG-RES-5 only pulled inputs off a matched SUBMIT; SG-RES-7 is symmetric — matching an input anchors
    // the goal and pulls in the submit (+ the other field), so a half-bound search still runs the form.
    const locale = { features: {
      q:   { id: 'q', label: 'Job title, keywords', kind: 'input', goals: ['g_search'], selector: 'input[name="q"]', interaction: { pattern: 'type', effect: 'none' } },
      l:   { id: 'l', label: 'Location', kind: 'input', goals: ['g_search'], selector: 'input[name="l"]', interaction: { pattern: 'type', effect: 'none' } },
      go:  { id: 'go', label: 'Search', kind: 'action', goals: ['g_search'], selector: 'button.search', interaction: { pattern: 'click', effect: 'submit' } },
    } };
    const sel = { matches: { 'enter-query': ['q'] } };   // ONLY a field matched
    const roles = selectionToTrialRoles({ shape: 'act' }, sel, locale);
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['go', 'l', 'q'], 'submit + sibling field expanded in from the goal');
  });

  it('binds off the FORWARD achievableVia map even when sibling features carry no reverse goals pointer', () => {
    // Goal-grounded ground truth lives in locale.goals[g].achievableVia. The matcher anchors a feature that
    // belongs to a goal (reverse pointer on the anchor only); the rest of achievableVia binds via the map.
    const locale = {
      goals: { g_search: { id: 'g_search', label: 'search for jobs', achievableVia: ['q', 'l', 'go'] } },
      features: {
        q:  { id: 'q', label: 'Job title', kind: 'input', selector: 'input[name="q"]', interaction: { pattern: 'type', effect: 'none' } },
        l:  { id: 'l', label: 'Location', kind: 'input', selector: 'input[name="l"]', interaction: { pattern: 'type', effect: 'none' } },
        go: { id: 'go', label: 'Search', kind: 'action', goals: ['g_search'], selector: 'button.search', interaction: { pattern: 'click', effect: 'submit' } },
      },
    };
    const sel = { matches: { 'execute-search': ['go'] } };   // anchor carries goals: ['g_search']
    const roles = selectionToTrialRoles({ shape: 'act' }, sel, locale);
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['go', 'l', 'q'], 'achievableVia members q + l bound via the forward goal map');
  });

  it('does not expand when the matched submit has no form-essential siblings (e.g. an Apply button)', () => {
    const locale = { features: {
      apply: { id: 'apply', label: 'Apply', kind: 'action', goals: ['g_apply'], selector: 'button.apply', interaction: { pattern: 'click', effect: 'submit' } },
      save:  { id: 'save', label: 'Save job', kind: 'action', goals: ['g_apply'], selector: 'button.save', interaction: { pattern: 'click', effect: 'none' } },
    } };
    const sel = { matches: { 'do-apply': ['apply'] } };
    const roles = selectionToTrialRoles({ shape: 'act' }, sel, locale);
    assert.deepEqual(roles.map((r) => r.featureId), ['apply'], 'no inputs/submit siblings in the goal → nothing pulled in (save is effect:none)');
  });

  it('does not drag in tangential non-form actions that merely share the goal', () => {
    // achievableVia membership is scoped to FORM ESSENTIALS (input/submit/disclosure). A "Share search"
    // action sharing the goal is NOT a form field and must not join the trial.
    const locale = { features: {
      q:     { id: 'q', label: 'Query', kind: 'input', goals: ['g_search'], selector: '#q', interaction: { pattern: 'type', effect: 'none' } },
      go:    { id: 'go', label: 'Search', kind: 'action', goals: ['g_search'], selector: '#go', interaction: { pattern: 'click', effect: 'submit' } },
      share: { id: 'share', label: 'Share search', kind: 'action', goals: ['g_search'], selector: '#share', interaction: { pattern: 'click', effect: 'none' } },
    } };
    const sel = { matches: { 'execute-search': ['go'] } };
    const roles = selectionToTrialRoles({ shape: 'act' }, sel, locale);
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['go', 'q'], 'q (input) bound; share (effect:none action) excluded');
  });
});

describe('selectionToTrialRoles — read/act intents resolve matched features via the locale', () => {
  it('maps matched featureIds to roles using the locale', () => {
    const locale = { features: {
      box: { id: 'box', label: 'Search', kind: 'input', selector: '#q', interaction: { pattern: 'type', effect: 'none' } },
      go: { id: 'go', label: 'Search', kind: 'action', selector: '#go', interaction: { pattern: 'click', effect: 'submit' } },
      list: { id: 'list', label: 'Results', kind: 'collection', selector: '.results', interaction: { pattern: 'none', effect: 'none' } },
    } };
    const sel = { matches: { 'enter-query': ['box'], 'submit-search': ['go'], 'read-results': ['list'] } };
    const roles = selectionToTrialRoles({ shape: 'read' }, sel, locale);
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['box', 'go', 'list']);
    assert.ok(roles.every((r) => r.selector));
  });
});
