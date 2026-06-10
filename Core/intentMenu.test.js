// Core/intentMenu.test.js — IM-1 intent menu (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildIntentMenu } from './intentMenu.js';

const cap = (intent, { id = `cap_${intent}`, aliases = [] } = {}) => ({ id, intent, aliases });
const goal = (label, id) => ({ id: id || label, label });

describe('buildIntentMenu — "what can I do here?" from the substrate', () => {
  it('mixes taught (run-now) + unauthored goals (teachable); a covered goal is NOT re-offered', () => {
    const caps = [cap('Search media by category', { aliases: ['search pixabay for videos'] })];
    const goals = [goal('Search media by category'), goal('Select content sort order'), goal('Download a media file')];
    const m = buildIntentMenu({ caps, goals, readiness: 'capable' });
    const kinds = m.entries.map((e) => e.kind);
    assert.ok(kinds.includes('run-now') && kinds.includes('teachable'));
    const labels = m.entries.map((e) => e.label);
    assert.equal(labels.filter((l) => l === 'Search media by category').length, 1, 'covered goal appears ONCE (as run-now)');
    assert.ok(labels.includes('Select content sort order'));
    assert.equal(m.counts.taught, 1);
    assert.equal(m.counts.teachable, 2);
  });

  it('run-now: ask = first accreted alias (warm path), ranked by alias count; label dedup', () => {
    const caps = [
      cap('Search jobs', { aliases: [] }),
      cap('Open each result', { aliases: ['open each job', 'open all results'] }),
      { id: 'dup', intent: '  search   JOBS ' },                       // whitespace/case dup of the first
    ];
    const m = buildIntentMenu({ caps });
    assert.equal(m.entries[0].label, 'Open each result', 'more aliases → first');
    assert.equal(m.entries[0].ask, 'open each job');
    assert.equal(m.entries.filter((e) => /search\s+jobs/i.test(e.label)).length, 1, 'dup label collapsed');
    assert.ok(m.entries.every((e) => e.kind === 'run-now'));
  });

  it('site catalog: prevalence ranks teachable goals + contributes goals beyond the Locale', () => {
    const siteCatalog = { capabilities: [
      { goal: 'Search media by category', count: 5 },
      { goal: 'Report an issue', count: 1 },
    ] };
    const m = buildIntentMenu({ goals: [goal('Select content sort order')], siteCatalog });
    const labels = m.entries.map((e) => e.label);
    assert.ok(labels.includes('Search media by category'), 'catalog-only goal offered');
    assert.equal(m.entries[0].label, 'Search media by category', 'prevalence 5 ranks first');
    assert.equal(m.entries[0].source, 'site-catalog');
    assert.ok(labels.includes('Select content sort order'));
    assert.equal(m.entries.find((e) => e.label === 'Select content sort order').source, 'locale-goal');
  });

  it('composition: run-now capped at ceil(limit/2) when teachable exists; tops up otherwise', () => {
    const caps = [cap('A taught one'), cap('B taught two'), cap('C taught three'), cap('D taught four')];
    const goals = [goal('Brand new goal x'), goal('Brand new goal y')];
    const m = buildIntentMenu({ caps, goals, limit: 5 });
    assert.equal(m.entries.length, 5);
    assert.equal(m.entries.filter((e) => e.kind === 'run-now').length, 3, '3 run-now (ceil(5/2)=3) + topped up');
    assert.equal(m.entries.filter((e) => e.kind === 'teachable').length, 2);
    const onlyCaps = buildIntentMenu({ caps, limit: 5 });
    assert.equal(onlyCaps.entries.filter((e) => e.kind === 'run-now').length, 4, 'no teachable → all taught');
  });

  it('cold ground: nothing known → a single explore-first signpost (ask=null)', () => {
    const m = buildIntentMenu({ readiness: 'empty' });
    assert.equal(m.entries.length, 1);
    assert.equal(m.entries[0].kind, 'explore-first');
    assert.equal(m.entries[0].ask, null);
    assert.equal(m.readiness, 'empty');
  });

  it('limit respected; degrades on null/garbage inputs', () => {
    const goals = Array.from({ length: 12 }, (_, i) => goal(`Do distinct thing number ${i}`));
    assert.equal(buildIntentMenu({ goals, limit: 4 }).entries.length, 4);
    const m = buildIntentMenu({ caps: [null, {}], goals: [null, { id: 'x' }], siteCatalog: { capabilities: [null] } });
    assert.equal(m.entries[0].kind, 'explore-first', 'all-garbage → explore-first, no throw');
  });
});
