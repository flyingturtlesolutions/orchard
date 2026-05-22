/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/imageSnap.js
 * @description image_snap shape (Free Extract). Coordinate-based capture
 * via screenshot rather than DOM picker.
 *
 * Author flow differs from picker-based shapes:
 *   - "Pick" button becomes "Snap"
 *   - Clicking Snap arms a snap session in the content script
 *   - Author clicks-and-drags on the page (mousedown → drag → mouseup);
 *     no upfront cursor change, no overlay arming UI
 *   - Result is a rectangle relative to the viewport plus the page's
 *     scrollY at capture time (so the runtime can reproduce the page
 *     state that places the rectangle within view)
 *
 * Schema:
 *   {
 *     shape: 'image_snap',
 *     rect: { x, y, width, height },   // viewport-relative CSS pixels
 *     scrollY: number,                  // window.pageYOffset at snap time
 *     viewport: { width, devicePixelRatio },
 *     output: 'NAME',
 *   }
 *
 * Note: target is intentionally absent — image_snap doesn't reference
 * the DOM. The runtime captures the screenshot directly.
 *
 * Future: video_snap (similar shape with start/end timestamps and a
 * MediaRecorder-driven capture) is reserved as a sibling shape.
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/imageSnap
 * @version 2.74.19
 */

const escAttr = (s) => String(s ?? '').replace(/"/g, '&quot;');
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const imageSnap = Object.freeze({
  id   : 'image_snap',
  label: 'Image (snap)',
  hint : 'click-and-drag a rectangle on the page → captured as image',
  tier : 'cache',

  defaults: () => ({
    shape  : 'image_snap',
    rect   : null,    // populated by SNAP_RESULT
    scrollY: 0,
    viewport: { width: 0, devicePixelRatio: 1 },
    output : '',
  }),

  /**
   * Custom flag used by the outer extractCard: this shape replaces the
   * usual target row (selector + Pick + Verify) with a snap-mode row
   * (rect display + Snap + Verify). The card chrome reads this and
   * dispatches.
   */
  customCaptureUI: true,

  renderExtras: (ex, exIdx) => {
    // Rect summary line — shown once a rect has been captured.
    if (!ex.rect) {
      return `
        <div class="oa-snap-rect-empty" data-oa-ex-extras="image_snap" data-ex-idx="${exIdx}">
          No region captured yet — click <strong>Snap</strong>, then drag a rectangle on the page.
        </div>
      `;
    }
    const { x, y, width, height } = ex.rect;
    return `
      <div class="oa-snap-rect" data-oa-ex-extras="image_snap" data-ex-idx="${exIdx}">
        <span class="oa-extract-label">Rect:</span>
        <span class="oa-snap-rect-coords">${x}, ${y} · ${width} × ${height}</span>
        <span class="oa-snap-rect-meta">scroll y=${ex.scrollY}, dpr=${ex.viewport?.devicePixelRatio ?? 1}</span>
      </div>
    `;
  },

  wireExtras: (rootEl, ex, exIdx, ctx) => {
    // No interactive extras — Snap and Verify live in the card head row,
    // wired by extractCard.js (which checks customCaptureUI).
  },

  validate: (ex) => {
    if (!ex.rect) return 'rect required (click Snap, then drag on the page)';
    const r = ex.rect;
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) return 'rect.x and rect.y must be numeric';
    if (!(r.width > 0) || !(r.height > 0)) return 'rect must have positive width and height';
    return null;
  },
});
