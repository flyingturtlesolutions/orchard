/**
 * @file Services/PageProbe.js
 * @description Live page interaction primitives for locale authoring and
 * verification. Provides three capabilities, all CSP-safe (routed through
 * the persistent content script via chrome.tabs.sendMessage rather than
 * chrome.scripting.executeScript with inline functions):
 *
 *   findOrOpenTab(urlPattern)  — locate a tab whose URL matches a pattern;
 *                                if none, open one and wait for ready.
 *   captureDom(tabId, opts)    — snapshot the live DOM into a compact form
 *                                suitable for prompt context.
 *   probeSelector(tabId, sel)  — run a CSS selector against the live DOM,
 *                                return matched count + sample HTML of
 *                                first match for verification.
 *
 * ── Why a separate module ──────────────────────────────────────────────
 *
 * Locales (Pass 17) capture verified DOM landmarks. To author one, we need
 * to (a) reach a tab on the right URL, (b) snapshot its DOM, and (c) verify
 * each landmark's selector against that DOM. To re-verify a locale later,
 * we need (a) and (c) again. To evaluate a `locale_ref` condition at
 * runtime, we need (c) against the running tab.
 *
 * Existing modules (TemplateWalker, ExecutionEngine, DiscoveryService) all
 * have their own tab/DOM utilities, but none expose the right shape for
 * locale work. PageProbe consolidates the primitives that locales need
 * without rewriting the consumers.
 *
 * Future passes (Observation auto-authoring, Fragment auto-authoring,
 * verification of page-family assertions) will reuse this module.
 *
 * @module Services/PageProbe
 * @author Agent HUB
 * @version 2.72.29
 */

import { Logger } from '../Core/Logger.js';

// ─── Tab management ─────────────────────────────────────────────────────

/**
 * Find a tab whose URL matches the pattern, or open a new tab on the
 * pattern if none exists.
 *
 * Pattern matching:
 *   - If pattern looks like a full URL (starts with http:// or https://),
 *     match by substring.
 *   - Else, treat as a substring match against the URL.
 *   - If pattern starts and ends with `/`, treat as a regex.
 *
 * The returned tabId can be used for captureDom / probeSelector calls.
 *
 * @param {string} urlPattern
 * @returns {Promise<{ok: true, tabId: number, url: string} | {ok: false, error: string}>}
 */
export async function findOrOpenTab(urlPattern) {
  if (!urlPattern || typeof urlPattern !== 'string') {
    return { ok: false, error: 'findOrOpenTab requires a non-empty urlPattern' };
  }
  const matcher = compilePattern(urlPattern);

  // Search existing tabs across all windows.
  let tabs;
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return { ok: false, error: `chrome.tabs.query failed: ${e.message}` };
  }
  const existing = tabs.find(t => t?.url && matcher(t.url));
  if (existing) {
    Logger.debug('PageProbe', `findOrOpenTab — matched existing tab ${existing.id}: ${existing.url}`);
    // Make sure it's the active tab in its window so the user can see what's
    // happening. tabs.update activates within-window; windows.update brings
    // the window to front. Both best-effort — tab activation is the primary
    // requirement, window focus is UX nicety.
    try {
      await chrome.tabs.update(existing.id, { active: true });
    } catch { /* best-effort */ }
    if (Number.isFinite(existing.windowId)) {
      try {
        await chrome.windows.update(existing.windowId, { focused: true });
      } catch { /* best-effort; missing 'windows' permission is non-fatal */ }
    }
    return { ok: true, tabId: existing.id, url: existing.url };
  }

  // Open a new tab. Pattern must be a usable URL — substring/regex patterns
  // can't open a tab. We accept the limitation: if you give us a pattern
  // that's not a URL, you must already have a tab open.
  //
  // v2.72.39 — Auto-prefix `https://` for domain-shaped patterns. Lets
  // users type `pixabay.com` instead of needing the full `https://pixabay.com`.
  // Heuristic: looks like a hostname (a.b or a.b.c) optionally followed by /path,
  // no spaces, no leading slash (which would signal a substring or regex
  // pattern). Anything more exotic — patterns with `?`, regexes, partial-path
  // substrings — falls through to the "open a tab manually" guidance.
  let candidateUrl = looksLikeUrl(urlPattern) ? urlPattern : null;
  if (!candidateUrl && looksLikeDomain(urlPattern)) {
    candidateUrl = `https://${urlPattern}`;
    Logger.info('PageProbe', `findOrOpenTab — auto-prefixed pattern to ${candidateUrl}`);
  }
  if (!candidateUrl) {
    return { ok: false, error: `No tab matches pattern "${urlPattern}", and the pattern is not openable as a URL. Open a matching tab first, or use a full URL like "https://example.com".` };
  }

  let newTab;
  try {
    newTab = await chrome.tabs.create({ url: candidateUrl, active: true });
  } catch (e) {
    return { ok: false, error: `chrome.tabs.create failed: ${e.message}` };
  }
  // Wait for the tab to finish loading.
  const ready = await waitForTabReady(newTab.id);
  if (!ready.ok) return ready;
  Logger.debug('PageProbe', `findOrOpenTab — opened new tab ${newTab.id}: ${candidateUrl}`);
  return { ok: true, tabId: newTab.id, url: candidateUrl };
}

