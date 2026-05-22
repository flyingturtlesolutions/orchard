/**
 * @file Services/Scope.js
 * @description Lexical scope + tagged-value model for Strategy execution.
 *
 * Pass E1 — Strategies become information-yielding by capturing values from
 * the page (EXTRACT actions) into a parameter scope. The scope is a stack of
 * frames; the bottom frame holds Strategy-level params (input + extracted),
 * higher frames will hold FOREACH iteration variables (Pass E2).
 *
 * In E1, only the bottom frame is ever populated — Strategies are linear,
 * no nested binding contexts exist yet. The stack abstraction is built now
 * so E2 can push/pop frames without changing how E1 Strategies behave.
 *
 * ── Tagged values ───────────────────────────────────────────────────────────
 *
 * Values in scope are tagged unions. Today only `scalar` is constructed, but
 * the type system anticipates E2's needs: list-of-elements (for FOREACH
 * sources) and element handles (for iteration variables).
 *
 *   { kind: 'scalar',  value: string }
 *   { kind: 'list',    items: TaggedValue[] }       // E2
 *   { kind: 'element', selector: string, ... }       // E2
 *   { kind: 'record',  fields: { [name]: string } } // I1 — EMIT output
 *
 * Helpers below construct, type-check, and unwrap these. The `asString`
 * unwrapper is the one used today by InjectionService — it produces a string
 * suitable for substitution into action values like TYPE.
 *
 * ── Append semantics ────────────────────────────────────────────────────────
 *
 * EXTRACT can either overwrite a target or append to it (E2 needs append for
 * accumulating per-iteration results into a list). E1 only uses overwrite.
 * Append behavior is wired but exercised in E2 — included now so the engine
 * doesn't need a follow-up change.
 *
 * @module Services/Scope
 * @since 2.26.0 (Pass E1)
 */

import { Logger } from '../Core/Logger.js';

// ── Tagged value constructors / assertions ──────────────────────────────────

/**
 * Wrap a string as a scalar value.
 *
 * v2.69.0 — Scalars now optionally track a subtype: 'string' | 'number' | 'boolean'.
 * Default subtype is 'string' for backward compat. The .value field is always a
 * string; subtype lets assertions check the original type (e.g., scalar_is_number)
 * and operations parse the value back to its native form. Engine wraps T3
 * primitive outputs with the appropriate subtype.
 */
export function scalar(value, subtype = 'string') {
  return { kind: 'scalar', value: String(value ?? ''), subtype };
}

/** Wrap an array of tagged values as a list value (E2). */
export function list(items) {
  return { kind: 'list', items: Array.isArray(items) ? items : [] };
}

/** Wrap an element reference as an element value (E2). */
export function element({ selector, attribute, snapshot }) {
  return { kind: 'element', selector, attribute: attribute ?? null, snapshot: snapshot ?? null };
}

/** Wrap a field-map as a record value (I1 — EMIT output). */
export function record(fields) {
  return { kind: 'record', fields: (fields && typeof fields === 'object') ? { ...fields } : {} };
}

/**
 * v2.72.12 (Pass 9) — Wrap captured image bytes as an image value. Used
 * by frontier-tier Observations (image / image_list shapes).
 *
 * Pass 9 stores raw base64 inline. Pass 10 will add a reference-based
 * variant for pause/resume serialization where the bytes live in a
 * separate chrome.storage.local key and the in-scope value carries
 * { kind: 'image', ref: '...', mime, width, height, label }.
 *
 * For now: all image values carry their bytes directly.
 *
 * v2.74.15 (Ship A — Observation refactor) — T1 cache-tier image capture
 * (picker-based) produces an image binding with `src` (URL ref) and no
 * `base64` (no screenshot crop). Frontier-tier image capture (vision LLM)
 * still produces `base64`. Both forms have `kind: 'image'`. Downstream
 * consumers that need bytes (e.g. an LLM call requiring image_url or
 * raw bytes) read base64 if present, else fetch from src. The image()
 * factory accepts either {base64, mime, ...} OR {src, alt, ...}; missing
 * fields default to safe values.
 */
export function image({ base64, mime, width, height, label, sourceUrl, capturedAt, src, alt } = {}) {
  return {
    kind     : 'image',
    base64   : (typeof base64 === 'string') ? base64 : '',
    mime     : mime || (base64 ? 'image/png' : ''),
    src      : (typeof src === 'string') ? src : '',
    alt      : (typeof alt === 'string') ? alt : '',
    width    : Number(width) || 0,
    height   : Number(height) || 0,
    label    : label ?? null,
    sourceUrl: sourceUrl ?? null,
    capturedAt: capturedAt ?? Date.now(),
  };
}

