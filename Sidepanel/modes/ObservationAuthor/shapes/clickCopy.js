/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/clickCopy.js
 * @description click_copy shape — atomically clicks a copy-to-clipboard
 * button and reads the resulting clipboard text.
 *
 * v2.74.219 — Introduced for format-agnostic chat reply extraction.
 *
 * Motivation:
 *   DOM-based text extraction (text, text_last, section) is fragile for
 *   AI chat surfaces because the same logical "reply" renders in
 *   radically different DOM structures depending on content type — a
 *   plain-text reply lives in a markdown div, a CSV reply lives in a
 *   table/CSV viewer component, a code reply lives in a code-block
 *   formatter, etc. Each format requires its own selector and the
 *   markdown div for non-text replies is often EMPTY.
 *
 *   Most modern AI chats (HubSpot Breeze, ChatGPT, Claude.ai, Slack
 *   AI, Discord AI) ship a per-message "Copy" button that knows how
 *   to serialize the message to text in its canonical form. Clicking
 *   that button and reading the clipboard gives the same answer the
 *   user would get by selecting + copy-paste — format-agnostic by
 *   construction.
 *
 * Fields:
 *   - target  CSS selector for the copy button (often :last-of-type
 *             scoped to the AI message wrapper, e.g.
 *             `[data-test-id="copy-button"]:last-of-type`)
 *   - output  Binding name for the captured text
 *
 * Runtime:
 *   1. Resolve the button via document.querySelector(target).
 *   2. Click it (synthetic click — fires the page's onclick handler
 *      which writes to navigator.clipboard).
 *   3. Wait ~150ms for the page to finish writing.
 *   4. Read navigator.clipboard.readText() and return.
 *
 * Permissions:
 *   manifest.json must include "clipboardRead" — added in v2.74.219.
 *
 * Caveats:
 *   - Overwrites the user's existing clipboard contents (workflow side
 *     effect — document this in author guidance).
 *   - If the page's copy button doesn't actually write to the clipboard
 *     (some apps use a textarea-select hack), this shape returns empty.
 *     Future enhancement: fallback path that reads from a target text
 *     attribute when clipboard is empty.
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/clickCopy
 */

export const clickCopy = Object.freeze({
  id   : 'click_copy',
  label: 'Click Copy → Clipboard',
  hint : 'Click a copy-to-clipboard button, return the clipboard text (format-agnostic)',
  tier : 'cache',
  defaults: () => ({ shape: 'click_copy', target: '', output: '' }),
  renderExtras: () => '',
  wireExtras  : () => { /* no-op */ },
  validate    : (ex) => {
    if (!ex.target) return 'copy button target required';
    return null;
  },
});

/**
 * v2.74.222 — Last-match variant for chat / feed UIs that render one
 * copy button per AI message. Same mechanics as click_copy, but the
 * content script picks the LAST querySelectorAll match instead of the
 * first — i.e., the most recently rendered copy button, which is the
 * button for the most recent AI reply.
 *
 * Mirrors the text / text_last split. Authors pick the shape that
 * matches their semantic intent: "the copy button" → click_copy;
 * "the latest copy button" → click_copy_last.
 */
export const clickCopyLast = Object.freeze({
  id   : 'click_copy_last',
  label: 'Click Copy (latest) → Clipboard',
  hint : 'Click the LATEST copy button matching the selector (for chat tails)',
  tier : 'cache',
  defaults: () => ({ shape: 'click_copy_last', target: '', output: '' }),
  renderExtras: () => '',
  wireExtras  : () => { /* no-op */ },
  validate    : (ex) => {
    if (!ex.target) return 'copy button target required';
    return null;
  },
});