/**
 * Wait until a tab reaches `complete` status.
 * @private
 */
async function waitForTabReady(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch { /* ok */ }
      clearTimeout(timer);
      resolve(result);
    };
    const listener = (changedTabId, changeInfo) => {
      if (changedTabId === tabId && changeInfo.status === 'complete') {
        finish({ ok: true });
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Also check immediately in case the tab is already ready.
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (tab?.status === 'complete') finish({ ok: true });
    });
    const timer = setTimeout(() => finish({ ok: false, error: `Tab ${tabId} did not reach 'complete' within ${timeoutMs}ms` }), timeoutMs);
  });
}

/**
 * Compile a urlPattern string into a matcher function.
 *
 * Three forms supported:
 *   "/regex/"  → a regex (slashes are stripped, body compiled as RegExp)
 *   "/jobs/"   → ambiguous: regex if body is non-empty AND no spaces, else substring
 *   "indeed.com/jobs" → substring match
 *
 * For locales, the URL pattern is usually a substring like "/jobs?q=" or
 * a regex like "/^https:\\/\\/(www\\.)?indeed\\.com\\/jobs/".
 *
 * @private
 */
function compilePattern(pattern) {
  // Regex form: starts and ends with `/` AND has body length ≥ 2 AND
  // doesn't contain whitespace. Conservative — substring is the safe default.
  const looksLikeRegex = pattern.length >= 2
    && pattern.startsWith('/')
    && pattern.endsWith('/')
    && pattern.length > 2
    && !/\s/.test(pattern.slice(1, -1));
  if (looksLikeRegex) {
    try {
      const rx = new RegExp(pattern.slice(1, -1));
      return (url) => rx.test(url);
    } catch {
      // Fall through to substring matching if regex compile fails.
    }
  }
  return (url) => url.includes(pattern);
}

/**
 * Heuristic: does the string look like an openable URL?
 * @private
 */
function looksLikeUrl(s) {
  return /^https?:\/\//i.test(s);
}

/**
 * v2.72.39 — Recognize domain-shaped strings so they auto-prefix to
 * https://. Examples that match: pixabay.com, www.indeed.com,
 * jobs.linkedin.com, indeed.com/jobs?q=foo. Examples that don't:
 * /jobs?q= (leading slash → substring matcher), /^https.+/ (regex),
 * localhost (no dot), 192.168.1.1 (IP — could be http or https; let
 * user be explicit). The heuristic is conservative — when in doubt,
 * fall through and let the user prefix manually.
 */
function looksLikeDomain(s) {
  if (typeof s !== 'string' || !s) return false;
  if (s.startsWith('/')) return false;
  if (/\s/.test(s)) return false;
  // Hostname part: at least one dot between alphanumeric segments.
  // Optional path/query/fragment after.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/.*)?$/i.test(s);
}

