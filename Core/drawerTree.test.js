// Core/drawerTree.test.js — CV-3c (v2.74.1168): the pure accordion model.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildDrawerTree } from './drawerTree.js';
import { OVERVIEW_ID } from './appDef.js';

const roles = (rows) => rows.map((r) => r.role);

describe('drawerTree — buildDrawerTree', () => {
  it('always pins Overview first and New-app last, even with no conversations', () => {
    const rows = buildDrawerTree([]);
    assert.equal(rows[0].role, 'overview');
    assert.equal(rows[0].id, OVERVIEW_ID);
    assert.equal(rows[rows.length - 1].role, 'new-app');
    assert.equal(rows[rows.length - 1].id, null);
  });

  it('an app collapsed shows a count + chevron but hides its sub-tasks; expanded reveals them after it', () => {
    const summaries = [
      { id: 'app1', title: 'Support', kind: 'agent', appId: 'support', icon: 'headset', updatedAt: 100 },
      { id: 't1', title: 'Ticket #1', kind: 'agent', parentId: 'app1', updatedAt: 90 },
      { id: 't2', title: 'Ticket #2', kind: 'agent', parentId: 'app1', updatedAt: 95 },
    ];

    const collapsed = buildDrawerTree(summaries);
    const appRow = collapsed.find((r) => r.id === 'app1');
    assert.equal(appRow.role, 'app');
    assert.equal(appRow.hasChildren, true);
    assert.equal(appRow.count, 2);
    assert.equal(appRow.expanded, false);
    assert.equal(collapsed.some((r) => r.role === 'subtask'), false, 'collapsed app hides sub-tasks');

    const open = buildDrawerTree(summaries, { expanded: ['app1'] });
    const subs = open.filter((r) => r.role === 'subtask');
    assert.equal(subs.length, 2);
    assert.equal(subs[0].depth, 1);
    // newest sub first (t2 updatedAt 95 > t1 90), and they sit immediately after the app row
    assert.deepEqual(subs.map((s) => s.id), ['t2', 't1']);
    const appIdx = open.findIndex((r) => r.id === 'app1');
    assert.equal(open[appIdx + 1].role, 'subtask');
  });

  it('dev mode off hides dev conversations; on shows them as plain rows', () => {
    const summaries = [
      { id: 'c1', title: 'Free chat', kind: 'agent', updatedAt: 50 },
      { id: 'd1', title: 'Dev thread', kind: 'dev', updatedAt: 60 },
    ];
    const off = buildDrawerTree(summaries, { devMode: false });
    assert.equal(off.some((r) => r.id === 'd1'), false);
    assert.equal(off.some((r) => r.id === 'c1'), true);

    const on = buildDrawerTree(summaries, { devMode: true });
    const devRow = on.find((r) => r.id === 'd1');
    assert.equal(devRow.role, 'plain');
    assert.equal(devRow.kind, 'dev');
  });

  it('an orphan sub-task (its app is absent) renders plain so it is never lost', () => {
    const rows = buildDrawerTree([
      { id: 'orphan', title: 'Stray', kind: 'agent', parentId: 'gone', updatedAt: 10 },
    ]);
    const row = rows.find((r) => r.id === 'orphan');
    assert.ok(row, 'orphan still appears');
    assert.equal(row.role, 'plain');
  });

  it('active flags the right row: a real id marks that row, null marks Overview', () => {
    const summaries = [{ id: 'app1', title: 'Inbox', kind: 'agent', appId: 'inbox', updatedAt: 100 }];

    const appActive = buildDrawerTree(summaries, { activeId: 'app1' });
    assert.equal(appActive.find((r) => r.id === 'app1').active, true);
    assert.equal(appActive.find((r) => r.role === 'overview').active, false);

    const homeActive = buildDrawerTree(summaries, { activeId: null });
    assert.equal(homeActive.find((r) => r.role === 'overview').active, true);
    assert.equal(homeActive.find((r) => r.id === 'app1').active, false);
  });

  it('apps + plain conversations order by updatedAt desc between the pins', () => {
    const rows = buildDrawerTree([
      { id: 'old', title: 'Old', kind: 'agent', updatedAt: 10 },
      { id: 'new', title: 'New', kind: 'agent', appId: 'x', updatedAt: 99 },
    ]);
    // drop the Overview pin (first) and New-app (last); the middle is recency-ordered
    const middle = rows.slice(1, -1).map((r) => r.id);
    assert.deepEqual(middle, ['new', 'old']);
  });
});
