/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/attribute.js
 * @description attribute shape — capture a named attribute of one
 * element (e.g. href, data-id, aria-label).
 *
 * v2.74.131 — Introduced as part of the scalar/raw_text split. Replaces
 * the pre-v2.74.131 scalar-with-extract.kind='attribute' authoring path.
 * Storage shape now carries the attribute name as a top-level `attribute`
 * field rather than nested under extract.attr — cleaner, no nesting.
 *
 * Legacy records ({shape:'scalar', extract:{kind:'attribute', attr}}) are
 * migrated on read by StorageManager.#migrateObservationShape.
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/attribute
 * @version 2.74.131
 */

const escAttr = (s) => String(s ?? '').replace(/"/g, '&quot;');

export const attribute = Object.freeze({
  id   : 'attribute',
  label: 'Attribute',
  hint : 'a named attribute of one element (href, data-id, …)',
  tier : 'cache',

  defaults: () => ({ shape: 'attribute', target: '', output: '', attribute: '' }),

  renderExtras: (ex, exIdx) => {
    const name = ex.attribute ?? '';
    return `
      <div class="oa-extract-row" data-oa-ex-extras="attribute" data-ex-idx="${exIdx}">
        <span class="oa-extract-label">Attribute name:</span>
        <input type="text" data-oa-ex-field="attribute" data-ex-idx="${exIdx}"
               placeholder="href" maxlength="40"
               class="oa-extract-attr-input" value="${escAttr(name)}" />
      </div>
    `;
  },

  wireExtras: (rootEl, ex, exIdx, ctx) => {
    const input = rootEl.querySelector(`input[data-oa-ex-field="attribute"][data-ex-idx="${exIdx}"]`);
    if (!input) return;
    input.addEventListener('input', () => {
      ex.attribute = input.value.trim();
      ctx.onChange();
    });
  },

  validate: (ex) => {
    if (!ex.target) return 'target required';
    if (typeof ex.attribute !== 'string' || ex.attribute.trim().length === 0) {
      return 'attribute name required';
    }
    return null;
  },
});
