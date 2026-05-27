/**
 * @file Services/Chat/strategyResultHtml.js
 * @description Validation for strategy-result HTML bubbles (chat rehydrate safety).
 */

const INJECTION_DENY_RE = /<script|on\w+\s*=|javascript:|data:text\/html|<iframe\b/i;
const ALLOWED_TAGS = new Set(['div', 'span', 'ul', 'li', 'em', 'code']);
const TAG_RE = /<(\/?)([a-z][a-z0-9]*)\b/gi;

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
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html)) !== null) {
    if (!ALLOWED_TAGS.has(m[2].toLowerCase())) return false;
  }
  return true;
}
