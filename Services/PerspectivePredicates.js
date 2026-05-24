/**
 * @file Services/PerspectivePredicates.js
 * @description Phase 7c+7d of the landmark substrate spec. Evaluates a
 * Perspective's applicability predicates against runtime page state to
 * determine whether the Perspective is "active" — meaning its landmarks
 * contribute to the addressable namespace and operations targeting
 * them can resolve.
 *
 * Per spec/02-CAPABILITIES.md § Perspective:
 *   predicates: AssertionTree-shaped applicability rules
 *   Leaf kinds (PERSPECTIVE_SPEC § 4 — all six implemented as of v2.74.331):
 *     - urlMatches      { pattern, mode: 'contains'|'regex'|'exact' }
 *     - visible         { target: <landmark uid> }
 *     - hasText         { target: <landmark uid>, value, caseSensitive? }
 *     - attributeEquals { target: <landmark uid>, attribute, value }
 *     - landmarkExists  { target: <landmark uid> }
 *     - iframeLoaded    { contextName }
 *
 * Tree operators: 'and' | 'or' | 'not'
 *
 * Phase 7c (v2.74.247) wired urlMatches synchronously and stubbed the
 * three DOM-touching leaves as null (fail-closed).
 *
 * Phase 7d (v2.74.248) makes the evaluator async end-to-end and
 * implements the three round-trip leaves:
 *
 *   visible       → looks up the landmark by UID in the registry, takes
 *                   its realization-layer selector + frameUrl, resolves
 *                   the frame, and asks the content script via
 *                   EVALUATE_PREDICATE_VISIBLE. Returns true iff the
 *                   element exists, has non-zero bbox, and isn't CSS- or
 *                   aria-hidden.
 *
 *   hasText       → same lookup path; asks the content script via
 *                   EVALUATE_PREDICATE_HAS_TEXT with the landmark's
 *                   selector and the predicate's `value`. Honors optional
 *                   caseSensitive (defaults to insensitive).
 *
 *   iframeLoaded  → reads the active perspective's iframeContexts[] for the
 *                   named context, then asks the content script
 *                   (top frame) to RESOLVE_IFRAME_BY_PREDICATE. Returns
 *                   true iff the iframe is reachable and same-origin
 *                   contentDocument is loaded.
 *
 * All three return null on any failure (tab gone, content script
 * unreachable, landmark missing, selector syntax error, frame missing).
 * The tree evaluator treats null inside AND as null overall and null
 * inside OR only as null if no peer evaluated true — matching the
 * spec's "don't activate perspectives whose conditions can't be verified"
 * stance.
 *
 * Backward compatibility: legacy perspectives carry a string `urlPattern`
 * field (no tree). This is treated as an implicit
 * `{ kind: 'urlMatches', pattern, mode: 'contains' }` predicate and
 * combined with any tree-form `predicates` via AND.
 *
 * @module Services/PerspectivePredicates
 * @version 2.74.248
 */

import { StorageManager } from './StorageManager.js';
import { Logger }         from '../Core/Logger.js';

const TOP_FRAME_ID = 0;

/**
 * Evaluate a single leaf predicate (no operator) against runtime
 * context. Returns:
 *   true    — predicate satisfied
 *   false   — predicate not satisfied
 *   null    — predicate kind unknown OR round-trip failed (caller
 *             decides fail-open or fail-closed)
 *
 * @param {object} predicate
 * @param {object} context  { tabUrl, tabId, perspective, ... }
 * @returns {Promise<boolean|null>}
 */
async function _evaluateLeafPredicate(predicate, context) {
  if (!predicate || typeof predicate !== 'object') return false;
  switch (predicate.kind) {
    case 'urlMatches':
      return _matchUrl(context?.tabUrl, predicate.pattern, predicate.mode);
    case 'visible':
      return _evaluateVisible(predicate, context);
    case 'hasText':
      return _evaluateHasText(predicate, context);
    case 'attributeEquals':
      return _evaluateAttributeEquals(predicate, context);
    case 'landmarkExists':
      return _evaluateLandmarkExists(predicate, context);
    case 'iframeLoaded':
      return _evaluateIframeLoaded(predicate, context);
    default:
      Logger.debug('PerspectivePredicates', `unknown predicate kind: ${predicate.kind} — treating as null`);
      return null;
  }
}

/**
 * Walk the predicate tree, evaluating internal nodes via their
 * operator and leaves via _evaluateLeafPredicate. Returns:
 *   true    — tree as a whole evaluates true
 *   false   — evaluates false
 *   null    — at least one leaf returned null AND it affects the
 *             overall result (e.g., null inside AND = null; null
 *             inside OR = depends on other children).
 *
 * Walks children sequentially with await — predicate trees are small
 * (typically <5 leaves) and short-circuiting saves content-script
 * round-trips when an earlier leaf decides the outcome.
 *
 * @param {object|Array} tree
 * @param {object} context
 * @returns {Promise<boolean|null>}
 */
