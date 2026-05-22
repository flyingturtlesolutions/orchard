/**
 * @file Services/Observation.js
 * @description Observation primitive — schema constants, shape vocabulary,
 * and a validator for the post-Ship-A multi-extract Observation contract.
 *
 * Shape registry (the 8 shapes; tier-keyed where relevant):
 *
 *   Cache (T1, picker-based):
 *     - scalar          one element + extract.kind → string
 *     - raw_text        one element → string
 *     - raw_html        one element → string
 *     - list_of_records container + per-field selectors → list-of-records
 *     - section         one element → tagged section value
 *     - image_refs      container with <img> descendants → list-of-records
 *     - image           one <img> element → tagged image value
 *     - image_list      container with <img> descendants → list-of-tagged-images
 *
 *   Frontier (T3, vision-LLM):
 *     - image           cropped region → tagged image value
 *     - image_list      multiple cropped regions → list-of-tagged-images
 *
 * The Observation record carries one implementation; the implementation
 * carries multiple extracts. Each extract has its own shape, target, and
 * output binding. preconditions/postconditions are page-state assertions
 * at the Observation level (Observations don't mutate the page; postconds
 * just confirm the state didn't drift during the read).
 *
 * @module Services/Observation
 * @version 2.74.15
 */

/**
 * All cache-tier (T1) shape ids. Each maps to a content-script handler
 * (OBSERVE_*) and a result-wrapping branch in ExecutionEngine.
 */
export const CACHE_SHAPE_IDS = Object.freeze([
  // v2.74.131 — `text` and `attribute` are the canonical text-capture
  // shapes. `scalar` and `raw_text` are retained for backward compat
  // (existing records still validate) but the authoring picker hides
  // them via cacheShapes() in shapes/index.js. Migration to the new
  // shape names happens on read via StorageManager.#migrateObservationShape.
  'text',
  'text_last',  // v2.74.214 — last-match variant of text (chat/feed tails)
  'click_copy', // v2.74.219 — click a copy button, read clipboard (format-agnostic chat)
  'click_copy_last', // v2.74.222 — last-match variant (latest AI message's copy button)
  'attribute',
  'scalar',     // legacy — retained for transitional load
  'raw_text',   // legacy — retained for transitional load
  'raw_html',
  'list_of_records',
  'section',
  'image_refs',
  'image',
  'image_list',
  // v2.74.19 — Free-extract: coordinate-based capture via screenshot
  // (chrome.tabs.captureVisibleTab + crop). No DOM target; saves a rect
  // + scrollY + viewport metadata instead.
  'image_snap',
  // v2.74.51 — Full-tab screenshot. Like image_snap but captures the
  // entire visible viewport — no rect, no scroll restoration.
  'image_full',
  // v2.74.62 — Cropped screenshot + Claude vision read. Carries the
  // same rect/scrollY/viewport as image_snap plus a `description`
  // string telling Claude what to read.
  'image_read',
  // v2.74.195 — Extract gate: control-flow wrapper that runs its body[]
  // of regular extracts only when a header condition is met (XOR negate).
  // Mirrors fragment-author's ACTION_GATE pattern. The runtime
  // (ExecutionEngine extract loop) recognizes this shape and dispatches
  // accordingly.
  'extract_gate',
]);

/** All frontier-tier (T3) shape ids. Vision-LLM driven; reuse of names is intentional. */
export const FRONTIER_SHAPE_IDS = Object.freeze([
  'image',
  'image_list',
]);

/**
 * Quick-reference: which shape ids are valid for a given tier.
 *
 * @param {'cache'|'frontier'} tier
 * @returns {readonly string[]}
 */
export function shapesForTier(tier) {
  if (tier === 'frontier') return FRONTIER_SHAPE_IDS;
  return CACHE_SHAPE_IDS;
}

