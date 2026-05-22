/**
 * @file Services/LandmarkProfile.js
 * @description Pure helpers that derive a landmark's capabilities,
 * downstream-allowed operations, and verification score from the rich
 * fingerprint that contentScript._buildElementInspectionReport produces
 * (v2.74.234).
 *
 * Wave 1 of the SSOT landmark project: capture enough information at
 * authoring time that downstream consumers (fragment actions,
 * observation extracts) can pick a landmark and know — without
 * re-verifying — which operations will succeed. The richer Claude-
 * generated profile (descriptions, aliases, pitfalls, expectedContent)
 * lands in Wave 2.
 *
 * All exports are pure functions: same input → same output, no DOM,
 * no I/O. Safe to call in any context.
 *
 * @module Services/LandmarkProfile
 * @version 2.74.286
 */

// ─── Selector tier classifier (v2.74.288) ──────────────────────────────
//
// Mirrors ContentScripts/contentScript.js `synthesizeCandidates` tier
// system so we can compare two selectors (picker vs. Claude-proposed)
// on the same stability scale.
//
//   Tier 1 — #id (stable id only)
//   Tier 2 — [data-test-id] / [data-testid] / [data-test] / [data-qa] / [data-cy]
//   Tier 3 — [aria-label="…"] / tag[name="…"] / [role="…"]
//   Tier 4 — single stable class (.stableClass)
//   Tier 5 — multi-class chain
//   Tier 6 — structural (` > ` combinator chain) / tag-only
//   Tier 99 — unclassifiable (no recognized discriminator)
//
// Lower tier = more stable. Used by the Wave-2 landmark profile flow:
// the picker's selector is the authority, Claude can only override
// when its proposal is at a STRICTLY LOWER tier.

// Stability heuristic — mirrors picker's isStableIdent. Kept inline so
// LandmarkProfile stays a leaf module with no DOM dependencies.
function _isStableIdent(s) {
  if (!s || typeof s !== 'string') return false;
  if (s.length < 2) return false;
  if (/^\d+$/.test(s)) return false;                          // all numeric
  if (/__[A-Za-z0-9_-]{3,}$/.test(s)) return false;           // CSS modules suffix
  if (/^:r[0-9a-z]+:$/.test(s)) return false;                 // React 18 useId
  if (/^_r\d/.test(s)) return false;                          // emotion underscore prefix
  if (/^css-[a-z0-9]{6,}$/.test(s)) return false;             // emotion-style hashes
  if (/[0-9]{4,}/.test(s)) return false;                      // long digit run
  if (/^[a-f0-9]{8,}$/i.test(s)) return false;                // hex-only run
  // styled-components hash (6-char mixed-case alpha, low vowel density)
  if (/^[a-zA-Z]{5,10}$/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s)) {
    const vowels = (s.match(/[aeiouAEIOU]/g) ?? []).length;
    if (vowels / s.length < 0.25) return false;
  }
  return true;
}

/**
 * Classify a CSS selector by its strongest discriminator.
 *
 * The score is the BEST tier any part of the selector achieves — a
 * selector containing both an `#id` AND a structural chain still
 * scores tier 1 because the `#id` dominates.
 *
 * @param {string} selector
 * @returns {number} tier 1..6, or 99 for unclassifiable / empty input
 */
