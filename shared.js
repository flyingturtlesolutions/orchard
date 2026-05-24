/**
 * @file shared.js
 * @module shared
 * @version 2.9.1
 *
 * Utilities shared between all extension UI surfaces (Lab side panel, Chat
 * side panel, and future entry points). Pure helpers — no DOM state beyond
 * the singleton toast container lookup.
 *
 * If a function appears in more than one entry point, it belongs here.
 * If it's specific to one surface, it stays there.
 */

// ─── DOM helpers ──────────────────────────────────────────────────────────────

export const uid  = () => crypto.randomUUID();
export const $    = (id)  => document.getElementById(id);
export const qs   = (sel, root = document) => root.querySelector(sel);
export const qsa  = (sel, root = document) => [...root.querySelectorAll(sel)];

// ─── String escaping ──────────────────────────────────────────────────────────

// v2.74.113 — Both helpers now escape `'` → `&#39;` for parity with the
// local copies in markdown.js and ParamForm.js. Codebase consistently uses
// double-quoted attributes, so this isn't an exploitable change today —
// purely consistency hardening so a future single-quoted attribute can't
// silently introduce a quote-breakout.
export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escAttr(str) {
  // v2.74.105 — Escape `&` first so the subsequent &quot;/&lt;/&gt;
  // substitutions don't double-encode it. Most other escAttr sites in the
  // codebase already do the full set; this shared.js helper was the odd
  // one out — a latent risk for paths/labels containing `&` or `<`.
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&#39;');
}

// ─── Time formatting ──────────────────────────────────────────────────────────

