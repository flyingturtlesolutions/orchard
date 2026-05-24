/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/imageFull.js
 * @description image_full shape (Free Extract). Full-tab screenshot —
 * no DOM picker, no click-and-drag region. Verify simply captures the
 * current visible viewport.
 *
 * Schema:
 *   {
 *     shape: 'image_full',
 *     viewport: { width, devicePixelRatio },  // populated on first verify
 *     output: 'NAME',
 *   }
 *
 * Like image_snap, target is intentionally absent (no DOM reference).
 * Unlike image_snap, there's no rect — the full visible viewport is
 * captured. The `instantCapture` flag tells extractCard to skip the
 * Snap button and enable Verify immediately.
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/imageFull
 * @version 2.74.51
 */

export const imageFull = Object.freeze({
  id   : 'image_full',
  label: 'Image (screenshot)',
  hint : 'capture the full visible tab as an image',
  tier : 'cache',

  defaults: () => ({
    shape   : 'image_full',
    viewport: { width: 0, devicePixelRatio: 1 },
    output  : '',
  }),

  // Free-extract family (no target input), but unlike image_snap there's
  // no rect-arming gesture — extractCard branches on `instantCapture`
  // and renders only a Verify button.
  customCaptureUI: true,
  instantCapture : true,

  renderExtras: (_ex, exIdx) => {
    return `
      <div class="oa-snap-rect-empty" data-oa-ex-extras="image_full" data-ex-idx="${exIdx}">
        Captures the full visible viewport when you click <strong>Verify</strong>. At runtime, the same screenshot is taken from whatever the tab is showing at execute time.
      </div>
    `;
  },

  wireExtras: (_rootEl, _ex, _exIdx, _ctx) => {
    // No interactive extras — Verify lives in the card head row, wired
    // by extractCard.js.
  },

  validate: (_ex) => {
    // No per-shape requirement: a screenshot is always capturable. The
    // generic output-binding-name check is enforced by the outer
    // savePerspective / validateObservation flow.
    return null;
  },
});
