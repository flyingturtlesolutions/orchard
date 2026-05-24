/**
 * @file Sidepanel/modes/ObservationAuthor/picker.js
 * @description Pick-session helpers for observation-author. Each Pick
 * session is per-extract: the session state remembers which extract
 * card requested the pick, so PICK_RESULT routes back to the right
 * card's target field.
 *
 * Shape of a pick session:
 *   {
 *     sessionId  : string  unique correlation token
 *     extractIdx : number  which extract requested the pick
 *   }
 *
 * @module Sidepanel/modes/ObservationAuthor/picker
 * @version 2.74.166
 */

// v2.74.166 — Frame-aware picker. Same broadcast helpers fragment-author
// and perspective-capture use, so observation extracts can target elements
// inside same-origin iframes too.
import { broadcastStartPick, broadcastCancelPick } from '../../../shared.js';

/**
 * Start a Pick session targeting a specific extract.
 *
 * @param {number} tabId
 * @param {number} extractIdx
 * @returns {Promise<{ ok: boolean, session?: object, error?: string }>}
 */
export async function startPick(tabId, extractIdx) {
  const sessionId = `oa_pick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await broadcastStartPick(tabId, {
    sessionId,
    mode: 'target',
    containerSelector: '',
    multiCandidate: false,
    labelMode: 'single',
  });
  if (!res.success) {
    return { ok: false, error: res.error ?? 'content script declined' };
  }
  return { ok: true, session: { sessionId, extractIdx } };
}

/**
 * Cancel an in-flight Pick session.
 *
 * @param {number} tabId
 * @param {object} session
 */
export async function cancelPick(tabId, session) {
  if (!session) return;
  // v2.74.166 — Broadcast cancel so iframe pickers tear down too.
  await broadcastCancelPick(tabId, { sessionId: session.sessionId });
}

/**
 * Match an incoming PICK_RESULT against an active session. Returns the
 * extractIdx the result should be applied to, or null if the message
 * doesn't match the session.
 */
export function matchPickResult(message, session) {
  if (!session) return null;
  if (message?.type !== 'PICK_RESULT') return null;
  if (message?.sessionId !== session.sessionId) return null;
  return session.extractIdx;
}

// ─── Snap (free-extract: click-and-drag rectangle) ────────────────────────

/**
 * Start a Snap session targeting a specific extract.
 *
 * @param {number} tabId
 * @param {number} extractIdx
 * @returns {Promise<{ ok: boolean, session?: object, error?: string }>}
 */
export async function startSnap(tabId, extractIdx) {
  const sessionId = `oa_snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let res;
  try {
    res = await chrome.tabs.sendMessage(
      tabId,
      { type: 'START_SNAP', payload: { sessionId } },
      { frameId: 0 },
    );
  } catch (e) {
    return { ok: false, error: e.message ?? String(e) };
  }
  if (!res?.success) {
    return { ok: false, error: res?.error ?? 'content script declined' };
  }
  return { ok: true, session: { sessionId, extractIdx } };
}

/** Cancel an in-flight Snap session. */
export async function cancelSnap(tabId, session) {
  if (!session) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'CANCEL_SNAP' }, { frameId: 0 });
  } catch { /* fine */ }
}

/**
 * Match an incoming SNAP_RESULT against an active session.
 * Returns the extractIdx, or null if no match.
 */
export function matchSnapResult(message, session) {
  if (!session) return null;
  if (message?.type !== 'SNAP_RESULT') return null;
  if (message?.sessionId !== session.sessionId) return null;
  return session.extractIdx;
}
