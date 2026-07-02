// background/handlers/canvas.js — the canvas domain (DESIGN_canvas.md §3). CA-4 + CA-9.
//
// RENDER_CANVAS (CA-4): persist a given spec + open/focus the app's canvas tab.
// COMPOSE_CANVAS (CA-9): have the app AUTHOR a fresh spec from an ask (the injected composeCanvas = the LLM), then
//   render it through the same path. The closed-vocabulary normalize (CanvasStore → canvasSpec.normalizeCanvasSpec)
//   is the single safety CHOKE POINT — an unknown/unsafe block from the model is DROPPED there.
// The open tab re-renders itself off chrome.storage.onChanged — the write IS the broadcast. NOT a page-driving
// channel → never busy-marked (Invariant #2 N/A).

import { writeCanvasSpec, loadCanvasSpec } from '../../Services/Storage/CanvasStore.js';
import { canvasDocId, stripMintedMedia } from '../../Core/canvasSpec.js';   // GD-7e — refs-not-URLs: strip LLM-minted media srcs where model output enters
import { builtinApp } from '../../Core/appCatalog.js';
import { describeObjectModel } from '../../Core/appDef.js';
import { specToDocsRequests } from '../../Core/canvasLower.js';   // GD-3 (§8) — the pure spec→batchUpdate lowering (the gdoc backend's paint)

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

// GD-4c (v2.74.1325) — open or FOCUS the app's Google Doc (the §8 external surface). Live lesson (.1324): painting
// a Doc nobody has open reads as "nothing happened" — the design's no-tab rule meant "no extension CANVAS tab",
// never "no surface". First compose opens the Doc; later composes focus it (the open Doc live-updates from the
// API batchUpdate on its own — the realtime property). focus:false = a silent background repaint: focus nothing,
// never open a new tab.
const _DOC_URL = (documentId) => `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/edit`;
async function _openDocTab(documentId, focus) {
  try {
    const tabs = await chrome.tabs.query({ url: `https://docs.google.com/document/d/${documentId}/*` });
    const mine = (tabs || []).find((t) => t && t.id != null);
    if (mine) {
      if (focus !== false) {
        await chrome.tabs.update(mine.id, { active: true });
        if (mine.windowId != null) { try { await chrome.windows.update(mine.windowId, { focused: true }); } catch { /* */ } }
      }
      return mine.id;
    }
    if (focus === false) return null;
    const t = await chrome.tabs.create({ url: _DOC_URL(documentId), active: true });
    return (t && typeof t.id === 'number') ? t.id : null;
  } catch { return null; }
}