async function _evaluateTree(tree, context) {
  if (tree === null || tree === undefined) return true;
  // Array → implicit AND (matches spec's predicates: [...] shorthand)
  if (Array.isArray(tree)) {
    return _evaluateTree({ operator: 'and', children: tree }, context);
  }
  const op = tree.operator;
  if (!op) {
    // Leaf node — has a kind directly
    return _evaluateLeafPredicate(tree, context);
  }
  const children = Array.isArray(tree.children) ? tree.children : [];
  if (op === 'and') {
    // false dominates; null lurks unless we find false
    let sawNull = false;
    for (const c of children) {
      const r = await _evaluateTree(c, context);
      if (r === false) return false;
      if (r === null) sawNull = true;
    }
    return sawNull ? null : true;
  }
  if (op === 'or') {
    // true dominates; null lurks unless we find true
    let sawNull = false;
    for (const c of children) {
      const r = await _evaluateTree(c, context);
      if (r === true) return true;
      if (r === null) sawNull = true;
    }
    return sawNull ? null : false;
  }
  if (op === 'not') {
    const child = children[0];
    const r = await _evaluateTree(child, context);
    if (r === null) return null;
    return !r;
  }
  Logger.debug('PerspectivePredicates', `unknown operator: ${op}`);
  return null;
}

function _matchUrl(url, pattern, mode) {
  if (typeof url !== 'string' || typeof pattern !== 'string' || !pattern) return false;
  switch (mode ?? 'contains') {
    case 'exact':
      return url === pattern;
    case 'regex':
      try { return new RegExp(pattern).test(url); }
      catch (e) {
        Logger.warn('PerspectivePredicates', `invalid regex pattern "${pattern}": ${e.message}`);
        return false;
      }
    case 'contains':
    default:
      return url.includes(pattern);
  }
}

// ─── Phase 7d: async leaf evaluators (content-script round-trips) ──────────

/**
 * Pull the realization-layer selector + frameUrl out of a landmark
 * record. Tolerates the record shape variations that accumulated
 * through the migration: top-level `selector`/`frameUrl` (current),
 * `realization: { selector, frameUrl }` (spec-aligned wrapping that
 * may land later), and legacy embedded-only perspectives (no record at
 * all → caller handles).
 *
 * @param {object} landmark
 * @returns {{ selector: string|null, frameUrl: string|null }}
 */
function _extractRealization(landmark) {
  if (!landmark || typeof landmark !== 'object') return { selector: null, frameUrl: null };
  const selector = landmark.selector
    ?? landmark.realization?.selector
    ?? null;
  const frameUrl = landmark.frameUrl
    ?? landmark.realization?.frameUrl
    ?? null;
  return { selector, frameUrl };
}

/**
 * Resolve a frameUrl to a concrete frameId via webNavigation. Falls
 * back to top frame when frameUrl is null or the frame can't be
 * found (matching TemplateWalker._resolveFrameId semantics).
 *
 * @param {number} tabId
 * @param {string|null} frameUrl
 * @returns {Promise<number>}
 */
async function _resolveFrameId(tabId, frameUrl) {
  if (!frameUrl) return TOP_FRAME_ID;
  let frames;
  try {
    frames = await new Promise(resolve => {
      chrome.webNavigation.getAllFrames({ tabId }, fs => resolve(fs ?? []));
    });
  } catch {
    return TOP_FRAME_ID;
  }
  if (!Array.isArray(frames) || frames.length === 0) return TOP_FRAME_ID;
  const exact = frames.find(f => f && f.url === frameUrl);
  if (exact) return exact.frameId;
  let savedOrigin = null;
  try { savedOrigin = new URL(frameUrl).origin; } catch { /* leave null */ }
  if (savedOrigin) {
    const origMatch = frames.find(f => {
      if (!f?.url) return false;
      try { return new URL(f.url).origin === savedOrigin; } catch { return false; }
    });
    if (origMatch) return origMatch.frameId;
  }
  return TOP_FRAME_ID;
}

/**
 * Send a message to a specific frame in a tab. Resolves with the
 * response object; resolves with null when chrome.runtime.lastError
 * fires (content script not loaded, tab gone, etc.) so the caller
 * can decide null vs throw.
 *
 * @param {number} tabId
 * @param {object} message
 * @param {number} frameId
 * @returns {Promise<any|null>}
 */
