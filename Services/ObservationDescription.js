/**
 * @file Services/ObservationDescription.js
 * @description Pure description-composer for Observation extract lists.
 *
 * Used by:
 *   - Sidepanel/modes/observation-author.js — at save time, to write a
 *     human-readable description into the Observation record.
 *   - studio.js — at render time, to display either compact or verbose
 *     description from the Observation's extracts regardless of what was
 *     stored at save (lets users toggle between formats without re-saving).
 *
 * Mirrors Services/FragmentDescription.js: each extract becomes a
 * verb-led prose phrase ("read text from `.price` as PRICE"); compact
 * joins phrases as one sentence with comma + and; verbose puts each on
 * its own line and indents per-field rows for list_of_records.
 *
 * Determinism: pure functions, no DOM, no async, no I/O. Same input
 * always produces same output — safe to call at render time on every
 * list refresh.
 *
 * @module Services/ObservationDescription
 * @version 2.74.21
 */

/**
 * Compose both compact and verbose descriptions from an Observation's
 * implementation.extracts array.
 *
 * @param {Array<Object>} extracts - Extract specs.
 * @returns {{compact: string, verbose: string}}
 */
export function composeDescriptions(extracts) {
  if (!Array.isArray(extracts) || extracts.length === 0) {
    return { compact: 'Empty observation.', verbose: 'Empty observation.' };
  }
  return {
    compact: _composeCompact(extracts),
    verbose: _composeVerbose(extracts),
  };
}

/**
 * Convenience: compute just the compact form. Used at save time to
 * populate the description field stored on disk.
 */
export function composeCompactDescription(extracts) {
  return composeDescriptions(extracts).compact;
}

// ─── Compact format ────────────────────────────────────────────────────────
// Single-sentence prose joining each extract's phrase.
//   1 extract:  "Read text from `.price` as PRICE."
//   2 extracts: "Read text from `.price` as PRICE and capture markdown
//                of `article` as ARTICLE."
//   3+:         "Read … as A, capture … as B, and snap … as C."

function _composeCompact(extracts) {
  const phrases = extracts
    .map(ex => _phraseForExtract(ex, /* verbose */ false))
    .filter(Boolean);
  if (phrases.length === 0) return 'Empty observation.';

  phrases[0] = _capitalize(phrases[0]);

  let sentence;
  if (phrases.length === 1) {
    sentence = phrases[0];
  } else if (phrases.length === 2) {
    sentence = `${phrases[0]} and ${phrases[1]}`;
  } else {
    const head = phrases.slice(0, -1).join(', ');
    sentence = `${head}, and ${phrases[phrases.length - 1]}`;
  }
  return sentence + '.';
}

// ─── Verbose format ────────────────────────────────────────────────────────
// One phrase per line, capitalized. list_of_records expands its fields as
// indented child lines beneath the head, mirroring Fragment's chain-action
// branch indentation.

function _composeVerbose(extracts) {
  const lines = [];
  for (const ex of extracts) {
    if (ex?.shape === 'list_of_records' && Array.isArray(ex.fields) && ex.fields.length > 0) {
      const head = _phraseForExtract(ex, /* verbose */ true);
      if (head) lines.push(_capitalize(head) + ':');
      for (const f of ex.fields) {
        const fline = _verboseFieldLine(f);
        if (fline) lines.push('  ' + fline);
      }
    } else {
      const phrase = _phraseForExtract(ex, /* verbose */ false);
      if (phrase) lines.push(_capitalize(phrase));
    }
  }
  if (lines.length === 0) return 'Empty observation.';
  return lines.join('\n');
}

function _verboseFieldLine(f) {
  const fname = f?.name || '(unnamed)';
  const sel = f?.selector ? _selectorTail(f.selector) : '`?`';
  const ek = f?.extract ?? { kind: 'text' };
  if (ek.kind === 'attribute') {
    const attr = ek.attr ? `\`${ek.attr}\`` : '`?`';
    return `${fname} ← ${attr} attribute of ${sel}`;
  }
  return `${fname} ← text of ${sel}`;
}

// ─── Per-extract phrase ────────────────────────────────────────────────────
// `verbose=true` strips inline field summaries from list_of_records (the
// caller renders fields as indented sub-lines instead). All other shapes
// produce the same phrase regardless of mode.

function _phraseForExtract(ex, verbose) {
  if (!ex || typeof ex !== 'object') return null;
  const out = ex.output || '(unnamed)';
  const tgt = ex.target ? _selectorTail(ex.target) : '`?`';

  switch (ex.shape) {
    // v2.74.131 — Canonical text-capture shapes.
    case 'text':
      return `read text from ${tgt} as ${out}`;

    case 'attribute': {
      const attr = ex.attribute ? `\`${ex.attribute}\`` : '`?`';
      return `read ${attr} attribute from ${tgt} as ${out}`;
    }

    // Legacy shapes — kept until all records are migrated.
    case 'scalar': {
      const ek = ex.extract ?? { kind: 'text' };
      if (ek.kind === 'attribute') {
        const attr = ek.attr ? `\`${ek.attr}\`` : '`?`';
        return `read ${attr} attribute from ${tgt} as ${out}`;
      }
      return `read text from ${tgt} as ${out}`;
    }

    case 'raw_text':
      return `read text of ${tgt} as ${out}`;

    case 'raw_html':
      return `read HTML of ${tgt} as ${out}`;

    case 'list_of_records': {
      const fields = Array.isArray(ex.fields) ? ex.fields : [];
      if (verbose || fields.length === 0) {
        return `capture each ${tgt} as ${out}`;
      }
      const fieldNames = fields.map(f => f?.name).filter(Boolean);
      const sample = fieldNames.slice(0, 3).join(', ');
      const more   = fieldNames.length > 3 ? ` +${fieldNames.length - 3} more` : '';
      const summary = fieldNames.length > 0 ? ` (${sample}${more})` : '';
      return `capture each ${tgt}${summary} as ${out}`;
    }

    case 'section':
      return `capture markdown of ${tgt} as ${out}`;

    case 'image_refs':
      return `list image references in ${tgt} as ${out}`;

    case 'image':
      return `capture the image at ${tgt} as ${out}`;

    case 'image_list':
      return `capture every image in ${tgt} as ${out}`;

    case 'image_snap': {
      const r = ex.rect ?? {};
      const dims = (Number.isFinite(r.width) && Number.isFinite(r.height))
        ? `${r.width}×${r.height} ` : '';
      return `snap a ${dims}region as ${out}`;
    }

    default:
      return `read ${ex.shape ?? '?'} from ${tgt} as ${out}`;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Last "segment" of a CSS selector; backticked. Matches FragmentDescription. */
function _selectorTail(sel) {
  const parts = String(sel).split(/[\s>+~]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? sel;
  return `\`${last}\``;
}

/** Capitalize first letter; leave the rest. */
function _capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