// ─── DOM capture ────────────────────────────────────────────────────────

/**
 * Capture a compact DOM snapshot from a tab. Uses the existing
 * DOM_SNAPSHOT_FULL handler in the content script, which produces a
 * filtered element-summary string (approx ~10-30KB depending on page).
 *
 * @param {number} tabId
 * @param {Object} [opts]
 * @param {number} [opts.maxLength=20000] — truncate the snapshot string
 * @returns {Promise<{ok: true, dom: string, url: string, title: string} | {ok: false, error: string}>}
 */
export async function captureDom(tabId, opts = {}) {
  const maxLength = Number.isFinite(opts.maxLength) ? opts.maxLength : 20000;

  let tabInfo;
  try {
    tabInfo = await chrome.tabs.get(tabId);
  } catch (e) {
    return { ok: false, error: `chrome.tabs.get failed: ${e.message}` };
  }

  const response = await sendToTabWithRetry(tabId, { type: 'DOM_SNAPSHOT_FULL' });
  if (!response) {
    return { ok: false, error: 'No response from content script (tab may not be ready)' };
  }
  if (response.success === false) {
    return { ok: false, error: response.error ?? 'DOM_SNAPSHOT_FULL failed' };
  }
  if (typeof response.snapshot !== 'string') {
    return { ok: false, error: 'DOM_SNAPSHOT_FULL response missing snapshot string' };
  }
  let dom = response.snapshot;
  if (dom.length > maxLength) dom = dom.slice(0, maxLength) + '\n…(truncated)';

  return {
    ok: true,
    dom,
    url: tabInfo?.url ?? '',
    title: tabInfo?.title ?? '',
  };
}

// ─── Selector probing ────────────────────────────────────────────────────

/**
 * Probe a CSS selector against a tab's live DOM. Returns the match count
 * and a sample of the first matched element's outerHTML.
 *
 * @param {number} tabId
 * @param {string} selector
 * @param {Object} [opts]
 * @param {number} [opts.sampleHtmlMax=400] — max length of sample HTML
 * @returns {Promise<{ok: true, matchedCount: number, sampleHtml: string} | {ok: false, error: string}>}
 */