export function classifySelectorTier(selector) {
  if (!selector || typeof selector !== 'string') return 99;
  const s = selector.trim();
  if (!s) return 99;

  // Tier 1 — stable #id
  const idMatch = s.match(/#([\w-]+)/);
  if (idMatch && _isStableIdent(idMatch[1])) return 1;

  // Tier 2 — test markers
  if (/\[\s*(data-test-id|data-testid|data-test|data-qa|data-cy)\b/i.test(s)) return 2;

  // Tier 3 — aria-label / name / role / aria-labelledby
  if (/\[\s*(aria-label|aria-labelledby|name|role)\b/i.test(s)) return 3;

  // Tier 4/5 — stable classes. Filter unstable hash classes so a chain
  // of all-hash classes doesn't score as tier 5.
  const classMatches = s.match(/\.[A-Za-z_][\w-]*/g) || [];
  const stableClasses = classMatches.filter(c => _isStableIdent(c.slice(1)));
  if (stableClasses.length === 1) return 4;
  if (stableClasses.length >= 2) return 5;

  // Tier 6 — structural / tag-only (anything else with recognizable
  // CSS structure). Includes ` > ` chains, `:nth-of-type`, plain tags.
  return 6;
}

// ─── Element-shape classification ───────────────────────────────────────

/**
 * Coarse element-shape classifier from a fingerprint. Each landmark
 * fits at least one shape; many fit multiple (a <button> is both
 * `button` and — if it carries text — `text`).
 *
 * @param {object} fp - The fingerprint from _buildElementInspectionReport.
 * @returns {Set<string>}
 */
function _classifyElementShapes(fp) {
  const shapes = new Set();
  const tag  = (fp?.tag ?? '').toLowerCase();
  const role = (fp?.ariaRole ?? '').toLowerCase();
  const inputType = (fp?.inputType ?? '').toLowerCase();

  // Input-like (text entry / typable).
  const inputTypeIsText = !inputType
    || ['text', 'search', 'email', 'tel', 'url', 'password', 'number'].includes(inputType);
  if (tag === 'input' && inputTypeIsText) shapes.add('input');
  if (tag === 'textarea')                 shapes.add('input');
  if (fp?.isContentEditable)              shapes.add('input');

  // Input-like but NOT typable (checkbox, radio, file, range, color).
  if (tag === 'input' && !inputTypeIsText) shapes.add('input-control');

  // Button / clickable.
  if (tag === 'button') shapes.add('button');
  if (tag === 'a' && fp?.attrs?.['href']) shapes.add('link');
  if (tag === 'input' && ['button', 'submit', 'reset'].includes(inputType)) shapes.add('button');
  if (['button', 'link', 'menuitem', 'tab', 'switch', 'option'].includes(role)) shapes.add('button');
  if (fp?.hasOnclickAttr) shapes.add('button');
  // v2.74.342 — cursor:pointer is a strong clickability signal for JS-wired
  // elements that carry no role=button / onclick attribute: SVG icon buttons,
  // clickable <div>/<span> whose click handler is attached via
  // addEventListener (e.g. a magnifying-glass search button). The
  // `interactable` gate in deriveCapabilities still applies downstream.
  if (fp?.computedStyle?.cursor === 'pointer') shapes.add('button');

  // Select.
  if (tag === 'select')        shapes.add('select');
  if (role === 'combobox')     shapes.add('select');
  if (role === 'listbox')      shapes.add('select');

  // Container (has children).
  if ((fp?.childCount ?? 0) > 0) shapes.add('container');

  // v2.74.285 — Container with clickable descendants. Set when the
  // element has any anchor / button / role=button / role=link /
  // role=menuitem / role=tab inside it. Powers CLICK_BY_LABEL on
  // container landmarks (tag lists, nav regions, card grids) whose
  // own a11y role is generic but whose children are clickable.
  if ((fp?.clickableDescendantCount ?? 0) > 0) shapes.add('container-of-clickables');

  // Text-bearing (has visible text).
  // v2.74.286 — Also true for inputs / textareas / selects: the runtime
  // EXTRACT handler reads .value (HTMLInputElement / HTMLTextAreaElement
  // / HTMLSelectElement) when innerText is empty. Without this rule,
  // input.value extraction was unreachable through operationsAllowed.
  if ((fp?.innerTextLength ?? 0) > 0) shapes.add('text');
  if (tag === 'input' || tag === 'textarea' || tag === 'select') shapes.add('text');
  if (fp?.isContentEditable) shapes.add('text');

  // v2.74.286 — Direct image landmark. Image extraction operations
  // (image_refs, image, image_list) currently only opened for
  // containers — a direct <img> landmark was silently invalid. The
  // extractImageRefs runtime fix (v2.74.286) makes direct images
  // return [self]; this capability flag exposes the operation.
  if (tag === 'img' || tag === 'picture' || role === 'img') shapes.add('image');

  // List-item (one of multiple same-tag siblings).
  if ((fp?.siblingsSameTag ?? 0) >= 3) shapes.add('list-item');

  return shapes;
}

// ─── Capabilities ───────────────────────────────────────────────────────

/**
 * Derive capability flags from the rule-based fingerprint. Capabilities
 * are the deterministic "can this element support operation X?" matrix;
 * downstream consumers use them to filter their action / shape pickers.
 *
 * `interactable` factors disabled / readonly / aria-disabled / pointer-
 * events:none state — capabilities only flip on for actions the element
 * could ACTUALLY accept right now.
 *
 * @param {object} fp
 * @returns {object} { clickable, typable, selectable, textBearing,
 *                     attrBearing, isContainer, isListItem,
 *                     isInput, isButton, isLink, isSelect }
 */
export function deriveCapabilities(fp) {
  const shapes = _classifyElementShapes(fp);
  const interactable = fp?.isInteractable === true;

  const isInput     = shapes.has('input');
  const isInputCtrl = shapes.has('input-control');
  const isButton    = shapes.has('button');
  const isLink      = shapes.has('link');
  const isSelect    = shapes.has('select');

  // Typable: must be a text-entry element AND not readonly/disabled.
  const typable = isInput && interactable && !fp?.isReadOnly;

  // Clickable: button / link / on-click-attr / role=button etc.
  // Even disabled buttons satisfy this strictly, but `interactable`
  // gates it so a disabled button reports clickable=false.
  const clickable = (isButton || isLink || isInputCtrl) && interactable;

  // Selectable: select / combobox / listbox, if interactable.
  const selectable = isSelect && interactable;

  const textBearing = shapes.has('text');
  const isContainer = shapes.has('container');
  const isListItem  = shapes.has('list-item');
  // v2.74.285 — Container with clickable descendants. Independent of
  // self-clickability — a non-clickable <div> wrapper with <a> tags
  // inside it satisfies this.
  const childrenAreClickable = shapes.has('container-of-clickables');

  // Attrs worth extracting at runtime — data-* and aria-* values.
  // Excludes class/style/role/tabindex which rarely carry data payloads.
  const stableAttrKeys = Object.keys(fp?.attrs ?? {}).filter(k =>
    /^(data-|aria-)/.test(k) && !['aria-hidden', 'aria-disabled', 'aria-readonly'].includes(k)
  );
  const attrBearing = stableAttrKeys.length > 0;

  // v2.74.286 — Common HTML attrs the runtime knows how to extract:
  // href (links), src/alt/title (images), value/placeholder (inputs),
  // for (labels). Previously `attribute` op was gated solely on data-*/
  // aria-* presence, leaving plain <a href> / <img src> / <input value>
  // unable to expose attribute extraction even though the runtime
  // supports it via .getAttribute(name).
  const commonExtractableAttrs = ['href', 'src', 'alt', 'title', 'value', 'placeholder', 'for', 'name', 'type'];
  const fpAttrs = fp?.attrs ?? {};
  const hasCommonExtractableAttr = commonExtractableAttrs.some(k => fpAttrs[k] != null && fpAttrs[k] !== '');

  // v2.74.286 — Direct image landmark. Enables image_refs (and the
  // image / image_list observation shapes) when the landmark itself
  // is an <img> / <picture> / role=img, not just when it's a
  // container of images.
  const isImage = shapes.has('image');

  return {
    clickable, typable, selectable,
    textBearing, attrBearing,
    isContainer, isListItem,
    isInput, isButton, isLink, isSelect,
    // v2.74.285 — Container-scope clickability.
    childrenAreClickable,
    // v2.74.286 — Image-direct + common-attr capability.
    isImage,
    hasCommonExtractableAttr,
    // Echo interactable for the score function.
    interactable,
  };
}

// ─── Operations the capabilities permit ────────────────────────────────

/**
 * Derive the set of fragment actions + observation shapes a landmark
 * can support, given its capabilities. This is the filter downstream
 * authoring UIs apply to their dropdowns — fragment CLICK action only
 * shows landmarks where allowed.includes('CLICK'); observation text
 * shape filters on allowed.includes('text'); etc.
 *
 * @param {object} caps - Output of deriveCapabilities.
 * @returns {string[]}
 */
export function deriveAllowedOperations(caps) {
  const ops = new Set();
  // Universal ops — any element supports these.
  ops.add('WAIT_FOR');
  ops.add('WAIT_FOR_GONE');
  ops.add('SCROLL_TO');

  if (caps.clickable) {
    ops.add('CLICK');
    ops.add('CLICK_BY_LABEL');
    ops.add('click_copy');
    ops.add('click_copy_last');
  }
  // v2.74.285 — Container-scope CLICK_BY_LABEL. When the landmark
  // itself isn't clickable but contains anchors / buttons / role=...
  // / etc., CLICK_BY_LABEL still applies — it scopes a label-text
  // search to children of the landmark. Closes the "tag list / nav
  // region / card grid is a <div> wrapper" gap where the substrate's
  // direct-clickability rule excluded these from CLICK_BY_LABEL even
  // though the operation semantically applies. click_copy /
  // click_copy_last similarly clone the scoped click then copy.
  if (caps.isContainer && caps.childrenAreClickable && !caps.clickable) {
    ops.add('CLICK_BY_LABEL');
    ops.add('click_copy');
    ops.add('click_copy_last');
  }
  if (caps.typable) {
    ops.add('TYPE');
    ops.add('BLUR');
  }
  if (caps.selectable) {
    ops.add('SELECT');
  }
  // v2.74.308 — ACTION_SPEC § 3: KEY targets a focusable element
  // (§ 6 step 2 validates focusability). Any interactable element —
  // clickable, typable, or selectable — accepts keyboard events.
  // Examples: ArrowDown in a combobox/listbox, Escape on a focused
  // popover trigger, Tab to advance focus, Enter on a button.
  if (caps.interactable && (caps.clickable || caps.typable || caps.selectable)) {
    ops.add('KEY');
  }
  if (caps.textBearing) {
    ops.add('text');
    ops.add('text_last');
    ops.add('raw_text');
  }
  // v2.74.286 — `attribute` op also opens for elements carrying common
  // HTML attrs (href, src, alt, title, value, placeholder, for, name,
  // type), not just data-*/aria-*. The runtime's attribute extractor
  // is value-agnostic — it just calls .getAttribute(name) — so capability
  // gating shouldn't artificially exclude these.
  if (caps.attrBearing || caps.hasCommonExtractableAttr) {
    ops.add('attribute');
  }
  if (caps.isContainer) {
    ops.add('section');
    ops.add('list_of_records');
    ops.add('image_refs');
  }
  // v2.74.286 — Direct <img> / <picture> / role=img landmarks expose
  // image_refs (which now returns [self] from extractImageRefs when
  // the root is an IMG). Without this the only way to extract image
  // info was to author a wrapping container landmark — a silent
  // capability gap that the runtime never enforced.
  if (caps.isImage) {
    ops.add('image_refs');
  }

  return Array.from(ops);
}

// ─── Role → expected element shape ──────────────────────────────────────

/**
 * Heuristic mapping from a landmark `role` (lowercase-hyphenated user
 * input) to the element shape the author probably intends. Used by the
 * verification score to flag type-vs-role mismatches at authoring time
 * (e.g., role="search-input" landing on a <div>).
 *
 * Returns null when the role doesn't match any known pattern — the
 * verification score then skips the type-match check rather than
 * false-flagging legitimate landmarks (a role like "active-filter"
 * has no obvious tag implication).
 *
 * @param {string} role
 * @returns {{ requiredShape: string, label: string } | null}
 */
export function inferExpectedShapeFromRole(role) {
  if (!role || typeof role !== 'string') return null;
  const r = role.toLowerCase();

  // Input-shaped.
  if (/(^|[-_])(input|field|textarea|textbox|search-bar|searchbar|composer|message-input|chat-input|prompt-input|query|filter-input)([-_]|$)/.test(r)) {
    return { requiredShape: 'input', label: 'text input' };
  }
  // Select-shaped.
  if (/(^|[-_])(select|dropdown|picker|combobox|listbox|chooser)([-_]|$)/.test(r)) {
    return { requiredShape: 'select', label: 'select / dropdown' };
  }
  // Button-shaped.
  if (/(^|[-_])(button|btn|action|trigger|submit|send|copy|save|delete|cancel|close|toggle|open|expand|collapse)([-_]|$)/.test(r)) {
    return { requiredShape: 'button', label: 'button / clickable' };
  }
  // Link-shaped.
  if (/(^|[-_])(link|href|nav-item|menu-item|tab)([-_]|$)/.test(r)) {
    return { requiredShape: 'link', label: 'link' };
  }
  // Container / list-shaped.
  if (/(^|[-_])(list|results|container|panel|section|grid|table|feed|column|sidebar)([-_]|$)/.test(r)) {
    return { requiredShape: 'container', label: 'container / list' };
  }
  // Text-shaped.
  if (/(^|[-_])(text|label|title|heading|message|content|description|name|reply|prompt|status|caption)([-_]|$)/.test(r)) {
    return { requiredShape: 'text', label: 'text-bearing element' };
  }
  return null;
}

// ─── Verification score ────────────────────────────────────────────────

/**
 * Multi-axis verification of a landmark against its fingerprint + role.
 *
 * Score:
 *   - 'ready'    — every check passed (or skipped because no role hint)
 *   - 'caveats'  — passed core checks but with warnings (>1 match, role
 *                  not implying a shape so type-match was skipped, etc.)
 *   - 'mismatch' — failed a core check (element gone, hidden, wrong type)
 *
 * Returns:
 *   {
 *     score: 'ready'|'caveats'|'mismatch',
 *     checks: { elementExists, visible, interactable, typeMatchesRole, uniqueMatch },
 *     issues: string[]            // human-readable list of failed/warned checks
 *   }
 *
 * @param {object} args
 * @param {object} args.fp           Fingerprint (or null if matchedCount === 0)
 * @param {object} args.capabilities Output of deriveCapabilities (or null)
 * @param {string} args.role         Landmark role (may be empty)
 * @param {number} args.matchedCount Number of elements the selector matches
 * @returns {{score: string, checks: object, issues: string[]}}
 */
export function computeVerificationScore({ fp, capabilities, role, matchedCount }) {
  const checks = {
    elementExists  : matchedCount > 0 && !!fp,
    visible        : fp?.isVisible === true,
    interactable   : capabilities?.interactable === true,
    typeMatchesRole: true,    // default; updated below
    uniqueMatch    : matchedCount === 1,
  };
  const issues = [];

  // Element existence is the strongest signal — without it, every
  // other check is moot.
  if (!checks.elementExists) {
    issues.push('selector matches 0 elements');
    return { score: 'mismatch', checks, issues };
  }
  if (!checks.visible) issues.push('element is not visible (display:none, zero box, or aria-hidden)');

  // Type-match. Skipped when role doesn't imply a shape (the role is
  // free-form; we can only flag mismatches when we know the expected
  // shape).
  const expected = inferExpectedShapeFromRole(role);
  if (expected) {
    let typeOk;
    switch (expected.requiredShape) {
      case 'input':     typeOk = capabilities?.isInput === true; break;
      case 'select':    typeOk = capabilities?.isSelect === true; break;
      case 'button':    typeOk = capabilities?.isButton === true || capabilities?.clickable === true; break;
      case 'link':      typeOk = capabilities?.isLink === true; break;
      case 'container': typeOk = capabilities?.isContainer === true; break;
      case 'text':      typeOk = capabilities?.textBearing === true; break;
      default:          typeOk = true;
    }
    checks.typeMatchesRole = typeOk;
    if (!typeOk) {
      issues.push(`role "${role}" implies ${expected.label}, but matched element is <${fp?.tag ?? '?'}>`);
    }
  }

  // Uniqueness — most landmarks should resolve to exactly 1 element.
  // 0 was already caught above. >1 is a warning, not a failure: the
  // author may have intentionally picked a feed-item pattern (e.g.
  // for use with text_last). Downstream consumers should know to
  // either use *_last variants or tighten the selector.
  if (matchedCount > 1) {
    issues.push(`selector matches ${matchedCount} elements — downstream will pick the first unless a "_last" shape is used`);
  }

  // Interactability is informational unless the role implies an
  // interactive element. For text/container roles, non-interactable
  // is fine.
  if (!checks.interactable && expected && ['input', 'select', 'button', 'link'].includes(expected.requiredShape)) {
    issues.push('element is disabled, read-only, or pointer-events:none — interactive ops will fail');
  }

  // Overall score.
  // v2.74.342 — A role/type mismatch (e.g. a "button" role resolving to a
  // clickable <div> / SVG icon) is now a CAVEAT, not a hard mismatch: the
  // element exists + is visible + resolves, and the capability model gates
  // ops by ACTUAL capability anyway (a non-clickable element won't be offered
  // CLICK regardless of the score). Only an absent/invisible element is a
  // true mismatch. typeMatchesRole=false still records an issue → caveats.
  let score;
  if (!checks.visible) {
    score = 'mismatch';
  } else if (issues.length > 0) {
    score = 'caveats';
  } else {
    score = 'ready';
  }
  return { score, checks, issues };
}