/**
 * v2.72.14 (Pass 6) — Wrap a captured DOM section as a section value.
 * Used by cache-tier Observations with shape='section' for document
 * composition workflows where the goal is to gather structured prose
 * plus image/link references from a page region.
 *
 * Fields:
 *   - markdown:  prose with structure preserved (paragraphs, headings,
 *                emphasis, links, lists). Hand-rolled minimal walker —
 *                tables, blockquotes, code blocks degrade to text.
 *   - text:      plain text version, no structure markers. Useful when
 *                downstream consumers want raw prose.
 *   - images:    list of records, one per <img> in the section. Each
 *                record has src, alt, width, height, currentSrc, srcset.
 *   - links:     list of records, one per <a> with href. Each record
 *                has href, text, title.
 *   - sourceUrl: page URL at capture time (provenance).
 *   - capturedAt: timestamp.
 *
 * The images and links sub-fields are themselves list tagged values,
 * which means downstream consumers iterating them see proper records.
 *
 * Note: postcondition vocabulary that addresses sub-fields of a section
 * binding doesn't exist in Pass 6. Authors needing strict checks
 * pipeline through an Analysis to extract sub-fields into top-level
 * scope bindings, then condition on those.
 */
export function section({ markdown, text, images, links, sourceUrl, capturedAt }) {
  return {
    kind      : 'section',
    markdown  : String(markdown ?? ''),
    text      : String(text ?? ''),
    // images and links arrive already wrapped as list tagged values from
    // the engine. Defensive: if a caller passes a raw array, wrap it.
    images    : (images && images.kind === 'list')
      ? images
      : list(Array.isArray(images) ? images : []),
    links     : (links && links.kind === 'list')
      ? links
      : list(Array.isArray(links) ? links : []),
    sourceUrl : sourceUrl ?? null,
    capturedAt: capturedAt ?? Date.now(),
  };
}

/**
 * v2.72.17 (Pass 7b) — Wrap composed text as a document value. Output of
 * template-kind Analyses (Pass 7b). Carries the rendered content plus
 * provenance (which scope bindings fed the composition) so the debugger
 * can show "this report was composed from ARTICLE, GALLERY, COVER."
 *
 * Pass 7b ships markdown only. Future formats (html, plain, ...) reuse
 * this kind with a different `format` value.
 */
export function document({ format, content, sourceBindings, composedAt, byteSize }) {
  const c = String(content ?? '');
  return {
    kind          : 'document',
    format        : format || 'markdown',
    content       : c,
    sourceBindings: Array.isArray(sourceBindings) ? [...sourceBindings] : [],
    composedAt    : composedAt ?? Date.now(),
    byteSize      : (typeof byteSize === 'number' && byteSize >= 0) ? byteSize : c.length,
  };
}

/** True if v is a tagged value of the given kind. */
export function isKind(v, kind) {
  return !!v && typeof v === 'object' && v.kind === kind;
}

/**
 * Coerce a tagged value to a string for action-value substitution.
 * Scalars return their value; lists and elements get reasonable string forms
 * (a list joins its items by comma; an element returns its selector). The
 * latter two are mostly for debugging — proper element binding for FOREACH
 * comes in E2 with a different code path.
 */
export function asString(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;          // legacy bare string (input params)
  if (isKind(v, 'scalar'))   return v.value;
  if (isKind(v, 'list'))     return asListString(v);
  if (isKind(v, 'element'))  return v.selector ?? '';
  if (isKind(v, 'record'))   return JSON.stringify(v.fields ?? {});
  // v2.72.12 (Pass 9) — Image values stringify to their label; binary
  // bytes are not appropriate for string substitution. Empty string if
  // no label was assigned.
  if (isKind(v, 'image'))    return v.label ?? '';
  // v2.72.14 (Pass 6) — Section values stringify to their markdown form.
  // The plain `text` field and the image/link sub-records are accessible
  // to downstream code paths but markdown is the natural string-form
  // when section is substituted into an action value or template.
  if (isKind(v, 'section'))  return v.markdown ?? '';
  // v2.72.17 (Pass 7b) — Documents stringify to their content. So a
  // template body with {{NAME}} where NAME is a document binding gets
  // the composed text inlined. Sub-field access (.format, .byteSize)
  // happens through the template engine's resolver, not here.
  if (isKind(v, 'document')) return v.content ?? '';
  return String(v);
}