export async function probeSelector(tabId, selector, opts = {}) {
  if (!selector || typeof selector !== 'string') {
    return { ok: false, error: 'probeSelector requires a non-empty selector' };
  }
  const sampleMax = Number.isFinite(opts.sampleHtmlMax) ? opts.sampleHtmlMax : 400;

  // v2.74.198 — frameUrl opt — when set, resolve to a frameId and
  // route the probe into that iframe. Caller (locale-capture verify,
  // future picker-driven verifies) passes ex.frameUrl / lm.frameUrl
  // captured by the picker. _resolveFrameId returns 0 when frameUrl
  // is absent / iframe gone, preserving back-compat.
  let frameId = 0;
  if (opts.frameUrl && typeof opts.frameUrl === 'string' && opts.frameUrl.trim()) {
    try {
      const { TemplateWalker } = await import('./TemplateWalker.js');
      frameId = await TemplateWalker._resolveFrameId(tabId, opts.frameUrl);
    } catch { /* fall back to top frame */ }
  }

  const response = await sendToTabWithRetry(tabId, {
    type: 'PROBE_SELECTOR',
    payload: { selector, sampleHtmlMax: sampleMax },
  }, { frameId });
  if (!response) {
    return { ok: false, error: 'No response from content script (tab may not be ready)' };
  }
  if (response.success === false) {
    return { ok: false, error: response.error ?? 'PROBE_SELECTOR failed' };
  }
  return {
    ok: true,
    matchedCount: Number.isFinite(response.matchedCount) ? response.matchedCount : 0,
    sampleHtml: typeof response.sampleHtml === 'string' ? response.sampleHtml : '',
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────

/**
 * Send a message to a tab's content script with retries for the case
 * where the content script hasn't finished registering its listener yet.
 *
 * On a freshly-opened tab, chrome.tabs.onUpdated fires status=='complete'
 * before the content script's top-level code necessarily finishes
 * running, especially when the content script is large or the page does
 * heavy synchronous work at load. The first sendMessage in that window
 * returns chrome.runtime.lastError = "Could not establish connection.
 * Receiving end does not exist." The fix is to retry briefly.
 *
 * Other lastError values (e.g. "The tab was closed") are not retried —
 * those are terminal.
 *
 * @private
 */
async function sendToTabWithRetry(tabId, message, opts = {}) {
  const maxAttempts = Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : 5;
  const backoffMs = Number.isFinite(opts.backoffMs) ? opts.backoffMs : 250;
  // v2.74.198 — frameId option threaded through to sendToTabRaw so
  // probeSelector + future probes can target iframe content scripts.
  const frameId = Number.isFinite(opts.frameId) ? opts.frameId : 0;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { response, error } = await sendToTabRaw(tabId, message, 10000, frameId);
    if (response) {
      if (attempt > 1) {
        Logger.info('PageProbe', `sendToTabWithRetry: succeeded on attempt ${attempt}`, {
          tabId, type: message?.type,
        });
      }
      return response;
    }
    lastErr = error;
    // Retry on transient causes:
    //  - "Receiving end does not exist" / "Could not establish connection":
    //    content script not registered yet on freshly-opened tab
    //  - "empty response": frame's listener returned undefined or didn't
    //    call sendResponse. Could be a frame race; retry might catch a
    //    proper async response on the next attempt.
    // Other errors (tab closed, threw, timeout) are terminal.
    const retryable = error && /Receiving end does not exist|Could not establish connection|empty response/.test(error);
    if (!retryable) break;
    if (attempt < maxAttempts) {
      Logger.debug('PageProbe', `sendToTabWithRetry: attempt ${attempt} — content script not ready, retrying in ${backoffMs}ms`, {
        tabId, type: message?.type,
      });
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  Logger.warn('PageProbe', `sendToTabWithRetry: gave up after ${maxAttempts} attempts`, {
    tabId, type: message?.type, lastError: lastErr,
  });
  return null;
}

/**
 * Single-attempt send. Returns {response, error} where one is set.
 * @private
 */
async function sendToTabRaw(tabId, message, timeoutMs = 10000, frameId = 0) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r, e) => { if (!settled) { settled = true; resolve({ response: r, error: e }); } };
    const timer = setTimeout(() => {
      finish(null, `timeout after ${timeoutMs}ms`);
    }, timeoutMs);
    try {
      // v2.72.40 — Target the main frame only by default. With
      // all_frames:true in manifest, sub-frames also register onMessage
      // listeners. Without frameId:0, an iframe's sync return-undefined
      // can win the channel before the main frame responds, surfacing
      // as "empty response."
      // v2.74.198 — Caller can pass a non-zero frameId for iframe-
      // bound probes (PageProbe.probeSelector accepts opts.frameUrl).
      chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          finish(null, chrome.runtime.lastError.message);
          return;
        }
        finish(response ?? null, response ? null : 'empty response');
      });
    } catch (e) {
      clearTimeout(timer);
      finish(null, `threw: ${e.message}`);
    }
  });
}

/**
 * Send a message to a tab's content script. Wraps chrome.tabs.sendMessage
 * with a timeout and clean error handling. Returns the raw response (or
 * null on failure).
 * @private
 */
async function sendToTab(tabId, message, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => {
      Logger.warn('PageProbe', `sendToTab timeout after ${timeoutMs}ms — tabId=${tabId} type=${message?.type}`);
      finish(null);
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          Logger.warn('PageProbe', `sendToTab error: ${chrome.runtime.lastError.message}`);
          finish(null);
          return;
        }
        finish(response ?? null);
      });
    } catch (e) {
      clearTimeout(timer);
      Logger.warn('PageProbe', `sendToTab threw: ${e.message}`);
      finish(null);
    }
  });
}
