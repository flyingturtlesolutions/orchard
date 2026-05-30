// Core/tier2Lower.test.js — SG-T2-1 unit tests (node --test). PURE: synthetic spec/selection/locale.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lowerToTier2, topoOrder, deriveStructuralPostcondition, buildObservationNode, buildNavigateNode, insertWaits, successToConditions, buildAnalysisNode } from './tier2Lower.js';

const input = (id, goal, sel) => ({ id, label: id, kind: 'input', goals: [goal], selector: sel, interaction: { pattern: 'type', effect: 'none' } });
const submit = (id, goal, sel) => ({ id, label: id, kind: 'action', goals: [goal], selector: sel, interaction: { pattern: 'click', effect: 'submit' } });

describe('topoOrder — dependency ordering, stable, cycle-safe', () => {
  it('orders a phase after the phases it dependsOn even when listed out of order', () => {
    const order = topoOrder([
      { id: 'b', dependsOn: ['a'] },
      { id: 'a', dependsOn: [] },
      { id: 'c', dependsOn: ['b'] },
    ]);
    assert.deepEqual(order.map((s) => s.id), ['a', 'b', 'c']);
  });

  it('preserves original order among independent phases', () => {
    const order = topoOrder([{ id: 'x' }, { id: 'y' }, { id: 'z' }]);
    assert.deepEqual(order.map((s) => s.id), ['x', 'y', 'z']);
  });

  it('degrades gracefully on a cycle — flushes the rest in order, drops nothing', () => {
    const order = topoOrder([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]);
    assert.deepEqual(order.map((s) => s.id).sort(), ['a', 'b']);
  });
});

describe('lowerToTier2 — fragment nodes per phase (SG-T2-1)', () => {
  const searchLocale = {
    goals: { g_search: { id: 'g_search', label: 'search for jobs', achievableVia: ['q', 'l', 'go'] } },
    features: { q: input('q', 'g_search', '#q'), l: input('l', 'g_search', '#l'), go: submit('go', 'g_search', '#go') },
  };

  it('MERGES a fill phase + a submit phase of the SAME form into ONE fragment (form atomicity)', () => {
    const spec = { target: 'search for jobs', subGoals: [
      { id: 'enter', label: 'enter criteria', shape: 'act', dependsOn: [] },
      { id: 'exec', label: 'execute search', shape: 'act', dependsOn: ['enter'] },
    ] };
    const selection = { matches: { enter: ['q'], exec: ['go'] } };
    const { tier, nodes } = lowerToTier2(spec, selection, searchLocale);
    assert.equal(tier, 'cache');
    assert.equal(nodes.length, 1, 'fill+submit collapse to one fragment');
    assert.deepEqual(nodes[0].subGoalIds.sort(), ['enter', 'exec']);
    assert.deepEqual(nodes[0].roles.map((r) => r.featureId).sort(), ['go', 'l', 'q']);
    assert.equal(nodes[0].type, 'fragment');
  });

  it('keeps TWO distinct forms as TWO fragments, in dependency order', () => {
    const locale = {
      goals: {
        g_login: { id: 'g_login', label: 'sign in', achievableVia: ['u', 'p', 'login'] },
        g_search: { id: 'g_search', label: 'search', achievableVia: ['q', 'go'] },
      },
      features: {
        u: input('u', 'g_login', '#u'), p: input('p', 'g_login', '#p'), login: submit('login', 'g_login', '#login'),
        q: input('q', 'g_search', '#q'), go: submit('go', 'g_search', '#go'),
      },
    };
    const spec = { target: 'sign in then search', subGoals: [
      { id: 'search', label: 'search', shape: 'act', dependsOn: ['signin'] },
      { id: 'signin', label: 'sign in', shape: 'act', dependsOn: [] },
    ] };
    const selection = { matches: { signin: ['login'], search: ['go'] } };
    const { nodes } = lowerToTier2(spec, selection, locale);
    const frags = nodes.filter((n) => n.type === 'fragment');   // a settle wait sits between the two forms
    assert.equal(frags.length, 2);
    assert.deepEqual(frags[0].subGoalIds, ['signin'], 'signin fragment first (dependency order)');
    assert.deepEqual(frags[0].roles.map((r) => r.featureId).sort(), ['login', 'p', 'u']);
    assert.deepEqual(frags[1].subGoalIds, ['search']);
    assert.deepEqual(frags[1].roles.map((r) => r.featureId).sort(), ['go', 'q']);
  });

  it('skips read / navigate phases in this slice (fragments only)', () => {
    const spec = { target: 'search for jobs', subGoals: [
      { id: 'nav', label: 'go to search', shape: 'navigate', dependsOn: [] },
      { id: 'fill', label: 'enter criteria', shape: 'act', dependsOn: ['nav'] },
      { id: 'read', label: 'read results', shape: 'read', dependsOn: ['fill'] },
    ] };
    const selection = { matches: { fill: ['q'] } };
    const { nodes } = lowerToTier2(spec, selection, searchLocale);
    assert.equal(nodes.length, 1, 'only the act phase becomes a fragment');
    assert.deepEqual(nodes[0].subGoalIds, ['fill']);
  });

  it('skips a phase that binds nothing (no matches, no resolvable goal)', () => {
    const spec = { target: '', subGoals: [
      { id: 'ghost', label: 'zzz', shape: 'act', dependsOn: [] },
      { id: 'fill', label: 'enter criteria', shape: 'act', dependsOn: [] },
    ] };
    const selection = { matches: { fill: ['q'] } };   // 'ghost' has no matches
    const { nodes } = lowerToTier2(spec, selection, searchLocale);
    assert.equal(nodes.length, 1);
    assert.deepEqual(nodes[0].subGoalIds, ['fill']);
  });

  it('goal-grounds a COMPLETE-shape phase (binds the whole form, not just the matched field)', () => {
    // A complete phase matched only one field; goal-grounding must still pull in the rest of the form +
    // submit. (Regression: bind.js's complete-branch skips SG-RES-7, so we bind via the else-path.)
    const locale = {
      goals: { g_apply: { id: 'g_apply', label: 'apply', achievableVia: ['name', 'email', 'send'] } },
      features: {
        name: input('name', 'g_apply', '#name'), email: input('email', 'g_apply', '#email'),
        send: submit('send', 'g_apply', '#send'),
      },
    };
    const spec = { target: 'apply', subGoals: [{ id: 'apply', label: 'fill application', shape: 'complete', dependsOn: [] }] };
    const { nodes } = lowerToTier2(spec, { matches: { apply: ['name'] } }, locale);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].shape, 'complete', 'node records the real phase shape');
    assert.deepEqual(nodes[0].roles.map((r) => r.featureId).sort(), ['email', 'name', 'send'], 'whole form bound via goal membership');
  });

  it('returns an empty tier-2 op when there are no fragment phases', () => {
    const { nodes } = lowerToTier2({ target: 'x', subGoals: [{ id: 'r', label: 'read', shape: 'read' }] }, { matches: {} }, searchLocale);
    assert.deepEqual(nodes, []);
  });
});