/**
 * Render a list value as a string. If all items are records, render as a
 * pretty JSON array (one object per line, readable for downstream consumers).
 * Otherwise fall back to the legacy comma-joined scalar form.
 *
 * I1 choice: default JSON rendering for record-lists; later passes can add
 * {{#each}} template iteration for custom formatting.
 */
function asListString(v) {
  const items = v.items ?? [];
  if (items.length > 0 && items.every(it => isKind(it, 'record'))) {
    return JSON.stringify(items.map(it => it.fields ?? {}), null, 2);
  }
  return items.map(asString).join(', ');
}

// ── Scope: stack of frames ──────────────────────────────────────────────────

export class Scope {

  /** @type {Array<Map<string, Object>>} stack of frames; bottom = Strategy-level */
  #frames;

  constructor() {
    this.#frames = [new Map()];
  }

  /**
   * Push a new frame onto the stack (E2: FOREACH body entry).
   * Variables in the new frame shadow lower frames during reads.
   */
  pushFrame() {
    this.#frames.push(new Map());
  }

  /** Pop the top frame (E2: FOREACH body exit). Refuses to pop the bottom. */
  popFrame() {
    if (this.#frames.length <= 1) {
      Logger.warn('Scope', 'Refused to pop bottom frame');
      return;
    }
    this.#frames.pop();
  }

  /**
   * Read a variable. Walks frames top-to-bottom and returns the first match,
   * giving inner scopes precedence (lexical scoping).
   * Returns the tagged value, or undefined if unbound.
   */
  get(name) {
    for (let i = this.#frames.length - 1; i >= 0; i--) {
      if (this.#frames[i].has(name)) return this.#frames[i].get(name);
    }
    return undefined;
  }

  /**
   * Write a variable into the bottom (Strategy-level) frame.
   * Used by EXTRACT actions and by initial input-param population.
   *
   * NOTE: writes always go to the bottom frame, NOT the top. Reasoning:
   * EXTRACTs inside a FOREACH body should accumulate into Strategy-level
   * params, not into the per-iteration frame which gets discarded. Per-
   * iteration writes are a separate concept (the iteration variable
   * binding) handled by `bindIteration` in E2.
   */
  set(name, value, { append = false } = {}) {
    const bottom = this.#frames[0];
    if (append) {
      const existing = bottom.get(name);
      if (existing == null) {
        bottom.set(name, list([value]));
      } else if (isKind(existing, 'list')) {
        existing.items.push(value);
      } else {
        // Promote scalar/element to a list with both values
        bottom.set(name, list([existing, value]));
      }
    } else {
      bottom.set(name, value);
    }
  }

  /**
   * Bind a value into the TOP frame (E2: FOREACH iteration variable).
   * Unlike `set`, this is per-frame and disappears when the frame pops.
   */
  bindIteration(name, value) {
    this.#frames[this.#frames.length - 1].set(name, value);
  }

  /**
   * Snapshot the bottom frame as a plain { name: string } object suitable
   * for InjectionService.injectParams. Strings only — values get coerced via
   * asString. Used by Fragment execution to convert Strategy-level params
   * into a format the existing param-substitution code understands.
   */
  asBindingMap() {
    const out = {};
    for (const [name, value] of this.#frames[0]) {
      out[name] = asString(value);
    }
    // Also fold in any iteration-frame bindings so they shadow correctly
    // (E2 needs this; in E1 there's only one frame so the loop is a no-op).
    for (let i = 1; i < this.#frames.length; i++) {
      for (const [name, value] of this.#frames[i]) {
        out[name] = asString(value);
      }
    }
    return out;
  }

  /**
   * Snapshot the bottom frame as { name: TaggedValue } — preserves the type
   * tags so the chat-result renderer can distinguish scalars from lists when
   * we eventually display extracted values.
   */
  asResultObject() {
    const out = {};
    for (const [name, value] of this.#frames[0]) {
      out[name] = value;
    }
    return out;
  }

  /**
   * Convenience: flat preview for logs / composition warnings. Returns the
   * names of all bottom-frame variables (input + extracted, before any new
   * iteration scope is pushed).
   */
  bottomFrameNames() {
    return [...this.#frames[0].keys()];
  }
}
