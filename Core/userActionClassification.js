// Core/userActionClassification.js — Pure L2 user-action classifier (SPEC C0).
//
// Observes nothing; resolves nothing. Takes a ResolvedUserEvent + context and
// returns a ClassifiedUserEvent. See SPEC_USER_ACTION_CLASSIFIER_C0.md.
//
// @module Core/userActionClassification

import { mintEventId } from './outcomes.js';

export const CLASSIFICATION_SCHEMA = 1;

export const INTERACTION_KINDS = Object.freeze([
  'click', 'dblclick', 'type', 'submit', 'focus', 'blur',
  'scroll-into', 'navigate', 'tab-activate',
]);

export const RESOLUTION_STATUSES = Object.freeze([
  'hit', 'ambiguous', 'miss', 'suppressed',
]);

export const CLASSIFICATION_TIERS = Object.freeze([
  'substrate', 'browser', 'unresolved',
]);

export const UNRESOLVED_REASONS = Object.freeze([
  'miss', 'suppressed', 'no-ground', 'no-demand',
]);

/** Base interaction → verb when role does not refine. */
const BASE_VERB_BY_INTERACTION = Object.freeze({
  click: 'click',
  dblclick: 'dblclick',
  type: 'type',
  submit: 'submit',
  focus: 'focus',
  blur: 'blur',
  'scroll-into': 'scroll-into-view',
  navigate: 'navigate',
  'tab-activate': 'switch-tab',
});

/**
 * role → { interactionKind → semanticVerb }
 * Keys normalized to lowercase on lookup.
 */
export const ROLE_SEMANTIC_VERB_MAP = Object.freeze({
  'search-query': Object.freeze({
    type: 'enter-search-query',
    focus: 'focus-search-query',
  }),
  'search-submit': Object.freeze({
    click: 'submit-search',
    submit: 'submit-search',
  }),
  'primary-action': Object.freeze({
    click: 'activate-primary-action',
  }),
  'secondary-action': Object.freeze({
    click: 'activate-secondary-action',
  }),
  'result-link': Object.freeze({
    click: 'select-result',
  }),
  'navigation-link': Object.freeze({
    click: 'follow-link',
  }),
  'add-to-cart': Object.freeze({
    click: 'add-to-cart',
  }),
  'email-input': Object.freeze({
    type: 'enter-email',
    focus: 'focus-email',
  }),
  'password-input': Object.freeze({
    type: 'type',
    focus: 'focus',
  }),
  'quantity-input': Object.freeze({
    type: 'enter-quantity',
  }),
});

/** All verbs the map + base table can emit (for validation / docs). */
export const SEMANTIC_VERBS = Object.freeze([
  ...new Set([
    ...Object.values(BASE_VERB_BY_INTERACTION),
    ...Object.values(ROLE_SEMANTIC_VERB_MAP).flatMap((m) => Object.values(m)),
    'unknown-interaction',
  ]),
]);

const SCORE_ACTIVE_PERSPECTIVE = 1000;
const SCORE_RECENCY = 50;

/**
 * @param {string} interactionKind
 * @param {string} [role]
 * @returns {string}
 */
export function semanticVerb(interactionKind, role) {
  const kind = String(interactionKind || '').trim();
  const r = role != null && String(role).trim() ? String(role).trim().toLowerCase() : '';
  if (r && ROLE_SEMANTIC_VERB_MAP[r]?.[kind]) {
    return ROLE_SEMANTIC_VERB_MAP[r][kind];
  }
  return BASE_VERB_BY_INTERACTION[kind] ?? 'unknown-interaction';
}

/**
 * Heuristic selector strength for ambiguous tie-break (0–3).
 * @param {string} selectorUsed
 * @returns {number}
 */
