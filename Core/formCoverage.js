// Core/formCoverage.js — deterministic required-field oracle + intent-COVERAGE gate.
//
// Motivating failure (DESIGN_phaseB_pipeline §5, BambooHR 2026-05-28): a "complete a job application"
// intent captured ONLY the two OPTIONAL social-link fields (LinkedIn, Website) and zero of the ~15
// REQUIRED fields, the required resume upload, or the submit button. The grounded intent understood the
// full task; proposal narrowed it; and nothing downstream re-checked that the captured roles COVER the
// intent. The existing completeness gate (trialSynth.assessPerspectiveCompleteness) measures the wrong
// ratio — resolved/proposed — so it FALSE-PASSES: 2 optional roles, 0 required, 0 missing → "complete".
//
// The page already encodes which fields are necessary — `required` / `aria-required`, the `.Mui-required`
// label + asterisk marker, a required file input, a `type=submit` control. This module reads those markers
// (NO LLM, NO guessing) to produce the ground-truth necessary set, then scores whether a proposed/resolved
// ROLE set covers it. Where assessPerspectiveCompleteness asks "did resolve keep what propose asked for?",
// assessIntentCoverage asks the load-bearing question: "does the proposal cover the INTENT?"
//
// The pure functions (slug/match/select/assess) are unit-testable like Core/trialSynth.js. The live-DOM
// walker `enumerateFormFields` runs in a content script (it reads label elements + asterisks) and is the
// only DOM-touching export; everything else operates on plain descriptors.
//
// @module Core/formCoverage
// @version 2.74.555

const STOPWORDS = new Set(['the', 'a', 'an', 'your', 'please', 'enter', 'this', 'of', 'to', 'for', 'or', 'and', 'value', 'field', 'optional', 'required']);