function _send(tabId, message, frameId = TOP_FRAME_ID) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId }, response => {
        if (chrome.runtime.lastError) {
          Logger.debug('PerspectivePredicates', `_send to frame ${frameId} failed: ${chrome.runtime.lastError.message}`);
          return resolve(null);
        }
        resolve(response);
      });
    } catch (e) {
      Logger.debug('PerspectivePredicates', `_send threw: ${e.message}`);
      resolve(null);
    }
  });
}

async function _evaluateVisible(predicate, context) {
  const tabId = context?.tabId;
  if (typeof tabId !== 'number') return null;
  const uid = predicate.target;
  if (!uid || typeof uid !== 'string') {
    Logger.debug('PerspectivePredicates', 'visible predicate missing target uid');
    return null;
  }
  let landmark;
  try { landmark = await StorageManager.getLandmark(uid); }
  catch (e) {
    Logger.debug('PerspectivePredicates', `getLandmark(${uid}) failed: ${e.message}`);
    return null;
  }
  if (!landmark) return null;
  const { selector, frameUrl } = _extractRealization(landmark);
  if (!selector) return null;
  const frameId = await _resolveFrameId(tabId, frameUrl);
  const res = await _send(tabId, {
    type   : 'EVALUATE_PREDICATE_VISIBLE',
    payload: { selector },
  }, frameId);
  if (!res || res.success !== true) return null;
  return res.visible === true;
}

async function _evaluateHasText(predicate, context) {
  const tabId = context?.tabId;
  if (typeof tabId !== 'number') return null;
  const uid = predicate.target;
  if (!uid || typeof uid !== 'string') {
    Logger.debug('PerspectivePredicates', 'hasText predicate missing target uid');
    return null;
  }
  if (typeof predicate.value !== 'string') {
    Logger.debug('PerspectivePredicates', 'hasText predicate missing string value');
    return null;
  }
  let landmark;
  try { landmark = await StorageManager.getLandmark(uid); }
  catch (e) {
    Logger.debug('PerspectivePredicates', `getLandmark(${uid}) failed: ${e.message}`);
    return null;
  }
  if (!landmark) return null;
  const { selector, frameUrl } = _extractRealization(landmark);
  if (!selector) return null;
  const frameId = await _resolveFrameId(tabId, frameUrl);
  const res = await _send(tabId, {
    type   : 'EVALUATE_PREDICATE_HAS_TEXT',
    payload: {
      selector,
      value        : predicate.value,
      caseSensitive: predicate.caseSensitive === true,
    },
  }, frameId);
  if (!res || res.success !== true) return null;
  return res.hasText === true;
}

// v2.74.331 — PERSPECTIVE_SPEC § 4 attributeEquals. Landmark's attribute === value.
async function _evaluateAttributeEquals(predicate, context) {
  const tabId = context?.tabId;
  if (typeof tabId !== 'number') return null;
  const uid = predicate.target;
  if (!uid || typeof uid !== 'string') {
    Logger.debug('PerspectivePredicates', 'attributeEquals predicate missing target uid');
    return null;
  }
  if (typeof predicate.attribute !== 'string' || !predicate.attribute.trim()) {
    Logger.debug('PerspectivePredicates', 'attributeEquals predicate missing attribute');
    return null;
  }
  let landmark;
  try { landmark = await StorageManager.getLandmark(uid); }
  catch (e) {
    Logger.debug('PerspectivePredicates', `getLandmark(${uid}) failed: ${e.message}`);
    return null;
  }
  if (!landmark) return null;
  const { selector, frameUrl } = _extractRealization(landmark);
  if (!selector) return null;
  const frameId = await _resolveFrameId(tabId, frameUrl);
  const res = await _send(tabId, {
    type   : 'EVALUATE_PREDICATE_ATTRIBUTE_EQUALS',
    payload: { selector, attribute: predicate.attribute, value: predicate.value ?? '' },
  }, frameId);
  if (!res || res.success !== true) return null;
  return res.matches === true;
}

// v2.74.331 — PERSPECTIVE_SPEC § 4 landmarkExists. Landmark's selector resolves
// to an element in the DOM (present; visibility not required).
async function _evaluateLandmarkExists(predicate, context) {
  const tabId = context?.tabId;
  if (typeof tabId !== 'number') return null;
  const uid = predicate.target;
  if (!uid || typeof uid !== 'string') {
    Logger.debug('PerspectivePredicates', 'landmarkExists predicate missing target uid');
    return null;
  }
  let landmark;
  try { landmark = await StorageManager.getLandmark(uid); }
  catch (e) {
    Logger.debug('PerspectivePredicates', `getLandmark(${uid}) failed: ${e.message}`);
    return null;
  }
  if (!landmark) return null;
  const { selector, frameUrl } = _extractRealization(landmark);
  if (!selector) return null;
  const frameId = await _resolveFrameId(tabId, frameUrl);
  const res = await _send(tabId, {
    type   : 'EVALUATE_PREDICATE_EXISTS',
    payload: { selector },
  }, frameId);
  if (!res || res.success !== true) return null;
  return res.exists === true;
}

