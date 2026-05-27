// Core/capabilitySynth.js — synthesize a DRAFT runnable procedure from a Locale goal.
//
// "Run this" (invocation arc, slice C, v2.74.470): a goal's `achievableVia` points at the
// concrete page features (each with a CSS selector + a `kind`) that accomplish it. This maps
// those into an ordered ACTION list — the Fragment `rawJson` shape `{action, selector, value}`
// — plus the params a TYPE needs, ready for the persistence slice to wrap into a Fragment +
// Strategy and hand to CapabilityAPI.invoke.
//
// IMPORTANT — this is a BEST-EFFORT DRAFT, not guaranteed automation. The page model encodes
// WHICH controls serve a goal, not the full procedure (exact order, what to type, when to wait /
// navigate). The output is meant for user REVIEW + refinement before running; `warnings` flags
// the uncertain parts and `runnable` says whether it has any real action (→ Strategy 'ready').
//
// PURE: no DOM / chrome / storage / id-minting (the persistence slice mints ids + saves).
//
// @module Core/capabilitySynth
// @version 2.74.470

/** Feature kinds that FILL a value (typed first), vs ACT (clicked after). */
const _FILL_KINDS = new Set(['input']);
const _ACT_KINDS  = new Set(['action', 'navigation', 'disclosure']);

/** A param name from a feature label: UPPER_SNAKE, bounded, never empty. */
function _paramName(label) {
  const n = String(label || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return n || 'INPUT';
}

/**
 * Synthesize a draft capability (ordered actions + params) from a goal and its Locale.
 * @param {{id?:string,label?:string,achievableVia?:string[]}} goal
 * @param {{features?:Object,url?:string,title?:string}} locale
 * @param {{groundId?:string,url?:string,name?:string}} [opts]  url = NAVIGATE target (archetype exemplar)
 * @returns {{ name:string, goal:string, groundId:string|null, navigateUrl:string|null,
 *             actions:Array<{action:string,selector?:string,value?:string}>,
 *             params:Array<{name:string,type:string,required:boolean,fromLabel:string}>,
 *             skipped:Array<{featureId:string,kind:string,why:string}>,
 *             warnings:string[], runnable:boolean }}
 */
export function synthesizeCapabilityDraft(goal, locale, { groundId = null, url = null, name = null } = {}) {
  const features = (locale && locale.features) || {};
  const via = (goal && Array.isArray(goal.achievableVia)) ? goal.achievableVia : [];
  const picked = via.map((id) => features[id]).filter(Boolean);

  const navigateUrl = url || (locale && locale.url) || null;
  const actions = [];
  const params = [];
  const skipped = [];
  const warnings = [];
  if (navigateUrl) actions.push({ action: 'NAVIGATE', value: navigateUrl });

  // Stable partition: fills (TYPE) before acts (CLICK) — "fill the form, then submit". The page
  // model doesn't encode true step order, so this conservative default is the draft's best guess.
  const fills = picked.filter((f) => _FILL_KINDS.has(f.kind));
  const acts  = picked.filter((f) => _ACT_KINDS.has(f.kind));
  for (const f of picked) {
    if (!_FILL_KINDS.has(f.kind) && !_ACT_KINDS.has(f.kind)) {
      skipped.push({ featureId: f.id, kind: f.kind || '(none)', why: 'not an actionable control (e.g. collection/content)' });
    }
  }

  let unverified = 0;
  const used = new Set();
  for (const f of fills) {
    if (!f.selector) { skipped.push({ featureId: f.id, kind: f.kind, why: 'no selector' }); continue; }
    if (f.selectorVerified === false) unverified++;
    let base = _paramName(f.label), n = base, k = 2;
    while (used.has(n)) n = `${base}_${k++}`;
    used.add(n);
    params.push({ name: n, type: 'string', required: true, fromLabel: f.label || '' });
    actions.push({ action: 'TYPE', selector: f.selector, value: `{{${n}}}` });
  }
  for (const f of acts) {
    if (!f.selector) { skipped.push({ featureId: f.id, kind: f.kind, why: 'no selector' }); continue; }
    if (f.selectorVerified === false) unverified++;
    actions.push({ action: 'CLICK', selector: f.selector });
  }

  const actionable = actions.filter((a) => a.action !== 'NAVIGATE').length;
  if (!picked.length) warnings.push('goal has no linked features (achievableVia empty) — nothing to do but navigate');
  if (unverified) warnings.push(`${unverified} selector(s) unverified — likely need refinement before running`);
  if (!actionable) warnings.push('no actionable controls resolved — draft only navigates to the page');

  return {
    name: (name || `Auto: ${(goal && goal.label) || 'capability'}`).slice(0, 80),
    goal: (goal && goal.label) || '',
    groundId,
    navigateUrl,
    actions,
    params,
    skipped,
    warnings,
    runnable: actionable > 0,
  };
}