/** Normalize any label/name/role into a stable kebab slug. */
export function toSlug(s) {
  return String(s || '')
    .replace(/[*]+/g, ' ')                 // drop required-marker asterisks
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')       // non-alnum → hyphen
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')// camelCase → kebab
    .toLowerCase()
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Significant tokens of a slug/phrase (stopwords + 1-char noise removed). */
function tokens(s) {
  return new Set(
    toSlug(s).split('-').filter((t) => t && t.length > 1 && !STOPWORDS.has(t)),
  );
}

/** Strip a trailing/embedded asterisk required-marker and surrounding whitespace from a label. */
export function stripAsterisk(label) {
  return String(label || '').replace(/\s*\*\s*$/,'').replace(/\s{2,}/g, ' ').trim();
}

/**
 * A concrete CSS selector for the field's REAL control, so resolve can bind directly instead of the
 * LLM guessing (which lands on MUI wrappers). Prefers a simple `#id`; falls back to a `[name="…"]`
 * attribute selector (handles dotted ids like `customQuestionAnswers.long_154` with no escaping); last
 * resort escapes a complex id. Returns null when neither id nor name is present.
 * @param {{id?:string, name?:string}} d
 * @returns {string|null}
 */
export function selectorForField(d) {
  const id = String(d?.id || '').trim();
  const name = String(d?.name || '').trim();
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `#${id}`;
  if (name) return `[name="${name.replace(/(["\\])/g, '\\$1')}"]`;
  if (id) return `#${id.replace(/([^\w-])/g, '\\$1')}`;
  return null;
}

/**
 * Is this descriptor a NECESSARY field for completing the form? Necessary = the submit control, or a
 * required actionable input (text/select/textarea/file). Optional fields are never necessary.
 * @param {object} d  field descriptor.
 */
export function isNecessaryField(d) {
  if (!d) return false;
  if (d.isSubmit) return true;
  return !!d.required;
}

/** Derive the semantic slot a field fills: 'submit' for the action, else slug(label||name||id). */
export function slotForField(d) {
  if (!d) return '';
  if (d.isSubmit) return 'submit';
  return toSlug(d.label || d.name || d.id || d.type || 'field');
}

/**
 * Reduce raw descriptors to the necessary set, de-duped by slot (the first descriptor wins).
 * @param {object[]} descriptors
 * @returns {Array<{slot:string, label:string, kind:string, required:boolean, isSubmit:boolean}>}
 */
export function selectNecessaryFields(descriptors) {
  const seen = new Set();
  const out = [];
  for (const d of (Array.isArray(descriptors) ? descriptors : [])) {
    if (!isNecessaryField(d)) continue;
    const slot = slotForField(d);
    if (!slot || seen.has(slot)) continue;
    seen.add(slot);
    out.push({ slot, label: stripAsterisk(d.label || d.name || d.id || ''), kind: d.kind || (d.isSubmit ? 'submit' : 'input'), required: !!d.required, isSubmit: !!d.isSubmit, selector: d.selector ?? selectorForField(d) });
  }
  return out;
}

/** Does a proposed role name plausibly fill a field slot? Token-overlap (Jaccard ≥ 0.5) or containment. */
export function slugMatch(roleName, fieldSlot) {
  const a = toSlug(roleName);
  const b = toSlug(fieldSlot);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.5;
}

/**
 * Match proposed roles to necessary fields.
 * @param {Array<string|{role:string}>} roles
 * @param {Array<{slot:string}>} necessaryFields
 * @returns {{ matched:Array<{field:string,role:string}>, missing:string[], extraRoles:string[] }}
 */
export function matchRolesToFields(roles, necessaryFields) {
  const roleNames = (Array.isArray(roles) ? roles : [])
    .map((r) => (typeof r === 'string' ? r : r && r.role)).filter(Boolean);
  const fields = Array.isArray(necessaryFields) ? necessaryFields : [];
  const matched = [];
  const usedRoles = new Set();
  const missing = [];
  for (const f of fields) {
    const hit = roleNames.find((rn) => slugMatch(rn, f.slot));
    if (hit) { matched.push({ field: f.slot, role: hit }); usedRoles.add(hit); }
    else missing.push(f.slot);
  }
  const extraRoles = roleNames.filter((rn) => !usedRoles.has(rn));
  return { matched, missing, extraRoles };
}

/**
 * The intent-COVERAGE gate. Only governs completion intents (where every required field is necessary);
 * read/act intents are governed by the existing minimal-role completeness, so this reports
 * `applicable:false` for them.
 *
 * @param {object} args
 * @param {'complete'|'read'|'act'} args.shape   from Core/intentShape.classifyIntentShape.
 * @param {object[]} args.fields                  raw field descriptors (from enumerateFormFields).
 * @param {Array<string|{role:string}>} args.roles  proposed/resolved role set.
 * @returns {{ applicable:boolean, shape:string, total:number, covered:number, coverage:number|null,
 *   missing:string[], extraRoles:string[], necessary:string[], sufficient:boolean, reason?:string }}
 */
export function assessIntentCoverage({ shape = 'act', fields = [], roles = [] } = {}) {
  if (shape !== 'complete') {
    return { applicable: false, shape, total: 0, covered: 0, coverage: null, missing: [], extraRoles: [], necessary: [], sufficient: true, reason: 'coverage gate applies to completion intents only' };
  }
  const necessary = selectNecessaryFields(fields);
  const { matched, missing, extraRoles } = matchRolesToFields(roles, necessary);
  const total = necessary.length;
  const covered = matched.length;
  return {
    applicable: true,
    shape,
    total,
    covered,
    coverage: total ? Math.round((covered / total) * 100) / 100 : null,
    missing,
    extraRoles,
    necessary: necessary.map((f) => f.slot),
    sufficient: missing.length === 0,
  };
}

/**
 * The necessary fields NOT covered by an existing role set — the deterministic backfill list. The form
 * oracle reads the full DOM (no viewport/scroll limit), so for an exhaustive completion intent this is
 * authoritative: append a role for each returned field to guarantee coverage regardless of what the LLM
 * could see or how a role cap truncated it.
 * @param {object[]} fields  raw descriptors (from enumerateFormFields).
 * @param {Array<string|{role:string}>} existingRoleNames
 * @returns {Array<{slot:string, label:string, kind:string, required:boolean, isSubmit:boolean}>}
 */
export function missingRoleFields(fields, existingRoleNames) {
  const necessary = selectNecessaryFields(fields);
  const have = (Array.isArray(existingRoleNames) ? existingRoleNames : []).filter(Boolean);
  const { missing } = matchRolesToFields(have, necessary);
  const missingSet = new Set(missing);
  return necessary.filter((f) => missingSet.has(f.slot));
}

// ─── Live-DOM walker (content-script only) ──────────────────────────────────
// The ONLY DOM-touching export. Produces descriptors for the pure functions above by reading the page's
// own necessity markers. Required is true when the control carries `required`/`aria-required`, OR its
// associated label is `.Mui-required` / ends with an asterisk (the MUI/Fabric convention this case used).

export const FORM_FIELD_SELECTOR =
  'input:not([type=hidden]):not([type=button]):not([type=reset]), select, textarea, button';

function labelTextFor(el, scope) {
  // 1) <label for=id>  2) wrapping <label>  3) aria-label / aria-labelledby.
  const id = el.id;
  if (id && scope.querySelector) {
    const forLabel = scope.querySelector(`label[for="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`);
    if (forLabel) return { text: forLabel.textContent || '', el: forLabel };
  }
  const closest = el.closest && el.closest('label');
  if (closest) return { text: closest.textContent || '', el: closest };
  const aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria) return { text: aria, el: null };
  const labelledby = el.getAttribute && el.getAttribute('aria-labelledby');
  if (labelledby && scope.getElementById) {
    const ref = scope.getElementById(labelledby);
    if (ref) return { text: ref.textContent || '', el: ref };
  }
  return { text: '', el: null };
}