async function _evaluateIframeLoaded(predicate, context) {
  const tabId  = context?.tabId;
  const perspective = context?.perspective;
  if (typeof tabId !== 'number') return null;
  if (!perspective || typeof perspective !== 'object') {
    Logger.debug('PerspectivePredicates', 'iframeLoaded predicate evaluated without perspective in context');
    return null;
  }
  const contextName = predicate.contextName;
  if (!contextName || typeof contextName !== 'string') {
    Logger.debug('PerspectivePredicates', 'iframeLoaded predicate missing contextName');
    return null;
  }
  const ctx = Array.isArray(perspective.iframeContexts)
    ? perspective.iframeContexts.find(c => c?.contextName === contextName)
    : null;
  if (!ctx || !ctx.predicate) {
    Logger.debug('PerspectivePredicates', `perspective "${perspective.id ?? perspective.name}" has no iframeContext named "${contextName}"`);
    return null;
  }
  const res = await _send(tabId, {
    type   : 'RESOLVE_IFRAME_BY_PREDICATE',
    payload: { predicate: ctx.predicate },
  }, TOP_FRAME_ID);
  if (!res) return null;
  // RESOLVE_IFRAME_BY_PREDICATE response shape:
  //   { success: false, reason: 'iframe-absent', ... } when the predicate
  //     matched no iframe → definitively NOT loaded.
  //   { success: false, error: ... }                  on selector / API
  //     errors → unverifiable, null.
  //   { success: true, sameOrigin, loaded, ... }      on match. The
  //     handler already encodes the cross-origin policy: it sets
  //     loaded=true when the element is present even though we can't
  //     read the iframe's readyState. Respect that decision so perspectives
  //     scoped to cross-origin iframes can activate.
  if (res.success === false) {
    if (res.reason === 'iframe-absent') return false;
    return null;
  }
  return res.loaded === true;
}

/**
 * Determine whether a Perspective is active given the runtime context.
 *
 * v2.74.275 — Legacy `urlPattern` field REMOVED. URL gating is now
 * expressed exclusively via a `urlMatches` predicate in the
 * predicates tree. Perspectives must declare at least one urlMatches
 * predicate to be URL-scoped; perspectives with no predicates are
 * always active.
 *
 * Treats null (unverifiable leaves) as fail-closed: a perspective with
 * unverifiable predicates is NOT considered active. This matches the
 * spec's "don't silently use the wrong element" stance — when in
 * doubt, exclude.
 *
 * Phase 7d: perspective is threaded into the evaluation context so
 * `iframeLoaded` leaves can look up the perspective's iframeContexts[].
 *
 * @param {object} perspective
 * @param {object} context  { tabUrl, tabId? }
 * @returns {Promise<boolean>}
 */
export async function isPerspectiveActive(perspective, context) {
  if (!perspective || typeof perspective !== 'object') return false;
  // v2.74.335 — PERSPECTIVE_SPEC § 12: a deprecated Perspective is excluded from the
  // active set (its perspective is retired; authoring/proposals filter it).
  if (perspective.lifecycle === 'deprecated') return false;
  const ctx = { ...(context ?? {}), perspective };
  if (Array.isArray(perspective.predicates)) {
    if (perspective.predicates.length === 0) return true;
    const verdict = await _evaluateTree({ operator: 'and', children: perspective.predicates }, ctx);
    return verdict === true;
  }
  if (perspective.predicates && typeof perspective.predicates === 'object') {
    const verdict = await _evaluateTree(perspective.predicates, ctx);
    return verdict === true;
  }
  return true;   // no predicates → always active
}

/**
 * List all active perspectives for a Ground given the current page context.
 *
 * @param {string} groundId
 * @param {object} context  { tabUrl, tabId? }
 * @returns {Promise<Array<object>>}
 */
export async function listActivePerspectives(groundId, context) {
  let perspectives;
  try {
    perspectives = await StorageManager.listPerspectives(groundId);
  } catch (e) {
    Logger.warn('PerspectivePredicates', `listActivePerspectives(${groundId}) failed: ${e.message}`);
    return [];
  }
  const active = [];
  for (const perspective of perspectives ?? []) {
    try {
      if (await isPerspectiveActive(perspective, context)) active.push(perspective);
    } catch (e) {
      Logger.warn('PerspectivePredicates', `isPerspectiveActive(${perspective?.id}) threw: ${e.message}`);
    }
  }
  return active;
}
