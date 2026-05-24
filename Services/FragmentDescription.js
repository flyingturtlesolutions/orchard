/**
 * @file Services/FragmentDescription.js
 * @description Pure description-composer for fragment action lists.
 *
 * Used by:
 *   - Sidepanel/modes/fragment-author.js — at save time, to write a
 *     human-readable description into the fragment record.
 *   - studio.js — at render time, to display either compact or verbose
 *     description from the fragment's rawJson regardless of what was
 *     stored at save (lets users toggle between formats without re-saving).
 *
 * Two formats:
 *   compact — single line. Action sequence joined with ", then" / "; ".
 *             For chain actions, exposes branch labels but skips per-branch
 *             layer-2 detail.
 *   verbose — multi-line. Each top-level action on its own line. Chain
 *             actions list per-branch layer-2 sample inline.
 *
 * Determinism: pure functions, no DOM, no async, no I/O. Same input always
 * produces same output. Safe to call at render time on every list refresh.
 *
 * @module Services/FragmentDescription
 * @version 2.74.9
 */

/**
 * Compose both compact and verbose descriptions from an action list.
 *
 * @param {Array<Object>} actions  - Action objects (rawJson-shape OR
 *                                   form-shape; both have `action`,
 *                                   `selector`, `value`, `pickedLabel`,
 *                                   optional `branches` and `bodyValue`).
 * @returns {{compact: string, verbose: string}}
 */
export function composeDescriptions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return { compact: 'Empty fragment.', verbose: 'Empty fragment.' };
  }
  return {
    compact : _composeCompact(actions),
    verbose : _composeVerbose(actions),
  };
}

/**
 * Convenience: compute just the compact form.
 * Used at fragment save time to populate the description field that
 * gets stored on disk; verbose can be regenerated from rawJson at
 * render time.
 *
 * @param {Array<Object>} actions
 * @returns {string}
 */
export function composeCompactDescription(actions) {
  return composeDescriptions(actions).compact;
}

// ─── Compact format ────────────────────────────────────────────────────────

function _composeCompact(actions) {
  const phrases = [];
  for (const a of actions) {
    const phrase = _phraseForAction(a, /* verbose */ false);
    if (phrase) phrases.push(phrase);
  }
  if (phrases.length === 0) return 'Empty fragment.';

  // Capitalize first letter of first phrase.
  phrases[0] = phrases[0].charAt(0).toUpperCase() + phrases[0].slice(1);

  let sentence;
  if (phrases.length === 1) {
    sentence = phrases[0];
  } else if (phrases.length === 2) {
    sentence = `${phrases[0]}, then ${phrases[1]}`;
  } else {
    const head = phrases.slice(0, -1).join(', ');
    sentence = `${head}, then ${phrases[phrases.length - 1]}`;
  }
  return sentence + '.';
}

// ─── Verbose format ────────────────────────────────────────────────────────

/**
 * Verbose layout: each top-level action on its own line. Chain actions
 * follow the head with an indented per-branch detail block. Newlines are
 * literal `\n` so renderers using `white-space: pre-line` (or similar)
 * lay them out as multi-line.
 */
function _composeVerbose(actions) {
  const lines = [];
  for (const a of actions) {
    if (Array.isArray(a.branches) && a.branches.length > 0) {
      // Chain: head as one line, branches indented beneath.
      const headPhrase = _chainHeadPhrase(a);
      lines.push(_capitalize(headPhrase) + ':');
      for (const b of a.branches) {
        const branchLine = _verboseBranchLine(a, b);
        if (branchLine) lines.push('  ' + branchLine);
      }
    } else {
      const phrase = _phraseForAction(a, /* verbose */ true);
      if (phrase) lines.push(_capitalize(phrase));
    }
  }
  if (lines.length === 0) return 'Empty fragment.';
  return lines.join('\n');
}

/**
 * Phrase for a chain head WITHOUT the branch tail (the tail is rendered
 * separately in verbose mode as indented lines below the head).
 *
 * @returns {string}
 */
