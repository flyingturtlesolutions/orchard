// Core/tier2Lower.test.js — SG-T2-1 unit tests (node --test). PURE: synthetic spec/selection/locale.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lowerToTier2, topoOrder, deriveStructuralPostcondition, buildObservationNode } from './tier2Lower.js';

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
    assert.equal(nodes.length, 2);
    assert.deepEqual(nodes[0].subGoalIds, ['signin'], 'signin fragment first (dependency order)');
    assert.deepEqual(nodes[0].roles.map((r) => r.featureId).sort(), ['login', 'p', 'u']);
    assert.deepEqual(nodes[1].subGoalIds, ['search']);
    assert.deepEqual(nodes[1].roles.map((r) => r.featureId).sort(), ['go', 'q']);
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
    assert.deepEqual(nodes.map((n) => n.type), ['fragment', 'observation']);
    assert.deepEqual(nodes[1].extracts[0].selector, '.results');
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
