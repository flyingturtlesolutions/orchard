/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/text.js
 * @description text shape — capture the textContent of one element.
 *
 * v2.74.131 — Introduced as part of the scalar/raw_text split. Replaces
 * the pre-v2.74.131 `raw_text` shape entirely (functionally identical:
 * both call el.textContent.trim() in the content script) AND the
 * scalar-with-extract.kind='text' authoring path. The legacy shapes
 * still load via StorageManager.#migrateObservationShape, which
 * rewrites them to this shape on read.
 *
 * No authoring-time configuration — there's only one way to capture
 * text from an element. The form renders just target + output bindings;
 * everything else is delegated to the extractCard frame.
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/text
 */

export const text = Object.freeze({
  id   : 'text',
  label: 'Text',
  hint : 'textContent of one element',
  tier : 'cache',
  defaults: () => ({ shape: 'text', target: '', output: '' }),
  renderExtras: () => '',
  wireExtras  : () => { /* no-op */ },
  validate    : (ex) => {
    if (!ex.target) return 'target required';
    return null;
  },
});
