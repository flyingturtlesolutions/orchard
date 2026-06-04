// Core/observedSegment.test.js — OBS-2 unit tests (node --test). PURE. Built against a LIVE Indeed
// demonstration (search "support" in Minneapolis, then filter by date posted = Last 3 days).
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRawAction, coalesce } from './observedTrace.js';
import { segmentTrace, opToPhases, stepToAction, deriveObservedParams, parameterizeObserved, obsParamName, optionContainerSelector, describeTraceInput, derivePhasePostcondition, reconcileObservedLandmarks } from './observedSegment.js';
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

  // LOGICAL boundary (SPA): a search + a filter that BOTH swap results via XHR — NO navigations at all. Without a
  // state_change marker these collapse into one fragment; with it they split exactly as an MPA reload would.
  const SC = (url) => buildRawAction({ domKind: 'state_change', url: url || 'https://spa.example/search' });
  it('an SPA search + filter (no navigation) splits into two fragments on state_change markers', () => {
    const trace = [
      A('input', 'Search', '#q', 'halo sound effects'),
      A('click', 'Search', '#searchbtn'),
      SC(),                                         // results swapped in place → boundary 1
      A('click', 'Recently added filter', '#sort'),
      A('click', 'Recently added', '#sort>li:1'),
      SC(),                                         // results re-swapped → boundary 2
    ];
    const op = segmentTrace(coalesce(trace));
    assert.equal(op.nodes.length, 2, 'two fragments despite zero navigations');
    assert.deepEqual(op.nodes[0].steps.map((s) => s.kind), ['type', 'click'], 'fragment 1 = the search commit');
    assert.deepEqual(op.nodes[1].steps.map((s) => s.kind), ['click', 'click'], 'fragment 2 = open + choose the filter');
  });

  // OBS (v2.74.763) — an IN-PLACE swap marker carries the swapped-in container's selector; the segmenter threads
  // it onto the node (node.settle) and opToPhases surfaces it as settleSelector → an in-place success signal.
  const SCsel = (url, selector) => buildRawAction({ domKind: 'state_change', url: url || 'https://spa.example/search', target: { selector } });
  it('an SPA swap carries its container selector onto the fragment (node.settle → settleSelector)', () => {
    // A real in-place swap fires its marker on the SAME url as the page (no navigation) — match the A() helper url.
    const trace = [A('input', 'Search', '#q', 'halo'), A('click', 'Search', '#searchbtn'), SCsel('https://www.indeed.com', '#results')];
    const op = segmentTrace(coalesce(trace));
    assert.equal(op.nodes.length, 1);
    assert.deepEqual(op.nodes[0].settle, { selector: '#results' }, 'the swapped-in container rides on the node');
    const ph = opToPhases(op)[0];
    assert.equal(ph.settleSelector, '#results', 'opToPhases surfaces it as settleSelector');
    assert.equal(ph.to, ph.url, 'in-place: no URL change (to === url)');
    assert.equal(derivePhasePostcondition(ph).source, 'spa-settle', 'so the phase yields a selector_present postcondition');
  });

  it('a state_change with no target selector → no settle (the fragment is unaffected)', () => {
    const op = segmentTrace(coalesce([A('click', 'Apply', '#apply'), SC('https://spa.example/x')]));
    assert.equal(op.nodes.length, 1);
    assert.ok(!('settle' in op.nodes[0]), 'no selector → no settle key');
    assert.equal(opToPhases(op)[0].settleSelector, '', 'settleSelector defaults to empty');
  });

  it('derivePhasePostcondition: NAVIGATION → url_matches on the destination path (source url-nav)', () => {
    const pc = derivePhasePostcondition({ url: 'https://x/search', to: 'https://x/jobs?q=a' });
    assert.equal(pc.source, 'url-nav');
    assert.equal(pc.match, 'all');
    assert.deepEqual(pc.conditions, [{ type: 'url_matches', pattern: '/jobs' }]);
  });

  it('derivePhasePostcondition: IN-PLACE swap → selector_present on the swapped-in container (source spa-settle)', () => {
    const pc = derivePhasePostcondition({ url: 'https://x/search', to: 'https://x/search', settleSelector: '#results' });
    assert.equal(pc.source, 'spa-settle');
    assert.deepEqual(pc.conditions, [{ type: 'selector_present', selector: '#results' }]);
  });

  it('derivePhasePostcondition: a NAV wins over a settle; a root / destination or no signal → null', () => {
    // a real nav with a settle selector present → still the url_matches (the page changed; the selector is post-nav noise)
    const navWins = derivePhasePostcondition({ url: 'https://x/a', to: 'https://x/b', settleSelector: '#r' });
    assert.equal(navWins.source, 'url-nav');
    assert.equal(derivePhasePostcondition({ url: 'https://x/a', to: 'https://x/' }), null, 'a root-path destination tells us nothing');
    assert.equal(derivePhasePostcondition({ url: 'https://x/a', to: 'https://x/a' }), null, 'in-place but no settle selector → null');
    assert.equal(derivePhasePostcondition({}), null, 'nothing → null');
  });

  // OBS (v2.74.764) — reconcile demonstrated landmarks to the grounded Locale so the observed path stops minting
  // duplicate landmarks for elements Explore already catalogued (the dedup the SG/NL path gets via the Locale).
  const LOC = (url, feats) => ({ url, features: feats });
  const SEARCH_FEAT = { id: 'feat_search', selector: '#searchbtn', a11yRole: 'button', label: 'Search', kind: 'action' };
  const phaseWith = (url, lm) => ({ url, actions: [{ action: 'CLICK', selector: lm.selector, landmark: { ...lm } }] });

  it('reconcileObservedLandmarks: exact-selector match adopts the feature identity + stamps featureId', () => {
    const phases = [phaseWith('https://x/jobs', { role: 'button', accessibleName: 'Search', selector: '#searchbtn' })];
    const r = reconcileObservedLandmarks(phases, [LOC('https://x/jobs', { feat_search: SEARCH_FEAT })]);
    assert.equal(r.reconciled, 1);
    assert.equal(r.phases[0].actions[0].landmark.featureId, 'feat_search');
    assert.equal(r.phases[0].actions[0].landmark.selector, '#searchbtn');
  });

  it('reconcileObservedLandmarks: role+name match across SELECTOR DRIFT upgrades to the grounded selector', () => {
    // the demo captured a different (positional) selector than Explore did — same element by role+name
    const phases = [phaseWith('https://x/jobs', { role: 'button', accessibleName: 'Search', selector: 'div > button:nth-child(3)' })];
    const r = reconcileObservedLandmarks(phases, [LOC('https://x/jobs', [SEARCH_FEAT])]);   // features as ARRAY too
    assert.equal(r.reconciled, 1);
    assert.equal(r.phases[0].actions[0].landmark.selector, '#searchbtn', 'demo selector → grounded feature selector → same uid as the catalog');
    assert.equal(r.phases[0].actions[0].landmark.featureId, 'feat_search');
  });

  it('reconcileObservedLandmarks: a same-path locale matches despite query/hash; the action selector is untouched', () => {
    const phases = [phaseWith('https://x/jobs?q=dev#top', { role: 'button', accessibleName: 'Search', selector: 'b.x' })];
    const r = reconcileObservedLandmarks(phases, [LOC('https://x/jobs', { feat_search: SEARCH_FEAT })]);
    assert.equal(r.reconciled, 1, 'query/hash ignored — same path reconciles');
    assert.equal(r.phases[0].actions[0].selector, 'b.x', 'the OPERATIONAL action selector is left alone (params match on it)');
    assert.equal(r.phases[0].localeUrl, 'https://x/jobs', 'mint url canonicalized to the grounded Locale url (no query noise → stable uid)');
    assert.equal(r.phases[0].url, 'https://x/jobs?q=dev#top', 'the phase url itself is untouched (postcondition derivation reads it)');
  });

  it('reconcileObservedLandmarks: no matching feature / different page / no locale → unchanged, no featureId', () => {
    const phases = [phaseWith('https://x/jobs', { role: 'button', accessibleName: 'Cancel', selector: '#cancel' })];
    const noMatch = reconcileObservedLandmarks(phases, [LOC('https://x/jobs', { feat_search: SEARCH_FEAT })]);
    assert.equal(noMatch.reconciled, 0);
    assert.ok(!('featureId' in noMatch.phases[0].actions[0].landmark), 'unmatched element keeps the demo identity, no featureId');
    const wrongPage = reconcileObservedLandmarks([phaseWith('https://x/other', { role: 'button', accessibleName: 'Search', selector: '#searchbtn' })], [LOC('https://x/jobs', { feat_search: SEARCH_FEAT })]);
    assert.equal(wrongPage.total, 0, 'no same-path locale → that phase is skipped entirely (no cross-page mis-bind)');
    assert.equal(reconcileObservedLandmarks(phases, []).reconciled, 0, 'no locales → unchanged');
  });

  it('a state_change marker right after an Enter/nav boundary mints NO empty fragment', () => {
    const K = (sel) => buildRawAction({ domKind: 'keypress', value: 'Enter', url: 'u', target: { tagName: 'INPUT', role: 'textbox', accessibleName: 'q', selector: sel } });
    const op = segmentTrace(coalesce([A('input', 'q', '#q', 'jobs'), K('#q'), SC('u/jobs'), A('click', 'Filter', '#f'), A('click', 'Opt', '#f>li:1'), SC('u/jobs')]));
    assert.equal(op.nodes.length, 2, 'the post-Enter marker is a no-op; the filter is its own fragment');
    assert.deepEqual(op.nodes[0].steps.map((s) => s.kind), ['type', 'key']);
  });

  it('a trace with NO state_change markers segments exactly as before (backward compatible)', () => {
    const op = segmentTrace(coalesce(raw));   // the navigation-based Indeed trace
    assert.equal(op.nodes.length, 2);
    assert.equal(op.nodes[0].label, 'Search');
    assert.equal(op.nodes[1].label, 'Date posted filter');
  });

  it('opToPhases maps steps → executable actions (SCROLL_TO before each) carrying inline landmarks + url (OBS-3/4)', () => {
    const phases = opToPhases(segmentTrace(coalesce(raw)));
    assert.equal(phases.length, 2);
    assert.ok(typeof phases[0].url === 'string', 'phase carries its page url (for per-page landmark UIDs)');
    assert.ok(/q=support/.test(phases[1].url), 'date phase url is the post-search page');
    assert.ok(/q=support/.test(phases[0].to), 'phase carries its destination url (to) — the navigating search → results, for a url postcondition');
    assert.ok(/fromage=3/.test(phases[1].to), 'the date filter phase reached the filtered URL');
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

  const _T = (sel, v, ts) => buildRawAction({ domKind: 'input', value: v, ts, url: 'u', target: { tagName: 'INPUT', role: 'textbox', accessibleName: 'Search', selector: sel } });
  const _K = (sel, ts) => buildRawAction({ domKind: 'keypress', value: 'Enter', ts, url: 'u', target: { tagName: 'INPUT', role: 'textbox', accessibleName: 'Search', selector: sel } });

  it('OBS — Enter is a boundary: a NEW-value action AFTER the Enter starts a NEW fragment (post-submit page)', () => {
    // type → Enter (submits/navigates) → a genuine NEW typed value on the results page (a refinement, not a dup)
    const op = segmentTrace(coalesce([_T('#q', 'gifs', 1), _K('#q', 2), _T('#q2', 'cats', 3)]));
    assert.equal(op.nodes.length, 2, 'Enter splits the trace so the post-Enter action is not stranded on a dead page');
    assert.deepEqual(op.nodes[0].steps.map((s) => s.kind), ['type', 'key'], 'the search (type + Enter) is fragment 1');
    assert.deepEqual(op.nodes[1].steps.map((s) => s.kind), ['type'], 'the new-value post-Enter type is its own fragment');
  });

  it('OBS — a redundant re-type after Enter is DROPPED (the results page re-shows the query; do not type twice)', () => {
    // type "gifs" → Enter → results page re-shows "gifs" in its search box → recorder captures a 2nd identical type
    const op = segmentTrace(coalesce([_T('#q', 'gifs', 1), _K('#q', 2), _T('#q', 'gifs', 3)]));
    assert.equal(op.nodes.length, 1, 'the redundant re-type fragment is dropped — only the real search remains');
    assert.deepEqual(op.nodes[0].steps.map((s) => s.kind), ['type', 'key'], 'one type + Enter, no second type');
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

  it('B — a category-nav CLICK carrying a peer group → a re-bindable CATEGORY option (one capability, N categories)', () => {
    // A LINK category (Pixabay's <a href="/music/">) classifies as a plain click; the recorder attaches the
    // sibling category labels as `options` AND the nav container as `optionContainer`. buildRawAction keeps the
    // demonstrated label as the value, and threads the container through so CLICK_BY_LABEL searches the whole set.
    const cats = ['Photos', 'Illustrations', 'Vectors', 'Videos', 'Music', 'Sound Effects', 'GIFs'];
    const click = buildRawAction({
      domKind: 'click', value: 'Music', url: 'https://pixabay.com',
      target: { role: 'link', accessibleName: 'Music', selector: 'nav > ul > li:nth-of-type(5) > a', options: cats, optionContainer: 'nav.cats' },
    });
    assert.equal(click.value, 'Music', 'a grouped click keeps its label as the value');
    const nav = buildRawAction({ domKind: 'navigate', url: 'https://pixabay.com/music/', from: 'https://pixabay.com' });
    const op = segmentTrace(coalesce([click, nav]));
    const params = deriveObservedParams(op);
    const cat = params.find((p) => p.kind === 'option');
    assert.ok(cat, 'the category click became an OPTION param');
    assert.equal(cat.value, 'Music', 'demonstrated category is the default');
    assert.ok(cat.vocabulary.includes('Vectors') && cat.vocabulary.includes('GIFs'), 'the whole category set is the vocabulary');
    assert.equal(cat.containerHint, 'nav.cats', 'the record-time nav container is carried as a hint');
    // and it lowers to a CLICK_BY_LABEL on the NAV (not the single li) so "search for vectors" re-binds CATEGORY
    const { phases, params: named } = parameterizeObserved(opToPhases(op), params);
    const np = named.find((p) => p.kind === 'option');
    assert.equal(np.used, true, 'category option is templated');
    const byLabel = phases[0].actions.filter((a) => a.action !== 'SCROLL_TO').find((a) => a.action === 'CLICK_BY_LABEL');
    assert.ok(byLabel, 'category click lowered to CLICK_BY_LABEL');
    assert.equal(byLabel.selector, 'nav.cats', 'CLICK_BY_LABEL targets the whole nav, so any category label resolves');
    assert.equal(byLabel.value, `{{${np.name}}}`, 'category is the placeholder');
    // a short peer group below the floor (<3) is NOT lifted (avoids parameterizing an ordinary link click)
    const lone = deriveObservedParams(segmentTrace(coalesce([
      buildRawAction({ domKind: 'click', value: 'Home', url: 'u', target: { role: 'link', accessibleName: 'Home', selector: '#a', options: ['Home', 'About'] } }),
      buildRawAction({ domKind: 'navigate', url: 'u/2', from: 'u' }),
    ])));
    assert.ok(!lone.some((p) => p.kind === 'option'), 'a 2-item nav is below the category floor');
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
