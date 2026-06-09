// Core/autoExplore.test.js — EX-6a pure orchestrator-brain tests (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planAutoExplore, autoExploreVerdict } from './autoExplore.js';

const node = (o) => ({
  id: o.id, urlPattern: o.urlPattern, name: o.name ?? o.urlPattern,
  goals: o.goals ?? [], status: o.status ?? 'discovered', pageType: o.pageType ?? null,
  exemplarUrl: o.exemplarUrl ?? null, instances: o.instances ?? [],
});
const SM = () => ({ nodes: {
  jobs:  node({ id: 'j', urlPattern: 'https://acme.com/jobs/{id}', name: 'Jobs', goals: ['Search jobs'], status: 'modeled', exemplarUrl: 'https://acme.com/jobs/123' }),
  about: node({ id: 'a', urlPattern: 'https://acme.com/about', name: 'About', status: 'stub' }),
} });

describe('planAutoExplore — EX-6a which page to explore', () => {
  it('relevance-picks the best archetype and explores its concrete exemplar', () => {
    const p = planAutoExplore({ ask: 'search jobs', startUrl: 'https://acme.com/', siteMap: SM() });
    assert.equal(p.exploreUrl, 'https://acme.com/jobs/123');
    assert.equal(p.reason, 'relevance-pick');
    assert.equal(p.picked.id, 'j');
  });
  it('falls back to startUrl when the picked archetype has no concrete exemplar', () => {
    const sm = { nodes: { jobs: node({ id: 'j', urlPattern: 'https://acme.com/jobs', name: 'Jobs', goals: ['Search jobs'], status: 'modeled', exemplarUrl: null, instances: [] }) } };
    const p = planAutoExplore({ ask: 'search jobs', startUrl: 'https://acme.com/start', siteMap: sm });
    assert.equal(p.exploreUrl, 'https://acme.com/start');
    assert.equal(p.reason, 'relevance-pick-no-exemplar');
    assert.equal(p.picked.id, 'j');
  });
  it('falls back to startUrl when nothing in the siteMap is relevant', () => {
    const p = planAutoExplore({ ask: 'zzzqqq nonsense', startUrl: 'https://acme.com/start', siteMap: SM() });
    assert.equal(p.exploreUrl, 'https://acme.com/start');
    assert.equal(p.reason, 'no-relevant-page');
    assert.equal(p.picked, null);
  });
  it('explores the startUrl when the Ground has no siteMap yet (fresh/empty Ground)', () => {
    assert.deepEqual(planAutoExplore({ ask: 'search jobs', startUrl: 'https://acme.com/start', siteMap: null }),
      { exploreUrl: 'https://acme.com/start', picked: null, reason: 'no-sitemap' });
    assert.equal(planAutoExplore({ ask: 'x', startUrl: 'https://s', siteMap: { nodes: {} } }).reason, 'no-sitemap');
  });
  it('an empty ask skips relevance-pick and uses the startUrl', () => {
    const p = planAutoExplore({ ask: '', startUrl: 'https://s', siteMap: SM() });
    assert.equal(p.exploreUrl, 'https://s');
    assert.equal(p.picked, null);
  });
  it('no target → exploreUrl null', () => {
    assert.equal(planAutoExplore({ ask: 'search jobs', startUrl: '', siteMap: null }).reason, 'no-target');
    assert.equal(planAutoExplore({}).exploreUrl, null);
  });
});

describe('autoExploreVerdict — EX-6a explore→next-action decision', () => {
  const healthy = () => ({
    features: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}`, { id: `f${i}`, kind: 'action' }])),
    goals: { g1: {}, g2: {} },
    coverage: { fidelity: 'L2', capped: false, featureCount: 8 },
  });
  it('trusted Locale → ready / author', () => {
    const v = autoExploreVerdict(healthy(), { stats: { aborted: null } });
    assert.equal(v.status, 'ready');
    assert.equal(v.action, 'author');
    assert.equal(v.trust.tier, 'trusted');
  });
  it('partial trust (e.g. aborted sweep) → partial / author with caveats', () => {
    const v = autoExploreVerdict(healthy(), { stats: { aborted: 'navigation-unrecovered' } });
    assert.equal(v.status, 'partial');
    assert.equal(v.action, 'author');
    assert.ok(v.trust.reasons.some((r) => r.code === 'sweep-aborted'));
  });
  it('untrusted Locale → insufficient / reexplore (do not mint junk)', () => {
    const m = healthy(); m.goals = {}; m.coverage.capped = true;
    const v = autoExploreVerdict(m, { stats: { aborted: 'navigation-unrecovered' } });
    assert.equal(v.status, 'insufficient');
    assert.equal(v.action, 'reexplore');
  });
  it('no model → failed / abort', () => {
    const v = autoExploreVerdict(null);
    assert.equal(v.status, 'failed');
    assert.equal(v.action, 'abort');
  });
});