function _chainHeadPhrase(a) {
  const label = (a.pickedLabel ?? '').trim();
  const sel = (a.selector ?? '').trim();
  const val = (a.value ?? '').trim();
  const isParamValue = /^\{\{[A-Z0-9_]+\}\}$/.test(val);
  const containerName = label ? `"${label}"` : _selectorTail(sel);
  if (isParamValue) return `pick ${val} from ${containerName}`;
  if (val)         return `pick "${_truncateValue(val)}" from ${containerName}`;
  return `pick from ${containerName}`;
}

/**
 * Render one branch as a verbose line. Format depends on branch action:
 *   CLICK_BY_LABEL — "Pay → click {{LAYER2}} from 'All Pay, $20+/hour, ...'"
 *   WAIT           — "After path X, wait 500ms"
 *   WAIT_FOR       — "After path X, wait for `selector-tail`"
 *
 * Returns empty string when the branch has no useful information.
 */
function _verboseBranchLine(chainAction, b) {
  const branchLabel = (b.label ?? '').trim() || '(unlabeled)';
  if (b.action === 'CLICK_BY_LABEL') {
    const bodyValue = (chainAction.bodyValue ?? '').trim();
    const layer2Sample = (b.pickedLabel ?? '').trim();
    const isParamBody = /^\{\{[A-Z0-9_]+\}\}$/.test(bodyValue);
    const targetPart = isParamBody
      ? `click ${bodyValue}`
      : (bodyValue ? `click "${_truncateValue(bodyValue)}"` : 'click');
    if (layer2Sample) {
      return `${branchLabel} → ${targetPart} from "${_truncateValue(layer2Sample, 80)}"`;
    }
    return `${branchLabel} → ${targetPart}`;
  }
  if (b.action === 'WAIT') {
    const ms = (b.value ?? '').trim() || '?';
    return `${branchLabel} → wait ${ms}ms`;
  }
  if (b.action === 'WAIT_FOR') {
    const sel = (b.selector ?? '').trim();
    return `${branchLabel} → wait for ${sel ? _selectorTail(sel) : 'element'}`;
  }
  return `${branchLabel} → ${b.action ?? '?'}`;
}

// ─── Per-action phrase (compact + plain top-level) ─────────────────────────

/**
 * Compose a single phrase for one action. Returns null when the action
 * is infrastructure (WAIT, BLUR, WAIT_FOR, unlabeled SCROLL_TO) and
 * shouldn't appear in the description.
 *
 * @param {Object}  a        - The action.
 * @param {boolean} verbose  - When true, omits the chain tail (caller
 *                             handles per-branch lines separately).
 *                             When false, emits the compact "..., then
 *                             N branches: label1, label2, ..." tail.
 */
