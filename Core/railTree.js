// Core/railTree.js — CV-3c (v2.74.1168): the pure rail-accordion model.
//
// DESIGN_conversations.md §7: the rail is ONE flush-left accordion (no indentation) — Overview pinned at the
// root, apps under it, an app's sub-tasks under it (when expanded), then a "New app" entry. This module turns a
// flat `ConversationStore.list()` summary array into the ORDERED row model the renderer walks. PURE — no DOM, no
// storage; the live `_renderRailList` builds DOM from these rows (chevron / glyph / weight / box convey the
// hierarchy WITHOUT indenting — depth is informational, not a left-pad).
//
// Identity (the store coerces kind:'app' → 'agent', §5): an APP = a conversation with `appId` and no `parentId`;
// a SUB-TASK = any conversation with `parentId` (a leaf, §5 one-level cap); everything else is a PLAIN row (a free
// chat or — in dev mode — a dev conversation, which keeps its own badge/preview in the renderer). An orphan
// sub-task (its parent isn't present) renders PLAIN so it's never lost.

import { OVERVIEW_ID, ADMIN_ID } from './appDef.js';

const byUpdatedDesc = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
// AP-1 (v2.74.1211) — PINNED conversations sort to the top (a configured app pins itself on setup-complete), then recency.
const byPinnedThenUpdated = (a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || byUpdatedDesc(a, b);
const isApp = (c) => !!c.appId && !c.parentId;
const isSub = (c) => !!c.parentId;

/**
 * @typedef {Object} RailRow
 * @property {string|null} id        conversation id (OVERVIEW_ID for the pin; null for the New-app entry)
 * @property {'overview'|'app'|'subtask'|'plain'|'new-app'} role
 * @property {string} title
 * @property {string|null} icon
 * @property {number} depth          0 for top-level / app / plain / overview; 1 for a sub-task (informational — NO indent)
 * @property {boolean} hasChildren   an app with ≥1 sub-task (renders a chevron)
 * @property {boolean} expanded
 * @property {boolean} active
 * @property {number} count          sub-task count (app rows; 0 otherwise)
 * @property {string|null} kind      'agent' | 'dev' (drives the plain-row badge/preview); null for new-app
 * @property {string} [appId]
 * @property {string} [parentId]
 * @property {string|null} [surface] dev altitude (plain dev rows)
 * @property {string|null} [status]  dev lifecycle (plain dev rows)
 */

/**
 * Build the ordered accordion row model. PURE.
 * @param {Array<Object>} summaries  ConversationStore.list() summaries ({id,title,kind,updatedAt,appId?,parentId?,icon?,…})
 * @param {{ devMode?:boolean, activeId?:string|null, expanded?:Set<string>|Array<string>|null }} [opts]
 * @returns {RailRow[]}
 */
export function buildRailTree(summaries, { devMode = false, activeId = null, expanded = null, workflowsByConv = null } = {}) {
  const list = (Array.isArray(summaries) ? summaries : []).filter(Boolean);
  const expandedSet = expanded instanceof Set ? expanded : new Set(Array.isArray(expanded) ? expanded : []);
  // v2.74.1777 ("one class") — workflows are desk CHILDREN like cases: the intensional record (chat history
  // condensed to its replayable skeleton) beside the extensional one (the case). workflowsByConv: Map convId →
  // saved-workflow records; each becomes a role:'workflow' row right after its desk row (mirroring the icon
  // order — workflows section above cases).
  const wfMap = workflowsByConv instanceof Map ? workflowsByConv : new Map();

  // Dev filter — mirror _renderRailList: dev mode off → hide dev conversations entirely (§2 precedent).
  const visible = devMode ? list : list.filter((c) => c.kind !== 'dev');

  // Sub-tasks grouped by parent (newest first within a group).
  const subsByParent = new Map();
  for (const c of visible) {
    if (!isSub(c)) continue;
    const arr = subsByParent.get(c.parentId) || [];
    arr.push(c);
    subsByParent.set(c.parentId, arr);
  }
  for (const arr of subsByParent.values()) arr.sort(byUpdatedDesc);

  const appIds = new Set(visible.filter(isApp).map((c) => c.id));
  // Top level = everything that isn't a sub-task of a PRESENT app (orphans fall through to plain → never lost).
  // v2.74.1234 — the Overview is a real persistent conversation now, but it's rendered as the reserved pin (below),
  // so exclude it from the regular rows or it'd appear twice (pin + a plain row). VT-2b (v2.74.1587) — the Admin
  // desk's children (incident CASES) attach under the fixture below, never as plain rows.
  const top = visible.filter((c) => c.id !== OVERVIEW_ID && c.id !== ADMIN_ID
    && (!isSub(c) || (!appIds.has(c.parentId) && c.parentId !== ADMIN_ID))).sort(byPinnedThenUpdated);

  const rows = [];

  // 1) Overview — pinned first, reserved (cannot be created/deleted, §2). Active when nothing else is (home state).
  // v2.74.1234 — the Overview is a REAL persistent general-assistant conversation, so its peek = ITS OWN last message
  // (from its index entry's summary), not an echo of another app. Null until it has activity.
  const overviewConv = visible.find((c) => c.id === OVERVIEW_ID) || null;
  rows.push({
    id: OVERVIEW_ID, role: 'overview', title: 'Front desk', icon: 'home', depth: 0,   // Front-desk adopt (v2.74.1507) — the display noun; OVERVIEW_ID + role token stay internal
    hasChildren: false, expanded: false, active: activeId == null || activeId === OVERVIEW_ID,
    count: 0, kind: 'agent',
    summary: (overviewConv && overviewConv.summary) ? overviewConv.summary : null,
  });

  // 2) Apps + plain conversations, by recency. An expanded app is immediately followed by its sub-task rows.
  for (const c of top) {
    if (isApp(c)) {
      const subs = subsByParent.get(c.id) || [];
      const wfs = wfMap.get(c.id) || [];
      const open = expandedSet.has(c.id);
      rows.push({
        id: c.id, role: 'app', title: c.title, icon: c.icon || null, depth: 0,
        hasChildren: subs.length > 0, expanded: open, active: activeId === c.id,
        count: subs.length, kind: c.kind || 'agent', appId: c.appId, pinned: !!c.pinned,   // AP-1 — drives the pin toggle's state
        wfCount: wfs.length,   // v2.74.1777 — drives the mirrored workflows button (icon + count, peek/pin)
        summary: c.summary || null,   // v2.74.1217 — the under-the-name "quick peek" (index-mirrored; rendered ≤3 lines)
      });
      // v2.74.1777 — workflow rows FIRST (the icons read workflows · cases left-to-right; the sections stack the
      // same way), then the case rows. Both always emit — hiding is the renderer's class, never a rebuild.
      for (const w of wfs) {
        rows.push({
          id: `wf:${w.id}`, role: 'workflow', title: w.name || w.ask || '', icon: null, depth: 1,
          hasChildren: false, expanded: false, active: false, count: 0,
          kind: 'agent', parentId: c.id, appId: c.appId, wf: w, wfKey: c.instanceId || null,
        });
      }
      // Rail peek/pin (v2.74.1774, DESIGN_panel_surfaces.md §8) — sub-task rows ALWAYS emit: the renderer
      // groups them under their app and hides them with a class, so a hover-peek never rebuilds the DOM
      // (a hover-driven re-render would destroy the node under the pointer — an instant open/close flicker
      // loop). `expanded` now means PINNED-open, not emitted-vs-not.
      for (const s of subs) {
        rows.push({
          id: s.id, role: 'subtask', title: s.title, icon: s.icon || null, depth: 1,
          hasChildren: false, expanded: false, active: activeId === s.id, count: 0,
          kind: s.kind || 'agent', parentId: c.id, appId: c.appId,
          summary: s.summary || null,   // CV-4-map — a sub-task's peek (its latest result / "⏳ Working…") so the parent's auto-run is visible per child
        });
      }
    } else {
      rows.push({
        id: c.id, role: 'plain', title: c.title, icon: c.icon || null, depth: 0,
        hasChildren: false, expanded: false, active: activeId === c.id, count: 0,
        kind: c.kind || 'agent', surface: c.surface || null, status: c.status || null, pinned: !!c.pinned,
      });
    }
  }

  // 3) Admin desk — the reserved vitals fixture (VT-2, DESIGN_vitals.md §8): PERMANENT in the Rail whether or
  // not its conversation exists yet (the click get-or-creates it; "silence when green" governs its CONTENT,
  // never its presence). v2.74.1582 — pinned as the LAST conversation (user directive: bottom of the rail —
  // the operator console sits under the work, not above it), just above the New-app constructor entry.
  // Excluded from the regular rows above so it never renders twice.
  const adminConv = visible.find((c) => c.id === ADMIN_ID) || null;
  // VT-2b (v2.74.1587) — incident CASES (children of the Admin desk) ride under the fixture. v2.74.1589 —
  // APP-ROW PARITY (user directive): the fixture collapses/expands its cases via the SAME expanded-set the app
  // rows use (chevron + count); silence-when-green = no children at all.
  const adminSubs = subsByParent.get(ADMIN_ID) || [];
  const adminOpen = expandedSet.has(ADMIN_ID);
  rows.push({
    id: ADMIN_ID, role: 'admin', title: 'Admin desk', icon: 'vitals', depth: 0,
    hasChildren: adminSubs.length > 0, expanded: adminOpen, active: activeId === ADMIN_ID,
    count: adminSubs.length, kind: 'agent',
    summary: (adminConv && adminConv.summary) ? adminConv.summary : null,
  });
  // v2.74.1774 — same always-emit rule as app sub-tasks (`adminOpen` above = pinned).
  for (const s of adminSubs) {
    rows.push({
      id: s.id, role: 'subtask', title: s.title, icon: s.icon || null, depth: 1,
      hasChildren: false, expanded: false, active: activeId === s.id, count: 0,
      kind: s.kind || 'agent', parentId: ADMIN_ID,
      summary: s.summary || null,
    });
  }

  // 4) New app — always last.
  rows.push({
    id: null, role: 'new-app', title: 'New app', icon: 'plus', depth: 0,
    hasChildren: false, expanded: false, active: false, count: 0, kind: null,
  });

  return rows;
}

/**
 * The sub-tasks of an app — its children by `parentId`, newest first. PURE. (CV-4, §6/§10) Feeds the **bounded
 * across** read: an app may reason over ITS OWN sub-tasks (never global), and the live spawn uses it for the count.
 * `appConvId` is the app's CONVERSATION id (what a sub-task's `parentId` points at).
 */
export function subTasksOf(summaries, appConvId) {
  const id = appConvId == null ? '' : String(appConvId);
  if (!id) return [];
  return (Array.isArray(summaries) ? summaries : [])
    .filter((c) => c && String(c.parentId || '') === id)
    .sort(byUpdatedDesc);
}
