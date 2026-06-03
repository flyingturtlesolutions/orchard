// Core/observedSegment.test.js — OBS-2 unit tests (node --test). PURE. Built against a LIVE Indeed
// demonstration (search "support" in Minneapolis, then filter by date posted = Last 3 days).
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRawAction, coalesce } from './observedTrace.js';
import { segmentTrace, opToPhases, stepToAction, deriveObservedParams, parameterizeObserved, obsParamName, optionContainerSelector, describeTraceInput } from './observedSegment.js';
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

  it('OBS — Enter is a boundary: an action AFTER the Enter starts a NEW fragment (post-submit page)', () => {
    const T = (sel, v, ts) => buildRawAction({ domKind: 'input', value: v, ts, url: 'u', target: { tagName: 'INPUT', role: 'textbox', accessibleName: 'Search', selector: sel } });
    const K = (sel, ts) => buildRawAction({ domKind: 'keypress', value: 'Enter', ts, url: 'u', target: { tagName: 'INPUT', role: 'textbox', accessibleName: 'Search', selector: sel } });
    // type → Enter (submits/navigates) → a stray re-type captured on the results page before the nav registered
    const op = segmentTrace(coalesce([T('#q', 'gifs', 1), K('#q', 2), T('#q', 'gifs', 3)]));
    assert.equal(op.nodes.length, 2, 'Enter splits the trace so the post-Enter action is not stranded on a dead page');
    assert.deepEqual(op.nodes[0].steps.map((s) => s.kind), ['type', 'key'], 'the search (type + Enter) is fragment 1');
    assert.deepEqual(op.nodes[1].steps.map((s) => s.kind), ['type'], 'the post-Enter re-type is its own fragment');
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

  it('ORCH-V: an option click carrying its dropdown vocabulary → param.vocabulary; parameterizeObserved preserves it', () => {
    const disc = buildRawAction({ domKind: 'click', value: 'Date posted filter', url: 'u', target: { role: 'button', accessibleName: 'Date posted filter', selector: '#fa' } });
    const opt = buildRawAction({ domKind: 'click', value: 'Last 3 days', url: 'u', target: { role: 'option', accessibleName: 'Last 3 days', selector: '#date>li:nth-of-type(3)', options: ['Today', 'Last 3 days', 'Last 7 days', 'Last 14 days'] } });
    const nav = buildRawAction({ domKind: 'navigate', url: 'u/jobs?fromage=3', from: 'u' });
    const op = segmentTrace(coalesce([disc, opt, nav]));
    const params = deriveObservedParams(op);
    const optP = params.find((p) => p.kind === 'option');
    assert.ok(optP, 'option param derived');
    assert.deepEqual(optP.vocabulary, ['Today', 'Last 3 days', 'Last 7 days', 'Last 14 days'], 'full dropdown vocabulary captured');
    // parameterizeObserved keeps the vocabulary on the templated param (for the binder + the re-run datalist)
    const { params: named } = parameterizeObserved(opToPhases(op), params);
    const np = named.find((p) => p.kind === 'option');
    assert.deepEqual(np.vocabulary, ['Today', 'Last 3 days', 'Last 7 days', 'Last 14 days']);
    assert.equal(np.used, true, 'still templated to CLICK_BY_LABEL');
    // a single-option (or no-vocab) capture is dropped (needs ≥2 to be a real choice)
    const lone = deriveObservedParams(segmentTrace(coalesce([
      buildRawAction({ domKind: 'click', value: 'X', url: 'u', target: { role: 'option', accessibleName: 'X', selector: '#o', options: ['X'] } }),
      buildRawAction({ domKind: 'navigate', url: 'u/2', from: 'u' }),
    ])));
    assert.ok(!('vocabulary' in (lone.find((p) => p.kind === 'option') || {})), 'a lone option is not a vocabulary');
  });

  it('describeTraceInput: structure-derived summary (phases as step kinds + params as example inputs) (ORCH-D)', () => {
    const op = segmentTrace(coalesce(raw));
    const { phases, params } = parameterizeObserved(opToPhases(op), deriveObservedParams(op));
    const di = describeTraceInput(phases, params);
    assert.equal(di.phases.length, 2);
    assert.equal(di.phases[0].label, 'Search');
    // steps are described by KIND (no SCROLL_TO, no literal demo values in the templated steps)
    assert.ok(di.phases[0].steps.some((s) => /^type into/.test(s)), 'a typed field reads as "type into …"');
    assert.ok(di.phases[1].steps.some((s) => /^choose an option/.test(s)), 'the option reads as "choose an option …"');
    assert.ok(!JSON.stringify(di.phases).includes('SCROLL_TO'));
    // params surface as example inputs (used only); the option carries its label + kind
    assert.ok(di.params.length >= 2);
    const optP = di.params.find((p) => p.kind === 'option');
    assert.ok(optP && optP.example === 'Last 3 days', 'demonstrated value is an EXAMPLE input');
  });

  it('OBS — a pure-scroll demo → a window SCROLL_TO; an incidental scroll in an action demo is dropped', () => {
    const scroll = (y) => buildRawAction({ domKind: 'scroll', url: 'u', ts: y, target: { scrollY: y } });
    // pure scroll (consecutive scrolls coalesce to the final position), no other action
    const pure = opToPhases(segmentTrace(coalesce([scroll(300), scroll(1500)])));
    assert.equal(pure.length, 1, 'a pure-scroll demo yields one runnable phase (no longer dropped)');
    assert.deepEqual(pure[0].actions.map((x) => x.action), ['SCROLL_TO']);
    assert.equal(pure[0].actions[0].value, '1500px', 'scrolls to where the viewport settled');
    assert.ok(!pure[0].actions[0].selector, 'a window scroll has no selector');
    // incidental scroll mixed with a real action → the scroll is dropped (replay reaches the control via SCROLL_TO)
    const mixed = opToPhases(segmentTrace(coalesce([
      scroll(200),
      buildRawAction({ domKind: 'input', value: 'hi', ts: 300, target: { tagName: 'INPUT', role: 'textbox', accessibleName: 'q', selector: '#q' } }),
    ])));
    assert.deepEqual(mixed[0].actions.filter((x) => x.action !== 'SCROLL_TO').map((x) => x.action), ['TYPE'], 'incidental scroll dropped; TYPE kept');
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
