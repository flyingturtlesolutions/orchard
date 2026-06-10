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

  it('ZERO-ANCHOR: when the matcher binds nothing, resolves the goal off its label and binds it (SG-RES-7b)', () => {
    // The matcher returned an empty match (no feature anchored a goal). The intent names "search for jobs",
    // which resolves to g_search by label → its achievableVia binds, so the plan is still runnable.
    const locale = {
      goals: { g_search: { id: 'g_search', label: 'search for jobs', achievableVia: ['q', 'l', 'go'] } },
      features: {
        q:  { id: 'q', label: 'Job title', kind: 'input', goals: ['g_search'], selector: '#q', interaction: { pattern: 'type', effect: 'none' } },
        l:  { id: 'l', label: 'Location', kind: 'input', goals: ['g_search'], selector: '#l', interaction: { pattern: 'type', effect: 'none' } },
        go: { id: 'go', label: 'Search', kind: 'action', goals: ['g_search'], selector: '#go', interaction: { pattern: 'click', effect: 'submit' } },
      },
    };
    const sel = { matches: {} };   // matcher anchored NOTHING
    const roles = selectionToTrialRoles({ shape: 'act', target: 'search for jobs', subGoals: [] }, sel, locale);
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['go', 'l', 'q'], 'goal resolved by label → achievableVia bound');
  });

  it('ZERO-ANCHOR abstains on an ambiguous intent → no roles (rather than bind a wrong form)', () => {
    const locale = {
      goals: { g1: { id: 'g1', label: 'foo widget', achievableVia: ['a'] }, g2: { id: 'g2', label: 'bar widget', achievableVia: ['b'] } },
      features: {
        a: { id: 'a', label: 'A', kind: 'input', goals: ['g1'], selector: '#a', interaction: { pattern: 'type', effect: 'none' } },
        b: { id: 'b', label: 'B', kind: 'input', goals: ['g2'], selector: '#b', interaction: { pattern: 'type', effect: 'none' } },
      },
    };
    const roles = selectionToTrialRoles({ shape: 'act', target: 'foo bar', subGoals: [] }, { matches: {} }, locale);
    assert.deepEqual(roles.map((r) => r.featureId), [], 'ambiguous top goal → abstain → unrunnable, not wrong');
  });

  it('binds ONE input per role: duplicate same-label search boxes are deduped (thepetal regression, SG-RES-7c)', () => {
    // A header search AND a hidden modal search, both labelled "Search", both in the goal. Binding both made
    // the trial type into the hidden modal box → landmark "Search" matched 2 candidates → unresolvable.
    const locale = {
      goals: { g: { id: 'g', label: 'search', achievableVia: ['s1', 's2'] } },
      features: {
        s1: { id: 's1', label: 'Search', kind: 'input', goals: ['g'], selector: '#Search-In-Modal-1', interaction: { pattern: 'type', effect: 'none' } },
        s2: { id: 's2', label: 'Search', kind: 'input', goals: ['g'], hidden: true, selector: '#Search-In-Modal', interaction: { pattern: 'type', effect: 'none' } },
      },
    };
    const roles = selectionToTrialRoles({ shape: 'read' }, { matches: { 'enter-query': ['s1'] } }, locale);
    assert.deepEqual(roles.map((r) => r.featureId), ['s1'], 'anchored search input bound; the duplicate "Search" skipped');
  });

  it('keeps DISTINCT-role inputs while deduping same-role ones (q + location survive, 2nd Search dropped)', () => {
    const locale = {
      goals: { g: { id: 'g', label: 'search for jobs', achievableVia: ['q', 'l', 'q2', 'go'] } },
      features: {
        q:  { id: 'q', label: 'Job title', kind: 'input', goals: ['g'], selector: '#q', interaction: { pattern: 'type', effect: 'none' } },
        l:  { id: 'l', label: 'Location', kind: 'input', goals: ['g'], selector: '#l', interaction: { pattern: 'type', effect: 'none' } },
        q2: { id: 'q2', label: 'Job title', kind: 'input', goals: ['g'], selector: '#q-dupe', interaction: { pattern: 'type', effect: 'none' } },
        go: { id: 'go', label: 'Search', kind: 'action', goals: ['g'], selector: '#go', interaction: { pattern: 'click', effect: 'submit' } },
      },
    };
    const roles = selectionToTrialRoles({ shape: 'act' }, { matches: { 'enter-query': ['q'] } }, locale);
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['go', 'l', 'q'], 'q + location kept; the duplicate "Job title" (q2) deduped');
  });

  it('OPTION GROUP (SG-RES-7d): a no-submit filter goal binds the disclosure + ONE option, not all', () => {
    // Indeed's pay filter: a disclosure + many mutually-exclusive brackets, NO submit. Goal expansion used
    // to bind all 8 brackets (the live "Apply pay filter — 8 role(s)" node); now it binds open + one option.
    const locale = {
      // Real filter brackets are HIDDEN behind their dropdown (revealedBy open); roleFor injects the dropdown
      // when a hidden option is bound, and 7f admits the sibling brackets because their revealedBy IS the
      // anchored dropdown (so the 7d cap, not 7f, is what drops o15/o25).
      goals: { g_pay: { id: 'g_pay', label: 'pay filter', achievableVia: ['open', 'o15', 'o20', 'o25'] } },
      features: {
        open: { id: 'open', label: 'Pay', kind: 'disclosure', goals: ['g_pay'], selector: '#open', interaction: { pattern: 'click', effect: 'reveal' } },
        o15:  { id: 'o15', label: '$15+', kind: 'input', goals: ['g_pay'], hidden: true, revealedBy: 'open', selector: '#o15', interaction: { pattern: 'type', effect: 'none' } },
        o20:  { id: 'o20', label: '$20+', kind: 'input', goals: ['g_pay'], hidden: true, revealedBy: 'open', selector: '#o20', interaction: { pattern: 'type', effect: 'none' } },
        o25:  { id: 'o25', label: '$25+', kind: 'input', goals: ['g_pay'], hidden: true, revealedBy: 'open', selector: '#o25', interaction: { pattern: 'type', effect: 'none' } },
      },
    };
    const roles = selectionToTrialRoles({ shape: 'act' }, { matches: { 'apply-pay': ['o20'] } }, locale);
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['o20', 'open'], 'anchored option + its dropdown only — the other brackets dropped');
  });

  it('ENSURE A VALUE (SG-RES-7h): disclosure+commit only → bind one concrete non-default option', () => {
    // The live "filter by pay" case: the matcher returned only the Pay dropdown + Update (no bracket), and
    // the brackets are action:none so form-expansion skips them — so the phase opened the dropdown and
    // committed the DEFAULT (a no-op). 7h pulls in one concrete option (revealed by the same disclosure) so
    // the filter selects a real value, inserted open → option → commit.
    const locale = {
      goals: { g_pay: { id: 'g_pay', label: 'pay', achievableVia: ['disc', 'optAll', 'opt20', 'update'] } },
      features: {
        disc:   { id: 'disc', label: 'Pay filter', kind: 'disclosure', reveals: 'layer_disc', goals: ['g_pay'], selector: '#pay', interaction: { pattern: 'click', effect: 'reveal' } },
        optAll: { id: 'optAll', label: 'All salaries', a11yRole: 'option', kind: 'action', goals: ['g_pay'], hidden: true, revealedBy: 'disc', selector: '#pay+ul>li:nth-of-type(1)', interaction: { pattern: 'click', effect: 'none' } },
        opt20:  { id: 'opt20', label: '$20.00+/hour', a11yRole: 'option', kind: 'action', goals: ['g_pay'], hidden: true, revealedBy: 'disc', selector: '#pay+ul>li:nth-of-type(2)', interaction: { pattern: 'click', effect: 'none' } },
        update: { id: 'update', label: 'Update', kind: 'action', goals: ['g_pay'], hidden: true, revealedBy: 'disc', selector: '#pay-update', interaction: { pattern: 'click', effect: 'submit' } },
      },
    };
    const ids = selectionToTrialRoles({ shape: 'act' }, { matches: { 'apply-pay': ['disc', 'update'] } }, locale).map((r) => r.featureId);
    assert.ok(ids.includes('opt20') && !ids.includes('optAll'), 'a non-default option ($20+, not "All salaries") is ensured');
    const iD = ids.indexOf('disc'), iO = ids.indexOf('opt20'), iU = ids.indexOf('update');
    assert.ok(iD < iO && iO < iU, 'open → option → commit order');
  });

  it('ENSURE A VALUE: does not fire when a value option is already bound, nor for a disclosure with no reveals', () => {
    const locale = {
      goals: { g: { id: 'g', label: 'g', achievableVia: ['d', 'o', 'u'] } },
      features: {
        d: { id: 'd', label: 'Disc', kind: 'disclosure', goals: ['g'], selector: '#d', interaction: { pattern: 'click', effect: 'reveal' } },   // no `reveals` layer
        o: { id: 'o', label: 'Opt', a11yRole: 'option', kind: 'action', goals: ['g'], hidden: true, revealedBy: 'd', selector: '#o', interaction: { pattern: 'click', effect: 'none' } },
        u: { id: 'u', label: 'Update', kind: 'action', goals: ['g'], hidden: true, revealedBy: 'd', selector: '#u', interaction: { pattern: 'click', effect: 'submit' } },
      },
    };
    const ids = selectionToTrialRoles({ shape: 'act' }, { matches: { 'x': ['d', 'u'] } }, locale).map((r) => r.featureId).sort();
    assert.deepEqual(ids, ['d', 'u'], 'no reveals layer → nothing to ensure (stays disclosure + commit)');
  });

  it('OPTION GROUP: anchoring only the disclosure still binds the disclosure + one option', () => {
    const locale = {
      goals: { g_pay: { id: 'g_pay', label: 'pay filter', achievableVia: ['open', 'o15', 'o20'] } },
      features: {
        open: { id: 'open', label: 'Pay', kind: 'disclosure', goals: ['g_pay'], selector: '#open', interaction: { pattern: 'click', effect: 'reveal' } },
        o15:  { id: 'o15', label: '$15+', kind: 'input', goals: ['g_pay'], selector: '#o15', interaction: { pattern: 'type', effect: 'none' } },
        o20:  { id: 'o20', label: '$20+', kind: 'input', goals: ['g_pay'], selector: '#o20', interaction: { pattern: 'type', effect: 'none' } },
      },
    };
    const roles = selectionToTrialRoles({ shape: 'act' }, { matches: { 'open-pay': ['open'] } }, locale);
    assert.equal(roles.length, 2, 'disclosure + exactly one option');
    assert.ok(roles.some((r) => r.featureId === 'open'), 'the disclosure is bound');
    assert.equal(roles.filter((r) => r.featureId !== 'open').length, 1, 'exactly one bracket bound');
  });

  it('a FORM goal (has submit) still binds ALL its inputs (the option cap only applies to no-submit goals)', () => {
    const locale = {
      goals: { g_search: { id: 'g_search', label: 'search', achievableVia: ['q', 'l', 'go'] } },
      features: {
        q:  { id: 'q', label: 'Job title', kind: 'input', goals: ['g_search'], selector: '#q', interaction: { pattern: 'type', effect: 'none' } },
        l:  { id: 'l', label: 'Location', kind: 'input', goals: ['g_search'], selector: '#l', interaction: { pattern: 'type', effect: 'none' } },
        go: { id: 'go', label: 'Search', kind: 'action', goals: ['g_search'], selector: '#go', interaction: { pattern: 'click', effect: 'submit' } },
      },
    };
    const roles = selectionToTrialRoles({ shape: 'act' }, { matches: { 'go': ['go'] } }, locale);
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['go', 'l', 'q'], 'form binds every field + submit');
  });

  it('does NOT expand shared filter-panel disclosures via goal membership (SG-RES-7e)', () => {
    // Indeed tags every filter dropdown disclosure onto every filter goal; goal expansion used to open all
    // of them (the live 8-role pay node = 1 option + 7 dropdowns). Now disclosures aren't expanded in bulk.
    const locale = {
      goals: { g_filter: { id: 'g_filter', label: 'filters', achievableVia: ['opt', 'd1', 'd2', 'd3'] } },
      features: {
        opt: { id: 'opt', label: '$20+', kind: 'action', goals: ['g_filter'], selector: '#opt', interaction: { pattern: 'click', effect: 'none' } },
        d1: { id: 'd1', label: 'Pay', kind: 'disclosure', goals: ['g_filter'], selector: '#d1', interaction: { pattern: 'click', effect: 'reveal' } },
        d2: { id: 'd2', label: 'Date', kind: 'disclosure', goals: ['g_filter'], selector: '#d2', interaction: { pattern: 'click', effect: 'reveal' } },
        d3: { id: 'd3', label: 'Type', kind: 'disclosure', goals: ['g_filter'], selector: '#d3', interaction: { pattern: 'click', effect: 'reveal' } },
      },
    };
    const roles = selectionToTrialRoles({ shape: 'act' }, { matches: { 'apply': ['opt'] } }, locale);
    assert.deepEqual(roles.map((r) => r.featureId), ['opt'], 'no filter dropdowns dragged in — just the anchored option');
  });

  it('still binds the SPECIFIC disclosure that reveals a bound hidden feature (via revealedBy, not bulk)', () => {
    const locale = {
      goals: { g_filter: { id: 'g_filter', label: 'filters', achievableVia: ['opt', 'd1', 'd2'] } },
      features: {
        opt: { id: 'opt', label: '$20+', kind: 'action', goals: ['g_filter'], hidden: true, revealedBy: 'd1', selector: '#opt', interaction: { pattern: 'click', effect: 'none' } },
        d1: { id: 'd1', label: 'Pay', kind: 'disclosure', goals: ['g_filter'], selector: '#d1', interaction: { pattern: 'click', effect: 'reveal' } },
        d2: { id: 'd2', label: 'Date', kind: 'disclosure', goals: ['g_filter'], selector: '#d2', interaction: { pattern: 'click', effect: 'reveal' } },
      },
    };
    const roles = selectionToTrialRoles({ shape: 'act' }, { matches: { 'apply': ['opt'] } }, locale);
    assert.deepEqual(roles.map((r) => r.featureId).sort(), ['d1', 'opt'], 'the pay dropdown (d1) revealed the option; the date dropdown (d2) untouched');
  });

  it('REVEAL BOUNDARY (SG-RES-7f): does NOT bind a member hidden behind a DIFFERENT dropdown', () => {
    // The live pay-filter failure: Indeed's LLM "filter by pay" goal lumped the real Pay-filter dropdown
    // (payDisc → its Update) with a job-card "missing preference" INPUT (stray) revealed by a DIFFERENT
    // disclosure (otherDisc). Goal expansion pulled `stray` in, dragging otherDisc into the pay phase, and
    // the run clicked the wrong widget then failed. 7f: a hidden member is bound only if its revealedBy is
    // among the anchored disclosures, so the operation stays inside the one dropdown we matched.
    const locale = {
      goals: { g_pay: { id: 'g_pay', label: 'pay', achievableVia: ['payDisc', 'update', 'stray'] } },
      features: {
        payDisc:   { id: 'payDisc', label: 'Pay filter', kind: 'disclosure', goals: ['g_pay'], selector: '#payDisc', interaction: { pattern: 'click', effect: 'reveal' } },
        update:    { id: 'update', label: 'Update', kind: 'action', goals: ['g_pay'], hidden: true, revealedBy: 'payDisc', selector: '#update', interaction: { pattern: 'click', effect: 'submit' } },
        stray:     { id: 'stray', label: 'Minimum base pay', kind: 'input', goals: ['g_pay'], hidden: true, revealedBy: 'otherDisc', selector: '#stray', interaction: { pattern: 'type', effect: 'none' } },
        otherDisc: { id: 'otherDisc', label: 'missing preference', kind: 'disclosure', goals: ['g_other'], selector: '#otherDisc', interaction: { pattern: 'click', effect: 'reveal' } },
      },
    };
    const roles = selectionToTrialRoles({ shape: 'act' }, { matches: { 'apply-pay': ['payDisc', 'update'] } }, locale);
    const ids = roles.map((r) => r.featureId).sort();
    assert.deepEqual(ids, ['payDisc', 'update'], 'real pay dropdown + its Update only');
    assert.ok(!ids.includes('stray'), 'the input behind a DIFFERENT dropdown is not bound');
    assert.ok(!ids.includes('otherDisc'), 'the foreign dropdown is not dragged in');
  });

  it('CONTAINER→OPTION (SG-RES-7g): swaps a matched listbox container for one concrete option child', () => {
    // Indeed's "Date posted" filter: the filter button reveals a <ul role=listbox> ("All Dates Last 24
    // hours…") + <li role=option> children + an Update. The matcher anchored the LISTBOX CONTAINER, so the
    // trial clicked the whole <ul> (applying the default). 7g swaps the container for a concrete option
    // child of the same dropdown, IN PLACE, so the order is button → option → Update, selecting a real value.
    const locale = {
      goals: { g_date: { id: 'g_date', label: 'date posted', achievableVia: ['btn', 'list', 'optAll', 'opt7', 'update'] } },
      features: {
        btn:    { id: 'btn', label: 'Date posted', kind: 'disclosure', goals: ['g_date'], selector: '#fromAge_filter_button', interaction: { pattern: 'click', effect: 'reveal' } },
        list:   { id: 'list', label: 'All Dates Last 24 hours Last 7 days', a11yRole: 'listbox', kind: 'action', goals: ['g_date'], hidden: true, revealedBy: 'btn', selector: 'div:nth-of-type(5) > ul', interaction: { pattern: 'click', effect: 'none' } },
        optAll: { id: 'optAll', label: 'All Dates', a11yRole: 'option', kind: 'action', goals: ['g_date'], hidden: true, revealedBy: 'btn', selector: 'div:nth-of-type(5) > ul > li:nth-of-type(1)', interaction: { pattern: 'click', effect: 'none' } },
        opt7:   { id: 'opt7', label: 'Last 7 days', a11yRole: 'option', kind: 'action', goals: ['g_date'], hidden: true, revealedBy: 'btn', selector: 'div:nth-of-type(5) > ul > li:nth-of-type(4)', interaction: { pattern: 'click', effect: 'none' } },
        update: { id: 'update', label: 'Update', kind: 'action', goals: ['g_date'], hidden: true, revealedBy: 'btn', selector: 'div:nth-of-type(5) > button.update', interaction: { pattern: 'click', effect: 'submit' } },
      },
    };
    // matcher anchored: filter button + the LISTBOX CONTAINER + Update (exactly the live shape)
    const roles = selectionToTrialRoles({ shape: 'act' }, { matches: { 'apply-date': ['btn', 'list', 'update'] } }, locale);
    const ids = roles.map((r) => r.featureId);
    assert.ok(!ids.includes('list'), 'the listbox container is swapped out');
    assert.ok(ids.includes('opt7'), 'a concrete NON-default option (Last 7 days) is bound instead');
    assert.ok(!ids.includes('optAll'), 'the default "All Dates" option is not chosen');
    // order preserved: button (reveal) → option → Update (submit)
    assert.deepEqual(ids, ['btn', 'opt7', 'update'], 'open → choose → commit order kept');
  });

  it('CONTAINER→OPTION: does NOT swap for a READ intent (a read of the listbox wants the whole container)', () => {
    // A read intent that matched the listbox wants to READ every option, not pick one. The swap is gated to
    // shape:'act' (tier2 binds fragments as act; propose passes the real shape).
    const locale = {
      goals: { g_date: { id: 'g_date', label: 'date posted', achievableVia: ['btn', 'list', 'opt7'] } },
      features: {
        btn:  { id: 'btn', label: 'Date posted', kind: 'disclosure', goals: ['g_date'], selector: '#btn', interaction: { pattern: 'click', effect: 'reveal' } },
        list: { id: 'list', label: 'All Dates Last 7 days', a11yRole: 'listbox', kind: 'action', goals: ['g_date'], hidden: true, revealedBy: 'btn', selector: '#btn + ul', interaction: { pattern: 'click', effect: 'none' } },
        opt7: { id: 'opt7', label: 'Last 7 days', a11yRole: 'option', kind: 'action', goals: ['g_date'], hidden: true, revealedBy: 'btn', selector: '#btn + ul > li:nth-of-type(2)', interaction: { pattern: 'click', effect: 'none' } },
      },
    };
    const ids = selectionToTrialRoles({ shape: 'read' }, { matches: { 'read-dates': ['list'] } }, locale).map((r) => r.featureId);
    assert.ok(ids.includes('list'), 'read keeps the listbox container (no option swap)');
    assert.ok(!ids.includes('opt7'), 'read did not collapse to a single option');
  });

  it('CONTAINER→OPTION: keeps the container when the catalog has NO option child (no regression)', () => {
    const locale = {
      goals: { g_f: { id: 'g_f', label: 'filter', achievableVia: ['btn', 'list', 'update'] } },
      features: {
        btn:    { id: 'btn', label: 'Filter', kind: 'disclosure', goals: ['g_f'], selector: '#btn', interaction: { pattern: 'click', effect: 'reveal' } },
        list:   { id: 'list', label: 'options', a11yRole: 'listbox', kind: 'action', goals: ['g_f'], hidden: true, revealedBy: 'btn', selector: '#btn + ul', interaction: { pattern: 'click', effect: 'none' } },
        update: { id: 'update', label: 'Update', kind: 'action', goals: ['g_f'], hidden: true, revealedBy: 'btn', selector: '#upd', interaction: { pattern: 'click', effect: 'submit' } },
      },
    };
    const ids = selectionToTrialRoles({ shape: 'act' }, { matches: { 'apply': ['btn', 'list', 'update'] } }, locale).map((r) => r.featureId).sort();
    assert.deepEqual(ids, ['btn', 'list', 'update'], 'no option child → container kept (open + default still works)');
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

describe('selectionToTrialRoles — dedup duplicate ANCHORED inputs (SG-RES-7c+, v2.74.880)', () => {
  it('collapses two same-role inputs BOTH anchored to one, keeping the visible field', () => {
    // Pixabay-style: a header search AND an in-page search, both role "Search videos", BOTH anchored by the
    // matcher → without this the op TYPEs the keyword twice (the SEARCH_FOR_VIDEOS + _2 duplicate). Keep one.
    const locale = { goals: { g: { id: 'g', label: 'search videos', achievableVia: ['s1', 's2'] } }, features: {
      s1: { id: 's1', label: 'Search videos', kind: 'input', goals: ['g'], selector: '#hdr-search', selectorVerified: true, interaction: { pattern: 'type', effect: 'none' } },
      s2: { id: 's2', label: 'Search videos', kind: 'input', goals: ['g'], selector: '#modal-search', hidden: true, interaction: { pattern: 'type', effect: 'none' } },
    } };
    const roles = selectionToTrialRoles({ shape: 'act' }, { matches: { q: ['s1', 's2'] } }, locale);
    const inputs = roles.filter((r) => r.kind === 'input');
    assert.equal(inputs.length, 1, `expected one input, got ${roles.map((r) => r.featureId).join(',')}`);
    assert.equal(inputs[0].featureId, 's1', 'kept the visible header search, dropped the hidden twin');
  });

  it('keeps DISTINCT roles (keyword + location) — only same-role dups collapse', () => {
    const locale = { goals: { g: { id: 'g', label: 'search jobs', achievableVia: ['q', 'loc'] } }, features: {
      q:   { id: 'q', label: 'Keyword', kind: 'input', goals: ['g'], selector: '#q', interaction: { pattern: 'type', effect: 'none' } },
      loc: { id: 'loc', label: 'Location', kind: 'input', goals: ['g'], selector: '#loc', interaction: { pattern: 'type', effect: 'none' } },
    } };
    const ids = selectionToTrialRoles({ shape: 'act' }, { matches: { f: ['q', 'loc'] } }, locale).map((r) => r.featureId).sort();
    assert.deepEqual(ids, ['loc', 'q'], 'distinct-role inputs are both kept');
  });

  it('prefers a selector-verified field over an unverified same-role twin', () => {
    const locale = { goals: { g: { id: 'g', label: 'search', achievableVia: ['a', 'b'] } }, features: {
      a: { id: 'a', label: 'Search', kind: 'input', goals: ['g'], selector: '#a', interaction: { pattern: 'type', effect: 'none' } },
      b: { id: 'b', label: 'Search', kind: 'input', goals: ['g'], selector: '#b', selectorVerified: true, interaction: { pattern: 'type', effect: 'none' } },
    } };
    const ids = selectionToTrialRoles({ shape: 'act' }, { matches: { q: ['a', 'b'] } }, locale).map((r) => r.featureId);
    assert.deepEqual(ids, ['b'], 'kept the selector-verified field');
  });
});

describe('selectionToTrialRoles — destructive-label veto on goal expansion (EX-1 at bind, v2.74.912)', () => {
  it('goal expansion never admits a destructive-labeled member (the live "delete recent search" click)', () => {
    // Live repro (Indeed, 23:32): "Enter job keyword" anchored the keyword field; the goal's membership
    // also carried the recent-search list's "delete recent search …" buttons (classed action effect:submit)
    // — and the trial CLICKED one, destroying a saved search. Expansion is the system GUESSING; it must
    // never admit a destroyer.
    const locale = { goals: { g: { id: 'g', label: 'search for jobs', achievableVia: ['kw', 'go', 'del1'] } }, features: {
      kw:   { id: 'kw', label: 'Job title keywords', kind: 'input', goals: ['g'], selector: '#q', interaction: { pattern: 'type', effect: 'none' } },
      go:   { id: 'go', label: 'Search', kind: 'action', goals: ['g'], selector: '#go', interaction: { pattern: 'click', effect: 'submit' } },
      del1: { id: 'del1', label: 'delete recent search open marketing roles', kind: 'action', goals: ['g'], selector: '#del1', interaction: { pattern: 'click', effect: 'submit' } },
    } };
    const ids = selectionToTrialRoles({ shape: 'act' }, { matches: { 'enter-keyword': ['kw'] } }, locale).map((r) => r.featureId).sort();
    assert.deepEqual(ids, ['go', 'kw'], 'delete button vetoed; input + real submit kept');
  });

  it('an explicitly ANCHORED destructive control still binds (veto is expansion-only)', () => {
    // A genuine "delete my account"-style intent anchors the destructive control DIRECTLY via the matcher;
    // the veto must not strip it — only guessed membership is gated.
    const locale = { goals: {}, features: {
      del: { id: 'del', label: 'Delete account', kind: 'action', selector: '#del', interaction: { pattern: 'click', effect: 'submit' } },
    } };
    const ids = selectionToTrialRoles({ shape: 'act' }, { matches: { 'delete-account': ['del'] } }, locale).map((r) => r.featureId);
    assert.deepEqual(ids, ['del'], 'matcher-anchored destructive feature is untouched');
  });
});

describe('selectionToTrialRoles — typeable disclosures pass the fill gates (CR-B1, v2.74.924)', () => {
  // .913 made a combobox (kind=disclosure + fieldType:'text') a FILL in the synth, but bind's six
  // kind==='input' gates were not extended — re-opening the empty-q submit via the expansion path.
  const combo = (id, label, sel, extra = {}) =>
    ({ id, label, kind: 'disclosure', fieldType: 'text', selector: sel, interaction: { pattern: 'reveal', effect: 'reveal' }, ...extra });

  it('goal expansion ADMITS a combobox member when only the submit anchored', () => {
    const locale = { goals: { g: { id: 'g', label: 'search for jobs', achievableVia: ['q', 'go'] } }, features: {
      q:  combo('q', 'Job title, keywords, or company', 'input[name="q"]', { goals: ['g'] }),
      go: { id: 'go', label: 'Search', kind: 'action', goals: ['g'], selector: '#go', interaction: { pattern: 'click', effect: 'submit' } },
    } };
    const ids = selectionToTrialRoles({ shape: 'act' }, { matches: { 'submit-search': ['go'] } }, locale).map((r) => r.featureId).sort();
    assert.deepEqual(ids, ['go', 'q'], 'the combobox keyword field rode in via form atomicity');
  });

  it('two same-label comboboxes BOTH anchored collapse to one (.880 reach)', () => {
    const locale = { goals: { g: { id: 'g', label: 'search', achievableVia: ['c1', 'c2'] } }, features: {
      c1: combo('c1', 'Search', '#hdr-search', { goals: ['g'], selectorVerified: true }),
      c2: combo('c2', 'Search', '#modal-search', { goals: ['g'], hidden: true }),
    } };
    const roles = selectionToTrialRoles({ shape: 'act' }, { matches: { q: ['c1', 'c2'] } }, locale);
    const fills = roles.filter((r) => r.kind === 'disclosure');
    assert.equal(fills.length, 1, `expected one combobox, got ${roles.map((r) => r.featureId).join(',')}`);
    assert.equal(fills[0].featureId, 'c1', 'kept the visible, selector-verified twin');
  });

  it('a combobox-only selection on a submit goal still pulls the submit (FILLS-must-SUBMIT)', () => {
    const locale = { goals: { g: { id: 'g', label: 'search for jobs', achievableVia: ['q', 'go'] } }, features: {
      q:  combo('q', 'Job title keywords', 'input[name="q"]', { goals: ['g'] }),
      go: { id: 'go', label: 'Search', kind: 'action', goals: ['g'], selector: '#go', interaction: { pattern: 'click', effect: 'submit' } },
    } };
    const ids = selectionToTrialRoles({ shape: 'act' }, { matches: { 'enter-keyword': ['q'] } }, locale).map((r) => r.featureId).sort();
    assert.deepEqual(ids, ['go', 'q'], 'the submit rode in for the combobox fill');
  });
});
