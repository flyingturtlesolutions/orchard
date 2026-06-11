/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/imageRefs.js
 * @description image_refs shape. Captures all <img> descendants of a
 * container as a list of records (each with src/alt/width/height).
 * Distinct from `image_list` which produces tagged image values.
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/imageRefs
 */

export const imageRefs = Object.freeze({
  id   : 'image_refs',
  label: 'Image refs',
  hint : '<img> descendants as records {src, alt, width, height}',
  tier : 'cache',
  defaults: () => ({ shape: 'image_refs', target: '', output: '' }),
  renderExtras: () => '',
  wireExtras  : () => { /* no-op */ },
  validate    : (ex) => {
    if (!ex.target) return 'target required';
    return null;
  },
});
