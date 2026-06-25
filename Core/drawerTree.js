// Core/drawerTree.js — CV-3c (v2.74.1168): the pure drawer-accordion model.
//
// DESIGN_conversations.md §7: the drawer is ONE flush-left accordion (no indentation) — Overview pinned at the
// root, apps under it, an app's sub-tasks under it (when expanded), then a "New app" entry. This module turns a
// flat `ConversationStore.list()` summary array into the ORDERED row model the renderer walks. PURE — no DOM, no
// storage; the live `_renderHistoryList` builds DOM from these rows (chevron / glyph / weight / box convey the
// hierarchy WITHOUT indenting — depth is informational, not a left-pad).
//
// Identity (the store coerces kind:'app' → 'agent', §5): an APP = a conversation with `appId` and no `parentId`;
// a SUB-TASK = any conversation with `parentId` (a leaf, §5 one-level cap); everything else is a PLAIN row (a free
// chat or — in dev mode — a dev conversation, which keeps its own badge/preview in the renderer). An orphan
// sub-task (its parent isn't present) renders PLAIN so it's never lost.

import { OVERVIEW_ID } from './appDef.js';

const byUpdatedDesc = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
// AP-1 (v2.74.1211) — PINNED conversations sort to the top (a configured app pins itself on setup-complete), then recency.
const byPinnedThenUpdated = (a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || byUpdatedDesc(a, b);
const isApp = (c) => !!c.appId && !c.parentId;
const isSub = (c) => !!c.parentId;

/**
 * @typedef {Object} DrawerRow
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
 * @returns {DrawerRow[]}
 */
export function buildDrawerTree(summaries, { devMode = false, activeId = null, expanded = null } = {}) {
  const list = (Array.isArray(summaries) ? summaries : []).filter(Boolean);
  const expandedSet = expanded instanceof Set ? expanded : new Set(Array.isArray(expanded) ? expanded : []);

  // Dev filter — mirror _renderHistoryList: dev mode off → hide dev conversations entirely (§2 precedent).
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
  const top = visible.filter((c) => !isSub(c) || !appIds.has(c.parentId)).sort(byPinnedThenUpdated);

  const rows = [];

  // 1) Overview — pinned first, reserved (cannot be created/deleted, §2). Active when nothing else is (home state).
  // v2.74.1219 — the Overview has no thread of its own, so its "quick peek" = the LAST ACTIVE conversation (the most-
  // recently-updated, any kind) — a "pick up where you left off" hint under the home row.
  // v2.74.1227 — ATTRIBUTE it to its source ("<title> · <last reply>") so it reads as a pointer to that conversation,
  // not a bare verbatim echo of the most-recent app's message (which already shows on that app's own row below).
  const lastActive = [...visible].sort(byUpdatedDesc)[0] || null;
  const overviewPeek = (lastActive && lastActive.summary)
    ? (lastActive.title ? `${lastActive.title} · ${lastActive.summary}` : lastActive.summary)
    : null;
  rows.push({
    id: OVERVIEW_ID, role: 'overview', title: 'Overview', icon: 'home', depth: 0,
    hasChildren: false, expanded: false, active: activeId == null || activeId === OVERVIEW_ID,
    count: 0, kind: 'agent',
    summary: overviewPeek,
  });

  // 2) Apps + plain conversations, by recency. An expanded app is immediately followed by its sub-task rows.
  for (const c of top) {
    if (isApp(c)) {
      const subs = subsByParent.get(c.id) || [];
      const open = expandedSet.has(c.id);
      rows.push({
        id: c.id, role: 'app', title: c.title, icon: c.icon || null, depth: 0,
        hasChildren: subs.length > 0, expanded: open, active: activeId === c.id,
        count: subs.length, kind: c.kind || 'agent', appId: c.appId, pinned: !!c.pinned,   // AP-1 — drives the pin toggle's state
        summary: c.summary || null,   // v2.74.1217 — the under-the-name "quick peek" (index-mirrored; rendered ≤3 lines)
      });
      if (open) {
        for (const s of subs) {
          rows.push({
            id: s.id, role: 'subtask', title: s.title, icon: s.icon || null, depth: 1,
            hasChildren: false, expanded: false, active: activeId === s.id, count: 0,
            kind: s.kind || 'agent', parentId: c.id, appId: c.appId,
          });
        }
      }
    } else {
      rows.push({
        id: c.id, role: 'plain', title: c.title, icon: c.icon || null, depth: 0,
        hasChildren: false, expanded: false, active: activeId === c.id, count: 0,
        kind: c.kind || 'agent', surface: c.surface || null, status: c.status || null, pinned: !!c.pinned,
      });
    }
  }

  // 3) New app — always last.
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