function fieldIsRequired(el, labelInfo) {
  if (el.required === true) return true;
  const ar = el.getAttribute && el.getAttribute('aria-required');
  if (ar === 'true') return true;
  if (el.hasAttribute && el.hasAttribute('required')) return true;
  const lbl = labelInfo && labelInfo.el;
  if (lbl) {
    const cls = (lbl.className || '') + '';
    if (/required/i.test(cls)) return true;                  // .Mui-required / .required
    if (/\*\s*$/.test((lbl.textContent || '').trim())) return true; // trailing asterisk
    if (lbl.querySelector && lbl.querySelector('[class*="asterisk"], [class*="required"]')) return true;
  }
  return false;
}

/**
 * Enumerate a form's fields into descriptors (live DOM only). Safe to call with no DOM (returns []).
 * @param {Document|Element} [root]
 * @returns {object[]} descriptors consumable by selectNecessaryFields / assessIntentCoverage.
 */
export function enumerateFormFields(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || !scope.querySelectorAll) return [];
  const out = [];
  for (const el of scope.querySelectorAll(FORM_FIELD_SELECTOR)) {
    const tag = (el.tagName || '').toLowerCase();
    const rawType = (el.getAttribute && el.getAttribute('type')) || '';
    const type = (rawType || (tag === 'textarea' ? 'textarea' : tag === 'select' ? 'select' : 'text')).toLowerCase();
    // Mirrors contentScript._describeFormControl (the live form pass). A button is a
    // form control only if it PARTICIPATES in the form (explicit submit/reset, image
    // submit, or a bare <button> default-submit inside a <form>); a type=button is
    // inert. And not every form button is the SUBMIT — a reset/cancel/clear/back
    // abandons the form, so tag it as a plain action, never the success target.
    const isButton = tag === 'button';
    const btnType = isButton ? ((el.getAttribute && el.getAttribute('type')) || '') : '';
    const inForm = !!(el.closest && el.closest('form'));
    const isFormButton = (tag === 'input' && type === 'image')
      || (isButton && (btnType === 'submit' || btnType === 'reset' || (!btnType && inForm)));
    if (isButton && !isFormButton) continue;
    const labelInfo = labelTextFor(el, scope);
    let labelStr = stripAsterisk(labelInfo.text);
    if (!labelStr) {
      if (isButton) labelStr = stripAsterisk(el.textContent || '');
      else if (tag === 'input' && type === 'image') labelStr = (el.getAttribute && (el.getAttribute('alt') || el.getAttribute('value'))) || '';
      else if (tag === 'input' && type === 'submit') labelStr = (el.getAttribute && el.getAttribute('value')) || '';
    }
    // SG-2/PROVISIONAL (DESIGN_substrate_grounded_capabilities §4.6) — submit-vs-abandon
    // is a SEMANTIC verdict owned by Select (LLM). This lexical denylist is the no-LLM
    // DEFAULT only; do NOT extend per-site. Mirrors contentScript._describeFormControl.
    const negative = btnType === 'reset' || /^(cancel|reset|clear|close|back|dismiss|skip|previous|prev|discard)\b/i.test(labelStr);
    const isSubmit = isFormButton && !negative;
    out.push({
      tag,
      type,
      name: (el.getAttribute && el.getAttribute('name')) || '',
      id: el.id || '',
      label: labelStr,
      required: isFormButton ? false : fieldIsRequired(el, labelInfo),
      isSubmit,
      isAction: isFormButton,
      kind: isFormButton ? (isSubmit ? 'submit' : 'button') : (type === 'file' ? 'file' : tag === 'select' ? 'select' : 'input'),
      selector: selectorForField({ id: el.id || '', name: (el.getAttribute && el.getAttribute('name')) || '' }),
    });
  }
  return out;
}
