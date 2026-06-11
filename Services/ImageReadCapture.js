/**
 * @file Services/ImageReadCapture.js
 * @module ImageCapture
 *
 * Shared helpers for the three image-capture observation shapes:
 *   - image_snap  : scroll → captureVisibleTab → crop to rect
 *   - image_full  : captureVisibleTab (no scroll, no crop)
 *   - image_read  : image_snap + Claude vision with author description
 *
 * Background:
 *   These all used to live inline in their respective background.js
 *   message handlers (OBSERVE_IMAGE_SNAP_BG / OBSERVE_IMAGE_FULL_BG /
 *   OBSERVE_IMAGE_READ_BG). ExecutionEngine reached them by
 *   `chrome.runtime.sendMessage` — but ExecutionEngine runs INSIDE the
 *   same background SW, and in MV3 module SWs sending a runtime message
 *   from the SW to itself is unreliable. The response port frequently
 *   closes immediately with "The message port closed before a response
 *   was received", because there's no separate receiving context to
 *   keep it open while the work runs.
 *
 *   v2.74.145 surfaced this for image_read (Claude vision call is slow
 *   enough that the race is hit every time). v2.74.146 extends the same
 *   refactor to image_snap and image_full — they're faster so the race
 *   manifests less often, but the antipattern is identical.
 *
 * Resolution:
 *   The pipeline lives here as pure async functions. Both the background
 *   message handlers (sidepanel verify path — cross-context, message
 *   channel still works) and ExecutionEngine (in-SW runtime path —
 *   direct call) import these. Sidepanel callers still use the message
 *   channel; in-SW callers skip the round-trip.
 *
 * @typedef {Object} CaptureParams
 * @property {number}  tabId
 * @property {{x:number,y:number,width:number,height:number}} [rect]
 *                                  — viewport-relative CSS-pixel rect (snap/read)
 * @property {number}  [scrollY]   — page scrollY at capture time
 * @property {{width?:number,devicePixelRatio?:number}} [viewport]
 * @property {string}  [description] — author's instruction to Claude (read only)
 */

import { AnthropicService } from './AnthropicService.js';
import { Logger }            from '../Core/Logger.js';

// ─── Internal: shared scroll + capture + crop pipeline ───────────────────
//
// `performImageSnap` and `performImageRead` both need: scroll → wait →
// captureVisibleTab → crop. The Claude call only matters for read.
// Splitting the crop logic out lets the read path skip a re-decode.
//
// Returns { cropDataUrl, sw, sh } on success; throws on capture failure.
async function _scrollCaptureCrop({ tabId, rect, scrollY, viewport }) {
  // 1. Scroll the tab so the rect's coordinates are valid at capture time.
  await new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: (y) => { window.scrollTo(0, y); },
      args: [Number(scrollY) || 0],
    }, (_results) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  // Give layout one frame to settle.
  await new Promise(r => setTimeout(r, 50));

  // 2. captureVisibleTab needs the tab's window id.
  const tab = await new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (t) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(t);
    });
  });
  const fullDataUrl = await new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!dataUrl) reject(new Error('captureVisibleTab returned empty'));
      else resolve(dataUrl);
    });
  });

  // 3. Crop to rect via OffscreenCanvas. DPR scales rect from CSS to
  //    capture pixels since captureVisibleTab returns at DPR.
  const dpr = (viewport?.devicePixelRatio) || 1;
  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.max(1, Math.round(rect.width  * dpr));
  const sh = Math.max(1, Math.round(rect.height * dpr));
  const blob   = await (await fetch(fullDataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx    = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  try { bitmap.close?.(); } catch {}
  const cropBlob    = await canvas.convertToBlob({ type: 'image/png' });
  const cropDataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload  = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
    fr.readAsDataURL(cropBlob);
  });

  // Best-effort visual confirmation flash on the target tab so the
  // author sees the snapshot was taken. Fire-and-forget; missing
  // content script is fine.
  try {
    chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_CAPTURE_FLASH',
      payload: { rect },
    }, { frameId: 0 }, () => { void chrome.runtime.lastError; });
  } catch { /* ignore */ }

  return { cropDataUrl, sw, sh };
}

