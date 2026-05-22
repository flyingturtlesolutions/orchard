/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/imageRead.js
 * @description image_read shape (Free Extract). Mirrors image_snap's
 * click-and-drag capture flow but adds a description field. Verify
 * sends the cropped image + description to Claude (vision) and
 * returns a curated list of values the author asked for.
 *
 * Schema:
 *   {
 *     shape      : 'image_read',
 *     rect       : { x, y, width, height },    // viewport-relative CSS pixels
 *     scrollY    : number,
 *     viewport   : { width, devicePixelRatio },
 *     description: 'what you want Claude to read from the image',
 *     output     : 'NAME',
 *   }
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/imageRead
 * @version 2.74.62
 */

const escAttr = (s) => String(s ?? '').replace(/"/g, '&quot;');
const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const imageRead = Object.freeze({
  id   : 'image_read',
  label: 'Image (read)',
  hint : 'click-and-drag a rectangle → describe what to read → Claude returns values',
  tier : 'cache',

  defaults: () => ({
    shape      : 'image_read',
    rect       : null,    // populated by SNAP_RESULT
    scrollY    : 0,
    viewport   : { width: 0, devicePixelRatio: 1 },
    description: '',
    output     : '',
  }),

  // Free-extract family — no target row. Snap gesture captures the
  // rect, just like image_snap. `instantCapture` is intentionally NOT
  // set so the Snap button stays in the capture row.
  customCaptureUI: true,

  renderExtras: (ex, exIdx) => {
    const rectLine = ex.rect
      ? (() => {
          const { x, y, width, height } = ex.rect;
          return `
            <div class="oa-snap-rect" data-ex-idx="${exIdx}">
              <span class="oa-extract-label">Rect:</span>
              <span class="oa-snap-rect-coords">${x}, ${y} · ${width} × ${height}</span>
              <span class="oa-snap-rect-meta">scroll y=${ex.scrollY}, dpr=${ex.viewport?.devicePixelRatio ?? 1}</span>
            </div>`;
        })()
      : `
        <div class="oa-snap-rect-empty" data-ex-idx="${exIdx}">
          No region captured yet — click <strong>Snap</strong>, then drag a rectangle on the page.
        </div>`;
    return `
      <div class="oa-image-read-extras" data-oa-ex-extras="image_read" data-ex-idx="${exIdx}">
        ${rectLine}
        <label class="oa-image-read-desc-field">
          <span class="oa-extract-label">Description:</span>
          <textarea class="oa-image-read-desc"
                    data-oa-image-read-desc="1" data-ex-idx="${exIdx}"
                    rows="2"
                    placeholder="What should Claude read from the image? e.g. 'all visible prices', 'product names', 'the address on the receipt'">${escHtml(ex.description ?? '')}</textarea>
        </label>
      </div>
    `;
  },

  wireExtras: (rootEl, ex, exIdx, ctx) => {
    const descEl = rootEl.querySelector(
      `textarea.oa-image-read-desc[data-ex-idx="${exIdx}"]`
    );
    if (!descEl) return;
    descEl.addEventListener('input', (e) => {
      ex.description = e.target.value;
      ctx.onChange?.();
    });
  },

  validate: (ex) => {
    if (!ex.rect) return 'rect required (click Snap, then drag on the page)';
    const r = ex.rect;
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) return 'rect.x and rect.y must be numeric';
    if (!(r.width > 0) || !(r.height > 0)) return 'rect must have positive width and height';
    if (typeof ex.description !== 'string' || !ex.description.trim()) {
      return 'description required (what should Claude read from the image?)';
    }
    return null;
  },
});

// Silence unused-import lint — escAttr is reserved for any data-attr
// usage future renderExtras revisions may need.
void escAttr;
