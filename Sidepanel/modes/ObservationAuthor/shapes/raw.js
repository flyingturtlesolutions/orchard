/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/raw.js
 * @description raw_text and raw_html shapes. Both capture one element's
 * full content (textContent or outerHTML respectively); no extras beyond
 * target + output binding.
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/raw
 * @version 2.74.16
 */

export const rawText = Object.freeze({
  id   : 'raw_text',
  label: 'Raw text',
  hint : 'full textContent of one element',
  tier : 'cache',
  defaults: () => ({ shape: 'raw_text', target: '', output: '' }),
  renderExtras: () => '',
  wireExtras  : () => { /* no-op */ },
  validate    : (ex) => {
    if (!ex.target) return 'target required';
    return null;
  },
});

export const rawHtml = Object.freeze({
  id   : 'raw_html',
  label: 'Raw HTML',
  hint : 'full outerHTML of one element',
  tier : 'cache',
  defaults: () => ({ shape: 'raw_html', target: '', output: '' }),
  renderExtras: () => '',
  wireExtras  : () => { /* no-op */ },
  validate    : (ex) => {
    if (!ex.target) return 'target required';
    return null;
  },
});
