/**
 * @file Services/LandmarkReplacementCandidates.js
 * @description Phase 10.5 of the landmark substrate spec. Given a
 * landmark UID, find ranked replacement candidates on the same Ground
 * — landmarks that share the same a11yRole and are plausibly the
 * "same thing renamed/relocated."
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────
 *
 * Phase 10 (LandmarkReplacer) does the rewrite. But it requires the
 * caller to KNOW which landmark to swap in. Two real workflows need
 * a candidate-finder:
 *
 *   1. Studio replacement UI: "I'm removing landmark X — show me the
 *      best replacement options." The author picks from a ranked list.
 *
 *   2. Drift recovery: a landmark whose accessibleName changed (e.g.,
 *      page renamed "Submit" → "Submit Form") falls out of heuristic
 *      recovery (which searches by exact name). A candidate-finder
 *      using fuzzy name match locates the renamed version.
 *
 * ── ALGORITHM ───────────────────────────────────────────────────────
 *
 * Hard filters:
 *   - Same Ground (caller scopes this)
 *   - Same a11yRole as the target (no cross-role replacement; spec's
 *     three-layer model says identity is role+name+context, so role
 *     mismatch = different identity)
 *   - Not the target itself
 *   - lifecycle !== 'deprecated' (deprecated landmarks aren't valid
 *     replacements by definition)
 *
 * Soft scoring (all 0..1, weighted sum):
 *
 *   name similarity (weight 0.50)
 *     exact (case-sensitive)            → 1.00
 *     exact (case-insensitive)          → 0.95
 *     substring either direction        → 0.80
 *     Levenshtein-based: 1 - dist/maxLen, floor at 0
 *     all-lowercase whitespace-token
 *     Jaccard overlap adds up to +0.10
 *
 *   context similarity (weight 0.20)
 *     ancestorRole equal                → +1/3
 *     ancestorName equal (or both null) → +1/3
 *     siblingPosition within ±2         → +1/3
 *
 *   URL similarity (weight 0.20)
 *     canonicalUrl exact match          → 1.00
 *     same origin                       → 0.50
 *     different                         → 0.00
 *
 *   lifecycle preference (weight 0.10)
 *     verified                          → 1.00
 *     fresh                             → 0.80
 *     stale-suspected                   → 0.40
 *     stale-confirmed                   → 0.10
 *     deprecated                        → (excluded by hard filter)
 *
 * Composite score = 0.5·name + 0.2·context + 0.2·url + 0.1·lifecycle.
 *
 * Candidates sorted descending by composite. Default top 5 returned.
 * Confidence band labels (for UI):
 *   ≥ 0.85  high
 *   0.65–0.85 medium
 *   0.40–0.65 low
 *   < 0.40   weak (returned only when limit not yet hit)
 *
 * @module Services/LandmarkReplacementCandidates
 */

import { StorageManager } from './StorageManager.js';
import { Logger }         from '../Core/Logger.js';

const DEFAULT_LIMIT = 5;

const LIFECYCLE_PREF = Object.freeze({
  'verified'        : 1.00,
  'fresh'           : 0.80,
  'stale-suspected' : 0.40,
  'stale-confirmed' : 0.10,
  // 'deprecated' excluded by hard filter
});

/**
 * Iterative Levenshtein distance — O(n·m) time, O(min(n,m)) space.
 * For accessibleName values (typically < 50 chars) this is cheap.
 */
function _levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  if (a.length > b.length) { const tmp = a; a = b; b = tmp; }
  const prev = new Array(a.length + 1);
  const curr = new Array(a.length + 1);
  for (let i = 0; i <= a.length; i++) prev[i] = i;
  for (let j = 1; j <= b.length; j++) {
    curr[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,        // deletion
        curr[i - 1] + 1,    // insertion
        prev[i - 1] + cost, // substitution
      );
    }
    for (let i = 0; i <= a.length; i++) prev[i] = curr[i];
  }
  return prev[a.length];
}

function _tokens(s) {
  return new Set(String(s ?? '').toLowerCase().split(/\s+/).filter(Boolean));
}

