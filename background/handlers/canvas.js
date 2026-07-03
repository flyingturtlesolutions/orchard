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
import { pageToSource, sourcesForPrompt, mergedRefMap, resolveMediaRefs, ensureSourceAttribution } from '../../Core/sourceBank.js';   // GD-7e — the source bank (KB-remix §8.7.1); v1336 — the attribution belt

const CANVAS_PAGE = 'canvas.html';

// Open or focus THE canvas tab for an anchor — one tab per (appId, conversationId), carried in the hash. tabs.query
// ignores the fragment, so we query all canvas.html tabs and match on the hash. Mirrors chat.js's btn-open-studio.
// v2.74.1341 (review G) — EXACT hash match (`.includes(tag)` let `app=x&conv=` prefix-match `app=x&conv=abc`, so
// the `canvas` command could focus the WRONG canvas tab); and `focusExisting:false` (a compose/revision repaint)
// leaves an already-open tab where it is instead of stealing tab+window focus on every turn.
async function _openCanvasTab(anchor, { focusExisting = true } = {}) {
  const appId = (anchor && anchor.appId) ? String(anchor.appId) : '';
  const convId = (anchor && anchor.conversationId) ? String(anchor.conversationId) : '';
  const tag = `app=${encodeURIComponent(appId)}&conv=${encodeURIComponent(convId)}`;
  const url = `${chrome.runtime.getURL(CANVAS_PAGE)}#${tag}`;
  try {
    const tabs = await chrome.tabs.query({ url: `${chrome.runtime.getURL(CANVAS_PAGE)}*` });
    const mine = (tabs || []).find((t) => t && typeof t.url === 'string' && String(t.url).split('#')[1] === tag);
    if (mine && mine.id != null) {
      if (focusExisting) {
        await chrome.tabs.update(mine.id, { active: true });
        if (mine.windowId != null) { try { await chrome.windows.update(mine.windowId, { focused: true }); } catch { /* */ } }
      }
      return mine.id;
    }
    const t = await chrome.tabs.create({ url, active: true });
    return (t && typeof t.id === 'number') ? t.id : null;
  } catch { return null; }
}

