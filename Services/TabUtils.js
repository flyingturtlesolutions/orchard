// Services/TabUtils.js — CR-D5 (v2.74.944): THE wait-for-tab-load. Six hand-rolled copies existed with
// three different timeout behaviors (resolve-anyway / reject / {ok:boolean}) and per-copy bug-fix drift —
// notably, only some handled the "tab already complete" race via a parallel tabs.get poll.
//
// This slice adopts the three RESOLVE-shaped copies (WorkflowExecutor._waitTabComplete,
// PageProbe.waitForTabReady, DiscoveryService.#navigate's inline wait — which GAINS the already-complete
// poll it was missing). The ExecutionEngine and TemplateWalker variants are DEFERRED to the CR-X2 engine
// extraction: their copies have grace-period sleeps and a reject contract woven into navigation flows
// that should only change under live verification.
//
// @module Services/TabUtils

import { Logger } from '../Core/Logger.js';

/**
 * Resolve when the tab reports status 'complete' (or immediately if it already does), else on timeout.
 * Never rejects — callers translate {ok:false} into their own contract.
 * @param {number} tabId
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{ok:boolean, timedOut?:boolean, error?:string}>}
 */
export function waitForTabComplete(tabId, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch { /* */ }
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const listener = (changedTabId, changeInfo) => {
      if (changedTabId === tabId && changeInfo.status === 'complete') finish({ ok: true });
    };
    try { chrome.tabs.onUpdated.addListener(listener); } catch (e) { finish({ ok: false, error: e.message }); return; }
    // The already-complete race: a fast/cached load can finish before the listener attaches.
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) { finish({ ok: false, error: chrome.runtime.lastError.message }); return; }
        if (tab?.status === 'complete') finish({ ok: true });
      });
    } catch (e) { finish({ ok: false, error: e.message }); return; }
    timer = setTimeout(() => {
      Logger.debug('TabUtils', `waitForTabComplete: tab ${tabId} not complete within ${timeoutMs}ms`);
      finish({ ok: false, timedOut: true, error: `Tab ${tabId} did not reach 'complete' within ${timeoutMs}ms` });
    }, Math.max(0, timeoutMs));
  });
}
