// Core/observedSegment.test.js — OBS-2 unit tests (node --test). PURE. Built against a LIVE Indeed
// demonstration (search "support" in Minneapolis, then filter by date posted = Last 3 days).
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRawAction, coalesce } from './observedTrace.js';
import { segmentTrace, opToPhases, stepToAction } from './observedSegment.js';

// `A` mirrors the real recorder: a click passes its accessibleName as the value (kept only when the click
// classifies as a `select` — i.e. on an option). role=option is set for the option / pay-bracket labels.
const A = (domKind, name, selector, value) => buildRawAction({
  domKind,
  value: value !== undefined ? value : (domKind === 'click' ? name : undefined),
  url: 'https://www.indeed.com',
  target: { role: /Last 3 days|\$/.test(name || '') ? 'option' : null, accessibleName: name, selector },
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

  it('opToPhases maps steps → executable actions carrying inline landmarks (OBS-3)', () => {
    const phases = opToPhases(segmentTrace(coalesce(raw)));
    assert.equal(phases.length, 2);
    assert.deepEqual(phases[0].actions.map((a) => a.action), ['TYPE', 'TYPE', 'CLICK']);
    assert.equal(phases[0].actions[0].value, 'support');
    assert.equal(phases[0].actions[2].landmark.accessibleName, 'Search');
    // the date option (a clicked <li role=option>) replays as a CLICK on that option
    assert.deepEqual(phases[1].actions.map((a) => a.action), ['CLICK', 'CLICK']);
    assert.equal(phases[1].actions[1].landmark.accessibleName, 'Last 3 days');
  });

  it('stepToAction: a native <select> change → SELECT op with value', () => {
    const a = stepToAction(buildRawAction({ domKind: 'change', value: 'CA', target: { tagName: 'SELECT', selector: '#state' } }));
    assert.equal(a.action, 'SELECT');
    assert.equal(a.value, 'CA');
  });
});