// GD-4c (v2.74.1325) — open or FOCUS the app's Google Doc (the §8 external surface). Live lesson (.1324): painting
// a Doc nobody has open reads as "nothing happened" — the design's no-tab rule meant "no extension CANVAS tab",
// never "no surface". focus:false = a silent background repaint: focus nothing, never open a new tab.
// v2.74.1341 (review G) — FOCUS ONCE: an already-open Doc live-updates from the API batchUpdate on its own, so a
// compose/revision no longer steals tab+window focus every turn (the user steers from the PANEL — yanking the
// window mid-steer was the annoyance). `focusExisting:true` (an explicit `canvas`/display ask) still focuses.
const _DOC_URL = (documentId) => `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/edit`;
async function _openDocTab(documentId, focus, { focusExisting = false } = {}) {
  try {
    const tabs = await chrome.tabs.query({ url: `https://docs.google.com/document/d/${documentId}/*` });
    const mine = (tabs || []).find((t) => t && t.id != null);
    if (mine) {
      if (focus !== false && focusExisting) {
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

  // GD-7e (§8.7.1) — the per-APP source bank: banked read/extract results (a KB article + its enumerated media)
  // that ride into every compose as SOURCES. Self-contained entries (each carries its own ref→url map), last 3
  // kept, seq is a stored counter so kb: refs stay stable across evictions. chrome.storage.local; per-app key.
  const _SRC_KEY = (appId) => `canvas:sources:${appId}`;
  const _SRC_SEQ_KEY = 'canvas:sourceSeq';
  async function _loadSources(appId) {
    if (!appId) return [];
    try { const k = _SRC_KEY(appId); const got = await chrome.storage.local.get(k); return Array.isArray(got[k]) ? got[k] : []; } catch { return []; }
  }
  // v2.74.1341 (review G) — the seq counter is a read-modify-write on shared storage: two concurrent BANK_SOURCEs
  // used to read the same value and mint DUPLICATE kb:N ids (colliding refs resolve to the wrong article). One
  // in-context chain serializes bank ops (BANK_SOURCE only ever runs in the SW, so one context IS global order).
  let _bankChain = Promise.resolve();
  const _bankSerialized = (fn) => { const next = _bankChain.then(fn); _bankChain = next.catch(() => {}); return next; };   // the kept tail never rejects

  // GD-3 (DESIGN_canvas.md §8) — the EXTERNAL gdoc backend: paint the spec into the app's own Google Doc via the
  // broker's REST channel. The doc is app-created under drive.file (the §8.1 ownership boundary — the token cannot
  // touch any other file), display-only by contract, and repainted replace-body from the SPEC (the single source of
  // truth — never read back). `confirmed:true` here is the §8.1-auto design decision: a render to the app's OWN
  // presentation doc is app plumbing (like a tab paint), NOT a model-driven write — the wire belt still gets its
  // explicit flag, and interpret-selected docs writes keep the normal HITL bar. Create-once per anchor; a vanished
  // doc (deleted by the user) recreates once.
  const _GDOC_KEY = (docId) => `canvas:gdocId:${docId}`;
  // v2.74.1341 (review P1-5) — "the doc is GONE" vs "the get merely failed": only a real not-found may drop the
  // stored doc id (recreating on ANY failure — broker-unauthorized, network — orphaned the old Doc with its shares
  // and comments). googleRest now carries the HTTP status; the hint match is the belt for older lambdas.
  const _isNotFound = (r) => !!r && (r.status === 404 || /\bnot[\s_-]?found\b/i.test(String(r.hint || '')));
  async function _renderGdoc(anchor, stored, docId) {
    if (typeof cloudInvokeConnector !== 'function') return { error: 'broker-unavailable' };
    const invoke = async (tool, args) => {
      try { return await cloudInvokeConnector({ server: 'google-docs', tool, args, confirmed: true }); }
      catch (e) { return { success: false, error: (e && e.message) || 'invoke-failed', hint: (e && e.body && e.body.hint) || undefined }; }
    };
    const key = _GDOC_KEY(docId);
    let documentId = null;
    let recreated = false;   // v1341 (review G) — surfaced so the panel can SAY "recreated your Doc" (never silent)
    try { documentId = (await chrome.storage.local.get(key))[key] || null; } catch { /* */ }
    for (let attempt = 0; attempt < 2; attempt++) {   // attempt 2 = recreate after a VANISHED (404) doc
      if (!documentId) {
        const created = await invoke('create_document', { title: (stored && stored.title) || 'Orchard Canvas' });
        if (!created || created.success === false || !created.value || !created.value.documentId) {
          return { error: (created && created.error) || 'gdoc-create-failed', hint: created && created.hint };
        }
        documentId = created.value.documentId;
        recreated = attempt > 0;
        try { await chrome.storage.local.set({ [key]: documentId }); } catch { /* */ }
      }
      const meta = await invoke('get_document', { documentId });
      if (!meta || meta.success === false) {
        if (_isNotFound(meta)) {
          documentId = null;                               // the user deleted the Doc → drop the id, recreate once
          try { await chrome.storage.local.remove(key); } catch { /* */ }
          continue;
        }
        // v1341 (P1-5) — any OTHER failure (auth, network, rate limit) returns honestly; the doc id KEEPS.
        return { error: (meta && meta.error) || 'gdoc-get-failed', hint: meta && meta.hint, documentId };
      }
      // GD-7h — inline ![alt](kb:…) refs in markdown/compose TEXT resolve at lowering time from the app's banked
      // map (block-level media resolved pre-store; inline ones can't be). Loaded here so EVERY render path —
      // compose, display, future cadence — resolves identically; an unresolved ref degrades visibly, never breaks.
      const refMap = mergedRefMap(await _loadSources((anchor && anchor.appId) || ''));
      const { requests, degraded } = specToDocsRequests(stored, { bodyEndIndex: meta.value.bodyEndIndex || 1, refMap });
      if (!requests.length) return { documentId, applied: 0, degraded, recreated };
      let painted = await invoke('render_document', { documentId, requests });
      if ((!painted || painted.success === false) && requests.some((q) => q.insertInlineImage)) {
        // v1337 — a PROTECTED source image (e.g. Zendesk Guide attachments 403 Google's fetcher) fails the WHOLE
        // atomic batchUpdate. Degrade-retry ONCE with every image as a placeholder — text/headings/video links/the
        // source link all keep; the honesty report says what happened. GD-7b-auth (the Drive round-trip) is the
        // real fix for protected media.
        // v1341 (review G) — RE-GET before the fallback paint: if attempt 1 actually applied but its response was
        // lost in transit, the stale pre-paint bodyEndIndex would DOUBLE-PAINT (append instead of replace). The
        // fresh read prices in whatever attempt 1 really did.
        const meta2 = await invoke('get_document', { documentId });
        if (!meta2 || meta2.success === false) return { error: (meta2 && meta2.error) || 'gdoc-get-failed', hint: meta2 && meta2.hint, documentId };
        const fb = specToDocsRequests(stored, { bodyEndIndex: meta2.value.bodyEndIndex || 1, refMap, noInlineImages: true });
        const repaint = await invoke('render_document', { documentId, requests: fb.requests });
        if (repaint && repaint.success !== false) {
          note(`CANVAS ▸ image-fallback — the source refused Google's image fetch (${(painted && painted.hint) || painted && painted.error || 'render failed'}); repainted with placeholders`);
          return { documentId, applied: repaint.value ? repaint.value.applied : fb.requests.length, degraded: fb.degraded, recreated };
        }
      }
      if (!painted || painted.success === false) return { error: (painted && painted.error) || 'gdoc-render-failed', hint: painted && painted.hint, documentId };
      return { documentId, applied: painted.value ? painted.value.applied : requests.length, degraded, recreated };   // GD-7a — the §8.3 honesty report rides to the panel
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
      // GD-4c — the Doc IS the surface, so SURFACE it: open when not open. v1341 (review G) — an already-open Doc
      // keeps its place (focus-once); only an explicit display ask (`canvas`) re-focuses it.
      const gTabId = (!g.error && g.documentId) ? await _openDocTab(g.documentId, focus, { focusExisting: op === 'display' }) : null;
      const deg = (Array.isArray(g.degraded) && g.degraded.length) ? ` degraded ${g.degraded.map((d) => `${d.kind}→${d.as}`).join(',')}` : '';
      note(`CANVAS ▸ ${op} → ${docId} gdoc ${g.error ? `ERROR ${g.error}${g.hint ? ` (${g.hint})` : ''}` : `${g.documentId} (applied ${g.applied}, tab ${gTabId ?? '—'})`}${g.recreated ? ' RECREATED' : ''}${deg} (rev ${stored ? stored.rev : '?'})`);
      return g.error
        ? { success: false, op, docId, rev: stored ? stored.rev : null, error: g.error, hint: g.hint }
        : { success: true, op, docId, rev: stored ? stored.rev : null, gdoc: g, tabId: gTabId, docUrl: _DOC_URL(g.documentId), degraded: g.degraded || [], recreated: !!g.recreated };
    }
    const tabId = (focus !== false) ? await _openCanvasTab(anchor, { focusExisting: op === 'display' }) : null;   // a cadence refresh may pass focus:false
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
          // GD-7e (§8.7.1) — SOURCES ride into compose: the app's BANKED sources (the `source` command). The model
          // sees title+text+the ref MENU only (no URLs). The returned spec passes stripMintedMedia (refs-not-URLs:
          // an LLM-minted remote media src is an exfil beacon — refs survive, minted srcs don't), then
          // resolveMediaRefs sets srcs from the TRUSTED banked map (the tab renders them; the gdoc lowering links
          // videos + placeholders images until GD-7b). Trusted app-defined blocks never pass through either.
          // v2.74.1341 (review G, latent) — the `p.sources` panel override is GONE: it had no live caller, and
          // attribution/resolution read `banked` — a panel-supplied list would have ridden the prompt while
          // bypassing both belts. Banked is the single source-of-sources.
          const banked = await _loadSources(String(p.appId || ''));
          const sources = banked.length ? sourcesForPrompt(banked) : null;
          const spec = await composeCanvas({ ask: String(p.ask || ''), seed: String(p.seed || ''), objects, learned: String(p.learned || ''), current, sources });
          if (!spec) { sendResponse({ success: false, error: 'compose-empty' }); return; }   // no LLM / unparseable / empty
          // v1336 — the attribution BELT: a draft composed from banked sources always carries a source link (the
          // prompt steers `[title](kb:N)`; this guarantees it when the model forgets — deterministic app plumbing).
          const attributed = ensureSourceAttribution(stripMintedMedia(spec), banked);
          sendResponse(await _render(anchor, resolveMediaRefs(attributed, mergedRefMap(banked)), 'compose', p.focus));
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'compose-canvas-failed' }); }
      })();
      return true;
    },

    // GD-7e (v2.74.1330, §8.7.1) — BANK the active page as a SOURCE for this app's composes: content-script
    // EXTRACT_SOURCE (read-only: title + bounded text + https media inventory) → Core/sourceBank mints the kb:
    // refs + the trusted ref→url map → per-app store (last 3, self-contained). The next compose carries it as
    // SOURCES automatically. Read-only page access → never busy-marked (Invariant #2 N/A).
    'BANK_SOURCE': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const p = (payload && typeof payload === 'object') ? payload : {};
          const appId = String(p.appId || '');
          const tabId = (typeof p.tabId === 'number') ? p.tabId : null;
          if (!appId) { sendResponse({ success: false, error: 'no-app' }); return; }
          if (tabId == null) { sendResponse({ success: false, error: 'no-tab' }); return; }
          // v2.74.1331 — inject-on-demand (the codebase-wide pattern, e.g. connector.js INVOKE_SESSION): a tab
          // opened BEFORE an extension reload has an orphaned content script — "Receiving end does not exist".
          // Inject and retry once; a chrome://-class page fails the injection too and falls through to the hint.
          const _extract = async () => { try { return await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_SOURCE' }); } catch { return null; } };
          let ex = await _extract();
          if (!ex) {
            try { await chrome.scripting.executeScript({ target: { tabId }, files: ['ContentScripts/contentScript.js'] }); } catch { /* */ }
            ex = await _extract();
          }
          if (!ex || ex.success === false || !ex.page) {
            sendResponse({ success: false, error: (ex && ex.error) || 'no-content-script', hint: 'open a normal web page (not a chrome:// or store page), or refresh it, and try again' });
            return;
          }
          // v1341 (review G) — seq mint + bank write inside the serializer: no duplicate kb:N under concurrency.
          const out = await _bankSerialized(async () => {
            let seq = 1;
            try { seq = (Number((await chrome.storage.local.get(_SRC_SEQ_KEY))[_SRC_SEQ_KEY]) || 0) + 1; await chrome.storage.local.set({ [_SRC_SEQ_KEY]: seq }); } catch { /* */ }
            const source = pageToSource(ex.page, { seq });
            if (!source) return { success: false, error: 'empty-source', hint: 'the page had no readable text or media' };
            const key = _SRC_KEY(appId);
            const kept = [source, ...(await _loadSources(appId))].slice(0, 3);   // newest first, last 3 kept
            try { await chrome.storage.local.set({ [key]: kept }); } catch { /* */ }
            const imgs = source.media.filter((m) => m.kind === 'image').length;
            const vids = source.media.filter((m) => m.kind === 'video').length;
            note(`SOURCE ▸ banked "${source.title.slice(0, 60)}" → ${source.id} (${imgs} images, ${vids} videos, ${source.text.length} chars) for ${appId} (${kept.length} banked)`);
            return { success: true, id: source.id, title: source.title, images: imgs, videos: vids, banked: kept.length };
          });
          sendResponse(out);
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'bank-source-failed' }); }
      })();
      return true;
    },

    // v2.74.1341 (review G) — the bank was WRITE-ONLY: up to 3×6k chars of page text rode every future compose with
    // no way to SEE or DROP it (an llm_privacy egress surface). `sources` lists what's banked; `sources clear`
    // empties this app's bank. Titles/counts only ride back — the panel never needs the raw text.
    'LIST_SOURCES': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const appId = String((payload && payload.appId) || '');
          if (!appId) { sendResponse({ success: false, error: 'no-app' }); return; }
          const banked = await _loadSources(appId);
          sendResponse({ success: true, sources: banked.map((s) => ({
            id: s.id, title: s.title || 'page', url: s.url || '',
            chars: (s.text || '').length,
            images: (Array.isArray(s.media) ? s.media : []).filter((m) => m.kind === 'image').length,
            videos: (Array.isArray(s.media) ? s.media : []).filter((m) => m.kind === 'video').length,
          })) });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'list-sources-failed' }); }
      })();
      return true;
    },

    'CLEAR_SOURCES': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const appId = String((payload && payload.appId) || '');
          if (!appId) { sendResponse({ success: false, error: 'no-app' }); return; }
          const had = (await _loadSources(appId)).length;
          try { await chrome.storage.local.remove(_SRC_KEY(appId)); } catch { /* */ }
          note(`SOURCE ▸ cleared ${had} banked source${had === 1 ? '' : 's'} for ${appId}`);
          sendResponse({ success: true, cleared: had });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'clear-sources-failed' }); }
      })();
      return true;
    },
  };
}
