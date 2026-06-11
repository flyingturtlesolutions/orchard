/**
 * @file Services/PerspectiveDescription.js
 * @description Pure description-composer for perspective landmark lists.
 * Mirrors the FragmentDescription / ObservationDescription pattern so
 * perspectives get auto-generated, human-readable summaries at save time.
 *
 * Used by:
 *   - Sidepanel/modes/perspective-capture.js — at save time, to write a
 *     descriptive summary into the perspective record's description field
 *     when the author left it blank.
 *   - studio.js — render-time fallback when a stored description is
 *     empty (regenerate from landmarks rather than show "—").
 *
 * Single format (compact) for now. The verbose form would essentially
 * be the landmark list, which the UI already renders, so a separate
 * verbose description doesn't add value.
 *
 * Determinism: pure functions, no DOM, no async, no I/O. Same input
 * always produces same output.
 *
 * @module Services/PerspectiveDescription
 */

/**
 * Compose a compact description from a perspective's landmarks.
 *
 * Format examples:
 *   1 landmark:   "Landmark: search input."
 *   2 landmarks:  "Landmarks: search input and results list."
 *   3+ landmarks: "Landmarks: search input, results list, and pagination controls."
 *   0 landmarks:  "Empty perspective (no landmarks)."
 *
 * Falls back to the selector tail when a landmark's role is missing
 * — exists rarely (the schema enforces role at save time) but
 * defensive in case of legacy/partial records.
 *
 * @param {Array<Object>} landmarks - Array of { role, selector, ... }
 * @returns {string}
 */
export function composeCompactDescription(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length === 0) {
    return 'Empty perspective (no landmarks).';
  }

  const roles = landmarks
    .map(lm => _humanizeRole(lm))
    .filter(Boolean);

  if (roles.length === 0) return 'Empty perspective (no landmarks).';

  const label = roles.length === 1 ? 'Landmark' : 'Landmarks';

  let body;
  if (roles.length === 1) {
    body = roles[0];
  } else if (roles.length === 2) {
    body = `${roles[0]} and ${roles[1]}`;
  } else {
    const head = roles.slice(0, -1).join(', ');
    body = `${head}, and ${roles[roles.length - 1]}`;
  }
  return `${label}: ${body}.`;
}

/**
 * v2.74.231 — Convenience alias so the import surface matches
 * FragmentDescription / ObservationDescription. Single format for now;
 * a future verbose form would just list one landmark per line, which
 * the UI already shows, so we don't add a separate verbose path.
 */
export function composeDescriptions(landmarks) {
  const compact = composeCompactDescription(landmarks);
  return { compact, verbose: compact };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Humanize a landmark's role for the description. Roles in storage are
 * lowercase-hyphenated tokens (e.g. "search-input", "results-list");
 * the user reads them better with spaces. Empty roles fall back to a
 * selector hint so the description doesn't drop landmarks silently.
 *
 * @param {Object} lm
 * @returns {string}
 */
function _humanizeRole(lm) {
  // v2.74.275 — Storage field renamed: role → alias.
  const role = (lm?.alias ?? '').toString().trim();
  if (role) {
    return role.replace(/[-_]+/g, ' ').toLowerCase();
  }
  // Defensive fallback — landmarks should always have a role, but
  // legacy records or mid-edit drafts might not.
  const sel = (lm?.selector ?? '').toString().trim();
  if (!sel) return '';
  return `(${_selectorTail(sel)})`;
}

function _selectorTail(sel) {
  const parts = sel.split(/[\s>+~]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? sel;
  return `\`${last}\``;
}
