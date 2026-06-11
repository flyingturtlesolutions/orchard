/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/section.js
 * @description section shape. Captures a DOM subtree, then asks Claude
 * to distill it into either a list of distinct text values OR a list
 * of meaningful URLs depending on the `extract` dropdown.
 *
 * Schema:
 *   {
 *     shape  : 'section',
 *     target : '<CSS selector>',
 *     extract: 'text' | 'url',          // dropdown value, default 'text'
 *     output : '<binding name>',
 *   }
 *
 * v2.74.61 — Added the Text/URL dropdown. Verify now sends the
 * captured section data + the chosen mode to a Claude prompt that
 * returns a curated list; the list is rendered as rows beneath the
 * card (parallel to how image_snap thumbnails appear).
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/section
 */

const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escAttr = escHtml;

export const section = Object.freeze({
  id   : 'section',
  label: 'Section',
  hint : 'DOM subtree → Claude → list of texts or URLs',
  tier : 'cache',
  defaults: () => ({ shape: 'section', target: '', extract: 'text', output: '' }),
  renderExtras: (ex, exIdx) => {
    const mode = ex.extract === 'url' ? 'url' : 'text';
    return `
      <div class="oa-section-extras" data-oa-ex-extras="section" data-ex-idx="${exIdx}">
        <label class="oa-section-mode-label">
          <span class="oa-extract-label">Extract:</span>
          <select class="oa-section-mode-select"
                  data-oa-section-mode="1" data-ex-idx="${exIdx}">
            <option value="text" ${mode === 'text' ? 'selected' : ''}>Text values</option>
            <option value="url"  ${mode === 'url'  ? 'selected' : ''}>URLs</option>
          </select>
        </label>
      </div>
    `;
  },
  wireExtras: (rootEl, ex, exIdx, ctx) => {
    const sel = rootEl.querySelector(
      `select.oa-section-mode-select[data-ex-idx="${exIdx}"]`
    );
    if (!sel) return;
    sel.addEventListener('change', (e) => {
      ex.extract = e.target.value === 'url' ? 'url' : 'text';
      // Mode change invalidates any previously-shown items.
      ctx.onChange?.();
    });
  },
  validate: (ex) => {
    if (!ex.target) return 'target required';
    if (ex.extract !== 'text' && ex.extract !== 'url') {
      return `extract must be 'text' or 'url' (got "${ex.extract}")`;
    }
    return null;
  },
});

// Re-export escAttr to satisfy lints — used internally by data attrs.
void escAttr;