describe('deriveStructuralPostcondition — structural floor (SG-T2-2)', () => {
  const region = (id, goal, sel) => ({ id, label: id, kind: 'collection', goals: [goal], selector: sel, interaction: { pattern: 'none', effect: 'none' } });

  it('asserts the goal-scoped result region is present after a committing fragment', () => {
    const locale = {
      goals: { g_search: { id: 'g_search', label: 'search', achievableVia: ['q', 'go'] } },
      features: { q: input('q', 'g_search', '#q'), go: submit('go', 'g_search', '#go'), results: region('results', 'g_search', '.results') },
    };
    const { nodes } = lowerToTier2({ target: 'search', subGoals: [{ id: 's', label: 'search', shape: 'act', dependsOn: [] }] }, { matches: { s: ['go'] } }, locale);
    assert.equal(nodes.length, 1);
    assert.deepEqual(nodes[0].postcondition, { match: 'all', conditions: [{ type: 'selector_present', selector: '.results' }], source: 'structural' });
  });

  it('omits the postcondition (no false floor) when no result region is derivable', () => {
    const { nodes } = lowerToTier2({ target: 'search for jobs', subGoals: [{ id: 's', label: 'search', shape: 'act', dependsOn: [] }] }, { matches: { s: ['go'] } }, searchLocale);
    assert.equal(nodes.length, 1);
    assert.ok(!('postcondition' in nodes[0]), 'no result region in this locale → no structural floor');
  });

  it('returns null for a fill-only fragment (no committing transition)', () => {
    const node = { roles: [{ featureId: 'q' }] };
    const locale = { features: { q: input('q', 'g', '#q') } };
    assert.equal(deriveStructuralPostcondition(node, locale), null);
  });

  it('does not assert a region from a DIFFERENT goal', () => {
    const locale = {
      goals: { g_search: { id: 'g_search', label: 'search', achievableVia: ['q', 'go'] } },
      features: {
        q: input('q', 'g_search', '#q'), go: submit('go', 'g_search', '#go'),
        other: region('other', 'g_unrelated', '.unrelated'),   // region of a different goal
      },
    };
    const { nodes } = lowerToTier2({ target: 'search', subGoals: [{ id: 's', label: 'search', shape: 'act' }] }, { matches: { s: ['go'] } }, locale);
    assert.ok(!('postcondition' in nodes[0]), 'unrelated-goal region must not become the floor');
  });
});