function _jaccard(a, b) {
  const A = _tokens(a);
  const B = _tokens(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function _nameSimilarity(oldName, candName) {
  const o = String(oldName ?? '');
  const c = String(candName ?? '');
  if (!o && !c) return 0;          // both empty: not a useful match
  if (o === c) return 1.00;
  if (o.toLowerCase() === c.toLowerCase()) return 0.95;
  const ol = o.toLowerCase();
  const cl = c.toLowerCase();
  if (ol && cl && (ol.includes(cl) || cl.includes(ol))) return 0.80;
  const dist = _levenshtein(ol, cl);
  const maxLen = Math.max(ol.length, cl.length);
  const lev = maxLen === 0 ? 0 : Math.max(0, 1 - dist / maxLen);
  const jacc = _jaccard(ol, cl);
  // Cap at 0.90 to keep below the substring threshold.
  return Math.min(0.90, lev + 0.10 * jacc);
}

function _contextSimilarity(oldCtx, candCtx) {
  // hierarchicalContext shape: { ancestorRole, ancestorName, siblingPosition }
  const o = oldCtx ?? {};
  const c = candCtx ?? {};
  let score = 0;
  if ((o.ancestorRole ?? null) === (c.ancestorRole ?? null)) score += 1 / 3;
  if ((o.ancestorName ?? null) === (c.ancestorName ?? null)) score += 1 / 3;
  const oPos = typeof o.siblingPosition === 'number' ? o.siblingPosition : null;
  const cPos = typeof c.siblingPosition === 'number' ? c.siblingPosition : null;
  if (oPos !== null && cPos !== null) {
    if (Math.abs(oPos - cPos) <= 2) score += 1 / 3;
  } else if (oPos === null && cPos === null) {
    score += 1 / 3;
  }
  return Math.min(1, score);
}

function _urlSimilarity(oldUrl, candUrl) {
  if (!oldUrl && !candUrl) return 0;
  if (oldUrl === candUrl) return 1.00;
  let oOrig = null, cOrig = null;
  try { oOrig = new URL(oldUrl).origin; } catch { /* leave null */ }
  try { cOrig = new URL(candUrl).origin; } catch { /* leave null */ }
  if (oOrig && cOrig && oOrig === cOrig) return 0.50;
  return 0;
}

function _lifecyclePref(lifecycle) {
  return LIFECYCLE_PREF[lifecycle ?? 'fresh'] ?? 0;
}

function _confidenceBand(score) {
  if (score >= 0.85) return 'high';
  if (score >= 0.65) return 'medium';
  if (score >= 0.40) return 'low';
  return 'weak';
}

/**
 * Find ranked replacement candidates for a landmark.
 *
 * @param {string} uid       Landmark being replaced
 * @param {string} groundId  Ground scope
 * @param {{limit?: number, includeWeak?: boolean, minConfidence?: 'high'|'medium'|'low'|'weak'}} [opts]
 * @returns {Promise<{
 *   success: boolean,
 *   uid: string,
 *   groundId: string,
 *   target: object|null,
 *   candidates: Array<{
 *     uid: string,
 *     landmark: object,
 *     score: number,
 *     confidence: 'high'|'medium'|'low'|'weak',
 *     breakdown: { name: number, context: number, url: number, lifecycle: number },
 *   }>,
 *   error?: string,
 * }>}
 */
export async function findReplacementCandidates(uid, groundId, opts = {}) {
  const limit = typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const includeWeak = opts.includeWeak === true;
  const minBand = opts.minConfidence ?? null;

  if (!uid || !groundId) {
    return { success: false, uid, groundId, target: null, candidates: [], error: 'uid + groundId required' };
  }

  let target;
  try { target = await StorageManager.getLandmark(uid); }
  catch (e) {
    return { success: false, uid, groundId, target: null, candidates: [], error: `getLandmark: ${e.message}` };
  }
  if (!target) {
    return { success: false, uid, groundId, target: null, candidates: [], error: 'target landmark not found' };
  }
  if (target.groundId !== groundId) {
    return { success: false, uid, groundId, target, candidates: [], error: `landmark is on ground ${target.groundId}, not ${groundId}` };
  }

  let allLandmarks;
  try { allLandmarks = await StorageManager.listLandmarksForGround(groundId); }
  catch (e) {
    return { success: false, uid, groundId, target, candidates: [], error: `listLandmarks: ${e.message}` };
  }

  // Hard filters
  // v2.74.275 — `lm.role` legacy fallback removed; a11yRole is now
  // canonical (computed at Pick).
  const targetA11yRole = target.a11yRole ?? null;
  const eligible = (allLandmarks ?? []).filter(lm => {
    if (!lm || !lm.uid) return false;
    if (lm.uid === uid) return false;
    if (lm.lifecycle === 'deprecated') return false;
    const candRole = lm.a11yRole ?? null;
    if (targetA11yRole && candRole !== targetA11yRole) return false;
    return true;
  });

  // Score
  const scored = eligible.map(lm => {
    const name = _nameSimilarity(target.accessibleName, lm.accessibleName);
    const context = _contextSimilarity(target.hierarchicalContext, lm.hierarchicalContext);
    const url = _urlSimilarity(target.canonicalUrl, lm.canonicalUrl);
    const lifecycle = _lifecyclePref(lm.lifecycle);
    const score = 0.5 * name + 0.2 * context + 0.2 * url + 0.1 * lifecycle;
    return {
      uid       : lm.uid,
      landmark  : lm,
      score,
      confidence: _confidenceBand(score),
      breakdown : { name, context, url, lifecycle },
    };
  });

  // Sort descending, optionally filter by min band, optionally drop weak,
  // then cap to limit.
  const bandRank = { high: 3, medium: 2, low: 1, weak: 0 };
  let result = scored.sort((a, b) => b.score - a.score);
  if (minBand) {
    const min = bandRank[minBand] ?? 0;
    result = result.filter(c => bandRank[c.confidence] >= min);
  } else if (!includeWeak) {
    // Default: drop weak unless caller has only weak candidates and
    // didn't hit the limit.
    const nonWeak = result.filter(c => c.confidence !== 'weak');
    if (nonWeak.length >= limit || nonWeak.length === result.length) {
      result = nonWeak;
    } else {
      // Keep weak as filler up to limit.
      const weak = result.filter(c => c.confidence === 'weak');
      result = nonWeak.concat(weak);
    }
  }
  result = result.slice(0, limit);

  Logger.debug('LandmarkReplacementCandidates',
    `${uid} on ${groundId}: ${result.length} candidate(s); top score ${result[0]?.score?.toFixed(3) ?? 'n/a'}`);

  return {
    success: true,
    uid, groundId, target,
    candidates: result,
  };
}
