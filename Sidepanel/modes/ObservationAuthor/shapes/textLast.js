/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/textLast.js
 * @description text_last shape — capture the textContent of the LAST
 * element matching the selector in document order.
 *
 * v2.74.214 — Introduced for "latest item in a feed" extraction. The
 * standard `text` shape uses `document.querySelector`, which returns
 * the FIRST match in document order. In chat UIs, log tails, and
 * notification streams, the relevant element is the LAST match. Common
 * pattern: a class repeats per item (`.message-bubble`, styled-components
 * hash on a wrapper, etc.) and CSS `:last-of-type` doesn't help because
 * the matches aren't siblings of each other.
 *
 * Same authoring fields as `text` (just target + output bindings). The
 * "last match" behavior is communicated to the content script via a
 * `pickLast:true` flag on the OBSERVE_RAW_TEXT payload — no new message
 * type required.
 *
 * v2.74.216 — Read mode switched from el.textContent to el.innerText.
 * For chat/feed extraction the "visible text as a human sees it" is
 * the right semantic; textContent picks up hidden accessibility helpers
 * (off-screen TruncateString measurement spans, etc.) and produces
 * duplicates like "Adam MillerAdam Miller". innerText respects CSS
 * visibility so those duplicates vanish automatically. The legacy
 * `text` shape continues to use textContent for back-compat.
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/textLast
 */

export const textLast = Object.freeze({
  id   : 'text_last',
  label: 'Text (latest)',
  hint : 'innerText of the LAST matching element (visible-text, for chat/feed tails)',
  tier : 'cache',
  defaults: () => ({ shape: 'text_last', target: '', output: '' }),
  renderExtras: () => '',
  wireExtras  : () => { /* no-op */ },
  validate    : (ex) => {
    if (!ex.target) return 'target required';
    return null;
  },
});