export function selectorSpecificityScore(selectorUsed) {
  const s = String(selectorUsed || '');
  if (!s) return 0;
  if (/(#[\w-]+)|\[id\s*=\s*['"]/i.test(s)) return 3;
  if (/\[role\s*=/i.test(s)) return 2.5;
  if (/\[(aria-label|name)\s*=/i.test(s)) return 2;
  if (/:nth(-child)?\s*\(/i.test(s)) return 0.5;
  return 1;
}

/**
 * @param {object} match
 * @param {object} context
 * @returns {number}
 */
export function scoreMatch(match, context = {}) {
  const m = match || {};
  const active = Array.isArray(context.activePerspectiveIds)
    ? context.activePerspectiveIds
    : [];
  const recent = Array.isArray(context.recentEvents) ? context.recentEvents : [];

  let score = 0;
  if (m.perspectiveId && active.includes(m.perspectiveId)) {
    score += SCORE_ACTIVE_PERSPECTIVE;
  }
  score += Math.round(selectorSpecificityScore(m.selectorUsed) * 100);
  if (typeof m.confidence === 'number') {
    score += Math.round(Math.max(0, Math.min(1, m.confidence)) * 100);
  }
  const last = recent[recent.length - 1];
  const lastPid = last?.classification?.primary?.perspectiveId
    ?? last?.classification?.candidates?.[0]?.perspectiveId;
  if (lastPid && m.perspectiveId === lastPid) {
    score += SCORE_RECENCY;
  }
  return score;
}

/**
 * @param {Array<object>} matches
 * @param {object} context
 * @returns {Array<object>} ranked with score, semanticVerb
 */
export function rankMatches(matches, context = {}) {
  const list = Array.isArray(matches) ? matches.filter((m) => m?.landmarkUid && m?.perspectiveId) : [];
  const ranked = list.map((m) => {
    const role = m.role;
    const verb = semanticVerb(context._interactionKind ?? context.interactionKind, role);
    return {
      landmarkUid: m.landmarkUid,
      perspectiveId: m.perspectiveId,
      role: role ?? undefined,
      semanticVerb: verb,
      score: scoreMatch(m, context),
      selectorUsed: m.selectorUsed,
      confidence: m.confidence,
    };
  });
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.landmarkUid).localeCompare(String(b.landmarkUid));
  });
  return ranked;
}

/**
 * @param {object} raw
 * @returns {boolean}
 */
export function validateRawUserEvent(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (typeof raw.id !== 'string' || !raw.id) return false;
  if (typeof raw.ts !== 'number') return false;
  if (typeof raw.tabId !== 'number') return false;
  if (typeof raw.url !== 'string') return false;
  return INTERACTION_KINDS.includes(raw.interactionKind);
}

/**
 * @param {object} resolved
 * @returns {boolean}
 */
export function validateResolvedUserEvent(resolved) {
  if (!resolved || typeof resolved !== 'object') return false;
  if (!validateRawUserEvent(resolved.raw)) return false;
  if (!RESOLUTION_STATUSES.includes(resolved.resolutionStatus)) return false;
  if (!Array.isArray(resolved.matches)) return false;
  if (!Array.isArray(resolved.activePerspectiveIds)) return false;
  return true;
}

function _effectiveGroundId(resolved, context) {
  if (context?.groundId != null) return context.groundId;
  return resolved.groundId ?? null;
}

function _pageEnrichment(context, activePerspectiveIds) {
  const archetypeId = context?.siteMapNode?.archetypeId;
  const n = activePerspectiveIds?.length ?? 0;
  if (!archetypeId && n === 0) return undefined;
  const page = {};
  if (archetypeId) page.archetypeId = archetypeId;
  if (n > 0) page.activePredicateSummary = `${n} perspective(s) active`;
  return page;
}

function _candidateFromRanked(row) {
  return {
    landmarkUid: row.landmarkUid,
    perspectiveId: row.perspectiveId,
    role: row.role,
    semanticVerb: row.semanticVerb,
    score: row.score,
  };
}

function _primaryFromRanked(row) {
  return {
    landmarkUid: row.landmarkUid,
    perspectiveId: row.perspectiveId,
    role: row.role,
    semanticVerb: row.semanticVerb,
  };
}

/**
 * Classify a resolved user event (L2 only).
 * @param {object} resolved  ResolvedUserEvent
 * @param {object} [context] ClassificationContext
 * @returns {object} UserActionClassification
 */
export function classifyResolved(resolved, context = {}) {
  const groundId = _effectiveGroundId(resolved, context);
  const activePerspectiveIds = Array.isArray(context.activePerspectiveIds)
    ? context.activePerspectiveIds
    : (resolved.activePerspectiveIds ?? []);
  const interactionKind = resolved.raw?.interactionKind ?? '';
  const rankCtx = {
    ...context,
    activePerspectiveIds,
    interactionKind,
    _interactionKind: interactionKind,
  };

  const page = _pageEnrichment(context, activePerspectiveIds);

  if (resolved.resolutionStatus === 'suppressed') {
    return { tier: 'unresolved', unresolvedReason: 'suppressed', ...(page ? { page } : {}) };
  }

  if (groundId == null) {
    return { tier: 'unresolved', unresolvedReason: 'no-ground', ...(page ? { page } : {}) };
  }

  if (interactionKind === 'navigate') {
    return { tier: 'browser', browserContext: 'navigate', ...(page ? { page } : {}) };
  }
  if (interactionKind === 'tab-activate') {
    return { tier: 'browser', browserContext: 'tab-switch', ...(page ? { page } : {}) };
  }

  if (resolved.resolutionStatus === 'miss') {
    return { tier: 'unresolved', unresolvedReason: 'miss', ...(page ? { page } : {}) };
  }

  const matches = resolved.matches ?? [];
  if (
    (resolved.resolutionStatus === 'ambiguous' || resolved.resolutionStatus === 'hit')
    && matches.length >= 1
  ) {
    const ranked = rankMatches(matches, rankCtx);
    const candidates = ranked.map(_candidateFromRanked);
    const primary = ranked.length ? _primaryFromRanked(ranked[0]) : undefined;
    const out = { tier: 'substrate', ...(page ? { page } : {}) };
    if (primary) out.primary = primary;
    if (resolved.resolutionStatus === 'ambiguous' && candidates.length) {
      out.candidates = candidates;
    }
    return out;
  }

  return { tier: 'unresolved', unresolvedReason: 'miss', ...(page ? { page } : {}) };
}

/**
 * @param {object} resolved
 * @param {object} [context]
 * @param {{ id?: string }} [opts]
 * @returns {object} ClassifiedUserEvent
 */
export function classifyUserAction(resolved, context = {}, opts = {}) {
  if (!validateResolvedUserEvent(resolved)) {
    throw new Error('classifyUserAction: invalid ResolvedUserEvent');
  }
  const classification = classifyResolved(resolved, context);
  const seed = `${resolved.raw.ts}|${resolved.raw.tabId}|${resolved.raw.interactionKind}`;
  const id = opts.id ?? mintEventId(seed);
  const groundId = _effectiveGroundId(resolved, context);

  return {
    id,
    ts: resolved.raw.ts,
    tabId: resolved.raw.tabId,
    groundId,
    interactionKind: resolved.raw.interactionKind,
    resolutionStatus: resolved.resolutionStatus,
    matches: resolved.matches,
    activePerspectiveIds: Array.isArray(context.activePerspectiveIds)
      ? context.activePerspectiveIds
      : (resolved.activePerspectiveIds ?? []),
    classification,
    schema: CLASSIFICATION_SCHEMA,
  };
}
