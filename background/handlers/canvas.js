// background/handlers/canvas.js — the canvas domain (DESIGN_canvas.md §3). CA-4 + CA-9.
//
// RENDER_CANVAS (CA-4): persist a given spec + open/focus the app's canvas tab.
// COMPOSE_CANVAS (CA-9): have the app AUTHOR a fresh spec from an ask (the injected composeCanvas = the LLM), then
//   render it through the same path. The closed-vocabulary normalize (CanvasStore → canvasSpec.normalizeCanvasSpec)
//   is the single safety CHOKE POINT — an unknown/unsafe block from the model is DROPPED there.
// The open tab re-renders itself off chrome.storage.onChanged — the write IS the broadcast. NOT a page-driving
// channel → never busy-marked (Invariant #2 N/A).

import { writeCanvasSpec } from '../../Services/Storage/CanvasStore.js';
import { canvasDocId } from '../../Core/canvasSpec.js';
import { builtinApp } from '../../Core/appCatalog.js';
import { describeObjectModel } from '../../Core/appDef.js';

const CANVAS_PAGE = 'canvas.html';

// Open or focus THE canvas tab for an anchor — one tab per (appId, conversationId), carried in the hash. tabs.query
// ignores the fragment, so we query all canvas.html tabs and match on the hash. Mirrors chat.js's btn-open-studio.
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

export function createCanvasHandlers({ log, composeCanvas } = {}) {
  const note = (line) => { try { if (typeof log === 'function') log(line); } catch { /* never let a log break a render */ } };

  // Shared render: normalize+persist the spec (CanvasStore stamps rev) then open/focus the tab. Returns the response.
  async function _render(anchor, spec, op, focus) {
    const docId = canvasDocId(anchor);
    if (!docId) return { success: false, error: 'canvas-no-anchor' };
    const stored = await writeCanvasSpec(anchor, spec);
    const tabId = (focus !== false) ? await _openCanvasTab(anchor) : null;   // a cadence refresh may pass focus:false
    note(`CANVAS ▸ ${op} → ${docId} (rev ${stored ? stored.rev : '?'}, ${stored ? stored.blocks.length : 0} blocks)`);
    return { success: true, op, docId, rev: stored ? stored.rev : null, tabId };
  }

  return {
    'RENDER_CANVAS': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const p = (payload && typeof payload === 'object') ? payload : {};
          const anchor = (p.anchor && typeof p.anchor === 'object') ? p.anchor : {};
          sendResponse(await _render(anchor, p.spec, String(p.op || 'display'), p.focus));
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'render-canvas-failed' }); }
      })();
      return true;
    },

    'COMPOSE_CANVAS': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          if (typeof composeCanvas !== 'function') { sendResponse({ success: false, error: 'no-compose' }); return; }
          const p = (payload && typeof payload === 'object') ? payload : {};
          const anchor = (p.anchor && typeof p.anchor === 'object') ? p.anchor : {};
          if (!canvasDocId(anchor)) { sendResponse({ success: false, error: 'canvas-no-anchor' }); return; }
          let objects = ''; try { objects = describeObjectModel(builtinApp(p.appId)?.objectModel || null); } catch { objects = ''; }
          const spec = await composeCanvas({ ask: String(p.ask || ''), seed: String(p.seed || ''), objects, learned: String(p.learned || '') });
          if (!spec) { sendResponse({ success: false, error: 'compose-empty' }); return; }   // no LLM / unparseable / empty
          sendResponse(await _render(anchor, spec, 'compose', p.focus));
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'compose-canvas-failed' }); }
      })();
      return true;
    },
  };
}
