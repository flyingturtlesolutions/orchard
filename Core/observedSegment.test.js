// Core/observedSegment.test.js — OBS-2 unit tests (node --test). PURE. Built against a LIVE Indeed
// demonstration (search "support" in Minneapolis, then filter by date posted = Last 3 days).
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRawAction, coalesce } from './observedTrace.js';
import { segmentTrace, opToPhases, stepToAction, deriveObservedParams, parameterizeObserved, obsParamName, optionContainerSelector } from './observedSegment.js';
import { buildTier2CapabilityRecords } from './capabilitySynth.js';

// `A` mirrors the real recorder: a click passes its accessibleName as the value (kept only when the click
// classifies as a `select` — i.e. on an option). The recorder captures a `role` for EVERY element, so the
// helper does too: option/pay-bracket labels → 'option'; typed fields → 'textbox'; everything else → 'button'.
// That role is what stepToAction needs to attach an inline landmark.
const A = (domKind, name, selector, value) => buildRawAction({
  domKind,
  value: value !== undefined ? value : (domKind === 'click' ? name : undefined),
  url: 'https://www.indeed.com',
  target: { role: /Last 3 days|\$/.test(name || '') ? 'option' : (domKind === 'input' ? 'textbox' : 'button'), accessibleName: name, selector },
});
const NAV = (to) => buildRawAction({ domKind: 'navigate', url: to, from: 'https://www.indeed.com' });

