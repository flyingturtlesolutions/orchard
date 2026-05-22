/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/scalar.js
 * @description scalar shape. One element + extract.kind ('text' or
 * 'attribute' with attr name). Produces a plain string in scope.
 *
 * Extras UI: a radio group for the extract.kind, and an attribute-name
 * input that's enabled only when kind='attribute'.
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/scalar
 * @version 2.74.16
 */

const escAttr = (s) => String(s ?? '').replace(/"/g, '&quot;');

export const scalar = Object.freeze({
  id   : 'scalar',
  label: 'Scalar',
  hint : 'one value (text or attribute) from one element',
  tier : 'cache',

  defaults: () => ({
    shape  : 'scalar',
    target : '',
    output : '',
    extract: { kind: 'text' },
  }),

  renderExtras: (ex, exIdx) => {
    const kind = ex.extract?.kind ?? 'text';
    const attr = ex.extract?.attr ?? '';
    const isAttr = kind === 'attribute';
    return `
      <div class="oa-extract-row" data-oa-ex-extras="scalar" data-ex-idx="${exIdx}">
        <span class="oa-extract-label">Extract:</span>
        <label class="oa-extract-radio">
          <input type="radio" name="oa-ex-${exIdx}-kind" value="text" ${!isAttr ? 'checked' : ''} />
          <span>Text</span>
        </label>
        <label class="oa-extract-radio">
          <input type="radio" name="oa-ex-${exIdx}-kind" value="attribute" ${isAttr ? 'checked' : ''} />
          <span>Attribute:</span>
          <input type="text" data-oa-ex-field="extract-attr" data-ex-idx="${exIdx}"
                 placeholder="href" maxlength="40"
                 class="oa-extract-attr-input" value="${escAttr(attr)}"
                 ${!isAttr ? 'disabled' : ''} />
        </label>
      </div>
    `;
  },

  wireExtras: (rootEl, ex, exIdx, ctx) => {
    const radios = rootEl.querySelectorAll(`input[name="oa-ex-${exIdx}-kind"]`);
    const attrInput = rootEl.querySelector(`input[data-oa-ex-field="extract-attr"][data-ex-idx="${exIdx}"]`);
    radios.forEach(r => {
      r.addEventListener('change', () => {
        const newKind = r.value;
        ex.extract = ex.extract ?? {};
        ex.extract.kind = newKind;
        if (newKind === 'attribute') {
          if (typeof ex.extract.attr !== 'string') ex.extract.attr = '';
        } else {
          delete ex.extract.attr;
        }
        if (attrInput) attrInput.disabled = newKind !== 'attribute';
        ctx.onChange();
      });
    });
    if (attrInput) {
      attrInput.addEventListener('input', () => {
        ex.extract = ex.extract ?? { kind: 'attribute' };
        ex.extract.attr = attrInput.value.trim();
        ctx.onChange();
      });
    }
  },

  validate: (ex) => {
    if (!ex.target) return 'target required';
    const ek = ex.extract;
    if (!ek || (ek.kind !== 'text' && ek.kind !== 'attribute')) return 'extract.kind must be text or attribute';
    if (ek.kind === 'attribute' && !ek.attr) return 'attribute name required';
    return null;
  },
});
