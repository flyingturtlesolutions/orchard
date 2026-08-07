// Core/uiViewModel.js — UI-VERIFICATION L1 (v2.74.1949): the pure, PII-safe LOGICAL snapshot of the panel.
//
// This is the "checklist" layer of DESIGN_ui_stream.md's reshaped verification harness: a snapshot of WHAT is shown
// and WHERE, derived purely from persisted state (ConversationStore summaries + the rail model + a few pane/tab
// facts), so the harness can ASSERT panel correctness headless — the thing that has always needed a live eyeball.
//
// BOUNDARY (three things at once — the reason this file is small and strict):
//   • PURITY — a pure function of PERSISTED state. No DOM, no chrome, no clock. DOM-only state (scroll, focus, open
//     cards, overlays, animation, computed layout) is DELIBERATELY OUT — that is L1.5 (jsdom render) / L2 (headless
//     render), never here. Claiming otherwise is the contradiction the design review caught.
//   • PII — the view-model carries ONLY generated ids, enum values, ints, and bools. NEVER a title, summary, body, or
//     label. `buildRailTree` rows carry `title`/`summary` (free text); `projectRow` strips them. `noFreeText` (in
//     uiInvariants.js) is the executable guarantee, so the boundary can't silently rot as the schema grows.
//   • COMPLETENESS — what is EXCLUDED (cards, overlays, scroll) is exactly what a reconstruction can't restore; the
//     schema below is the frozen contract of what L1 does and does not know.
//
// PURE.

import { buildRailTree } from './railTree.js';

/** The frozen enums the view-model is allowed to name. Exported so uiInvariants.js validates against the same source. */
export const PANES = Object.freeze(new Set(['rail', 'thread', 'canvas']));
export const RAIL_TABS = Object.freeze(new Set(['conversations', 'automations', 'connect']));   // CN-1 — the Connect tab (login/connection status)
export const RAIL_ROLES = Object.freeze(new Set(['app', 'subtask', 'plain', 'new-app']));   // dead-code pass 2026-08-07 — workflow/admin/overview roles died with their fixtures

/**
 * Project a `buildRailTree` row → the PII-safe view-model row. PURE.
 * Drops `title` / `summary` / `icon` (free text or presentation); keeps ids, enums, counts, and flags.
 * `pinned` (AP-1 configured-app sort pin, may be >1) and `expanded` (the rail peek/pin-OPEN state, the "only one
 * card pinned" rule → ≤1) are kept SEPARATE — conflating them was a real ambiguity.
 */
function projectRow(r) {
  const out = {
    id: r.id == null ? null : String(r.id),
    role: r.role,
    active: !!r.active,
    pinned: !!r.pinned,        // configured-app sort pin (AP-1) — NOT limited to one
    expanded: !!r.expanded,    // rail pin-open (peek/pin) — the ≤1 rule lives here
    hasChildren: !!r.hasChildren,
    depth: r.depth | 0,
    count: r.count | 0,
    kind: r.kind == null ? null : String(r.kind),
  };
  if (r.appId != null) out.appId = String(r.appId);
  if (r.parentId != null) out.parentId = String(r.parentId);
  return out;
}

/**
 * Assemble the panel's logical view-model. PURE.
 * @param {{
 *   summaries?: Array<Object>,          // ConversationStore.list() — the persisted rail state
 *   activeId?: string|null,             // the selected conversation (null = the Admin home)
 *   expanded?: Set<string>|Array<string>|null,
 *   devMode?: boolean,
 *   pane?: 'rail'|'thread'|'canvas',    // the active pane (a live/module fact, passed in — never read here)
 *   railTab?: 'conversations'|'automations',
 *   activeConv?: {messages?: Array}|null // the loaded active conversation (for the msg count — bodies never read)
 * }} input
 * @returns {{ pane, rail:{tab, rows:Array}, thread:{convId, msgCount} }}
 */
export function uiViewModel({
  summaries = [], activeId = null, expanded = null, devMode = false,
  pane = 'thread', railTab = 'conversations', activeConv = null,
} = {}) {
  const rows = buildRailTree(summaries, { devMode, activeId, expanded }).map(projectRow);
  return {
    pane,                                    // passed through as-is; uiInvariants flags an unknown enum
    rail: { tab: railTab, rows },
    thread: {
      convId: activeId == null ? null : String(activeId),
      msgCount: (activeConv && Array.isArray(activeConv.messages)) ? activeConv.messages.length : 0,
    },
  };
}
