/**
 * @file Sidepanel/modes/ObservationAuthor/shapes/index.js
 * @description Per-shape extract-card extras: the bits of UI specific to
 * each shape that the outer extractCard delegates rendering and event
 * wiring to.
 *
 * Every shape entry exposes:
 *   - id          shape id (string, matches Services/Observation.js
 *                 CACHE_SHAPE_IDS / FRONTIER_SHAPE_IDS)
 *   - label       short human-facing label for the shape selector dropdown
 *   - hint        one-line description shown next to the label
 *   - tier        'cache' | 'frontier' (frontier shapes hidden in T1 UI)
 *   - defaults    object literal of fields the extract gets when this
 *                 shape is selected fresh (e.g. scalar.extract = {kind:'text'})
 *   - renderExtras(ex, exIdx) → string  HTML appended below the target row;
 *                                       empty string when no extras for the shape
 *   - wireExtras(rootEl, ex, exIdx, ctx)  attach event listeners to the
 *                                       extras DOM after innerHTML is set;
 *                                       ctx provides {onChange, renderAll}
 *   - validate(ex) → string | null      shape-specific authoring-time error,
 *                                       or null when valid; complements the
 *                                       Services/Observation.js validator
 *
 * Each shape lives in its own tiny module under shapes/ for clarity. This
 * index pulls them all together and exposes lookup helpers.
 *
 * @module Sidepanel/modes/ObservationAuthor/shapes/index
 */

import { scalar }         from './scalar.js';
import { rawText, rawHtml } from './raw.js';
import { text }            from './text.js';
import { textLast }        from './textLast.js';
import { clickCopy, clickCopyLast } from './clickCopy.js';
import { attribute }       from './attribute.js';
import { listOfRecords }  from './list.js';
import { section }        from './section.js';
import { imageRefs }      from './imageRefs.js';
import { imageT1, imageListT1 } from './imageT1.js';
import { imageSnap }      from './imageSnap.js';
import { imageFull }      from './imageFull.js';
import { imageRead }      from './imageRead.js';

/** Registry: shape id → shape entry.
 *
 * v2.74.131 — `scalar` and `raw_text` are retained as registry entries
 * so legacy records still resolve to a shape definition (the form can
 * render them without breaking). They are NOT exposed in cacheShapes()
 * — the new-observation picker shows only `text` and `attribute` as the
 * forward path. Existing records get rewritten to the new shapes via
 * StorageManager.#migrateObservationShape on read, so authors editing
 * a pre-v2.74.131 observation see it as `text` or `attribute` regardless
 * of how it was stored.
 */
const REGISTRY = Object.freeze({
  text           : text,             // v2.74.131 — canonical text-content capture
  text_last      : textLast,         // v2.74.214 — "latest match" variant of text (feed/chat tails)
  click_copy     : clickCopy,        // v2.74.219 — click a copy button, read clipboard (format-agnostic chat)
  click_copy_last: clickCopyLast,    // v2.74.222 — last-match variant of click_copy (chat tails)
  attribute      : attribute,        // v2.74.131 — canonical attribute capture
  scalar         : scalar,           // legacy — retained for transitional load
  raw_text       : rawText,          // legacy — retained for transitional load
  raw_html       : rawHtml,
  list_of_records: listOfRecords,
  section        : section,
  image_refs     : imageRefs,
  image          : imageT1,
  image_list     : imageListT1,
  image_snap     : imageSnap,
  image_full     : imageFull,
  image_read     : imageRead,
});

/** Lookup a shape by id. Returns null when unknown (shouldn't happen
 *  since the dropdown is populated from this same registry). */
export function getShape(id) {
  return REGISTRY[id] ?? null;
}

/** Cache-tier (T1) shape entries available via the regular + Extract
 *  button. Picker-based shapes that read from the DOM.
 *
 *  v2.74.131 — `scalar` and `raw_text` removed from the picker (still in
 *  REGISTRY for legacy load). Replaced by `text` (was raw_text + scalar
 *  with kind=text) and `attribute` (was scalar with kind=attribute).
 */
export function cacheShapes() {
  return [
    REGISTRY.text,
    REGISTRY.text_last,            // v2.74.214 — last-match variant
    REGISTRY.click_copy,           // v2.74.219 — click copy button, read clipboard
    REGISTRY.click_copy_last,      // v2.74.222 — last-match variant
    REGISTRY.attribute,
    REGISTRY.raw_html,
    REGISTRY.list_of_records,
    REGISTRY.section,
    REGISTRY.image_refs,
    REGISTRY.image,
    REGISTRY.image_list,
  ];
}

/** Free-extract shapes available via the + Free Extract button.
 *  Coordinate-based capture, no DOM picker. */
export function freeExtractShapes() {
  return [
    REGISTRY.image_snap,
    REGISTRY.image_full,
    REGISTRY.image_read,
  ];
}

/** Frontier-tier (T3) shape entries. Reuses image / image_list ids; the
 *  capture mechanism (vision LLM) is the runtime-side difference. */
export function frontierShapes() {
  // Currently the frontier flow is a separate mode (not authored via the
  // sidepanel extract cards). Returning the same shape entries lets a
  // future T3 author UI reuse the registry without changes here.
  return [REGISTRY.image, REGISTRY.image_list];
}

/** All shape ids for a tier. */
export function shapeIdsForTier(tier) {
  return (tier === 'frontier' ? frontierShapes() : cacheShapes()).map(s => s.id);
}
