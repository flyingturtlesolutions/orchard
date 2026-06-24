// Core/appDef.test.js — CV-1 (v2.74.1161): the AppDefinition + app/sub-task shapes + tighten-only config.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  OVERVIEW_ID, ARCHETYPES, WRITE_POLICIES,
  normalizeConfig, tightenConfig, normalizeAppDefinition, appFromDefinition,
  isOverview, isApp, isSubTask, canDelete, composeSeed, subTaskFromApp, overviewShape, planSubTasks,
} from './appDef.js';

const DEF = { id: 'support', name: 'Support agent', seed: 'You triage and reply to tickets.', archetype: 'operator', defaultConfig: { writePolicy: 'gated' }, version: 2, source: 'builtin' };

describe('appDef — config (tighten-only)', () => {
  it('normalizeConfig defaults to gated; keeps never; clamps junk', () => {
    assert.deepEqual(normalizeConfig(undefined), { writePolicy: 'gated' });
    assert.deepEqual(normalizeConfig({ writePolicy: 'never' }), { writePolicy: 'never' });
    assert.deepEqual(normalizeConfig({ writePolicy: 'wide-open' }), { writePolicy: 'gated' });
    assert.ok(WRITE_POLICIES.includes('never'));
  });
  it('tightenConfig — a child may only narrow, never loosen', () => {
    assert.equal(tightenConfig({ writePolicy: 'never' }, { writePolicy: 'gated' }).writePolicy, 'never');  // parent never wins
    assert.equal(tightenConfig({ writePolicy: 'gated' }, { writePolicy: 'never' }).writePolicy, 'never');  // child tightens
    assert.equal(tightenConfig({ writePolicy: 'gated' }, { writePolicy: 'gated' }).writePolicy, 'gated');
  });
});

describe('appDef — normalizeAppDefinition', () => {
  it('normalizes a valid definition', () => {
    const d = normalizeAppDefinition(DEF);
    assert.equal(d.id, 'support');
    assert.equal(d.archetype, 'operator');
    assert.deepEqual(d.defaultConfig, { writePolicy: 'gated' });
    assert.equal(d.version, 2);
    assert.equal(d.source, 'builtin');
  });
  it('requires id + name + seed; null otherwise', () => {
    assert.equal(normalizeAppDefinition({ name: 'x', seed: 'y' }), null);
    assert.equal(normalizeAppDefinition({ id: 'x', seed: 'y' }), null);
    assert.equal(normalizeAppDefinition({ id: 'x', name: 'y' }), null);
    assert.equal(normalizeAppDefinition(null), null);
  });
  it('clamps a bad archetype to null, a bad source to user, missing version to 1', () => {
    const d = normalizeAppDefinition({ id: 'a', name: 'A', seed: 's', archetype: 'wizard', source: 'evil' });
    assert.equal(d.archetype, null);
    assert.equal(d.source, 'user');     // unknown source → untrusted
    assert.equal(d.version, 1);
    assert.ok(ARCHETYPES.includes('operator'));
  });
  it('normalizes starters: trims, drops blanks, caps at 4; absent → []', () => {
    assert.deepEqual(normalizeAppDefinition(DEF).starters, []);                                  // none on DEF → []
    const d = normalizeAppDefinition({ ...DEF, starters: ['  a ', '', 'b', 'c', 'd', 'e'] });
    assert.deepEqual(d.starters, ['a', 'b', 'c', 'd']);                                          // trimmed, blank dropped, capped at 4
  });
});

describe('appDef — appFromDefinition (copy-on-add)', () => {
  it('projects the app conversation-extension fields, copying the seed', () => {
    const a = appFromDefinition(DEF);
    assert.equal(a.kind, 'app');
    assert.equal(a.appId, 'support');
    assert.equal(a.appVersion, 2);
    assert.equal(a.title, 'Support agent');
    assert.equal(a.seed, DEF.seed);                 // copied
    assert.deepEqual(a.config, { writePolicy: 'gated' });
    assert.equal('id' in a, false);                 // caller stamps id/timestamps
  });
  it('null on an unusable definition', () => {
    assert.equal(appFromDefinition({ id: 'x' }), null);
  });
});

describe('appDef — classifiers', () => {
  const app = { id: 'c1', kind: 'app', appId: 'support', seed: 'app seed', config: { writePolicy: 'gated' } };
  const sub = { id: 'c2', kind: 'app', parentId: 'c1', seed: 'sub seed' };
  const overview = { id: OVERVIEW_ID, kind: 'agent' };
  const plain = { id: 'c3', kind: 'agent' };

  it('distinguishes overview / app / sub-task / plain', () => {
    assert.ok(isOverview(overview));
    assert.ok(isApp(app) && !isApp(sub) && !isApp(overview));
    assert.ok(isSubTask(sub) && !isSubTask(app));
    assert.equal(isApp(plain), false);
  });
  it('canDelete — everything but the Overview', () => {
    assert.equal(canDelete(app), true);
    assert.equal(canDelete(sub), true);
    assert.equal(canDelete(overview), false);
  });
});

