/**
 * @file Sidepanel/shell-api.js
 * @description The service surface that mode modules import from. Modes
 * never reach into shell.js or each other directly — everything goes
 * through this boundary.
 *
 * Services:
 *   - toast(msg, type)         — show a toast (uses shared.js)
 *   - requestModeChange(...)   — programmatic mode switch from inside a mode
 *   - getActiveTab(precise?)   — query active tab in last-focused window
 *   - pingContentScript(...)   — verify content script is reachable
 *
 * The module registry of mode names → import paths lives in shell.js.
 * Modes don't need to know about each other; they only need to be able
 * to TRIGGER a switch via requestModeChange.
 *
 * @module Sidepanel/shell-api
 * @author Agent HUB
 * @version 2.72.50
 */

import { toast as _toast } from '../shared.js';

// ─── Toast passthrough ────────────────────────────────────────────────────
//
// Modes call shellApi.toast(...) instead of importing shared.js directly.
// One reason: shell owns the #toast DOM element. If the shell relocates
// or restyles the toast container (e.g., to handle multi-mode positioning
// rules), modes don't have to change.

export function toast(msg, type = 'ok') {
  return _toast(msg, type);
}

// ─── Mode change request ──────────────────────────────────────────────────
//
// Modes can request a transition (e.g., perspective-capture's Cancel button
// might want to return to idle/chat). Goes through background's mode
// registry so the source of truth stays consistent.

export async function requestModeChange(name, payload = {}) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'REQUEST_SIDEPANEL_MODE',
      payload: { mode: name, payload },
    });
    return res;
  } catch (e) {
    console.warn('[shell-api] requestModeChange threw:', e?.message);
    return { success: false, error: e?.message };
  }
}

// ─── Exit to Studio ───────────────────────────────────────────────────────
//
// A mode can call this to indicate "I'm done, return the user to Studio."
// Two-tier close:
//   1. Background runs chrome.sidePanel.close (Chrome 141+) or the
//      disable+enable toggle workaround (older Chrome). Background also
//      clears the sidepanel mode + finds/focuses Studio.
//   2. We try window.close() from the sidepanel page itself. Free
//      belt-and-suspenders for the rare case where the background path
//      didn't fully dismiss the panel.

export async function exitToStudio() {
  // Get the window that hosts THIS sidepanel page. Background can't
  // reliably figure this out from chrome.tabs.query (lastFocusedWindow
  // race). Pass the windowId explicitly so background's
  // chrome.sidePanel.close has the right target.
  let windowId = null;
  try {
    const win = await chrome.windows.getCurrent();
    windowId = win?.id ?? null;
  } catch (e) {
    console.warn('[shell-api] getCurrent window failed:', e?.message);
  }

  // v2.72.58 — Call chrome.sidePanel.close FROM THE SIDEPANEL PAGE itself
  // BEFORE messaging background. The user just clicked Cancel/Close;
  // the user-gesture window is still warm here. Calling close from
  // background after a sendMessage round-trip may lose the gesture
  // (Chrome requires a user gesture to invoke sidePanel.close).
  if (typeof chrome.sidePanel?.close === 'function' && windowId != null) {
    try {
      await chrome.sidePanel.close({ windowId });
      console.log('[shell-api] chrome.sidePanel.close from panel: OK');
    } catch (e) {
      console.warn('[shell-api] chrome.sidePanel.close from panel threw:', e?.message);
    }
  }

  // Send EXIT_TO_STUDIO to background for: mode-clear, focus Studio,
  // and close-fallback in case the panel-side close didn't take effect.
  try {
    await chrome.runtime.sendMessage({
      type: 'EXIT_TO_STUDIO',
      payload: { windowId },
    });
  } catch (e) {
    console.warn('[shell-api] exitToStudio threw:', e?.message);
  }
  // Belt-and-suspenders: window.close from the sidepanel page.
  try { window.close(); } catch (_) { /* fine */ }
  return { success: true };
}

// ─── Active tab ──────────────────────────────────────────────────────────
//
// Several modes (perspective-capture, strategy-debug-future, observation-trace-
// future) need "the tab the user is looking at right now." This wraps the
// chrome.tabs.query call so all modes use the same semantics.
//
// Returns the chrome.tabs.Tab object or null.

export async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs?.[0] ?? null;
  } catch (e) {
    console.warn('[shell-api] getActiveTab threw:', e?.message);
    return null;
  }
}

// ─── Content-script ping ─────────────────────────────────────────────────
//
// Probes whether the content script is reachable in the main frame of
// the given tab. Used by modes that need to send messages to the page
// (perspective-capture's picker, strategy-debug's CHECK_CONDITION, etc.).
//
// Returns { ok: true } | { ok: false, error: string, hint?: string }.

export async function pingContentScript(tabId) {
  // Get URL for diagnostic context — content scripts can't load on
  // chrome:// or chrome-extension:// pages.
  let tabUrl = '';
  try {
    const t = await chrome.tabs.get(tabId);
    tabUrl = t?.url ?? '';
  } catch (e) {
    return { ok: false, error: 'Tab no longer exists' };
  }
  if (/^(chrome|chrome-extension|edge|about):/i.test(tabUrl)) {
    let proto = 'extension';
    try { proto = new URL(tabUrl).protocol; } catch {}
    return {
      ok: false,
      error: `Content scripts can't run on ${proto} pages`,
      hint: `Navigate to a regular https:// page first.`,
    };
  }

  try {
    const res = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('PING timeout (1500ms)')), 1500);
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: 0 }, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
    if (!res?.ready) {
      return { ok: false, error: 'PING returned unexpected response' };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: `Content script not reachable: ${e.message}`,
      hint: `Tab URL: ${tabUrl}. Try reloading the tab.`,
    };
  }
}