describe('read → Observation node (SG-T2-3)', () => {
  const region = (id, kind, sel) => ({ id, label: id, kind, selector: sel, interaction: { pattern: 'none', effect: 'none' } });
  const locale = {
    goals: { g_search: { id: 'g_search', label: 'search', achievableVia: ['q', 'go'] } },
    features: {
      q: input('q', 'g_search', '#q'), go: submit('go', 'g_search', '#go'),
      results: region('results', 'collection', '.results'),
    },
  };

  it('emits an observation with an extract for a matched content region', () => {
    const obs = buildObservationNode({ id: 'view', label: 'view results' }, { view: ['results'] }, locale);
    assert.equal(obs.type, 'observation');
    assert.deepEqual(obs.subGoalIds, ['view']);
    assert.deepEqual(obs.extracts, [{ selector: '.results', output: 'RESULTS', shape: 'list' }]);
  });

  it('search → read lowers to [fragment, observation] in dependency order', () => {
    const spec = { target: 'search', subGoals: [
      { id: 'search', label: 'search', shape: 'act', dependsOn: [] },
      { id: 'view', label: 'view results', shape: 'read', dependsOn: ['search'] },
    ] };
    const { nodes } = lowerToTier2(spec, { matches: { search: ['go'], view: ['results'] } }, locale);
    assert.deepEqual(nodes.map((n) => n.type), ['fragment', 'wait', 'observation'], 'a settle wait sits across the search→results transition');
    assert.deepEqual(nodes[2].extracts[0].selector, '.results');
  });

  it('drops a read phase that matched no readable region (e.g. only an input)', () => {
    assert.equal(buildObservationNode({ id: 'view', label: 'view' }, { view: ['q'] }, locale), null);
    const { nodes } = lowerToTier2({ target: 'x', subGoals: [{ id: 'view', label: 'view', shape: 'read' }] }, { matches: { view: ['q'] } }, locale);
    assert.deepEqual(nodes, []);
  });

  it('maps kinds to extract shapes (collection→list, composite→record, region→text)', () => {
    const loc2 = { features: { c: region('c', 'collection', '.c'), r: region('r', 'region', '.r'), m: region('m', 'composite', '.m') } };
    const obs = buildObservationNode({ id: 'v', label: 'v' }, { v: ['c', 'r', 'm'] }, loc2);
    assert.deepEqual(obs.extracts.map((e) => e.shape), ['list', 'text', 'record']);
  });
});

describe('navigate node + wait insertion (SG-T2-4)', () => {
  it('navigate phase with an href → a url navigate node', () => {
    const locale = { features: { link: { id: 'link', label: 'Pricing', kind: 'navigation', selector: 'a.price', href: '/pricing', interaction: { pattern: 'click', effect: 'navigate' } } } };
    const nav = buildNavigateNode({ id: 'go', label: 'open pricing' }, { go: ['link'] }, locale);
    assert.deepEqual(nav, { type: 'navigate', subGoalIds: ['go'], label: 'open pricing', mode: 'url', url: '/pricing' });
  });

  it('navigate phase with no href → a click navigate node', () => {
    const locale = { features: { tab: { id: 'tab', label: 'Settings', kind: 'navigation', selector: '#tab', interaction: { pattern: 'click', effect: 'navigate' } } } };
    const nav = buildNavigateNode({ id: 'go', label: 'open settings' }, { go: ['tab'] }, locale);
    assert.equal(nav.mode, 'click');
    assert.equal(nav.selector, '#tab');
  });

  it('inserts a settle wait after a committing fragment, keyed on the next node first selector', () => {
    const frag = { type: 'fragment', roles: [{ featureId: 'go', selector: '#go' }] };
    const obs = { type: 'observation', extracts: [{ selector: '.results' }] };
    const locale = { features: { go: { id: 'go', kind: 'action', interaction: { effect: 'submit' } } } };
    const out = insertWaits([frag, obs], locale);
    assert.deepEqual(out.map((n) => n.type), ['fragment', 'wait', 'observation']);
    assert.deepEqual(out[1].condition, { type: 'selector_present', selector: '.results' });
  });

  it('inserts a wait after a navigate node', () => {
    const nav = { type: 'navigate', mode: 'url', url: '/x' };
    const frag = { type: 'fragment', roles: [{ featureId: 'a', selector: '#a' }] };
    const out = insertWaits([nav, frag], { features: { a: { kind: 'input', interaction: { effect: 'none' } } } });
    assert.deepEqual(out.map((n) => n.type), ['navigate', 'wait', 'fragment']);
  });

  it('does NOT insert a wait after a non-committing fragment', () => {
    const f1 = { type: 'fragment', roles: [{ featureId: 'a', selector: '#a' }] };
    const f2 = { type: 'fragment', roles: [{ featureId: 'b', selector: '#b' }] };
    const locale = { features: { a: { kind: 'input', interaction: { effect: 'none' } }, b: { kind: 'input', interaction: { effect: 'none' } } } };
    const out = insertWaits([f1, f2], locale);
    assert.deepEqual(out.map((n) => n.type), ['fragment', 'fragment']);
  });
});

