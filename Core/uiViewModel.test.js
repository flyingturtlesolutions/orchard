// Core/uiViewModel.test.js — UI-VERIFICATION L1 (v2.74.1949): the pure logical snapshot + its invariants.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { uiViewModel } from './uiViewModel.js';
import { checkUiInvariants, noFreeText } from './uiInvariants.js';
import { ADMIN_ID } from './appDef.js';

// A realistic persisted rail: one app with a workflow + a sub-task, plus a free chat — titles/summaries carry the
// free text the view-model MUST strip.
const SUMMARIES = () => [
  { id: 'app1', title: 'Support — Acme', kind: 'agent', appId: 'support', instanceId: 'inst1', updatedAt: 100, summary: '2 open tickets for Jane Doe' },
  { id: 't1', title: 'Ticket #4889 — broken switch', kind: 'agent', parentId: 'app1', updatedAt: 90, summary: 'awaiting vendor' },
  { id: 'c1', title: 'Free chat about billing', kind: 'agent', updatedAt: 50 },
];
const WFS = () => new Map([['app1', [{ id: 'w1', name: 'daily sweep', ask: 'get open tickets' }]]]);

describe('uiViewModel — the pure, PII-safe snapshot', () => {
  it('projects the rail to ids/enums/counts/flags and STRIPS every title + summary', () => {
    const vm = uiViewModel({ summaries: SUMMARIES(), activeId: 'app1', workflowsByConv: WFS(), pane: 'thread', railTab: 'automations' });
    const blob = JSON.stringify(vm);
    assert.doesNotMatch(blob, /Acme|Jane Doe|broken switch|billing|awaiting vendor|daily sweep/, 'no free text leaks into the view-model');
    const app = vm.rail.rows.find((r) => r.id === 'app1');
    assert.equal(app.role, 'app');
    assert.equal(app.active, true);
    assert.equal(vm.rail.tab, 'automations');
    assert.equal(vm.pane, 'thread');
    // dead-code pass 2026-08-07 — the accordion emits NO workflow rows (they live in the Automations tab);
    // a legacy workflowsByConv arg is ignored, so no workflow name can leak by construction.
    assert.equal(vm.rail.rows.some((r) => r.role === 'workflow'), false);
  });

  it('thread carries only convId + a message COUNT, never bodies', () => {
    const vm = uiViewModel({ summaries: SUMMARIES(), activeId: 'app1', activeConv: { messages: [{ role: 'user', body: 'secret PII here' }, { role: 'assistant', body: 'more PII' }] } });
    assert.equal(vm.thread.convId, 'app1');
    assert.equal(vm.thread.msgCount, 2);
    assert.doesNotMatch(JSON.stringify(vm), /secret PII|more PII/);
  });
});

describe('uiInvariants — the checklist HOLDS on a correct panel', () => {
  it('a normal view-model passes every invariant', () => {
    const vm = uiViewModel({ summaries: SUMMARIES(), activeId: 'app1', workflowsByConv: WFS(), pane: 'thread', railTab: 'conversations' });
    assert.deepEqual(checkUiInvariants(vm), []);
    assert.deepEqual(noFreeText(vm), []);
  });

  it('CN-2 — nothing selected (activeId null) is the launch-page home: NO active row, and a VALID state', () => {
    const vm = uiViewModel({ summaries: SUMMARIES(), activeId: null, pane: 'thread' });
    assert.deepEqual(checkUiInvariants(vm), [], 'the home state passes every invariant');
    assert.equal(vm.rail.rows.some((r) => r.active), false, 'launch page home → no active row');
    assert.equal(vm.thread.convId, null);
  });
});