/**
 * image_snap: capture a cropped region of the active tab.
 *
 * @param {CaptureParams} params  — requires tabId + rect
 * @returns {Promise<{success:boolean, dataUrl?:string, width?:number, height?:number, cssWidth?:number, cssHeight?:number, error?:string}>}
 */
export async function performImageSnap({ tabId, rect, scrollY, viewport }) {
  if (!tabId || !rect) {
    return { success: false, error: 'tabId + rect required' };
  }
  try {
    const { cropDataUrl, sw, sh } = await _scrollCaptureCrop({ tabId, rect, scrollY, viewport });
    return {
      success  : true,
      dataUrl  : cropDataUrl,
      width    : sw,
      height   : sh,
      cssWidth : rect.width,
      cssHeight: rect.height,
    };
  } catch (err) {
    Logger.warn?.('ImageCapture', `performImageSnap failed: ${err.message ?? err}`);
    return { success: false, error: err?.message ?? String(err) };
  }
}

/**
 * image_full: capture the full visible viewport — no scroll, no crop.
 * Returns the dataUrl + decoded captured-pixel dimensions.
 *
 * @param {{tabId:number}} params
 * @returns {Promise<{success:boolean, dataUrl?:string, width?:number, height?:number, error?:string}>}
 */
export async function performImageFull({ tabId }) {
  if (!tabId) return { success: false, error: 'tabId required' };
  try {
    const tab = await new Promise((resolve, reject) => {
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(t);
      });
    });
    const dataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (du) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!du) reject(new Error('captureVisibleTab returned empty'));
        else resolve(du);
      });
    });
    // Decode once for captured-pixel dimensions. Non-fatal on failure.
    let width = 0, height = 0;
    try {
      const blob   = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      width  = bitmap.width;
      height = bitmap.height;
      try { bitmap.close?.(); } catch {}
    } catch (e) {
      Logger.warn?.('ImageCapture', `performImageFull: dimension probe failed: ${e.message}`);
    }
    return { success: true, dataUrl, width, height };
  } catch (err) {
    Logger.error?.('ImageCapture', `performImageFull failed: ${err.message ?? err}`);
    return { success: false, error: err?.message ?? String(err) };
  }
}

/**
 * image_read: image_snap + Claude vision with the author's description.
 * Returns the crop dataUrl + Claude's curated reply list.
 *
 * @param {CaptureParams} params  — requires tabId + rect + description
 * @returns {Promise<{success:boolean, items?:string[], dataUrl?:string, width?:number, height?:number, error?:string}>}
 */
export async function performImageRead({ tabId, rect, scrollY, viewport, description }) {
  if (!tabId || !rect) {
    return { success: false, error: 'tabId + rect required' };
  }
  if (typeof description !== 'string' || !description.trim()) {
    return { success: false, error: 'description required (what to read from the image)' };
  }
  try {
    const { cropDataUrl, sw, sh } = await _scrollCaptureCrop({ tabId, rect, scrollY, viewport });
    const llmRes = await AnthropicService.readImage({
      description,
      imageDataUrl: cropDataUrl,
    });
    if (!llmRes) {
      return { success: false, error: 'Claude returned no usable list', dataUrl: cropDataUrl, width: sw, height: sh };
    }
    // v2.74.154 — Forward LLM call metadata (confidence / rationale /
    // cost / usage / model) alongside the items list. ExecutionEngine
    // logs these on the OBSERVATION step; the binding itself stays as
    // the curated value(s) per the v2.74.148 cardinality-aware wrap.
    return {
      success    : true,
      items      : llmRes.items,
      dataUrl    : cropDataUrl,
      width      : sw,
      height     : sh,
      confidence : llmRes.confidence ?? null,
      rationale  : llmRes.rationale  ?? '',
      cost       : llmRes.cost       ?? null,
      usage      : llmRes.usage      ?? null,
      model      : llmRes.model      ?? null,
    };
  } catch (err) {
    Logger.error?.('ImageCapture', `performImageRead failed: ${err.message ?? err}`);
    return { success: false, error: err?.message ?? String(err) };
  }
}
