// Core/uiInvariants.js — UI-VERIFICATION L1 (v2.74.1949): the contracts a correct panel view-model must satisfy.
//
// These are the "checklist" — pure assertions over `uiViewModel` output, run in the npm harness (uiViewModel.test.js).
// A violation is a returned finding, and a red test. This is where panel correctness finally becomes HEADLESS: the
// class of bug that used to need a live eyeball ("is exactly one thing selected", "did a card leak across desks",
// "does the app's workflow count match what's shown") is now a deterministic check.
//
// SCOPE: L1 sees only the LOGICAL view-model (ids/enums/counts/flags). CSS/geometry (overflow, z-index, the WFT-1
// source-order bug) and timing (animation) are NOT visible here — those are L1.5 (jsdom real DOM) and L2 (headless
// render). This file must never pretend to check them.
//
// PURE.

import { PANES, RAIL_TABS } from './uiViewModel.js';

// An id/enum-shaped token: letters, digits, and the id punctuation the app actually uses (`:` `_` `.` `-`). NO spaces,
// so a free-text title ("My open tickets") or summary ("2 open incidents") FAILS — which is the whole point.
const ID_OR_ENUM = /^[A-Za-z0-9_:.\-]+$/;

/**
 * Check the structural/logical invariants of a panel view-model. PURE.
 * @param {object} vm  uiViewModel output
 * @returns {Array<{code:string, msg:string}>}  empty = all invariants hold
 */
export function checkUiInvariants(vm) {
  const v = [];
  const push = (code, msg) => v.push({ code, msg });
  const rows = (vm && vm.rail && Array.isArray(vm.rail.rows)) ? vm.rail.rows : [];

  // 1) ACTIVE-ROW RULE (CN-2, DESIGN_vitals.md §8.4). Home is now the LAUNCH PAGE, not the Admin fixture. When NO
  //    conversation is selected (thread.convId == null) zero rail rows are active — that is the home state, not a bug.
  //    When a conversation IS selected, exactly one row is active: zero = a dangling active pointer (a deleted/missing
  //    conversation left nothing highlighted), >1 = a double-select — both real, previously eyeball-only, bugs.
  const active = rows.filter((r) => r.active);
  const hasSelection = !!(vm && vm.thread && vm.thread.convId != null);
  if (hasSelection) {
    if (active.length !== 1) push('active-not-one', `a conversation is selected but ${active.length} rows are active`);
  } else if (active.length !== 0) {
    push('active-when-home', `nothing is selected (launch-page home) but ${active.length} rows are active`);
  }

  // 2) AT MOST ONE rail section pinned-open (`expanded`). The "only a single card can be pinned" rule (user directive):
  //    a second pin must unpin the first. >1 expanded = the rule regressed.
  const pinnedOpen = rows.filter((r) => r.expanded);
  if (pinnedOpen.length > 1) push('pinned-gt-one', `more than one rail section pinned-open: ${pinnedOpen.length}`);

  // 3) NO ORPHAN CHILD. Every subtask row's parent must be a present app row — a child under a missing desk is
  //    the cross-desk leak class (buildRailTree renders true orphans as `plain`, so a `subtask` role with a
  //    dangling parentId is a genuine invariant breach). (dead-code pass 2026-08-07: the `workflow` role and
  //    its wfCount rule died with the accordion's workflow section — workflows render in the Automations tab.)
  const parents = new Set(rows.filter((r) => r.role === 'app').map((r) => r.id));
  for (const r of rows) {
    if (r.role === 'subtask' && r.parentId != null && !parents.has(r.parentId)) {
      push('orphan-child', `${r.role} ${r.id} has no present parent ${r.parentId}`);
    }
  }

  // 5) THE FIXTURES (CN-2, DESIGN_vitals.md §8.4): the Admin fixture is REMOVED (home is the launch page). Exactly
  //    one New-app entry, and it is LAST.
  const newApps = rows.filter((r) => r.role === 'new-app');
  if (newApps.length !== 1) push('newapp-not-one', 'expected exactly one new-app entry');
  else if (rows.length && rows[rows.length - 1].role !== 'new-app') push('newapp-not-last', 'new-app must be the last row');

  // 6) KNOWN ENUMS for pane + rail tab.
  if (!PANES.has(vm && vm.pane)) push('bad-pane', `unknown pane ${vm && vm.pane}`);
  if (!RAIL_TABS.has(vm && vm.rail && vm.rail.tab)) push('bad-tab', `unknown rail tab ${vm && vm.rail && vm.rail.tab}`);

  return v;
}

/**
 * THE PII BOUNDARY, as an executable invariant. PURE. Walks the whole view-model; every string must be id/enum-shaped
 * (no free text). A leaked title/summary/label — the thing that must never reach the fleet mailbox — FAILS here.
 * @returns {Array<{path:string, value:string}>}  empty = clean
 */
export function noFreeText(vm) {
  const bad = [];
  const walk = (node, path) => {
    if (typeof node === 'string') { if (!ID_OR_ENUM.test(node)) bad.push({ path, value: node }); return; }
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (node && typeof node === 'object') { for (const [k, val] of Object.entries(node)) walk(val, path ? `${path}.${k}` : k); }
  };
  walk(vm, '');
  return bad;
}
