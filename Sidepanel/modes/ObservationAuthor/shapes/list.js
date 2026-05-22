/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/list.js
 * @description list_of_records shape. Container target + per-field
 * selectors + per-field extract kind. Produces a list of records, one
 * per matched container element, with each field's value extracted
 * relative to the row.
 *
 * Extras UI: a sub-list of fields. Each field has:
 *   - name (binding key in the record)
 *   - selector (relative to the container row)
 *   - kind (text | attribute)
 *   - attr (when kind=attribute)
 *
 * Authors add fields incrementally with a + Field button. There is no
 * picker for field selectors in Ship B — authors type them. (Picker
 * support for relative-to-row selectors is a Ship D polish item.)
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/list
 * @version 2.74.16
 */

const escAttr = (s) => String(s ?? '').replace(/"/g, '&quot;');
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const listOfRecords = Object.freeze({
  id   : 'list_of_records',
  label: 'List of records',
  hint : 'container + per-field selectors → N records',
  tier : 'cache',

  defaults: () => ({
    shape : 'list_of_records',
    target: '',
    output: '',
    fields: [],
  }),

  renderExtras: (ex, exIdx) => {
    const fields = Array.isArray(ex.fields) ? ex.fields : [];
    const rows = fields.map((f, fi) => _renderField(f, exIdx, fi)).join('');
    return `
      <div class="oa-list-fields" data-oa-ex-extras="list" data-ex-idx="${exIdx}">
        <div class="oa-list-fields-head">
          <span class="oa-list-fields-label">Fields</span>
          <span class="oa-list-fields-count">${fields.length}</span>
          <button type="button" class="btn-secondary tiny" data-oa-ex-action="add-field" data-ex-idx="${exIdx}">+ Field</button>
        </div>
        <div class="oa-list-fields-list">${rows}</div>
        ${fields.length === 0 ? '<div class="oa-list-fields-empty">No fields yet — click + Field to add one.</div>' : ''}
      </div>
    `;
  },

  wireExtras: (rootEl, ex, exIdx, ctx) => {
    // + Field
    rootEl.querySelector(`[data-oa-ex-action="add-field"][data-ex-idx="${exIdx}"]`)?.addEventListener('click', () => {
      ex.fields = Array.isArray(ex.fields) ? ex.fields : [];
      ex.fields.push({ name: '', selector: '', kind: 'text' });
      ctx.renderAll();   // re-render so the new field row appears
    });

    const fields = Array.isArray(ex.fields) ? ex.fields : [];
    fields.forEach((f, fi) => {
      const fieldRoot = rootEl.querySelector(`[data-oa-ex-field-idx="${fi}"][data-ex-idx="${exIdx}"]`);
      if (!fieldRoot) return;

      // name
      fieldRoot.querySelector(`input[data-oa-ex-field="field-name"]`)?.addEventListener('input', (e) => {
        f.name = e.target.value.trim();
        ctx.onChange();
      });
      // selector
      fieldRoot.querySelector(`input[data-oa-ex-field="field-selector"]`)?.addEventListener('input', (e) => {
        f.selector = e.target.value;
        ctx.onChange();
      });
      // kind (text/attr)
      fieldRoot.querySelectorAll(`input[name="oa-ex-${exIdx}-field-${fi}-kind"]`).forEach(r => {
        r.addEventListener('change', () => {
          f.kind = r.value;
          if (f.kind === 'attribute' && typeof f.attr !== 'string') f.attr = '';
          if (f.kind !== 'attribute') delete f.attr;
          ctx.renderAll();   // re-render to enable/disable attr input
        });
      });
      // attr name
      fieldRoot.querySelector(`input[data-oa-ex-field="field-attr"]`)?.addEventListener('input', (e) => {
        f.attr = e.target.value.trim();
        ctx.onChange();
      });
      // remove
      fieldRoot.querySelector(`[data-oa-ex-action="remove-field"]`)?.addEventListener('click', () => {
        ex.fields.splice(fi, 1);
        ctx.renderAll();
      });
    });
  },

  validate: (ex) => {
    if (!ex.target) return 'target required';
    if (!Array.isArray(ex.fields) || ex.fields.length === 0) return 'at least one field required';
    for (let i = 0; i < ex.fields.length; i++) {
      const f = ex.fields[i];
      if (!f.name) return `field[${i}].name required`;
      if (!f.selector) return `field[${i}].selector required`;
      if (f.kind !== 'text' && f.kind !== 'attribute') return `field[${i}].kind must be text or attribute`;
      if (f.kind === 'attribute' && !f.attr) return `field[${i}].attr required`;
    }
    return null;
  },
});

function _renderField(f, exIdx, fi) {
  const isAttr = f.kind === 'attribute';
  return `
    <div class="oa-list-field-row" data-ex-idx="${exIdx}" data-oa-ex-field-idx="${fi}">
      <input type="text" class="oa-list-field-name"
             data-oa-ex-field="field-name"
             placeholder="field name (e.g. price)"
             value="${escAttr(f.name ?? '')}" />
      <input type="text" class="oa-list-field-selector"
             data-oa-ex-field="field-selector"
             placeholder="selector relative to row (e.g. .price)"
             value="${escAttr(f.selector ?? '')}" />
      <div class="oa-list-field-kind">
        <label>
          <input type="radio" name="oa-ex-${exIdx}-field-${fi}-kind" value="text" ${!isAttr ? 'checked' : ''} />
          text
        </label>
        <label>
          <input type="radio" name="oa-ex-${exIdx}-field-${fi}-kind" value="attribute" ${isAttr ? 'checked' : ''} />
          attr:
          <input type="text" data-oa-ex-field="field-attr"
                 class="oa-list-field-attr"
                 placeholder="href" maxlength="40"
                 value="${escAttr(f.attr ?? '')}" ${!isAttr ? 'disabled' : ''} />
        </label>
      </div>
      <button type="button" class="btn-action danger" data-oa-ex-action="remove-field" title="Remove field">✕</button>
    </div>
  `;
}
