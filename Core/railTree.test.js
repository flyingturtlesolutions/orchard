// Core/railTree.test.js — CV-3c (v2.74.1168): the pure accordion model.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildRailTree, subTasksOf } from './railTree.js';
import { OVERVIEW_ID, ADMIN_ID } from './appDef.js';

const roles = (rows) => rows.map((r) => r.role);

describe('railTree — buildRailTree', () => {
  it('always pins Overview first, the Admin desk as the LAST conversation, and New-app last, even with no conversations', () => {
    const rows = buildRailTree([]);
    assert.equal(rows[0].role, 'overview');
    assert.equal(rows[0].id, OVERVIEW_ID);
    assert.equal(rows[rows.length - 2].role, 'admin', 'VT-2 (v2.74.1582) — the vitals fixture is PERMANENT and sits at the BOTTOM (the operator console under the work), just above the constructor entry');
    assert.equal(rows[rows.length - 2].id, ADMIN_ID);
    assert.equal(rows[rows.length - 1].role, 'new-app');
    assert.equal(rows[rows.length - 1].id, null);
  });

  it('an existing Admin-desk conversation feeds the fixture (summary, no double row) instead of rendering plain', () => {
    const rows = buildRailTree([{ id: ADMIN_ID, title: 'Admin desk', kind: 'agent', updatedAt: 99, summary: '2 open incidents' }]);
    const admin = rows.filter((r) => r.id === ADMIN_ID);
    assert.equal(admin.length, 1, 'the fixture absorbs the conversation — never a second plain row');
    assert.equal(admin[0].role, 'admin');
    assert.equal(admin[0].summary, '2 open incidents');
  });

  it('VT-2b/1589 — incident CASES (Admin children) collapse/expand under the fixture like an app\'s, never plain', () => {
    const summaries = [
      { id: 'vtc_a', title: 'vendorsuite looks signed out', kind: 'agent', parentId: ADMIN_ID, updatedAt: 90, summary: 'fresh → signed-out' },
      { id: 'vtc_b', title: 'Read X may have drifted', kind: 'agent', parentId: ADMIN_ID, updatedAt: 95 },
      { id: 'chat', title: 'Free chat', kind: 'agent', updatedAt: 99 },
    ];
    const collapsed = buildRailTree(summaries);
    const fix = collapsed.find((r) => r.role === 'admin');
    assert.equal(fix.count, 2, 'the fixture carries the case count');
    assert.equal(fix.hasChildren, true);
    assert.equal(fix.expanded, false, 'collapsed by default — the chevron is the door (app-row parity)');
    assert.equal(collapsed.some((r) => String(r.id).startsWith('vtc_')), false, 'collapsed hides the cases');
    const open = buildRailTree(summaries, { expanded: [ADMIN_ID] });
    const adminIdx = open.findIndex((r) => r.role === 'admin');
    assert.equal(open[adminIdx].expanded, true);
    assert.deepEqual([open[adminIdx + 1].id, open[adminIdx + 2].id], ['vtc_b', 'vtc_a'], 'expanded cases sit under the fixture, newest first');
    assert.equal(open[adminIdx + 1].role, 'subtask');
    assert.equal(open[open.length - 1].role, 'new-app', 'the constructor entry stays last');
    assert.equal(open.filter((r) => r.role === 'plain' && String(r.id).startsWith('vtc_')).length, 0, 'a case never leaks as a plain row');
  });

  it('an app collapsed shows a count + chevron but hides its sub-tasks; expanded reveals them after it', () => {
    const summaries = [
      { id: 'app1', title: 'Support', kind: 'agent', appId: 'support', icon: 'headset', updatedAt: 100 },
      { id: 't1', title: 'Ticket #1', kind: 'agent', parentId: 'app1', updatedAt: 90 },
      { id: 't2', title: 'Ticket #2', kind: 'agent', parentId: 'app1', updatedAt: 95 },
    ];

    const collapsed = buildRailTree(summaries);
    const appRow = collapsed.find((r) => r.id === 'app1');
    assert.equal(appRow.role, 'app');
    assert.equal(appRow.hasChildren, true);
    assert.equal(appRow.count, 2);
    assert.equal(appRow.expanded, false);
    assert.equal(collapsed.some((r) => r.role === 'subtask'), false, 'collapsed app hides sub-tasks');

    const open = buildRailTree(summaries, { expanded: ['app1'] });
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

  it('active flags the right row: a real id marks that row, null marks Overview', () => {
    const summaries = [{ id: 'app1', title: 'Inbox', kind: 'agent', appId: 'inbox', updatedAt: 100 }];

    const appActive = buildRailTree(summaries, { activeId: 'app1' });
    assert.equal(appActive.find((r) => r.id === 'app1').active, true);
    assert.equal(appActive.find((r) => r.role === 'overview').active, false);

    const homeActive = buildRailTree(summaries, { activeId: null });
    assert.equal(homeActive.find((r) => r.role === 'overview').active, true);
    assert.equal(homeActive.find((r) => r.id === 'app1').active, false);
  });

  it('apps + plain conversations order by updatedAt desc between the pins', () => {
    const rows = buildRailTree([
      { id: 'old', title: 'Old', kind: 'agent', updatedAt: 10 },
      { id: 'new', title: 'New', kind: 'agent', appId: 'x', updatedAt: 99 },
    ]);
    // drop the Overview pin (first) and the trailing fixtures (Admin desk + New-app, v2.74.1582); the middle is recency-ordered
    const middle = rows.slice(1, -2).map((r) => r.id);
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