export function createCanvasHandlers({ log, composeCanvas, cloudInvokeConnector } = {}) {
  const note = (line) => { try { if (typeof log === 'function') log(line); } catch { /* never let a log break a render */ } };

  // GD-3 (DESIGN_canvas.md §8) — the EXTERNAL gdoc backend: paint the spec into the app's own Google Doc via the
  // broker's REST channel. The doc is app-created under drive.file (the §8.1 ownership boundary — the token cannot
  // touch any other file), display-only by contract, and repainted replace-body from the SPEC (the single source of
  // truth — never read back). `confirmed:true` here is the §8.1-auto design decision: a render to the app's OWN
  // presentation doc is app plumbing (like a tab paint), NOT a model-driven write — the wire belt still gets its
  // explicit flag, and interpret-selected docs writes keep the normal HITL bar. Create-once per anchor; a vanished
  // doc (deleted by the user) recreates once.
  const _GDOC_KEY = (docId) => `canvas:gdocId:${docId}`;
  async function _renderGdoc(anchor, stored, docId) {
    if (typeof cloudInvokeConnector !== 'function') return { error: 'broker-unavailable' };
    const invoke = async (tool, args) => {
      try { return await cloudInvokeConnector({ server: 'google-docs', tool, args, confirmed: true }); }
      catch (e) { return { success: false, error: (e && e.message) || 'invoke-failed', hint: (e && e.body && e.body.hint) || undefined }; }
    };
    const key = _GDOC_KEY(docId);
    let documentId = null;
    try { documentId = (await chrome.storage.local.get(key))[key] || null; } catch { /* */ }
    for (let attempt = 0; attempt < 2; attempt++) {   // attempt 2 = recreate after a vanished doc
      if (!documentId) {
        const created = await invoke('create_document', { title: (stored && stored.title) || 'Orchard Canvas' });
        if (!created || created.success === false || !created.value || !created.value.documentId) {
          return { error: (created && created.error) || 'gdoc-create-failed', hint: created && created.hint };
        }
        documentId = created.value.documentId;
        try { await chrome.storage.local.set({ [key]: documentId }); } catch { /* */ }
      }
      const meta = await invoke('get_document', { documentId });
      if (!meta || meta.success === false) {
        documentId = null;                                   // vanished / inaccessible → drop the id and recreate once
        try { await chrome.storage.local.remove(key); } catch { /* */ }
        continue;
      }
      const { requests, degraded } = specToDocsRequests(stored, { bodyEndIndex: meta.value.bodyEndIndex || 1 });
      if (!requests.length) return { documentId, applied: 0, degraded };
      const painted = await invoke('render_document', { documentId, requests });
      if (!painted || painted.success === false) return { error: (painted && painted.error) || 'gdoc-render-failed', hint: painted && painted.hint, documentId };
      return { documentId, applied: painted.value ? painted.value.applied : requests.length, degraded };   // GD-7a — the §8.3 honesty report rides to the panel
    }
    return { error: 'gdoc-recreate-failed' };
  }

  // Shared render: normalize+persist the spec (CanvasStore stamps rev), then paint the app's chosen backend —
  // the canvas TAB (default) or the external gdoc (§8; the Doc is the surface, so no tab opens). Returns the response.
  async function _render(anchor, spec, op, focus) {
    const docId = canvasDocId(anchor);
    if (!docId) return { success: false, error: 'canvas-no-anchor' };
    const stored = await writeCanvasSpec(anchor, spec);
    const backend = (builtinApp(anchor.appId)?.presentation?.backend) || 'tab';
    if (backend === 'gdoc') {
      const g = await _renderGdoc(anchor, stored, docId);
      // GD-4c — the Doc IS the surface, so SURFACE it: open on first compose, focus on the rest (unless focus:false).
      const gTabId = (!g.error && g.documentId) ? await _openDocTab(g.documentId, focus) : null;
      const deg = (Array.isArray(g.degraded) && g.degraded.length) ? ` degraded ${g.degraded.map((d) => `${d.kind}→${d.as}`).join(',')}` : '';
      note(`CANVAS ▸ ${op} → ${docId} gdoc ${g.error ? `ERROR ${g.error}${g.hint ? ` (${g.hint})` : ''}` : `${g.documentId} (applied ${g.applied}, tab ${gTabId ?? '—'})`}${deg} (rev ${stored ? stored.rev : '?'})`);
      return g.error
        ? { success: false, op, docId, rev: stored ? stored.rev : null, error: g.error, hint: g.hint }
        : { success: true, op, docId, rev: stored ? stored.rev : null, gdoc: g, tabId: gTabId, docUrl: _DOC_URL(g.documentId), degraded: g.degraded || [] };
    }
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
          // GD-4 (§8.2) — spec-revision turns: hand the CURRENT spec to compose, so "change the first line" edits
          // the addressed block instead of starting over. First compose (no spec yet) stays a fresh compose.
          let current = null; try { current = await loadCanvasSpec(anchor); } catch { current = null; }
          // GD-7e (§8.7.1) — banked SOURCES (a fetched KB article + its enumerated media menu) ride into compose;
          // the returned spec passes stripMintedMedia BEFORE the render path (refs-not-URLs: an LLM-minted remote
          // media src is an exfil beacon — refs survive, minted srcs don't; trusted app-defined blocks never pass here).
          const sources = Array.isArray(p.sources) ? p.sources : null;
          const spec = await composeCanvas({ ask: String(p.ask || ''), seed: String(p.seed || ''), objects, learned: String(p.learned || ''), current, sources });
          if (!spec) { sendResponse({ success: false, error: 'compose-empty' }); return; }   // no LLM / unparseable / empty
          sendResponse(await _render(anchor, stripMintedMedia(spec), 'compose', p.focus));
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'compose-canvas-failed' }); }
      })();
      return true;
    },
  };
}
