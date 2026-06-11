/**
 * @file Sidepanel/modes/ObservationAuthor/extractCard.js
 * @description Outer chrome for one Extract card. Renders the common
 * fields (output binding, shape selector, target row with Pick + Verify,
 * remove button) and delegates shape-specific extras to the per-shape
 * module under shapes/.
 *
 * The card has a per-extract verified state ({ success: bool, summary?,
 * error? } | null) which the outer mode tracks. Verify dispatches a
 * tier-appropriate OBSERVE_* message to the content script, mirroring
 * what ExecutionEngine#executeObservationCache does at runtime — this
 * gives the author an exact preview, not a stand-in.
 *
 * @module Sidepanel/modes/ObservationAuthor/extractCard
 */

import { getShape, cacheShapes, freeExtractShapes } from './shapes/index.js';

const escAttr = (s) => String(s ?? '').replace(/"/g, '&quot;');
const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Render one extract card.
 *
 * @param {Object} ex     - The extract object (mutated in-place by handlers).
 * @param {number} exIdx  - Index in the extracts array.
 * @param {Object} state  - { tier, verifying:Set<idx>, verified:Map<idx, {success, summary?, error?}> }
 * @returns {string} HTML string
 */
export function renderExtractCard(ex, exIdx, state) {
  const shape = getShape(ex.shape);
  // v2.74.19 — Cards split into two families by capture mechanism:
  //   - DOM picker shapes (the original 8): selectable from a shape
  //     dropdown built from cacheShapes()
  //   - Free-extract shapes (image_snap, future video_snap): each has
  //     its own dedicated card type. The shape dropdown only lists the
  //     OTHER free-extract shapes when in this family.
  const isFreeExtract = !!shape?.customCaptureUI;
  const shapeOptionsList = isFreeExtract ? freeExtractShapes() : cacheShapes();
  const shapeOptions = shapeOptionsList
    .map(s => `<option value="${escAttr(s.id)}" ${s.id === ex.shape ? 'selected' : ''}>${escHtml(s.label)}</option>`)
    .join('');

  const isVerifying = state.verifying.has(exIdx);
  const v = state.verified.get(exIdx);
  // Verified accent is family-aware: + Extract (DOM picker) cards adopt
  // the violet accent of the + Extract button; + Free Extract cards adopt
  // the teal accent of the + Free Extract button. Both retain the base
  // .oa-extract-card-verified class for any rules that target either.
  let accentClass = 'oa-extract-card';
  if (isVerifying) accentClass += ' oa-extract-card-verifying';
  else if (v?.success === true) {
    accentClass += isFreeExtract
      ? ' oa-extract-card-verified oa-extract-card-verified-free'
      : ' oa-extract-card-verified oa-extract-card-verified-picker';
  }
  else if (v?.success === false) accentClass += ' oa-extract-card-failed';

  // Shape-specific extras (renderExtras returns '' for shapes with none)
  const extrasHtml = shape ? shape.renderExtras(ex, exIdx) : '';

  // Per-card status row. For verified image-bearing shapes we show a
  // thumbnail of the captured/picked image; for shapes that returned
  // Claude-distilled items (section, image_read) we also render the
  // items list. image_read returns BOTH a thumbnail (the cropped
  // region) and items (Claude's reply), so the rendering composes them
  // rather than branching either/or.
  //
  // v2.74.144 — Fixed image_read rendering. Previously the conditional
  // was `if thumbnail else if items`, which silently swallowed Claude's
  // reply because the thumbnail branch always won. Now thumbnail and
  // items are independently composed under one ok-status container so
  // image_read shows both the captured crop AND what Claude read from
  // it. (Section keeps its items-only path because section verify
  // doesn't return a thumbnail.)
  let statusHtml = '';
  if (!isVerifying && v?.success === false && v.error) {
    statusHtml = `<div class="oa-extract-status oa-extract-status-error">${escHtml(v.error)}</div>`;
  } else if (!isVerifying && v?.success === true) {
    let thumbBlock = '';
    if (v.thumbnail) {
      const dims = (Number.isFinite(v.width) && Number.isFinite(v.height))
        ? `${v.width} × ${v.height}` : '';
      const ts = Number.isFinite(v.verifiedAt)
        ? new Date(v.verifiedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '';
      const nameLine = ex.output ? `<div class="oa-extract-status-meta-name">${escHtml(ex.output)}</div>` : '';
      const dimsLine = dims ? `<div class="oa-extract-status-meta-dims">${escHtml(dims)}</div>` : '';
      const tsLine   = ts   ? `<div class="oa-extract-status-meta-ts">${escHtml(ts)}</div>` : '';
      thumbBlock = `
        <div class="oa-extract-status-thumb-row">
          <a class="oa-extract-thumb-link" href="${escAttr(v.thumbnail)}" target="_blank" rel="noopener noreferrer" title="Open full-size in new tab">
            <img class="oa-extract-thumb" src="${escAttr(v.thumbnail)}" alt="capture preview" />
          </a>
          <div class="oa-extract-status-meta">${nameLine}${dimsLine}${tsLine}</div>
        </div>`;
    }

    let itemsBlock = '';
    if (Array.isArray(v.items) && v.items.length > 0) {
      const isUrlMode = v.itemsMode === 'url';
      const rowsHtml = v.items.map(item => {
        if (isUrlMode) {
          return `<div class="oa-section-item oa-section-item-url">
            <a class="oa-section-item-link" href="${escAttr(item)}" target="_blank" rel="noopener noreferrer" title="Open in new tab">${escHtml(item)}</a>
          </div>`;
        }
        return `<div class="oa-section-item oa-section-item-text">${escHtml(item)}</div>`;
      }).join('');
      // Header line clarifies the provenance when a thumbnail is also
      // present — the items came from Claude reading the image above.
      const headerLine = v.thumbnail
        ? '<div class="oa-section-item-list-header">Claude read:</div>'
        : '';
      itemsBlock = `${headerLine}<div class="oa-section-item-list">${rowsHtml}</div>`;
    }

    if (thumbBlock || itemsBlock) {
      const summaryLine = (!v.thumbnail && v.summary)
        ? `<div class="oa-extract-status-text">${escHtml(v.summary)}</div>`
        : '';
      statusHtml = `<div class="oa-extract-status oa-extract-status-ok">
        ${summaryLine}${thumbBlock}${itemsBlock}
      </div>`;
    } else {
      statusHtml = `<div class="oa-extract-status oa-extract-status-ok"><span class="oa-extract-status-text">${escHtml(v.summary ?? 'ok')}</span></div>`;
    }
  }

  const verifyText = isVerifying ? 'Verifying…' : 'Verify';

  // Capture/Verify row: differs by family.
  // - DOM picker family: target input + Pick + Verify
  // - Free extract family (image_snap): no target input; Snap + Verify.
  //   Verify enables once a rect has been captured.
  // v2.74.51 — Free-extract shapes that set `instantCapture: true`
  // (image_full) have no Snap gesture — just a Verify button that
  // grabs the full visible viewport on click.
  let captureRow;
  if (isFreeExtract && shape?.instantCapture) {
    const verifyDisabled = isVerifying ? 'disabled' : '';
    captureRow = `
      <div class="oa-extract-snap-row">
        <button type="button" class="btn-secondary tiny"
                data-oa-ex-action="verify" data-ex-idx="${exIdx}" ${verifyDisabled}>${verifyText}</button>
      </div>`;
  } else if (isFreeExtract) {
    const verifyDisabled = (!ex.rect || isVerifying) ? 'disabled' : '';
    captureRow = `
      <div class="oa-extract-snap-row">
        <button type="button" class="btn-secondary tiny"
                data-oa-ex-action="snap" data-ex-idx="${exIdx}">Snap</button>
        <button type="button" class="btn-secondary tiny"
                data-oa-ex-action="verify" data-ex-idx="${exIdx}" ${verifyDisabled}>${verifyText}</button>
      </div>`;
  } else {
    const verifyDisabled = (!ex.target || isVerifying) ? 'disabled' : '';
    captureRow = `
      <div class="oa-extract-target-row">
        <input type="text" class="oa-extract-target"
               data-oa-ex-field="target" data-ex-idx="${exIdx}"
               placeholder="CSS selector (target element)"
               value="${escAttr(ex.target ?? '')}" />
        <button type="button" class="btn-secondary tiny"
                data-oa-ex-action="pick" data-ex-idx="${exIdx}">Pick</button>
        <button type="button" class="btn-secondary tiny"
                data-oa-ex-action="verify" data-ex-idx="${exIdx}" ${verifyDisabled}>${verifyText}</button>
      </div>`;
  }

  return `
    <div class="${accentClass}" data-oa-ex-card data-ex-idx="${exIdx}">
      <div class="oa-extract-card-head">
        <span class="oa-extract-order">${exIdx + 1}.</span>
        <select class="oa-extract-shape-select" data-oa-ex-field="shape" data-ex-idx="${exIdx}">
          ${shapeOptions}
        </select>
        <input type="text" class="oa-extract-output"
               data-oa-ex-field="output" data-ex-idx="${exIdx}"
               placeholder="OUTPUT_NAME"
               value="${escAttr(ex.output ?? '')}" />
        <button type="button" class="btn-action danger"
                data-oa-ex-action="remove" data-ex-idx="${exIdx}"
                title="Remove this extract">✕</button>
      </div>

      ${captureRow}

      ${extrasHtml}

      ${statusHtml}
    </div>
  `;
}

/**
 * Attach event handlers to a freshly-rendered extract card.
 *
 * @param {HTMLElement} listEl  - Container holding all extract cards.
 * @param {Object}      ex      - The extract object (mutated by handlers).
 * @param {number}      exIdx
 * @param {Object}      ctx     - {
 *                                  onChange()         : called after any field edit
 *                                  renderAll()        : full re-render of the extracts list
 *                                  onRemove(exIdx)    : remove this extract
 *                                  onPick(exIdx)      : start a Pick session targeting this extract
 *                                  onVerify(exIdx)    : run Verify against this extract
 *                                }
 */
export function wireExtractCard(listEl, ex, exIdx, ctx) {
  const cardEl = listEl.querySelector(`[data-oa-ex-card][data-ex-idx="${exIdx}"]`);
  if (!cardEl) return;

  // Shape selector — change resets per-shape extras to defaults but keeps
  // output (universal). Target is preserved only when switching between
  // shapes that both use targets (DOM picker family). Switching INTO a
  // free-extract shape (or out of one) resets the capture state.
  cardEl.querySelector(`select[data-oa-ex-field="shape"]`)?.addEventListener('change', (e) => {
    const newShapeId = e.target.value;
    const newShape = getShape(newShapeId);
    if (!newShape) return;
    const oldUsesTarget = !shape?.customCaptureUI;
    const newUsesTarget = !newShape.customCaptureUI;
    const carriedTarget = (oldUsesTarget && newUsesTarget) ? (ex.target ?? '') : '';
    const carriedOutput = ex.output ?? '';
    Object.keys(ex).forEach(k => delete ex[k]);
    Object.assign(ex, newShape.defaults());
    if (newUsesTarget) ex.target = carriedTarget;
    ex.output = carriedOutput;
    ctx.renderAll();
  });

  // output (binding name) — uppercase + strip whitespace
  cardEl.querySelector(`input[data-oa-ex-field="output"]`)?.addEventListener('input', (e) => {
    ex.output = e.target.value.replace(/\s/g, '').toUpperCase();
    e.target.value = ex.output;
    ctx.onChange();
  });

  // target
  cardEl.querySelector(`input[data-oa-ex-field="target"]`)?.addEventListener('input', (e) => {
    ex.target = e.target.value;
    // v2.74.211 — Keep the iframe binding on hand-typing. Previously
    // (v2.74.198) we dropped `frameUrl` whenever the author edited
    // the target, on the theory that "a manually-typed selector is
    // implicitly top-frame." That's wrong: in iframe-heavy UIs (chat
    // widgets, embedded apps) the author Picks once to establish the
    // frame context, then tweaks the selector — typing was silently
    // breaking the frame binding and routing verify back to the top
    // frame, where the selector matches 0 elements. Keep frameUrl
    // until the author re-Picks (which re-sets it) or removes the
    // extract entirely.
    ctx.onChange();
  });

  // remove
  cardEl.querySelector(`[data-oa-ex-action="remove"]`)?.addEventListener('click', () => {
    ctx.onRemove(exIdx);
  });

  // pick (DOM picker family)
  cardEl.querySelector(`[data-oa-ex-action="pick"]`)?.addEventListener('click', () => {
    ctx.onPick(exIdx);
  });

  // v2.74.19 — snap (free-extract family). Same conceptual role as Pick
  // but kicks off a click-and-drag rectangle session in the content
  // script instead of a DOM-element pick.
  cardEl.querySelector(`[data-oa-ex-action="snap"]`)?.addEventListener('click', () => {
    ctx.onSnap(exIdx);
  });

  // verify
  cardEl.querySelector(`[data-oa-ex-action="verify"]`)?.addEventListener('click', () => {
    ctx.onVerify(exIdx);
  });

  // Thumbnail click — intercept and open via blob URL. Chrome blocks
  // top-level navigation to data: URLs from anchor clicks since 2017
  // (lands on about:blank), but blob: URLs work fine. We convert the
  // captured data URL to a blob, hand the blob URL to chrome.tabs.create,
  // and revoke it after a minute (long enough for the new tab to load).
  cardEl.querySelector('.oa-extract-thumb-link')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const dataUrl = e.currentTarget.getAttribute('href');
    if (!dataUrl) return;
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const blobUrl = URL.createObjectURL(blob);
      await chrome.tabs.create({ url: blobUrl });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (err) {
      console.warn('[extractCard] thumbnail open failed:', err);
    }
  });

  // Shape-specific extras
  const shape = getShape(ex.shape);
  if (shape) shape.wireExtras(cardEl, ex, exIdx, ctx);
}