describe('LLM-refined postconditions + Analysis (SG-T2-5)', () => {
  // result region carries the search goal so the structural floor (SG-T2-2) can find it
  const region = (id, kind, sel) => ({ id, label: id, kind, goals: ['g_search'], selector: sel, interaction: { pattern: 'none', effect: 'none' } });

  it('successToConditions maps url/text/selector observables; drops prose', () => {
    const conds = successToConditions([
      { signal: 'url', match: '/jobs' },
      { signal: 'text', match: 'results found' },
      { signal: 'element', match: '.result-card' },
      { signal: 'element', match: 'a list of jobs is visible' },   // prose → dropped
      { signal: 'value', match: 'whatever' },                       // not statically checkable → dropped
    ]);
    assert.deepEqual(conds, [
      { type: 'url_matches', pattern: '/jobs' },
      { type: 'text_present', text: 'results found' },
      { type: 'selector_present', selector: '.result-card' },
    ]);
  });

  it('merges a per-subGoal successCondition into the fragment postcondition (match:any, source:structural+llm)', () => {
    const locale = {
      goals: { g_search: { id: 'g_search', label: 'search', achievableVia: ['q', 'go'] } },
      features: { q: input('q', 'g_search', '#q'), go: submit('go', 'g_search', '#go'), results: region('results', 'collection', '.results') },
    };
    const spec = { target: 'search', subGoals: [{ id: 's', label: 'search', shape: 'act', dependsOn: [], successCondition: [{ signal: 'url', match: '/jobs' }] }] };
    const { nodes } = lowerToTier2(spec, { matches: { s: ['go'] } }, locale);
    const frag = nodes.find((n) => n.type === 'fragment');
    assert.equal(frag.postcondition.match, 'any');
    assert.equal(frag.postcondition.source, 'structural+llm');
    assert.deepEqual(frag.postcondition.conditions, [
      { type: 'selector_present', selector: '.results' },
      { type: 'url_matches', pattern: '/jobs' },
    ]);
  });

  it('structural-only postcondition is unchanged (match:all, source:structural) when no successCondition', () => {
    const locale = {
      goals: { g_search: { id: 'g_search', label: 'search', achievableVia: ['q', 'go'] } },
      features: { q: input('q', 'g_search', '#q'), go: submit('go', 'g_search', '#go'), results: region('results', 'collection', '.results') },
    };
    const { nodes } = lowerToTier2({ target: 'search', subGoals: [{ id: 's', label: 'search', shape: 'act' }] }, { matches: { s: ['go'] } }, locale);
    const frag = nodes.find((n) => n.type === 'fragment');
    assert.equal(frag.postcondition.match, 'all');
    assert.equal(frag.postcondition.source, 'structural');
  });

  it('buildAnalysisNode returns null with no upstream data, else an analysis over it', () => {
    assert.equal(buildAnalysisNode({ id: 'a', label: 'cheapest' }, null), null);
    assert.deepEqual(buildAnalysisNode({ id: 'a', label: 'pick the cheapest' }, 'RESULTS'),
      { type: 'analysis', subGoalIds: ['a'], label: 'pick the cheapest', op: 'sort', over: 'RESULTS' });
  });

  it('a transform-hint read AFTER an observation lowers to an Analysis over the observation output', () => {
    const locale = {
      goals: { g_search: { id: 'g_search', label: 'search', achievableVia: ['q', 'go'] } },
      features: { q: input('q', 'g_search', '#q'), go: submit('go', 'g_search', '#go'), results: region('results', 'collection', '.results') },
    };
    const spec = { target: 'search cheap', subGoals: [
      { id: 'search', label: 'search', shape: 'act', dependsOn: [] },
      { id: 'view', label: 'view results', shape: 'read', dependsOn: ['search'] },
      { id: 'pick', label: 'keep only the remote ones', shape: 'read', dependsOn: ['view'] },
    ] };
    const { nodes } = lowerToTier2(spec, { matches: { search: ['go'], view: ['results'], pick: ['results'] } }, locale);
    const an = nodes.find((n) => n.type === 'analysis');
    assert.ok(an, 'transform-hint read became an analysis');
    assert.equal(an.op, 'filter');   // "only" → filter; (a "cheapest"/"sort" label would be op:'sort')
    assert.equal(an.over, 'RESULTS');
  });
});