describe('appDef — seed composition + sub-task shape', () => {
  const app = { id: 'c1', kind: 'app', appId: 'support', seed: 'You are the Support agent.', config: { writePolicy: 'gated' } };

  it('composeSeed joins app ∘ sub-task; tolerates empties', () => {
    assert.equal(composeSeed('A', 'B'), 'A\n\nB');
    assert.equal(composeSeed('A', ''), 'A');
    assert.equal(composeSeed('', 'B'), 'B');
  });

  it('subTaskFromApp composes the seed, inherits config, sets parentId', () => {
    const s = subTaskFromApp(app, 'This is ticket #64222.');
    assert.equal(s.kind, 'app');
    assert.equal(s.parentId, 'c1');
    assert.equal(s.appId, 'support');
    assert.equal(s.seed, 'You are the Support agent.\n\nThis is ticket #64222.');
    assert.deepEqual(s.config, { writePolicy: 'gated' });
    assert.equal(s.title, 'This is ticket #64222.');
  });

  it('a sub-task inherits a tightened (never) parent config', () => {
    const strict = { ...app, config: { writePolicy: 'never' } };
    assert.equal(subTaskFromApp(strict, 'x').config.writePolicy, 'never');
  });

  it('ONE-LEVEL cap — refuses a sub-task or the Overview as a parent (no sub-sub-tasks)', () => {
    const sub = { id: 'c2', kind: 'app', parentId: 'c1', seed: 'sub' };
    assert.equal(subTaskFromApp(sub, 'deeper'), null);              // parent is a sub-task → refused
    assert.equal(subTaskFromApp({ id: OVERVIEW_ID, kind: 'agent' }, 'x'), null);
    assert.equal(subTaskFromApp({ kind: 'app' }, 'x'), null);       // no id
    assert.equal(subTaskFromApp(null, 'x'), null);
  });
});

describe('appDef — planSubTasks (fan-out) + live-record classifiers', () => {
  // A LIVE app record: ConversationStore coerces kind:'app'→'agent', so apps are identified by appId, not kind.
  const liveApp = { id: 'cv9', kind: 'agent', appId: 'inbox', seed: 'Triage and draft email.', config: { writePolicy: 'gated' } };

  it('classifiers recognize the live (kind:agent + appId) form', () => {
    assert.equal(isApp(liveApp), true);
    assert.equal(isSubTask({ id: 's', kind: 'agent', parentId: 'cv9' }), true);
    assert.equal(isApp({ id: 'x', kind: 'agent' }), false);   // a plain agent (no appId) is not an app
  });

  it('plans one sub-task spec per item — composed seed, parentId, inherited config', () => {
    const specs = planSubTasks(liveApp, ['Alice', 'Bob']);
    assert.equal(specs.length, 2);
    assert.equal(specs[0].title, 'Alice');
    assert.equal(specs[0].parentId, 'cv9');
    assert.equal(specs[0].appId, 'inbox');
    assert.ok(specs[0].seed.startsWith('Triage and draft email.'));   // the app seed leads (composeSeed)
    assert.ok(specs[0].seed.includes('Alice'));
    assert.equal(specs[0].config.writePolicy, 'gated');
  });

  it('dedupes items case-insensitively and drops blanks', () => {
    const specs = planSubTasks(liveApp, ['x', 'X', '  ', 'y']);
    assert.deepEqual(specs.map((s) => s.title), ['x', 'y']);
  });

  it('refuses to fan out from a sub-task or a non-app (the one-level cap)', () => {
    assert.deepEqual(planSubTasks({ id: 's', kind: 'agent', appId: 'inbox', parentId: 'cv9' }, ['a']), []);
    assert.deepEqual(planSubTasks({ id: 'p', kind: 'agent' }, ['a']), []);   // plain, not an app
    assert.deepEqual(planSubTasks(liveApp, []), []);
  });
});

describe('appDef — overviewShape', () => {
  it('the reserved Overview: fixed id, agent kind, system-default seed', () => {
    const o = overviewShape();
    assert.equal(o.id, OVERVIEW_ID);
    assert.equal(o.kind, 'agent');
    assert.equal(o.seed, null);
    assert.ok(isOverview(o) && canDelete(o) === false);
  });
});