describe('observedSegment — segment a demonstration into Fragments (OBS-2)', () => {
  // Faithful reconstruction of the captured trace (focus-clicks ×2 / ×3 included, as recorded).
  const raw = [
    A('click', 'Job title, keywords, or company', '#q'),
    A('click', 'Job title, keywords, or company', '#q'),
    A('input', 'Job title, keywords, or company', '#q', 'support'),
    A('click', 'Edit location', '#l'),
    A('click', 'Edit location', '#l'),
    A('click', 'Edit location', '#l'),
    A('input', 'Edit location', '#l', 'minneapolis'),
    A('click', 'Search', '#searchbtn'),
    A('submit', null, '#jobsearch'),
    NAV('https://www.indeed.com/jobs?q=support&l=minneapolis'),
    A('click', 'Date posted filter', '#fromAge_filter_button'),
    A('click', 'Last 3 days', '#date>li:nth-of-type(3)'),
    NAV('https://www.indeed.com/jobs?q=support&l=minneapolis&fromage=3'),
  ];

  it('yields a Search fragment and a Date-filter fragment, dropping focus-click noise', () => {
    const op = segmentTrace(coalesce(raw));
    assert.equal(op.tier, 'observed');
    assert.equal(op.nodes.length, 2);
    const [f1, f2] = op.nodes;
    // Fragment 1 — search form: the 5 focus-clicks are dropped; two typed fields + the Search click remain.
    assert.equal(f1.label, 'Search');
    assert.deepEqual(f1.steps.map((s) => s.kind), ['type', 'type', 'click']);
    assert.equal(f1.steps[0].value, 'support');
    assert.equal(f1.steps[1].value, 'minneapolis');
    assert.ok(/q=support/.test(f1.to), 'transition → the results URL (the navigate, not the stale submit URL)');
    // Fragment 2 — date filter: open the disclosure + select the option (with its value).
    assert.equal(f2.label, 'Date posted filter');
    assert.deepEqual(f2.steps.map((s) => s.kind), ['click', 'select']);
    assert.equal(f2.steps[1].value, 'Last 3 days');
    assert.ok(/fromage=3/.test(f2.to));
  });

  it('an in-place filter with no navigation still becomes a fragment', () => {
    const r = [A('click', 'Pay filter', '#pay'), A('click', '$20+/hr', '#pay>li:2')];
    const op = segmentTrace(coalesce(r));
    assert.equal(op.nodes.length, 1);
    assert.equal(op.nodes[0].label, 'Pay filter');
    assert.deepEqual(op.nodes[0].steps.map((s) => s.kind), ['click', 'select']);
  });

  it('a click-then-submit pair before a navigation does not create an empty fragment', () => {
    const r = [A('click', 'Go', '#go'), A('submit', null, '#form'), NAV('https://x/done')];
    const op = segmentTrace(coalesce(r));
    assert.equal(op.nodes.length, 1);
    assert.equal(op.nodes[0].steps.length, 1);
    assert.ok(/done/.test(op.nodes[0].to));
  });

  it('opToPhases maps steps → executable actions (SCROLL_TO before each) carrying inline landmarks + url (OBS-3/4)', () => {
    const phases = opToPhases(segmentTrace(coalesce(raw)));
    assert.equal(phases.length, 2);
    assert.ok(typeof phases[0].url === 'string', 'phase carries its page url (for per-page landmark UIDs)');
    assert.ok(/q=support/.test(phases[1].url), 'date phase url is the post-search page');
    // each real action is preceded by an optional SCROLL_TO (OBS-4)
    assert.ok(phases[0].actions.every((a, i, arr) => a.action !== 'SCROLL_TO' || (arr[i + 1] && arr[i + 1].selector === a.selector)), 'each SCROLL_TO targets the following action');
    const real0 = phases[0].actions.filter((a) => a.action !== 'SCROLL_TO');
    assert.deepEqual(real0.map((a) => a.action), ['TYPE', 'TYPE', 'CLICK']);
    assert.equal(real0[0].value, 'support');
    assert.equal(real0[2].landmark.accessibleName, 'Search');
    const real1 = phases[1].actions.filter((a) => a.action !== 'SCROLL_TO');
    assert.deepEqual(real1.map((a) => a.action), ['CLICK', 'CLICK']);   // a clicked <li role=option> replays as CLICK
    assert.equal(real1[1].landmark.accessibleName, 'Last 3 days');
  });

  it('Enter-to-submit is recorded as a KEY step; navigate (or native submit) is the boundary (OBS)', () => {
    const T = (name, sel, v) => buildRawAction({ domKind: 'input', value: v, url: 'u', target: { tagName: 'INPUT', role: 'textbox', accessibleName: name, selector: sel } });
    const K = (name, sel) => buildRawAction({ domKind: 'keypress', value: 'Enter', url: 'u', target: { tagName: 'INPUT', role: 'textbox', accessibleName: name, selector: sel } });
    const op = segmentTrace(coalesce([T('Job title', '#q', 'support'), K('Job title', '#q'), NAV('u/jobs?q=support')]));
    assert.equal(op.nodes.length, 1);
    assert.deepEqual(op.nodes[0].steps.map((s) => s.kind), ['type', 'key'], 'Enter is a step, not dropped');
    const real = opToPhases(op)[0].actions.filter((a) => a.action !== 'SCROLL_TO');
    assert.deepEqual(real.map((a) => a.action), ['TYPE', 'KEY']);
    assert.equal(real[1].value, 'Enter');
  });

  it('stepToAction: a native <select> change → SELECT op with value', () => {
    const a = stepToAction(buildRawAction({ domKind: 'change', value: 'CA', target: { tagName: 'SELECT', selector: '#state' } }));
    assert.equal(a.action, 'SELECT');
    assert.equal(a.value, 'CA');
  });

  it('deriveObservedParams: typed fields + option choices → params (option keyed by its disclosure) (OBS-4)', () => {
    const ps = deriveObservedParams(segmentTrace(coalesce(raw)));
    const byKey = Object.fromEntries(ps.map((p) => [p.key, p]));
    // key = slug of the field's full accessibleName (the real #q label), bounded at 40 chars
    assert.equal(byKey['job-title-keywords-or-company'].value, 'support');
    assert.equal(byKey['job-title-keywords-or-company'].kind, 'text');
    assert.equal(byKey['edit-location'].value, 'minneapolis');
    assert.ok(byKey['date-posted-filter'], 'date selection keyed by its disclosure, not "last-3-days"');
    assert.equal(byKey['date-posted-filter'].value, 'Last 3 days');
    assert.equal(byKey['date-posted-filter'].kind, 'option');
    assert.ok(!ps.some((p) => p.value === 'Search'), 'the Search commit is not a param');
  });

  it('obsParamName: key → UPPER_SNAKE placeholder name (matches the {{NAME}} regex) (OBS-4b)', () => {
    assert.equal(obsParamName('date-posted-filter'), 'DATE_POSTED_FILTER');
    assert.equal(obsParamName('a--b__c'), 'A_B_C');
    assert.equal(obsParamName(''), 'PARAM');
  });

  it('parameterizeObserved: text inputs → {{NAME}} placeholders, input phases untouched (OBS-4b)', () => {
    const op = segmentTrace(coalesce(raw));
    const phasesRaw = opToPhases(op);
    const { phases, params } = parameterizeObserved(phasesRaw, deriveObservedParams(op));
    const qP = params.find((p) => p.selector === '#q');
    assert.ok(qP && qP.kind === 'text' && qP.used === true, '#q is a templated text param');
    assert.equal(qP.value, 'support', 'demonstrated value preserved as the default');
    // the TYPE action now carries the placeholder, not the literal value
    const qType = phases[0].actions.filter((a) => a.action !== 'SCROLL_TO').find((a) => a.action === 'TYPE' && a.selector === '#q');
    assert.equal(qType.value, `{{${qP.name}}}`, 'TYPE value rewritten to the placeholder');
    // purity — the input phases are untouched (no in-place mutation of TYPE value or option CLICK)
    const origQ = phasesRaw[0].actions.filter((a) => a.action !== 'SCROLL_TO').find((a) => a.action === 'TYPE' && a.selector === '#q');
    assert.equal(origQ.value, 'support', 'parameterizeObserved does not mutate its input');
    assert.ok(phasesRaw[1].actions.some((a) => a.action === 'CLICK' && a.selector === '#date>li:nth-of-type(3)'), 'original option CLICK preserved on the input');
  });

  it('optionContainerSelector: strips the last top-level combinator to the dropdown container (OBS-4c)', () => {
    assert.equal(optionContainerSelector('#date>li:nth-of-type(3)'), '#date');
    assert.equal(optionContainerSelector('#date > li:nth-of-type(3)'), '#date');
    assert.equal(optionContainerSelector('.menu .item'), '.menu');
    assert.equal(optionContainerSelector("div[data-id='a>b'] > li"), "div[data-id='a>b']");
    assert.equal(optionContainerSelector('#solo'), null, 'a single simple selector has no derivable container');
    assert.equal(optionContainerSelector(''), null);
  });

  it('parameterizeObserved: an option choice → CLICK_BY_LABEL scoped to its container, label = {{NAME}} (OBS-4c)', () => {
    const op = segmentTrace(coalesce(raw));
    const { phases, params } = parameterizeObserved(opToPhases(op), deriveObservedParams(op));
    const optP = params.find((p) => p.kind === 'option');
    assert.ok(optP && optP.used === true, 'the date option is now templated (re-choosable)');
    assert.equal(optP.value, 'Last 3 days', 'demonstrated label preserved as default');
    assert.equal(optP.container, '#date', 'container derived from the option selector');
    // the date-filter phase's option CLICK became a CLICK_BY_LABEL within #date with the placeholder
    const dateReal = phases[1].actions.filter((a) => a.action !== 'SCROLL_TO');
    const byLabel = dateReal.find((a) => a.action === 'CLICK_BY_LABEL');
    assert.ok(byLabel, 'option click lowered to CLICK_BY_LABEL');
    assert.equal(byLabel.selector, '#date', 'CLICK_BY_LABEL targets the container');
    assert.equal(byLabel.value, `{{${optP.name}}}`, 'label is the placeholder');
    assert.ok(!byLabel.landmarkRef && !byLabel.landmark, 'no per-option landmark on a by-label click');
    // the disclosure-open CLICK ("Date posted filter") is untouched (not a param)
    assert.ok(dateReal.some((a) => a.action === 'CLICK'), 'the disclosure-open click stays a literal CLICK');
  });

  it('parameterizeObserved: a native <select> option → SELECT value templated to {{NAME}} (OBS-4c)', () => {
    const sel = [
      buildRawAction({ domKind: 'change', value: 'CA', url: 'u', target: { tagName: 'SELECT', role: 'combobox', accessibleName: 'State', selector: '#state' } }),
      buildRawAction({ domKind: 'click', value: 'Go', url: 'u', target: { role: 'button', accessibleName: 'Go', selector: '#go' } }),
      buildRawAction({ domKind: 'submit', url: 'u', target: { selector: '#f' } }),
      buildRawAction({ domKind: 'navigate', url: 'u/done', from: 'u' }),
    ];
    const op = segmentTrace(coalesce(sel));
    const { phases, params } = parameterizeObserved(opToPhases(op), deriveObservedParams(op));
    const stateP = params.find((p) => p.selector === '#state');
    assert.ok(stateP && stateP.kind === 'option' && stateP.used === true, 'native select option is templated');
    assert.equal(stateP.value, 'CA', 'demonstrated value preserved as default');
    assert.ok(!stateP.container, 'a native select has no container (value substitution, not find-by-label)');
    const selAct = phases[0].actions.filter((a) => a.action !== 'SCROLL_TO').find((a) => a.action === 'SELECT');
    assert.equal(selAct.value, `{{${stateP.name}}}`, 'SELECT value rewritten to the placeholder');
  });

  it('buildTier2CapabilityRecords wires params: per-fragment bindings from real placeholders + strategy.params union (OBS-4b)', () => {
    const op = segmentTrace(coalesce(raw));
    const { phases, params } = parameterizeObserved(opToPhases(op), deriveObservedParams(op));
    const recs = buildTier2CapabilityRecords(phases, { groundId: 'g1', strategyId: 's1', fragmentIds: ['f1', 'f2'], name: 'cap', goal: 'cap', params });
    const qName = params.find((p) => p.selector === '#q').name;
    const optName = params.find((p) => p.kind === 'option').name;
    // fragment 0 (search) declares its text params; fragment 1 (date filter) declares the OBS-4c option param
    assert.ok(recs.fragments[0].params.includes(qName), 'search fragment declares its templated param');
    assert.ok(recs.fragments[1].params.includes(optName), 'date-filter fragment declares its CLICK_BY_LABEL option param (OBS-4c)');
    assert.deepEqual(recs.strategy.fragmentSteps[0].paramBindings[qName], { kind: 'strategy_param', name: qName });
    assert.deepEqual(recs.strategy.fragmentSteps[1].paramBindings[optName], { kind: 'strategy_param', name: optName });
    const sp = recs.strategy.params.find((p) => p.name === qName);
    assert.ok(sp && sp.kind === 'scalar' && sp.required === false && sp.default === 'support', 'strategy param: scalar, optional, demonstrated default');
    const op2 = recs.strategy.params.find((p) => p.name === optName);
    assert.equal(op2.default, 'Last 3 days', 'option strategy param carries the demonstrated label as default');
  });
});
