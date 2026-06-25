// background/handlers/canvas.js — the canvas domain (DESIGN_canvas.md §3). CA-4.
//
// RENDER_CANVAS: the executor behind the DISPLAY/COMPOSE legs AND the panel's `canvas` command. It (1) persists the
// model-/app-authored spec per anchor via CanvasStore (which re-pins the anchor + stamps a monotonic rev, and runs
// the closed-vocabulary normalize — Core/canvasSpec), then (2) opens/focuses the app's canvas TAB. The open tab
// re-renders itself off chrome.storage.onChanged — the storage write IS the broadcast, so there's no custom fan-out.
// NOT a page-driving channel (it writes a store + paints an extension tab) → never busy-marked (Invariant #2 N/A).

import { writeCanvasSpec } from '../../Services/Storage/CanvasStore.js';
import { canvasDocId } from '../../Core/canvasSpec.js';

const CANVAS_PAGE = 'canvas.html';

// Open or focus THE canvas tab for an anchor — one tab per (appId, conversationId), carried in the hash. tabs.query
// ignores the fragment, so we query all canvas.html tabs and match on the hash. Mirrors chat.js's btn-open-studio
// focus-or-create. Returns the tabId or null.
async function _openCanvasTab(anchor) {
  const appId = (anchor && anchor.appId) ? String(anchor.appId) : '';
  const convId = (anchor && anchor.conversationId) ? String(anchor.conversationId) : '';
  const tag = `app=${encodeURIComponent(appId)}&conv=${encodeURIComponent(convId)}`;
  const url = `${chrome.runtime.getURL(CANVAS_PAGE)}#${tag}`;
  try {
    const tabs = await chrome.tabs.query({ url: `${chrome.runtime.getURL(CANVAS_PAGE)}*` });
    const mine = (tabs || []).find((t) => t && typeof t.url === 'string' && t.url.includes(tag));
    if (mine && mine.id != null) {
      await chrome.tabs.update(mine.id, { active: true });
      if (mine.windowId != null) { try { await chrome.windows.update(mine.windowId, { focused: true }); } catch { /* */ } }
      return mine.id;
    }
    const t = await chrome.tabs.create({ url, active: true });
    return (t && typeof t.id === 'number') ? t.id : null;
  } catch { return null; }
}

export function createCanvasHandlers({ log } = {}) {
  const note = (line) => { try { if (typeof log === 'function') log(line); } catch { /* never let a log break a render */ } };
  return {
    'RENDER_CANVAS': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const p = (payload && typeof payload === 'object') ? payload : {};
          const anchor = (p.anchor && typeof p.anchor === 'object') ? p.anchor : {};
          const docId = canvasDocId(anchor);
          if (!docId) { sendResponse({ success: false, error: 'canvas-no-anchor' }); return; }
          const stored = await writeCanvasSpec(anchor, p.spec);   // normalize (closed vocab) + pin anchor + stamp rev; the open tab repaints off storage.onChanged
          const focus = p.focus !== false;                        // a cadence refresh may pass focus:false to update silently
          const tabId = focus ? await _openCanvasTab(anchor) : null;
          note(`CANVAS ▸ ${String(p.op || 'display')} → ${docId} (rev ${stored ? stored.rev : '?'}, ${stored ? stored.blocks.length : 0} blocks)`);
          sendResponse({ success: true, op: String(p.op || 'display'), docId, rev: stored ? stored.rev : null, tabId });
        } catch (e) {
          sendResponse({ success: false, error: (e && e.message) || 'render-canvas-failed' });
        }
      })();
      return true;   // async — keep the sendResponse channel open
    },
  };
}
