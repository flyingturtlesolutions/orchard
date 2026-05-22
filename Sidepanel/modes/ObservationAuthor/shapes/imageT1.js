/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/imageT1.js
 * @description image + image_list shapes for T1 (cache-tier). Both are
 * picker-driven captures.
 *
 *   image       — pick exactly one <img> element. Engine reads
 *                 src/alt/width/height, produces a tagged image value.
 *   image_list  — pick any container; engine queries for <img> descendants
 *                 and produces a list of tagged image values.
 *
 * Distinct from image_refs (which produces a list-of-records, not a list
 * of image-tagged values). Distinct from frontier-tier image / image_list
 * (same shape names, different capture mechanism: vision LLM crops a
 * screenshot region instead of picking a DOM <img>).
 *
 * Neither shape has extras beyond target + output binding. The picker
 * validates element type for `image` (rejects non-<img>); for `image_list`
 * the container can be any element.
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/imageT1
 * @version 2.74.16
 */

export const imageT1 = Object.freeze({
  id   : 'image',
  label: 'Image',
  hint : 'one <img> element → tagged image value',
  tier : 'cache',
  defaults: () => ({ shape: 'image', target: '', output: '' }),
  renderExtras: () => '',
  wireExtras  : () => { /* no-op */ },
  validate    : (ex) => {
    if (!ex.target) return 'target required';
    return null;
  },
});

export const imageListT1 = Object.freeze({
  id   : 'image_list',
  label: 'Image list',
  hint : 'container with <img> descendants → list of tagged images',
  tier : 'cache',
  defaults: () => ({ shape: 'image_list', target: '', output: '' }),
  renderExtras: () => '',
  wireExtras  : () => { /* no-op */ },
  validate    : (ex) => {
    if (!ex.target) return 'target required';
    return null;
  },
});