/**
 * Validate an Observation record against the post-Ship-A contract.
 * Returns { ok, errors } — errors is an array of human-readable messages.
 * Used by JSON modal and external save paths; the form does its own
 * field-level validation and shouldn't need this gate.
 *
 * Required:
 *   - id, groundId, name (non-empty strings)
 *   - implementations: array, length 1 (Ship A — exactly one; multi-tier
 *     layering may come later)
 *   - implementations[0].tier: 'cache' or 'frontier'
 *   - implementations[0].extracts: non-empty array
 *   - each extract: shape (valid for tier), target (non-empty string),
 *     output (non-empty string, no spaces)
 *   - extract.output names unique within the Observation
 *
 * Optional:
 *   - description, params, preconditions, postconditions, startUrl,
 *     endUrl, authoringTier (must match implementations[0].tier
 *     vocabulary loosely: 'T1'↔cache, 'T3'↔frontier — not strictly
 *     enforced)
 *
 * @param {Object} obs
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateObservationRecord(obs) {
  const errors = [];
  if (!obs || typeof obs !== 'object') {
    return { ok: false, errors: ['Observation must be an object'] };
  }
  if (typeof obs.id !== 'string' || obs.id.length === 0) errors.push('id required');
  if (typeof obs.groundId !== 'string' || obs.groundId.length === 0) errors.push('groundId required');
  if (typeof obs.name !== 'string' || obs.name.length === 0) errors.push('name required');

  // implementations
  if (!Array.isArray(obs.implementations) || obs.implementations.length !== 1) {
    errors.push('implementations must be an array of length 1');
    return { ok: false, errors };
  }
  const impl = obs.implementations[0];
  if (!impl || typeof impl !== 'object') {
    errors.push('implementations[0] must be an object');
    return { ok: false, errors };
  }
  const tier = impl.tier;
  if (tier !== 'cache' && tier !== 'frontier') {
    errors.push(`implementations[0].tier must be 'cache' or 'frontier', got ${JSON.stringify(tier)}`);
    return { ok: false, errors };
  }
  if (!Array.isArray(impl.extracts) || impl.extracts.length === 0) {
    errors.push('implementations[0].extracts must be a non-empty array');
    return { ok: false, errors };
  }

  const validShapes = shapesForTier(tier);
  const seenOutputs = new Set();
  impl.extracts.forEach((ex, i) => {
    const path = `extracts[${i}]`;
    if (!ex || typeof ex !== 'object') {
      errors.push(`${path} must be an object`);
      return;
    }
    if (!validShapes.includes(ex.shape)) {
      errors.push(`${path}.shape "${ex.shape}" not valid for tier "${tier}" (valid: ${validShapes.join(', ')})`);
    }
    // v2.74.195 — extract_gate validation. The gate carries a header
    // condition + negate + body[] of regular extracts; no output /
    // target of its own. Each body sub is validated as a regular
    // extract (recursive validation against the same vocabulary).
    if (ex.shape === 'extract_gate') {
      // v2.74.201 — Optional waitTimeout (ms). When > 0, runtime retries
      // the condition for that many ms before deciding. Must be a
      // positive integer when present.
      if (ex.waitTimeout != null) {
        if (!Number.isFinite(ex.waitTimeout) || ex.waitTimeout < 0 || !Number.isInteger(ex.waitTimeout)) {
          errors.push(`${path}.waitTimeout must be a non-negative integer (ms)`);
        }
      }
      const cond = ex.condition;
      if (!cond || typeof cond !== 'object' || typeof cond.type !== 'string' || !cond.type) {
        errors.push(`${path}.condition required (object with non-empty type) for shape=extract_gate`);
      } else {
        // Per-type required fields (same vocabulary fragment ACTION_GATE accepts).
        if ((cond.type === 'selector_present' || cond.type === 'selector_absent') &&
            (typeof cond.selector !== 'string' || !cond.selector.trim())) {
          errors.push(`${path}.condition.selector required for type=${cond.type}`);
        } else if (cond.type === 'text_present' &&
                   (typeof cond.text !== 'string' || !cond.text.toString().trim())) {
          errors.push(`${path}.condition.text required for type=text_present`);
        } else if (cond.type === 'url_matches' &&
                   (typeof cond.pattern !== 'string' || !cond.pattern.trim())) {
          errors.push(`${path}.condition.pattern required for type=url_matches`);
        } else if (cond.type === 'attribute_equals') {
          if (typeof cond.selector !== 'string' || !cond.selector.trim()) {
            errors.push(`${path}.condition.selector required for type=attribute_equals`);
          }
          if (typeof cond.attribute !== 'string' || !cond.attribute.trim()) {
            errors.push(`${path}.condition.attribute required for type=attribute_equals`);
          }
        }
      }
      if (!Array.isArray(ex.body)) {
        errors.push(`${path}.body required (array) for shape=extract_gate`);
      } else {
        // v2.74.197 — Restrict body sub-shapes to the DOM/text-capture
        // vocabulary. Image-capture shapes (image_snap, image_full,
        // image_read) need rect / viewport / description fields that
        // the simplified inline body form doesn't author — they'd pass
        // shape validation but fail at runtime with "missing rect".
        // Nested gates are also rejected to keep evaluation flat.
        const BODY_ALLOWED_SHAPES = new Set([
          'text', 'text_last',                              // v2.74.214 — last-match variant
          'click_copy', 'click_copy_last',                  // v2.74.219/.222 — click copy button, read clipboard
          'attribute', 'scalar', 'raw_text', 'raw_html',
          'list_of_records', 'section', 'image_refs', 'image', 'image_list',
        ]);
        ex.body.forEach((sub, j) => {
          const subPath = `${path}.body[${j}]`;
          if (!sub || typeof sub !== 'object') {
            errors.push(`${subPath} must be an object`);
            return;
          }
          if (typeof sub.shape !== 'string' || !BODY_ALLOWED_SHAPES.has(sub.shape)) {
            errors.push(`${subPath}.shape "${sub.shape}" not allowed in extract_gate body (use a top-level extract for image_snap/image_full/image_read or other unlisted shapes; nested gates not supported)`);
          }
          if (typeof sub.output !== 'string' || !sub.output) {
            errors.push(`${subPath}.output required (non-empty string)`);
          } else if (/\s/.test(sub.output)) {
            errors.push(`${subPath}.output must not contain whitespace: ${JSON.stringify(sub.output)}`);
          } else if (seenOutputs.has(sub.output)) {
            errors.push(`${subPath}.output duplicate "${sub.output}" — output names must be unique within an Observation`);
          } else {
            seenOutputs.add(sub.output);
          }
          if (typeof sub.target !== 'string' || !sub.target) {
            errors.push(`${subPath}.target required (non-empty string)`);
          }
          // Per-shape required sub-fields (mirrors top-level rules).
          if (sub.shape === 'attribute') {
            if (typeof sub.attribute !== 'string' || !sub.attribute.trim()) {
              errors.push(`${subPath}.attribute required for shape=attribute`);
            }
          } else if (sub.shape === 'scalar') {
            const ek = sub.extract;
            if (!ek || (ek.kind !== 'text' && ek.kind !== 'attribute')) {
              errors.push(`${subPath}.extract.kind must be 'text' or 'attribute' for shape=scalar`);
            } else if (ek.kind === 'attribute' && (typeof ek.attr !== 'string' || !ek.attr)) {
              errors.push(`${subPath}.extract.attr required when extract.kind='attribute'`);
            }
          } else if (sub.shape === 'list_of_records') {
            if (!Array.isArray(sub.fields) || sub.fields.length === 0) {
              errors.push(`${subPath}.fields required (non-empty array) for shape=list_of_records`);
            }
          }
        });
      }
      return; // skip the per-shape branches below
    }
    // v2.74.19 — image_snap doesn't carry a DOM target; it captures by
    // coordinate. Validate rect/scrollY/viewport instead.
    // v2.74.51 — image_full also skips the target check — it captures
    // the full visible viewport with no rect or scroll restoration, so
    // there are no required sub-fields beyond shape + output.
    if (ex.shape === 'image_snap') {
      const r = ex.rect;
      if (!r || typeof r !== 'object') {
        errors.push(`${path}.rect required (object) for shape=image_snap`);
      } else {
        if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) {
          errors.push(`${path}.rect.x and rect.y must be numeric`);
        }
        if (!(r.width > 0))  errors.push(`${path}.rect.width must be positive`);
        if (!(r.height > 0)) errors.push(`${path}.rect.height must be positive`);
      }
      if (!Number.isFinite(ex.scrollY)) {
        errors.push(`${path}.scrollY must be numeric for shape=image_snap`);
      }
      // viewport is informational; missing is non-fatal but warned via
      // best-effort default in the runtime (DPR=1, width=0).
    } else if (ex.shape === 'image_full') {
      // No required sub-fields; viewport is informational.
    } else if (ex.shape === 'image_read') {
      // v2.74.62 — Same rect/scrollY checks as image_snap, plus a
      // required description string (what the user wants Claude to
      // read from the cropped image).
      const r = ex.rect;
      if (!r || typeof r !== 'object') {
        errors.push(`${path}.rect required (object) for shape=image_read`);
      } else {
        if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) {
          errors.push(`${path}.rect.x and rect.y must be numeric`);
        }
        if (!(r.width > 0))  errors.push(`${path}.rect.width must be positive`);
        if (!(r.height > 0)) errors.push(`${path}.rect.height must be positive`);
      }
      if (!Number.isFinite(ex.scrollY)) {
        errors.push(`${path}.scrollY must be numeric for shape=image_read`);
      }
      if (typeof ex.description !== 'string' || ex.description.trim() === '') {
        errors.push(`${path}.description required (non-empty string) for shape=image_read`);
      }
    } else if (typeof ex.target !== 'string' || ex.target.length === 0) {
      errors.push(`${path}.target required (non-empty string)`);
    }
    if (typeof ex.output !== 'string' || ex.output.length === 0) {
      errors.push(`${path}.output required (non-empty string)`);
    } else if (/\s/.test(ex.output)) {
      errors.push(`${path}.output must not contain whitespace: ${JSON.stringify(ex.output)}`);
    } else if (seenOutputs.has(ex.output)) {
      errors.push(`${path}.output duplicate "${ex.output}" — extract output names must be unique within an Observation`);
    } else {
      seenOutputs.add(ex.output);
    }

    // Per-shape required sub-fields.
    // v2.74.131 — `text` requires only target. `attribute` requires target
    // + attribute name (stored as top-level `ex.attribute`, no nesting).
    // Legacy `scalar` validation kept verbatim for records that haven't
    // been migrated yet — those records still load and validate; reading
    // them through StorageManager rewrites them to the new shapes.
    if (ex.shape === 'attribute') {
      if (typeof ex.attribute !== 'string' || ex.attribute.trim().length === 0) {
        errors.push(`${path}.attribute required (non-empty string) for shape=attribute`);
      }
    }
    if (ex.shape === 'scalar') {
      const ek = ex.extract;
      if (!ek || (ek.kind !== 'text' && ek.kind !== 'attribute')) {
        errors.push(`${path}.extract.kind must be 'text' or 'attribute' for shape=scalar`);
      } else if (ek.kind === 'attribute' && (typeof ek.attr !== 'string' || ek.attr.length === 0)) {
        errors.push(`${path}.extract.attr required when extract.kind='attribute'`);
      }
    }
    if (ex.shape === 'list_of_records') {
      if (!Array.isArray(ex.fields) || ex.fields.length === 0) {
        errors.push(`${path}.fields required (non-empty array) for shape=list_of_records`);
      } else {
        ex.fields.forEach((f, fi) => {
          const fpath = `${path}.fields[${fi}]`;
          if (!f || typeof f !== 'object') {
            errors.push(`${fpath} must be an object`);
            return;
          }
          if (typeof f.name !== 'string' || f.name.length === 0) errors.push(`${fpath}.name required`);
          if (typeof f.selector !== 'string' || f.selector.length === 0) errors.push(`${fpath}.selector required`);
          if (f.kind !== 'text' && f.kind !== 'attribute') {
            errors.push(`${fpath}.kind must be 'text' or 'attribute'`);
          } else if (f.kind === 'attribute' && (typeof f.attr !== 'string' || f.attr.length === 0)) {
            errors.push(`${fpath}.attr required when kind='attribute'`);
          }
        });
      }
    }
  });

  return { ok: errors.length === 0, errors };
}