function _phraseForAction(a, verbose) {
  const label = (a.pickedLabel ?? '').trim();
  const sel = (a.selector ?? '').trim();
  const val = (a.value ?? '').trim();
  const isParamValue = /^\{\{[A-Z0-9_]+\}\}$/.test(val);

  switch (a.action) {
    case 'CLICK':
      if (label) return `click "${label}"`;
      if (sel) return `click ${_selectorTail(sel)}`;
      return 'click';

    case 'CLICK_BY_LABEL': {
      // Chain: CLICK_BY_LABEL with non-empty branches. In compact mode
      // we expose the branch labels inline. Verbose mode is handled by
      // the caller (uses _chainHeadPhrase + per-branch lines).
      if (Array.isArray(a.branches) && a.branches.length > 0) {
        const headPhrase = _chainHeadPhrase(a);
        if (verbose) return headPhrase;   // caller adds branch lines
        // Compact tail: list the branch labels inline so a reader can
        // see WHICH paths the chain handles, not just the count.
        const branchLabels = a.branches
          .map(b => (b.label ?? '').trim())
          .filter(Boolean);
        if (branchLabels.length === 0) {
          const n = a.branches.length;
          return `${headPhrase}, then ${n} branch${n === 1 ? '' : 'es'}`;
        }
        return `${headPhrase}, then branch on: ${branchLabels.join(', ')}`;
      }
      const containerName = label ? `"${label}"` : _selectorTail(sel);
      if (isParamValue) return `pick ${val} from ${containerName}`;
      if (val) return `pick "${_truncateValue(val)}" from ${containerName}`;
      return `pick from ${containerName}`;
    }

    case 'TYPE': {
      if (label) {
        if (isParamValue) return `fill "${label}" with ${val}`;
        if (val) return `fill "${label}" with "${_truncateValue(val)}"`;
        return `fill "${label}"`;
      }
      if (val) return `type ${isParamValue ? val : `"${_truncateValue(val)}"`}${sel ? ` into ${_selectorTail(sel)}` : ''}`;
      return 'type';
    }

    case 'SELECT': {
      if (label) {
        if (isParamValue) return `select ${val} from "${label}"`;
        if (val) return `select "${_truncateValue(val)}" from "${label}"`;
        return `select an option from "${label}"`;
      }
      if (val) return `select ${isParamValue ? val : `"${_truncateValue(val)}"`}`;
      return 'select an option';
    }

    case 'SCROLL_TO':
      if (label) return `scroll to "${label}"`;
      // Unlabeled scrolls are infrastructure-ish; skip.
      return null;

    case 'WAIT':
    case 'WAIT_FOR':
    case 'WAIT_FOR_GONE':   // v2.74.200 — infrastructure, same as WAIT_FOR
    case 'BLUR':
      // Infrastructure — not meaningful in a human description.
      return null;

    case 'ACTION_GATE': {
      // v2.74.158 — Compose a phrase summarizing what the gate does:
      // a brief condition + the body's auto-composed phrases joined by
      // "and". When body is empty, fall back to a no-op note rather
      // than swallowing the gate entirely (which would make a
      // gate-only fragment compose as "Empty fragment.").
      const cond = a.condition ?? {};
      const negate = !!a.negate;
      const condText = _summarizeGateCondition(cond);
      const ifWord = negate ? 'if not' : 'if';
      const body = Array.isArray(a.body) ? a.body : [];
      const subPhrases = body
        .map(sub => _phraseForAction(sub, false))
        .filter(Boolean);
      if (subPhrases.length === 0) {
        return `${ifWord} ${condText}, (no actions)`;
      }
      return `${ifWord} ${condText}, ${subPhrases.join(' and ')}`;
    }

    default:
      return null;
  }
}

// v2.74.158 — Short human phrase for an ACTION_GATE header condition.
// Mirrors the dropdown vocabulary; falls back to the raw type when an
// unfamiliar condition kind appears (e.g. authored via JSON edit).
function _summarizeGateCondition(c) {
  if (!c || typeof c !== 'object') return 'condition';
  const t = c.type ?? 'condition';
  switch (t) {
    case 'selector_present':  return c.selector ? `${_selectorTail(c.selector)} appears` : 'selector appears';
    case 'selector_absent':   return c.selector ? `${_selectorTail(c.selector)} is absent` : 'selector is absent';
    case 'url_matches':       return c.pattern ? `URL matches "${_truncateValue(c.pattern)}"` : 'URL matches';
    // v2.74.170 — Mention the scoping selector when present.
    case 'text_present':      return c.text
                                ? (c.selector ? `"${_truncateValue(c.text)}" appears in ${_selectorTail(c.selector)}` : `"${_truncateValue(c.text)}" appears`)
                                : 'text appears';
    case 'attribute_equals':  return c.attribute && c.value
                                ? `${_selectorTail(c.selector ?? '')} has ${c.attribute}="${_truncateValue(c.value)}"`
                                : 'attribute equals';
    case 'assertion_ref':     return c.assertionId ? `assertion holds` : 'assertion';
    case 'perspective_ref':        return c.perspectiveId ? `perspective matches` : 'perspective';
    default:                  return String(t);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Last "segment" of a CSS selector, for use as a friendly fallback name. */
function _selectorTail(sel) {
  const parts = sel.split(/[\s>+~]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? sel;
  return `\`${last}\``;
}

/**
 * Truncate a literal value at maxLen chars for inline display.
 * Default 30 (matches legacy behavior). Verbose layer-2 samples get
 * 80 to show more menu options.
 */
function _truncateValue(v, maxLen = 30) {
  if (v.length <= maxLen) return v;
  return v.slice(0, maxLen - 3) + '…';
}

/** Capitalize first letter; leave the rest. */
function _capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
