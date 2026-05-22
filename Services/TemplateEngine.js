/**
 * v2.72.17 (Pass 7b) — Template engine for compose-style Analyses.
 *
 * Mustache-lite. Three constructs:
 *
 *   {{NAME}}              — substitute a scope binding (default render)
 *   {{NAME.field}}        — sub-field access on tagged values
 *   {{#each LIST as ITEM}}...{{/each}}
 *                         — iterate a list, binding each item to ITEM
 *
 * No conditionals, no helpers, no expressions. Every `{{...}}` reference
 * resolves through scope.get(path[0]) plus per-kind sub-field navigation.
 *
 * Two-phase API:
 *   parseTemplate(source) → AST or error
 *   evalTemplate(ast, scope) → content string or error
 *
 * Authoring flow validates parseTemplate at save time so authors see
 * syntax errors early. Evaluation happens at strategy run time.
 *
 * Sub-field resolution is type-aware (see resolveSubField).
 */

import { isKind, asString } from './Scope.js';

// ── Parser ──────────────────────────────────────────────────────────────────

const RX_TAG_START = /\{\{/g;

/**
 * Parse a template source string into an AST.
 *
 * AST node kinds:
 *   { type: 'text', value: string }
 *   { type: 'sub',  path: string[] }                           // {{NAME.field.field}}
 *   { type: 'each', listPath: string[], itemName: string,      // {{#each LIST.field as ITEM}}...{{/each}}
 *                   body: Node[] }
 *
 * Returns { ok: true, ast } or { ok: false, error }. The error message
 * names the offending token region for clear authoring feedback.
 *
 * Robustness:
 *   - Unclosed tags ({{ without }}) → error
 *   - Unclosed each blocks ({{#each}} without {{/each}}) → error
 *   - Mismatched closers ({{/each}} without opener) → error
 *   - Empty {{}} → error
 *
 * Whitespace inside tags is tolerated: `{{  NAME.field  }}` parses as
 * `{{NAME.field}}`. Tag content is trimmed.
 *
 * No escape sequence yet — '{{' is always a tag start. Authors who need
 * literal '{{' in output have no workaround in 7b. Future: '\\{{' escape.
 */
export function parseTemplate(source) {
  if (typeof source !== 'string') {
    return { ok: false, error: 'Template source must be a string' };
  }
  // Tokenize into text segments and tag bodies. Tags are anything between
  // `{{` and `}}`.
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{{', i);
    if (open < 0) {
      // Trailing text.
      if (i < source.length) tokens.push({ kind: 'text', value: source.slice(i) });
      break;
    }
    if (open > i) {
      tokens.push({ kind: 'text', value: source.slice(i, open) });
    }
    const close = source.indexOf('}}', open + 2);
    if (close < 0) {
      return { ok: false, error: `Unclosed tag starting at character ${open}: "${source.slice(open, open + 30)}..."` };
    }
    const inner = source.slice(open + 2, close).trim();
    if (inner.length === 0) {
      return { ok: false, error: `Empty tag at character ${open}: "{{}}"` };
    }
    tokens.push({ kind: 'tag', body: inner, pos: open });
    i = close + 2;
  }

  // Second pass: build the AST. Each-block tracking via a stack of frames.
  // Frame: { items: [], itemName, listPath, openPos } for blocks; root frame
  // has no closer.
  const root = { items: [], parent: null };
  let frame = root;

  for (const tok of tokens) {
    if (tok.kind === 'text') {
      frame.items.push({ type: 'text', value: tok.value });
      continue;
    }
    // tok.kind === 'tag'
    const body = tok.body;
    if (body.startsWith('#each')) {
      const m = body.match(/^#each\s+([A-Z][A-Z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s+as\s+([A-Z][A-Z0-9_]*)\s*$/);
      if (!m) {
        return {
          ok: false,
          error: `Invalid #each tag at character ${tok.pos}: "{{${body}}}". Expected "{{#each LIST as ITEM}}" with UPPERCASE_NAMES.`,
        };
      }
      const listPath = m[1].split('.');
      const itemName = m[2];
      const newFrame = {
        items: [],
        parent: frame,
        opener: { type: 'each', listPath, itemName, openPos: tok.pos },
      };
      frame = newFrame;
      continue;
    }
    if (body === '/each') {
      if (!frame.opener || frame.opener.type !== 'each') {
        return { ok: false, error: `Unexpected {{/each}} at character ${tok.pos} — no matching {{#each}} block.` };
      }
      const completed = {
        type: 'each',
        listPath: frame.opener.listPath,
        itemName: frame.opener.itemName,
        body: frame.items,
      };
      const parent = frame.parent;
      parent.items.push(completed);
      frame = parent;
      continue;
    }
    // Plain substitution.
    if (!/^[A-Z][A-Z0-9_]*(?:\.[A-Za-z0-9_]+)*$/.test(body)) {
      return {
        ok: false,
        error: `Invalid tag at character ${tok.pos}: "{{${body}}}". Expected UPPERCASE_NAME or NAME.subfield with UPPERCASE_NAME root.`,
      };
    }
    frame.items.push({ type: 'sub', path: body.split('.') });
  }

  if (frame !== root) {
    return {
      ok: false,
      error: `Unclosed {{#each ${frame.opener.listPath.join('.')} as ${frame.opener.itemName}}} block opened at character ${frame.opener.openPos} — missing {{/each}}.`,
    };
  }

  return { ok: true, ast: root.items };
}

// ── Evaluator ───────────────────────────────────────────────────────────────

/**
 * Evaluate a parsed AST against a scope, producing the rendered string.
 *
 * Returns { ok: true, content } or { ok: false, error }.
 *
 * Strict resolution:
 *   - Missing scope binding → error
 *   - Missing sub-field on a tagged value → error
 *   - {{#each}} target that isn't a list → error
 *
 * Iteration:
 *   - Each item in a list gets bound to itemName for the duration of the
 *     loop body. Scope's frame stack is pushed/popped around each item.
 *
 * Sub-field default render: see resolveSubField for per-kind field maps.
 * For unknown fields, returns an error (strict mode).
 *
 * @param {Node[]} ast       parsed template AST
 * @param {Scope}  scope     active scope from the engine
 * @returns {{ok: true, content: string} | {ok: false, error: string}}
 */
export function evalTemplate(ast, scope) {
  try {
    const out = renderNodes(ast, scope);
    return { ok: true, content: out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function renderNodes(nodes, scope) {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value;
    } else if (node.type === 'sub') {
      out += resolvePath(node.path, scope);
    } else if (node.type === 'each') {
      out += renderEach(node, scope);
    }
  }
  return out;
}

function renderEach(node, scope) {
  // Resolve listPath to a list value.
  const listVal = resolveValue(node.listPath, scope);
  if (!isKind(listVal, 'list')) {
    throw new Error(
      `{{#each ${node.listPath.join('.')} as ${node.itemName}}}: ` +
      `expected a list, got ${describeKind(listVal)}.`
    );
  }
  const items = Array.isArray(listVal.items) ? listVal.items : [];
  let out = '';
  // Push a frame for each iteration; bind itemName via bindIteration so
  // it lives in the top frame (gets discarded when the frame pops). Scope's
  // regular `set` writes to the BOTTOM frame which would leak iterations.
  for (const item of items) {
    scope.pushFrame();
    try {
      scope.bindIteration(node.itemName, item);
      out += renderNodes(node.body, scope);
    } finally {
      scope.popFrame();
    }
  }
  return out;
}

/**
 * Resolve a path of segments to its final string-rendered value.
 * Path[0] is a scope binding name (uppercase); path[1..] navigate sub-fields.
 *
 * Throws on missing binding or unknown sub-field (strict mode).
 */
function resolvePath(path, scope) {
  const v = resolveValue(path, scope);
  return defaultRender(v);
}

/**
 * Resolve a path to a typed value (NOT yet string-rendered). Used by:
 *   - resolvePath (which then string-renders)
 *   - renderEach   (which expects a list)
 */
function resolveValue(path, scope) {
  const root = path[0];
  // Scope.get returns undefined for missing — use that as the "not bound"
  // signal. There's no separate has() method.
  const rootVal = scope.get(root);
  if (rootVal === undefined) {
    throw new Error(`Template references {{${path.join('.')}}} but scope binding "${root}" is not defined.`);
  }
  let cur = rootVal;
  for (let i = 1; i < path.length; i++) {
    cur = resolveSubField(cur, path[i], path.slice(0, i + 1).join('.'));
  }
  return cur;
}

/**
 * Per-kind sub-field navigation. Returns the typed sub-value (which may
 * itself be a tagged value or a primitive).
 *
 * Field maps:
 *   - record:   field name → fields[field]    (primitive string)
 *   - section:  markdown / text / url / title (primitive); images / links (list)
 *   - image:    base64 / mime / width / height / label / sourceUrl / dataUrl (primitive)
 *               dataUrl is synthetic: "data:{mime};base64,{base64}"
 *   - document: content / format / byteSize / composedAt (primitive)
 *   - list:     items (raw array — rarely useful; mostly accessed via #each)
 *   - scalar:   value (primitive; equivalent to default render)
 *   - element:  selector / attribute (primitive)
 *
 * Anything else (or unknown field on a known kind) → error.
 *
 * @param {*} val        the typed value being navigated into
 * @param {string} field the next path segment
 * @param {string} pathStr the full path-so-far for the error message
 */
function resolveSubField(val, field, pathStr) {
  if (val == null) {
    throw new Error(`Template path "${pathStr}": cannot access ".${field}" of null.`);
  }

  // Records: field name → fields[name]. The primitive returned is whatever
  // the field stored (typically a string from observation extraction).
  if (isKind(val, 'record')) {
    const f = val.fields ?? {};
    if (!(field in f)) {
      const known = Object.keys(f).join(', ') || '(none)';
      throw new Error(`Template path "${pathStr}": record has no field "${field}". Known fields: ${known}.`);
    }
    return f[field];
  }

  if (isKind(val, 'section')) {
    if (field === 'markdown' || field === 'text' || field === 'url' || field === 'title') {
      return val[field] ?? '';
    }
    if (field === 'images' || field === 'links') {
      return val[field] ?? { kind: 'list', items: [] };
    }
    throw new Error(`Template path "${pathStr}": section has no field "${field}". Known fields: markdown, text, url, title, images, links.`);
  }

  if (isKind(val, 'image')) {
    if (field === 'dataUrl') {
      // Synthetic field — the bytes as a data URL, suitable for inline
      // markdown image embedding: ![alt]({{IMG.dataUrl}}).
      const mime = val.mime || 'image/png';
      const b64  = val.base64 || '';
      return `data:${mime};base64,${b64}`;
    }
    if (field === 'base64' || field === 'mime' || field === 'label' || field === 'sourceUrl') {
      return val[field] ?? '';
    }
    if (field === 'width' || field === 'height') {
      return Number(val[field] ?? 0);
    }
    throw new Error(`Template path "${pathStr}": image has no field "${field}". Known fields: dataUrl, base64, mime, width, height, label, sourceUrl.`);
  }

  if (isKind(val, 'document')) {
    if (field === 'content' || field === 'format') return val[field] ?? '';
    if (field === 'byteSize' || field === 'composedAt') return Number(val[field] ?? 0);
    if (field === 'sourceBindings') return val.sourceBindings ?? [];
    throw new Error(`Template path "${pathStr}": document has no field "${field}". Known fields: content, format, byteSize, composedAt, sourceBindings.`);
  }

  if (isKind(val, 'list')) {
    if (field === 'items') return val.items ?? [];
    if (field === 'length') return (val.items ?? []).length;
    throw new Error(`Template path "${pathStr}": list has no field "${field}". To iterate, use {{#each ${pathStr} as ITEM}}...{{/each}}.`);
  }

  if (isKind(val, 'scalar')) {
    if (field === 'value') return val.value ?? '';
    throw new Error(`Template path "${pathStr}": scalar has no field "${field}". Known fields: value.`);
  }

  if (isKind(val, 'element')) {
    if (field === 'selector' || field === 'attribute') return val[field] ?? '';
    throw new Error(`Template path "${pathStr}": element has no field "${field}". Known fields: selector, attribute.`);
  }

  // Bare primitive (string/number) — no sub-fields available.
  throw new Error(`Template path "${pathStr}": cannot navigate into ${describeKind(val)} (".${field}").`);
}

/**
 * Default string rendering of a typed (or primitive) value when used as
 * a {{NAME}} or end-of-path substitution. Delegates to asString for tagged
 * values; converts primitives directly.
 */
function defaultRender(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Tagged values: asString covers scalar / list / record / element /
  // image / section / document. Each renders sensibly without throwing.
  return asString(v);
}

/** Human-readable kind name for error messages. */
function describeKind(v) {
  if (v == null) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v !== 'object') return typeof v;
  if (v.kind) return v.kind;
  if (Array.isArray(v)) return 'array';
  return 'object';
}

// ── Convenience ─────────────────────────────────────────────────────────────

/**
 * Parse + evaluate in one shot. Convenience for callers that don't need
 * to cache the AST. Returns { ok, content } or { ok: false, error }.
 */
export function renderTemplate(source, scope) {
  const parsed = parseTemplate(source);
  if (!parsed.ok) return parsed;
  return evalTemplate(parsed.ast, scope);
}

/**
 * v2.72.17 — Walk an AST collecting all {{NAME}} root references.
 * Used by authoring tools to detect which inputs a template uses.
 * Returns an array of unique root names (path[0] values), in order of
 * first appearance.
 *
 * Each-block iterator names are NOT included in the returned set —
 * those are bindings introduced by the template, not consumed from scope.
 */
export function collectTemplateReferences(ast) {
  const seen = new Set();
  const refs = [];
  const localBindings = new Set(); // each-loop iterator names (not external refs)

  const visit = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'sub') {
        const root = node.path[0];
        if (!localBindings.has(root) && !seen.has(root)) {
          seen.add(root);
          refs.push(root);
        }
      } else if (node.type === 'each') {
        // The list path's root may be external; the iterator name is local.
        const listRoot = node.listPath[0];
        if (!localBindings.has(listRoot) && !seen.has(listRoot)) {
          seen.add(listRoot);
          refs.push(listRoot);
        }
        // Push iterator name as local for the duration of the body.
        const wasLocal = localBindings.has(node.itemName);
        localBindings.add(node.itemName);
        try {
          visit(node.body);
        } finally {
          if (!wasLocal) localBindings.delete(node.itemName);
        }
      }
      // text nodes: nothing to collect
    }
  };

  visit(ast);
  return refs;
}