export function relTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const sec  = Math.floor(diff / 1000);
  if (sec < 60)  return `${sec}s ago`;
  const min  = Math.floor(sec / 60);
  if (min < 60)  return `${min}m ago`;
  const hr   = Math.floor(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  const day  = Math.floor(hr / 24);
  if (day < 30)  return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ─── Toast notifications ──────────────────────────────────────────────────────
// Expects a #toast element in the host page.

let _toastTimer = null;
export function toast(msg, type = 'ok') {
  const el = document.getElementById('toast');
  if (!el) { console.warn('[toast] No #toast element found'); return; }
  // v2.74.113 — Coerce null/undefined → empty string. Previously displayed
  // literal "null" / "undefined" in the toast for a caller that forgot
  // to short-circuit on a missing message — defensive only, no current
  // caller triggers it.
  el.textContent = String(msg ?? '');
  // v2.72.46 — 'ok' now maps to the green variant (was neutral default).
  // Existing call sites passing 'ok' are typically success messages, so
  // this is the desired behavior. Plain (no type) calls still get the
  // neutral fallback.
  let cls = 'toast';
  if (type === 'err')  cls += ' err';
  else if (type === 'warn') cls += ' warn';
  else if (type === 'ok')   cls += ' ok';
  el.className = cls;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

// ─── Sidepanel launcher (v2.74.140) ──────────────────────────────────────────
//
// Opens the multi-mode sidepanel (sidepanel.html) on the current window's
// active tab, displacing any prior per-tab override (e.g. the Chat handler
// in popup.js sets a per-tab `chat.html` override that wins on the active
// tab until something explicitly overwrites it).
//
// Why both global AND per-tab? Per Chrome's sidePanel API, per-tab
// overrides take precedence over the window-scoped default. The global
// setOptions alone is necessary (so future tab switches inside this window
// show sidepanel.html) but not sufficient (the current tab keeps showing
// whatever per-tab override is still registered). Setting both ensures
// the panel switches to sidepanel.html immediately AND future tab
// switches track the same path. The original popup.js Ground handler hit
// this exact bug — v2.74.125 fixed it inline; v2.74.140 lifts the
// pattern into a shared helper so the seven Studio launchers don't each
// re-implement it (and don't each potentially miss the fix).
//
// Callers should run this synchronously from a user gesture (button click)
// — chrome.sidePanel.open() requires a recent user gesture.
//
// @param {string} [path='sidepanel.html'] - sidepanel HTML to install
// @returns {Promise<void>}
export async function openSidepanelHere(path = 'sidepanel.html') {
  try {
    // Global default first — applies to tabs without a per-tab override
    // and to future tab activations in this window.
    await chrome.sidePanel.setOptions({ path, enabled: true });
    // Per-tab override on the active tab — displaces any prior
    // per-tab path (chat.html being the realistic case).
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id != null) {
      await chrome.sidePanel.setOptions({ tabId: activeTab.id, path, enabled: true });
    }
    if (activeTab?.windowId != null) {
      await chrome.sidePanel.open({ windowId: activeTab.windowId });
    }
  } catch (e) {
    console.warn('[openSidepanelHere] failed:', e?.message);
  }
}

// ─── Picker broadcast (v2.74.166) ───────────────────────────────────────
//
// Three sidepanel modes start a live-page selector picker:
//   - fragment-author  (+ Action / + Action branch / + Action gate body)
//   - observation-author (Pick on each extract)
//   - perspective-capture   (Pick on each landmark)
//
// Each one sends START_PICK to the active tab's content script. The
// historical implementation targeted `{ frameId: 0 }` only, which made
// the picker top-frame-only — clicks inside same-origin iframes did
// nothing because the iframe's content script never got the message.
//
// This helper broadcasts START_PICK (and the matching CANCEL_PICK) to
// every frame in the tab. The content script self-decides whether to
// activate via a same-origin probe (cross-origin frames refuse, same-
// origin frames arm). Per-frame errors are silently swallowed —
// missing content script in chrome:// frames is expected.
//
// The top frame's response is the canonical success/failure signal
// returned by this helper. Iframe responses arrive asynchronously and
// don't block the caller — the iframe pickers self-arm and wait for
// mouse events.
//
// @param {number} tabId   - target tab
// @param {object} payload - START_PICK message payload (sessionId, mode, etc.)
// @returns {Promise<{success: boolean, error?: string}>}
export async function broadcastStartPick(tabId, payload) {
  const msg = { type: 'START_PICK', payload };
  // Top frame first — its response is what we return to the caller.
  let topRes;
  try {
    topRes = await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch (e) {
    return { success: false, error: e?.message ?? String(e) };
  }
  if (!topRes?.success) {
    return { success: false, error: topRes?.error ?? 'content script declined' };
  }
  // Broadcast to other frames in the background. Fire-and-forget; the
  // per-frame callbacks just log so a missing/cross-origin frame is
  // diagnosable from the sidepanel console without blocking the caller.
  try {
    const frames = await new Promise((resolve) => {
      chrome.webNavigation.getAllFrames({ tabId }, (fs) => resolve(fs ?? []));
    });
    for (const f of frames) {
      if (!f || f.frameId === 0) continue;
      if (!f.url || /^(about|chrome|chrome-extension):/i.test(f.url)) continue;
      chrome.tabs.sendMessage(tabId, msg, { frameId: f.frameId }, () => {
        // Swallow lastError — cross-origin refusals + missing-listener
        // (e.g. blob:/data: frames without our content script) are
        // both expected for some frames.
        void chrome.runtime.lastError;
      });
    }
  } catch (e) {
    // getAllFrames failed (tab gone, API blocked) — not fatal; top
    // frame is already armed.
    console.warn('[broadcastStartPick] frame enumeration failed:', e?.message);
  }
  return { success: true };
}

// Cancel a picker session in every frame. Symmetrical with
// broadcastStartPick — without iframe cancel, an aborted top-frame
// pick would leave armed iframe pickers, and a stale iframe click
// could pollute the next session.
//
// @param {number} tabId
// @param {object} payload - { sessionId } from the original START_PICK
// @returns {Promise<void>}
export async function broadcastCancelPick(tabId, payload) {
  const msg = { type: 'CANCEL_PICK', payload };
  // v2.74.169 — Diagnostic logging so we can confirm the cancel chain
  // actually fires when a pick completes (the user reported the top-
  // frame picker overlay staying on screen after an iframe pick lands;
  // these logs let us see whether broadcastCancelPick is reached, which
  // frames it dispatches to, and whether the per-frame send succeeded).
  console.info('[broadcastCancelPick] dispatching', { tabId, payload });
  try {
    const topRes = await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    console.info('[broadcastCancelPick] top frame ack', topRes);
  } catch (e) {
    console.warn('[broadcastCancelPick] top frame send failed:', e?.message);
  }
  try {
    const frames = await new Promise((resolve) => {
      chrome.webNavigation.getAllFrames({ tabId }, (fs) => resolve(fs ?? []));
    });
    console.info('[broadcastCancelPick] enumerated frames', {
      count: frames.length,
      ids: frames.map(f => f?.frameId),
    });
    for (const f of frames) {
      if (!f || f.frameId === 0) continue;
      if (!f.url || /^(about|chrome|chrome-extension):/i.test(f.url)) continue;
      chrome.tabs.sendMessage(tabId, msg, { frameId: f.frameId }, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.info('[broadcastCancelPick] frame', f.frameId, 'no listener:', err.message);
        }
      });
    }
  } catch (e) {
    console.warn('[broadcastCancelPick] frame enumeration failed:', e?.message);
  }
}

// ─── Cross-context storage change broadcast (v2.27.0) ─────────────────────────
//
// When any extension context (sidepanel, Studio, chat) saves or deletes a
// shared record (strategies, fragments, grounds, groundmaps), it calls this
// helper. Chrome's runtime messaging routes the message to every other
// extension page, which can then refresh its UI.
//
// Background.js has its own copy of this logic (same payload shape), fired
// after CUD operations that already route through message handlers
// (SAVE_FRAGMENT, SAVE_STRATEGY, etc.). UI code calls this directly only for
// operations that DON'T round-trip through background (currently: Ground
// saves, which go straight to StorageManager from sidepanel.js).
//
// Listeners filter by msg.kind to decide whether they care.
//
// @param {'strategy'|'fragment'|'ground'|'groundmap'} kind
// @param {string|null} id
// @param {'saved'|'deleted'} action
export function broadcastStorageChanged(kind, id, action) {
  chrome.runtime.sendMessage({
    type: 'STORAGE_CHANGED',
    kind, id, action,
    ts: Date.now(),
  }).catch((err) => {
    // v2.74.113 — "No receiver" is the common case (broadcasting to sibling
    // pages; if none are open, that's expected). Surface anything else so a
    // real channel failure isn't silently dropped. Chrome reports the
    // no-receiver case with a stable substring; everything else hits the
    // warn branch.
    const msg = err?.message ?? String(err);
    if (msg.includes('Receiving end does not exist')) return;
    console.warn('[broadcastStorageChanged] failed:', msg);
  });
}