describe('uiInvariants — the checklist FIRES on each real bug class', () => {
  const base = () => uiViewModel({ summaries: SUMMARIES(), activeId: 'app1', workflowsByConv: WFS(), pane: 'thread', railTab: 'conversations' });

  it('dangling active pointer → zero active rows → active-not-one', () => {
    const vm = uiViewModel({ summaries: SUMMARIES(), activeId: 'deleted-xyz', pane: 'thread' });
    assert.ok(checkUiInvariants(vm).some((f) => f.code === 'active-not-one'), 'a deleted active conversation leaves nothing highlighted');
  });

  it('two rail sections pinned-open → pinned-gt-one (the "only one pinned" rule)', () => {
    // CN-2 — the Admin fixture is gone, so use two APP rows to create the >1 pinned condition.
    const vm = uiViewModel({ summaries: [
      { id: 'app1', title: 'A', kind: 'agent', appId: 'a', updatedAt: 100 },
      { id: 'app2', title: 'B', kind: 'agent', appId: 'b', updatedAt: 90 },
    ], activeId: 'app1', pane: 'thread', railTab: 'conversations' });
    vm.rail.rows.filter((r) => r.role === 'app').forEach((r) => { r.expanded = true; });
    assert.ok(checkUiInvariants(vm).some((f) => f.code === 'pinned-gt-one'));
  });

  it('a subtask under a missing desk → orphan-child (the cross-desk leak; workflow rows died with the accordion section)', () => {
    const vm = base();
    const sub = vm.rail.rows.find((r) => r.role === 'subtask');
    sub.parentId = 'ghost-desk';
    assert.ok(checkUiInvariants(vm).some((f) => f.code === 'orphan-child'));
  });

  it('an unknown pane / rail tab → bad-pane / bad-tab', () => {
    const vm = base();
    vm.pane = 'sidebar'; vm.rail.tab = 'workflows';
    const codes = checkUiInvariants(vm).map((f) => f.code);
    assert.ok(codes.includes('bad-pane') && codes.includes('bad-tab'));
  });

  it('New-app must be last', () => {
    const vm = base();
    vm.rail.rows.push(vm.rail.rows.splice(vm.rail.rows.findIndex((r) => r.role === 'new-app'), 1)[0]);   // move it, then break order
    vm.rail.rows.push({ id: 'stray', role: 'plain', active: false, pinned: false, expanded: false, hasChildren: false, depth: 0, count: 0, wfCount: 0, kind: 'agent' });
    assert.ok(checkUiInvariants(vm).some((f) => f.code === 'newapp-not-last'));
  });
});

describe('noFreeText — the executable PII boundary', () => {
  it('a leaked title fails the boundary (path-pinpointed)', () => {
    const vm = uiViewModel({ summaries: SUMMARIES(), activeId: 'app1' });
    vm.rail.rows[0].title = 'Support — Acme';   // simulate a regression that re-adds free text
    const bad = noFreeText(vm);
    assert.equal(bad.length, 1);
    assert.match(bad[0].path, /rail\.rows\[0\]\.title/);
    assert.equal(bad[0].value, 'Support — Acme');
  });
  it('ids with the app\'s real punctuation (: _ . -) are NOT flagged', () => {
    assert.deepEqual(noFreeText({ a: 'wf:w1', b: 'admin_desk', c: 'conv-12.3' }), []);
  });
});

describe('cross-reload equality — the view-model is a pure projection of PERSISTED state', () => {
  it('re-deriving from storage (a serialize round-trip) reproduces the view-model EXACTLY', () => {
    const summaries = SUMMARIES();
    const opts = { activeId: 'app1', workflowsByConv: WFS(), pane: 'thread', railTab: 'automations' };
    const before = uiViewModel({ summaries, ...opts });
    // "reload" = what the panel does on reopen: read summaries back from chrome.storage (JSON round-trip) and re-derive.
    const reloaded = JSON.parse(JSON.stringify(summaries));
    const wfReloaded = new Map(JSON.parse(JSON.stringify([...WFS()])));
    const after = uiViewModel({ summaries: reloaded, ...opts, workflowsByConv: wfReloaded });
    assert.deepEqual(after, before, 'cross-reload survival is now a headless assertion');
  });
});
