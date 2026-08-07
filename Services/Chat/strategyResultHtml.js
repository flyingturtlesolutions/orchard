/**
 * @file Services/Chat/strategyResultHtml.js
 * @description Validation for strategy-result HTML bubbles (chat rehydrate safety).
 */

const INJECTION_DENY_RE = /<script|on\w+\s*=|javascript:|data:text\/html|<iframe\b/i;
const ALLOWED_TAGS = new Set(['div', 'span', 'ul', 'li', 'em', 'code']);
const TAG_RE = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi;
// CF-4.19 (chat-tab review) — ATTRIBUTES are scanned too: the tag allowlist alone let e.g. style="background:
// url(https://…)" through on an allowed div — a CSS network-beacon channel (MV3 CSP blocks scripts, not
// CSS-loaded resources). `class` is the one attribute the extension's own generated bodies use (verified
// against all stored shapes), so the WHOLE allowed shape after the tag name is one optional double-quoted
// class. A shape test (not a name scan) so boolean attributes (`contenteditable`) fail closed too.
const OPEN_TAG_REST_RE = /^(?:\s+class="[^"<>]*")?\s*$/;
// CF verify — a tag opened and never closed before EOF escapes TAG_RE entirely (it needs the `>`); the old
// name-only scan caught it. Unscannable input fails closed.
const UNTERMINATED_TAG_RE = /<[a-z/][^>]*$/i;

/**
 * Conservative prefix check for legacy bubbles missing the html persist flag.
 * @param {string} body
 */
export function looksLikeStrategyResultHtml(body) {
  if (typeof body !== 'string') return false;
  return body.trimStart().startsWith('<div class="strategy-result-headline">');
}

/**
 * @param {string} html
 * @returns {boolean}
 */
export function isSafeStrategyResultHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return false;
  if (INJECTION_DENY_RE.test(html)) return false;
  if (!looksLikeStrategyResultHtml(html)) return false;
  if (UNTERMINATED_TAG_RE.test(html)) return false;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html)) !== null) {
    if (!ALLOWED_TAGS.has(m[2].toLowerCase())) return false;
    // CF-4.19 — shape check (opening tags only): anything beyond one double-quoted class fails closed.
    if (!m[1] && m[3] && !OPEN_TAG_REST_RE.test(m[3])) return false;
  }
  return true;
}
