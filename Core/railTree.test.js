// Core/railTree.test.js — CV-3c (v2.74.1168): the pure accordion model.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRailTree, subTasksOf } from './railTree.js';
import { OVERVIEW_ID, ADMIN_ID } from './appDef.js';

const roles = (rows) => rows.map((r) => r.role);

describe('railTree — buildRailTree', () => {
  it('CN-2 — no Front/overview pin and no Admin fixture; home is the launch page; New-app is the only fixture', () => {
    const rows = buildRailTree([]);
    assert.equal(rows.some((r) => r.role === 'overview'), false, 'no Front desk pin');
    assert.equal(rows.some((r) => r.role === 'admin'), false, 'the Admin fixture is removed (CN-2) — home is the launch page');
    assert.equal(rows.length, 1, 'empty input → only the New-app entry');
    assert.equal(rows[0].role, 'new-app');
    assert.equal(rows[0].id, null);
  });

  it('CN-2 — a stored admin_desk conversation is excluded from the Rail (invisible; retained, not rendered)', () => {
    const rows = buildRailTree([{ id: ADMIN_ID, title: 'Admin desk', kind: 'agent', updatedAt: 99, summary: '2 open incidents' }]);
    assert.equal(rows.filter((r) => r.id === ADMIN_ID).length, 0, 'no admin fixture + excluded from top → renders nowhere');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, 'new-app');
  });

  it('CN-2 — incident cases (vtc_, admin_desk children) render NOWHERE now the fixture is gone; other convs unaffected', () => {
    const summaries = [
      { id: 'vtc_a', title: 'vendorsuite looks signed out', kind: 'agent', parentId: ADMIN_ID, updatedAt: 90 },
      { id: 'vtc_b', title: 'Read X may have drifted', kind: 'agent', parentId: ADMIN_ID, updatedAt: 95 },
      { id: 'chat', title: 'Free chat', kind: 'agent', updatedAt: 99 },
    ];
    const rows = buildRailTree(summaries);
    assert.equal(rows.some((r) => r.role === 'admin'), false, 'no admin fixture');
    assert.equal(rows.some((r) => String(r.id).startsWith('vtc_')), false, 'admin_desk-parented cases are excluded from top — never leak as rows');
    assert.equal(rows.some((r) => r.id === 'chat' && r.role === 'plain'), true, 'ordinary conversations still render');
    assert.equal(rows[rows.length - 1].role, 'new-app', 'the constructor entry stays last');
  });

  it('an app row carries count + pin state; sub-tasks ALWAYS emit right after it (v1774 peek/pin)', () => {
    const summaries = [
      { id: 'app1', title: 'Support', kind: 'agent', appId: 'support', icon: 'headset', updatedAt: 100 },
      { id: 't1', title: 'Ticket #1', kind: 'agent', parentId: 'app1', updatedAt: 90 },
      { id: 't2', title: 'Ticket #2', kind: 'agent', parentId: 'app1', updatedAt: 95 },
    ];

    const unpinned = buildRailTree(summaries);
    const appRow = unpinned.find((r) => r.id === 'app1');
    assert.equal(appRow.role, 'app');
    assert.equal(appRow.hasChildren, true);
    assert.equal(appRow.count, 2);
    assert.equal(appRow.expanded, false, 'expanded = pinned; hiding is the RENDERER\'s job (hover-peek must not rebuild)');
    const subs = unpinned.filter((r) => r.role === 'subtask');
    assert.equal(subs.length, 2, 'sub-task rows emit even unpinned');
    assert.equal(subs[0].depth, 1);
    // newest sub first (t2 updatedAt 95 > t1 90), and they sit immediately after the app row
    assert.deepEqual(subs.map((s) => s.id), ['t2', 't1']);
    const appIdx = unpinned.findIndex((r) => r.id === 'app1');
    assert.equal(unpinned[appIdx + 1].role, 'subtask');

    const open = buildRailTree(summaries, { expanded: ['app1'] });
    assert.equal(open.find((r) => r.id === 'app1').expanded, true, 'the pin flows through');
  });

  it('v1777 "one class" — workflows emit as desk children (role workflow) between the app row and its cases', () => {
    const summaries = [
      { id: 'app1', title: 'Support', kind: 'agent', appId: 'support', instanceId: 'inst1', updatedAt: 100 },
      { id: 't1', title: 'Ticket #1', kind: 'agent', parentId: 'app1', updatedAt: 90 },
    ];
    const wf = { id: 'w1', name: 'daily sweep', ask: 'get open tickets', subAsks: ['a', 'b'] };
    const rows = buildRailTree(summaries, { workflowsByConv: new Map([['app1', [wf]]]) });
    const appIdx = rows.findIndex((r) => r.id === 'app1');
    assert.equal(rows[appIdx].wfCount, 1, 'the app row carries the workflow count for the mirrored button');
    assert.equal(rows[appIdx + 1].role, 'workflow', 'workflow rows come FIRST (icon order), then cases');
    assert.equal(rows[appIdx + 1].title, 'daily sweep');
    assert.equal(rows[appIdx + 1].wfKey, 'inst1', 'wfKey = the desk instance (the bank key)');
    assert.deepEqual(rows[appIdx + 1].wf, wf, 'the full record rides the row — actions need it');
    assert.equal(rows[appIdx + 2].role, 'subtask');
    assert.equal(buildRailTree(summaries).find((r) => r.id === 'app1').wfCount, 0, 'no map → count 0, no button');
  });

  it('dev mode off hides dev conversations; on shows them as plain rows', () => {
    const summaries = [
      { id: 'c1', title: 'Free chat', kind: 'agent', updatedAt: 50 },
      { id: 'd1', title: 'Dev thread', kind: 'dev', updatedAt: 60 },
    ];
    const off = buildRailTree(summaries, { devMode: false });
    assert.equal(off.some((r) => r.id === 'd1'), false);
    assert.equal(off.some((r) => r.id === 'c1'), true);

    const on = buildRailTree(summaries, { devMode: true });
    const devRow = on.find((r) => r.id === 'd1');
    assert.equal(devRow.role, 'plain');
    assert.equal(devRow.kind, 'dev');
  });

  it('an orphan sub-task (its app is absent) renders plain so it is never lost', () => {
    const rows = buildRailTree([
      { id: 'orphan', title: 'Stray', kind: 'agent', parentId: 'gone', updatedAt: 10 },
    ]);
    const row = rows.find((r) => r.id === 'orphan');
    assert.ok(row, 'orphan still appears');
    assert.equal(row.role, 'plain');
  });

  it('CN-2 — active flags the selected row; null (launch-page home) leaves NO row active', () => {
    const summaries = [{ id: 'app1', title: 'Inbox', kind: 'agent', appId: 'inbox', updatedAt: 100 }];

    const appActive = buildRailTree(summaries, { activeId: 'app1' });
    assert.equal(appActive.find((r) => r.id === 'app1').active, true);

    const homeActive = buildRailTree(summaries, { activeId: null });
    assert.equal(homeActive.some((r) => r.active), false, 'null = launch page home → no active row');
  });

  it('CN-2 — apps + plain conversations order by updatedAt desc; only New-app trails', () => {
    const rows = buildRailTree([
      { id: 'old', title: 'Old', kind: 'agent', updatedAt: 10 },
      { id: 'new', title: 'New', kind: 'agent', appId: 'x', updatedAt: 99 },
    ]);
    // CN-2 — no leading Overview pin, no trailing Admin fixture; only New-app trails
    const middle = rows.slice(0, -1).map((r) => r.id);
    assert.deepEqual(middle, ['new', 'old']);
  });
});

describe('railTree — subTasksOf (bounded across)', () => {
  const summaries = [
    { id: 'app1', title: 'Support', kind: 'agent', appId: 'support', updatedAt: 100 },
    { id: 't1', title: 'Ticket #1', kind: 'agent', parentId: 'app1', updatedAt: 90 },
    { id: 't2', title: 'Ticket #2', kind: 'agent', parentId: 'app1', updatedAt: 95 },
    { id: 'other', title: 'Elsewhere', kind: 'agent', parentId: 'app2', updatedAt: 80 },
  ];

  it('returns only the named app’s children, newest first', () => {
    assert.deepEqual(subTasksOf(summaries, 'app1').map((c) => c.id), ['t2', 't1']);
  });

  it('empty for an app with no children, or a missing id', () => {
    assert.deepEqual(subTasksOf(summaries, 'app1-none'), []);
    assert.deepEqual(subTasksOf(summaries, null), []);
    assert.deepEqual(subTasksOf(null, 'app1'), []);
  });
});
