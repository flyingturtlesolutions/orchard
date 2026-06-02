// Core/trialSynth.js — synthesize a TRIAL operation from a RESOLVED Perspective bundle.
//
// Phase B (DESIGN_phaseB_pipeline R9, PB-3). Where Core/capabilitySynth.js builds a draft from a
// goal's `achievableVia` features, this builds one from the roles the user just materialized — the
// resolved role→landmark bundle (each role carries a selector and, when grounded, a featureId/kind).
// The output is a capabilitySynth-compatible DRAFT (`{name, goal, actions, params}`), so PB-4 can
// hand it to `buildCapabilityRecords` → Fragment+Strategy and run it as the intent-truth proof.
//
// The trial demonstrates the intent: reveal hidden controls → fill inputs (concrete trial values, so
// the run is self-contained) → click actions → and for a READ-shaped intent with a content role,
// EXTRACT it as the proof of what the Perspective surfaces.
//
// PURE: no chrome / DOM / storage. Unit-testable like Core/locale.js + Core/outcomes.js.
//
// @module Core/trialSynth
// @version 2.74.645

const FILL_KINDS = new Set(['input']);
const ACT_KINDS  = new Set(['action', 'navigation', 'disclosure']);
const READ_KINDS = new Set(['collection', 'region', 'composite']);

// SG normalizing actions — make the synthesized op robust on a real page instead of racing it. After a
// reveal CLICK the disclosed modal/menu paints asynchronously; the engine's fixed ~200ms post-step settle
// isn't always enough, so we WAIT_FOR the revealed element to actually appear (WAIT_FOR_ELEM polls and
// returns the instant it's there — this is the cap, not a fixed sleep). Off-screen targets (long pages:
// footer links, lower bands) get a SCROLL_TO so the action doesn't fire on an unscrolled element.
const REVEAL_WAIT_MS = 8000;
// Steps that move/settle the page rather than fulfilling the intent — excluded from the `runnable` count.
const _NORMALIZER_ACTIONS = new Set(['NAVIGATE', 'WAIT', 'WAIT_FOR', 'SCROLL_TO']);

// v2.74.580 — runtime sentinel: SELECT this to pick the first selectable option (handleSelect skips a
// leading placeholder). Lets a trial EXERCISE a dropdown without knowing valid option values. The literal
// is mirrored in contentScript.handleSelect (classic content scripts can't import Core).
export const TRIAL_SELECT_FIRST = '__ahub_trial_first_option__';

// Which fill op a control needs: a <select> → SELECT, a file input → SET_FILE (SG-#81c, not yet
// executable), everything else (text/textarea/search/email/…) → TYPE. Driven by the SUBSTRATE
// (feature.fieldType / interaction.pattern), not the role name. Exported so SG-INV-1 (Core/accept's
// param-schema builder) classifies a fillable role's input op with the SAME rule — no drift copy.
export function fillOpFor(feature, role) {
  const ft  = (feature && feature.fieldType) || (role && role.fieldType) || '';
  const pat = (feature && feature.interaction && feature.interaction.pattern) || '';
  if (ft === 'file' || pat === 'upload') return 'file';
  if (ft === 'select' || pat === 'select') return 'select';
  return 'text';
}

const READ_VERB = /\b(find|search|show|list|get|see|view|read|browse|capture|extract|check|look|compare|monitor|track|scrape)\b/i;

/** Classify a role's kind: prefer the bound feature's kind, else infer from the role name. */
export function inferRoleKind(role, feature) {
  if (feature && typeof feature.kind === 'string' && feature.kind) return feature.kind;
  // v2.74.594 — replay path: when the live feature is absent (re-Explore re-keyed featureIds), trust the
  // kind the bind step copied off the substrate onto the role. Keeps a saved capability's bucketing (fill
  // vs act) identical to its trial without the live feature. (`role` may be the role object or its name.)
  if (role && typeof role === 'object' && typeof role.kind === 'string' && role.kind) return role.kind;
  const n = String((role && typeof role === 'object' ? role.role : role) || '').toLowerCase();
  if (/(input|search|query|email|password|field|textbox|address|phone|quantity|amount|message|comment|keyword|term)/.test(n)) return 'input';
  if (/(result|item|card|row|listing|product|tile|entry|post|cell|article)/.test(n)) return 'collection';
  if (/(submit|button|action|add-to|buy|checkout|send|save|apply|continue|next|confirm|sign-in|signin|login|search-submit)/.test(n)) return 'action';
  if (/(trigger|toggle|expand|disclosure|dropdown|open|reveal|menu-button)/.test(n)) return 'disclosure';
  if (/(link|nav|menu|tab|breadcrumb)/.test(n)) return 'navigation';
  return 'action';   // default: treat an unknown role as an actionable control
}

// A control's value SLOT — what KIND of value it wants — so a search trial fills the LOCATION field with
// the place and the KEYWORD field with the query, instead of stuffing the same phrase into every text box.
// Matched first by the input's `name` attribute (exact, reliable), then by its role/label text.
const _SLOT_NAMES = {
  email:    new Set(['email', 'e-mail', 'mail', 'useremail']),
  location: new Set(['l', 'loc', 'location', 'city', 'where', 'region', 'state', 'zip', 'zipcode', 'postal', 'postcode', 'country', 'town']),
  keyword:  new Set(['q', 'query', 'k', 'kw', 'keyword', 'keywords', 'search', 'what', 'term', 'title', 's']),
  quantity: new Set(['qty', 'quantity', 'amount', 'count', 'num', 'number']),
  phone:    new Set(['phone', 'tel', 'telephone', 'mobile']),
};
const _SLOT_LABEL = [
  ['email',    /\be-?mail\b/],
  ['location', /\b(where|location|city|town|state|province|region|place|near|area|zip|postal|postcode|country)\b/],
  ['phone',    /\b(phone|tel|mobile|telephone)\b/],
  ['quantity', /\b(quantity|amount|qty|count|how many|number)\b/],
  ['name',     /\b(first name|last name|full name|your name|name)\b/],
  ['keyword',  /\b(what|search|keyword|query|term|title|job|find)\b/],
];
function _fieldSlot(label, name) {
  const n = String(name || '').toLowerCase().trim();
  if (n) for (const slot of Object.keys(_SLOT_NAMES)) if (_SLOT_NAMES[slot].has(n)) return slot;
  const h = String(label || '').toLowerCase();
  for (const [slot, re] of _SLOT_LABEL) if (re.test(h)) return slot;
  return 'generic';
}
// Place after a locative preposition ("… in arizona that were recently posted" → "arizona").
function _locationIn(intent) {
  const m = /\b(?:in|near|around|within|at|from)\s+([a-z][a-z .'\-]{1,28}?)(?=\s+(?:that|which|with|and|then|for|posted|recent|recently|over|under|from|to|by|on|near)\b|[,.?!]|$)/i.exec(String(intent || ''));
  return m ? m[1].trim() : '';
}
// Primary query term ("search for software jobs in arizona …" → "software jobs"); also honors a quoted phrase.
function _keyword(intent) {
  const s = String(intent || '');
  const q = /["“'']([^"”'']{2,60})["”'']/.exec(s);
  if (q) return q[1].trim();
  const m = /\b(?:search(?:\s+for)?|find|look\s+for|enter|type|query|browse|show\s+me)\s+(.{2,40}?)(?:\s+(?:on|in|at|near|from|and|then|with|that|which)\b|[.?!]|$)/i.exec(s);
  return m ? m[1].trim() : '';
}
// The `name` attribute out of a `[name="…"]` selector — the most reliable field-slot signal (q / l / email).
function _nameAttr(selector) {
  const m = /\[name=["']?([^"'\]]+)/.exec(String(selector || ''));
  return m ? m[1] : '';
}
/**
 * A representative value to type into a free-text input for the trial (self-contained run). FIELD-AWARE:
 * uses the control's role + label/name to pick the right slice of the intent (keyword vs location vs email
 * vs …), so a search trial actually exercises the form (a location field gets a place, not the query). Real
 * per-field values are supplied later at invocation (SG-INV). PURE.
 * @param {string} role  @param {string} intent  @param {{label?:string,name?:string}|string} [field]
 */
export function trialValueFor(role, intent, field = {}) {
  const f = (typeof field === 'string') ? { label: field } : (field || {});
  switch (_fieldSlot(`${role || ''} ${f.label || ''}`, f.name)) {
    case 'email':    return 'test@example.com';
    case 'quantity': return '1';
    case 'phone':    return '555-0100';
    case 'name':     return 'Test User';
    case 'location': return _locationIn(intent) || 'New York';
    case 'keyword':  return _keyword(intent) || 'test';
    default:         return _keyword(intent) || 'test';   // generic free-text
  }
}

/**
 * @param {object} args
 * @param {string} args.groundedIntent   the user's (grounded) intent — the proof target.
 * @param {Array<{role:string,selector?:string,featureId?:string,multiplicity?:string,hidden?:boolean,revealedBy?:string}>} args.roles
 *        the RESOLVED bundle (filled roles, with selectors).
 * @param {object} [args.locale]          Locale model — for feature.kind when a role carries featureId.
 * @param {string|null} [args.navigateUrl]
 * @param {string} [args.name]
 * @returns {{ name:string, goal:string, navigateUrl:string|null, shape:'act'|'read',
 *   actions:Array<{action:string,selector?:string,value?:string}>, params:Array<object>,
 *   trialInputs:Array<{role:string,selector:string,value:string}>, extractRole:string|null,
 *   skipped:Array<{role:string,why:string}>, warnings:string[], runnable:boolean }}
 */
export function synthesizeTrialOp({ groundedIntent, roles, locale = null, navigateUrl = null, name = null } = {}) {
  const intent = String(groundedIntent || '').trim();
  const features = (locale && locale.features) || {};
  const list = (Array.isArray(roles) ? roles : [])
    .filter((r) => r && typeof r.role === 'string')
    .map((r) => {
      const feature = r.featureId ? features[r.featureId] : null;
      const _offscreen = !!(feature && feature.location && feature.location.visibleAtRest === false);
      return { ...r, _kind: inferRoleKind(r, feature), _verified: !!(feature && feature.selectorVerified), _fillOp: fillOpFor(feature, r), _offscreen, _label: (feature && feature.label) || null, _href: (feature && feature.href) || null };
    });

  const actions = [];
  const trialInputs = [];
  const skipped = [];
  const warnings = [];
  if (navigateUrl) actions.push({ action: 'NAVIGATE', value: navigateUrl });

  // SG-LM-3 — the recoverable identity (proto-landmark, attached by Core/bind) travels ON each action as
  // `landmark: { role, accessibleName, hierarchicalContext, selector }`. The engine (TemplateWalker
  // #executeStep) probes the selector and, on a miss, recovers by role + accessible name — so a stale
  // selector self-heals instead of hard-failing. undefined when the role has no recoverable identity.
  const _lm = (r) => {
    const lm = r && r.landmark;
    if (!lm || !lm.selector) return undefined;
    return { role: lm.role || null, accessibleName: lm.accessibleName || null, hierarchicalContext: lm.hierarchicalContext || null, selector: lm.selector };
  };

  const fills = list.filter((r) => FILL_KINDS.has(r._kind));
  let   acts  = list.filter((r) => ACT_KINDS.has(r._kind));
  const reads = list.filter((r) => READ_KINDS.has(r._kind));

  // Collapse equivalent act/navigation targets (same destination identity) to ONE, preferring a SURFACE
  // control over a disclosed (hidden) one. A single-target navigate/act can match several controls that
  // reach the same place — e.g. Pixabay's footer "Pixabay Radio" link AND the hidden Explore-menu "Pixabay
  // Radio" link. The FIRST click navigates away, so a second target click then runs on the wrong page and
  // hard-fails (the live regression). Disclosures are enablers, never collapsed.
  const _destKey = (r) => String((r.landmark && r.landmark.accessibleName) || r._label || r._href || r.role || '').trim().toLowerCase();
  {
    const before = acts.length;
    const chosenAt = new Map();   // destKey → index into deduped
    const deduped = [];
    for (const r of acts) {
      if (r._kind === 'disclosure') { deduped.push(r); continue; }
      const key = _destKey(r);
      if (!key) { deduped.push(r); continue; }
      const at = chosenAt.get(key);
      if (at === undefined) { chosenAt.set(key, deduped.length); deduped.push(r); continue; }
      if (deduped[at].hidden && !r.hidden) deduped[at] = r;   // prefer the surface control; else drop the dup
    }
    acts = deduped;
    if (acts.length < before) warnings.push(`collapsed ${before - acts.length} duplicate target(s) reaching the same destination`);
  }

  // 1. Reveal hidden controls first (open the trigger that discloses them). Scroll the trigger into view
  //    first if it sits below the fold, so the disclosure click lands on a real, painted control.
  const revealed = new Set();
  for (const r of [...fills, ...acts]) {
    if (!r.hidden || !r.revealedBy) continue;
    const trig = list.find((c) => c.role === r.revealedBy);
    if (!trig || !trig.selector || revealed.has(trig.selector)) continue;
    revealed.add(trig.selector);
    if (trig._offscreen) actions.push({ action: 'SCROLL_TO', selector: trig.selector, optional: true });
    actions.push({ action: 'CLICK', selector: trig.selector, landmark: _lm(trig) });
  }

  // Pre-action normalizer for a role we're about to act on: WAIT_FOR a just-revealed element to paint
  // (only when its disclosure was actually injected above — otherwise the element is unreachable and a
  // WAIT_FOR would only burn the timeout before the doomed action fails honestly), else SCROLL_TO an
  // off-screen target into view. Marked `optional` so a miss is BEST-EFFORT, never fatal: the real action
  // step that follows still carries the landmark and does the probe-or-recover — a landmark-less normalizer
  // must NOT pre-empt that recovery by hard-failing on a stale/scroll-activated selector. No landmark here:
  // WAIT_FOR must poll the raw selector until the overlay renders, and SCROLL_TO needs a present element.
  const _pushNorm = (r) => {
    if (!r || !r.selector) return;
    if (r.hidden) {
      const trig = r.revealedBy ? list.find((c) => c.role === r.revealedBy) : null;
      if (trig && trig.selector && revealed.has(trig.selector)) {
        // SG-RES-2b (v2.74.645) — wait by IDENTITY, not only the positional selector. A revealed option's
        // page-absolute selector is captured INSIDE the disclosure's subtree, but many popovers render in a
        // body PORTAL (Indeed's pay/date filters), so that selector never matches → the wait burned its full
        // 8s timeout and the dropdown dismissed during the stall, starving the CLICK's role+name recovery
        // that follows. Carry the role + accessibleName so the wait returns the instant the option MOUNTS by
        // identity (selector OR description — either wins), keeping the popover open for the action.
        const lm = _lm(r);
        const wf = (lm && lm.role && lm.accessibleName) ? { role: lm.role, accessibleName: lm.accessibleName } : null;
        actions.push({ action: 'WAIT_FOR', selector: r.selector, value: REVEAL_WAIT_MS, optional: true, ...(wf ? { waitFor: wf } : {}) });
      }
    } else if (r._offscreen) {
      actions.push({ action: 'SCROLL_TO', selector: r.selector, optional: true });
    }
  };

  // 2. Fill inputs — by the field's ACTUAL kind, not always TYPE. A <select> needs SELECT; a file input
  //    needs SET_FILE (SG-#81c — not yet executable, so deferred with a clear reason rather than mis-TYPED);
  //    text/textarea/etc. get TYPE with a concrete trial value (self-contained run, no param binding).
  for (const r of fills) {
    if (!r.selector) { skipped.push({ role: r.role, why: 'no selector' }); continue; }
    _pushNorm(r);
    if (r._fillOp === 'file') {
      actions.push({ action: 'SET_FILE', selector: r.selector, value: 'trial-upload.pdf', landmark: _lm(r) });
      trialInputs.push({ role: r.role, selector: r.selector, value: '(trial file)', op: 'SET_FILE' });
      continue;
    }
    if (r._fillOp === 'select') {
      actions.push({ action: 'SELECT', selector: r.selector, value: TRIAL_SELECT_FIRST, landmark: _lm(r) });
      trialInputs.push({ role: r.role, selector: r.selector, value: '(first option)', op: 'SELECT' });
      continue;
    }
    const value = trialValueFor(r.role, intent, { label: r._label, name: _nameAttr(r.selector) });
    actions.push({ action: 'TYPE', selector: r.selector, value, landmark: _lm(r) });
    trialInputs.push({ role: r.role, selector: r.selector, value });
  }

  // 3. Click action controls (skip any already clicked as a reveal trigger).
  for (const r of acts) {
    if (!r.selector) { skipped.push({ role: r.role, why: 'no selector' }); continue; }
    if (revealed.has(r.selector)) continue;
    _pushNorm(r);
    actions.push({ action: 'CLICK', selector: r.selector, landmark: _lm(r) });
    // A NAVIGATION click leaves the page — any further on-page action would run on the destination and
    // hard-fail (the live "click footer Radio → navigate → then try the Explore-menu Radio" failure). A
    // navigate/act intent is fulfilled by reaching the target, so stop emitting once we've navigated.
    if (r._kind === 'navigation') break;
  }

  // 4. READ-shaped intent: EXTRACT the content/collection role as the proof of what's surfaced.
  // (A search intent is both: it fills+submits AND then extracts results.)
  const readish = reads.length > 0 && (fills.length === 0 ? true : READ_VERB.test(intent));
  let extractRole = null;
  if (readish) {
    const readRole = reads.find((r) => r.selector);
    // EXTRACT writes to scope under `target` (TemplateWalker), surfacing in the run's extractedValues
    // → the read-intent proof ("did the Perspective actually surface the content?").
    // v2.74.619 (SG-RES-4): `optional` — if the content role surfaces nothing the executor leaves
    // TRIAL_RESULT unset and the trial scores extractQuality=0 (a clean read-intent fail), not an abort.
    if (readRole) { _pushNorm(readRole); actions.push({ action: 'EXTRACT', selector: readRole.selector, target: 'TRIAL_RESULT', optional: true, landmark: _lm(readRole) }); extractRole = readRole.role; }
  }
  const shape = extractRole ? 'read' : 'act';

  // `runnable` reflects REAL operations (fill/click/extract), so a plan isn't deemed runnable on the
  // normalizing steps alone (NAVIGATE/WAIT/WAIT_FOR/SCROLL_TO never appear without a real action anyway).
  const actionable = actions.filter((a) => !_NORMALIZER_ACTIONS.has(a.action)).length;
  if (revealed.size) warnings.push(`${revealed.size} reveal step(s) injected to open hidden controls — review step order`);
  const unverified = list.filter((r) => r.selector && r.featureId && !r._verified).length;
  if (unverified) warnings.push(`${unverified} grounded selector(s) not yet page-verified — the trial verifies them`);
  if (!actionable) warnings.push('no actionable controls in the bundle — nothing to trial');

  return {
    name: (name || `Trial: ${intent.slice(0, 60) || 'perspective'}`).slice(0, 80),
    goal: intent,
    navigateUrl,
    shape,
    actions,
    params: [],            // concrete trial values inline → no param binding needed
    trialInputs,
    extractRole,
    skipped,
    warnings,
    runnable: actionable > 0,
  };
}

// PB-4 (R8) — trial safety classing. To PROVE an intent we must DO it, but a literal trial of an
// irreversible action (purchase/send/delete) would commit on the user's real account. So classify
// the op and, when irreversible, defer the terminal commit: swap the LAST CLICK → an EXTRACT
// reachability probe (confirms the commit element is present + reached after the reversible prefix
// ran, WITHOUT firing it). read/reversible ops run in full.
const IRREVERSIBLE_INTENT = /\b(buy|purchase|order|pay|payment|checkout|place\s*order|send|submit|delete|remove|cancel|post|publish|confirm|book|reserve|subscribe|unsubscribe|transfer|donate|withdraw|deposit|sign\s*up|register|apply|vote|bid)\b/i;
const IRREVERSIBLE_SELECTORHINT = /(buy|purchase|order|pay|checkout|place-?order|submit|delete|confirm|publish|send|book|subscribe|register|donate|transfer)/i;

/**
 * @param {string} intent
 * @param {{actions:Array<{action:string,selector?:string,value?:string}>}} draft
 * @returns {{ safetyClass:'read'|'reversible'|'irreversible', actions:Array<object>, deferred:string[] }}
 */
export function classifyTrialSafety(intent, draft) {
  const actions = (Array.isArray(draft?.actions) ? draft.actions : []).map((a) => ({ ...a }));
  const mutates = actions.some((a) => a.action === 'TYPE' || a.action === 'CLICK');
  if (!mutates) return { safetyClass: 'read', actions, deferred: [] };

  // Find the terminal commit = the LAST CLICK in the op.
  let termIdx = -1;
  for (let i = actions.length - 1; i >= 0; i--) { if (actions[i].action === 'CLICK') { termIdx = i; break; } }
  const termSel = termIdx >= 0 ? actions[termIdx].selector : null;
  const irreversible = IRREVERSIBLE_INTENT.test(String(intent || ''))
    || (termSel && IRREVERSIBLE_SELECTORHINT.test(String(termSel)));

  if (!irreversible || termIdx < 0) return { safetyClass: 'reversible', actions, deferred: [] };

  // Defer the commit: probe its reachability instead of clicking it. Carry the landmark through so the
  // reachability probe also self-heals if the commit's selector drifted (SG-LM-3). v2.74.619 (SG-RES-4):
  // `optional` — an absent
  // terminal is the SIGNAL this probe captures (not reachable), not a fragment crash: the executor leaves
  // TRIAL_TERMINAL unset → scoreTrial reads terminalReachable=0 → a clean trial-fail with legible evidence
  // (e.g. a "sign up with google" whose GSI button lives in a cross-origin iframe we can't reach).
  const termLm = actions[termIdx].landmark;
  actions[termIdx] = { action: 'EXTRACT', selector: termSel, target: 'TRIAL_TERMINAL', optional: true, ...(termLm ? { landmark: termLm } : {}) };
  return { safetyClass: 'irreversible', actions, deferred: [termSel] };
}

// PB-5 (R10) — score a trial RUN into a legible fidelity vector + verdict. This rubric IS the
// operational definition of an "intent-true" Perspective, so each axis is inspectable evidence, not a
// hidden number. Axes are 0..1 or null when not applicable to the intent shape. The verdict is
// shape/class-specific; `score` is the mean of the evaluated axes. PURE.
//
// @param {object} args
// @param {'act'|'read'} [args.shape]
// @param {'read'|'reversible'|'irreversible'} [args.safetyClass]
// @param {number} [args.resolvedRoleCount]  roles that filled (the bundle)
// @param {number} [args.proposedRoleCount]  roles the proposal asked for (≥ resolved)
// @param {string[]} [args.deferred]          deferred terminal selectors (irreversible)
// @param {object|null} args.result           ExecutionEngine.executeStrategy result
// @returns {{ verdict:'trial-pass'|'trial-fail', score:number, vector:object, evidence:string[] }}
export function scoreTrial({ shape = 'act', safetyClass = 'reversible', resolvedRoleCount = 0, proposedRoleCount = 0, deferred = [], result = null } = {}) {
  const evidence = [];
  const stepResults = Array.isArray(result?.stepResults) ? result.stepResults : [];
  const frag = stepResults[0] || null;
  const extracted = (result && result.extractedValues) || {};
  const sizeOf = (v) => Array.isArray(v) ? v.length : (typeof v === 'string' ? v.trim().length : (v ? 1 : 0));

  // resolvedCompleteness — filled / proposed roles.
  const denom = proposedRoleCount > 0 ? proposedRoleCount : resolvedRoleCount;
  const resolvedCompleteness = denom > 0 ? Math.min(1, resolvedRoleCount / denom) : null;
  if (resolvedCompleteness != null) evidence.push(`${resolvedRoleCount}/${denom} role(s) resolved (${Math.round(resolvedCompleteness * 100)}%)`);

  // effectMatch — did the op's steps execute without error? (PB-8 refines with observed-vs-predicted.)
  const ranOk = frag ? (frag.success !== false) : !!result?.success;
  const effectMatch = result == null ? null : (ranOk ? 1 : 0);
  if (result != null) evidence.push(ranOk ? `Ran ${frag?.actionsRun ?? '?'} step(s), no errors` : `Run failed: ${frag?.error || result?.error || 'step error'}`);

  // postconditionMet — only meaningful if conditions existed (trial fragments have none → null).
  const postFailures = frag?.postFailures;
  const postconditionMet = Array.isArray(postFailures) ? (postFailures.length === 0 ? 1 : 0) : null;
  if (Array.isArray(postFailures) && postFailures.length) evidence.push(`${postFailures.length} postcondition(s) failed`);

  // extractQuality — read-intent proof: did the EXTRACT surface content?
  let extractQuality = null;
  if (shape === 'read') {
    const n = sizeOf(extracted.TRIAL_RESULT);
    extractQuality = n > 0 ? 1 : 0;
    evidence.push(n > 0 ? `Surfaced content (${Array.isArray(extracted.TRIAL_RESULT) ? extracted.TRIAL_RESULT.length + ' item(s)' : 'non-empty'})` : 'Extract returned nothing');
  }

  // terminalReachable — irreversible proof: did the deferred terminal probe resolve (not fire)?
  let terminalReachable = null;
  if (safetyClass === 'irreversible') {
    const present = sizeOf(extracted.TRIAL_TERMINAL) > 0;
    terminalReachable = present ? 1 : 0;
    evidence.push(present ? `Reached terminal action (${deferred.join(', ') || 'commit'}) — not fired` : `Terminal action not reachable (${deferred.join(', ') || 'commit'})`);
  }

  let pass;
  if (safetyClass === 'irreversible') pass = effectMatch === 1 && terminalReachable === 1;
  else if (shape === 'read') pass = effectMatch === 1 && extractQuality === 1;
  else pass = effectMatch === 1 && (resolvedCompleteness == null || resolvedCompleteness >= 0.5);

  const vector = { resolvedCompleteness, effectMatch, postconditionMet, extractQuality, terminalReachable };
  const axes = Object.values(vector).filter((x) => x != null);
  const score = axes.length ? Math.round((axes.reduce((a, b) => a + b, 0) / axes.length) * 100) / 100 : 0;
  return { verdict: pass ? 'trial-pass' : 'trial-fail', score, vector, evidence };
}

// PB-6 (R6) — assess a resolved bundle against the PROPOSED roles. "Complete" = every REQUIRED role
// (multiplicity one|many) resolved; optional/conditional roles never block. Surfaces the resolution
// report so the orchestrator can BLOCK accept on a structurally-incomplete Perspective — containment
// completeness (every survivor kept) ≠ sufficiency (a required role that resolve dropped is missing).
const REQUIRED_MULT = new Set(['one', 'many']);

/**
 * @param {Array<{role:string,multiplicity?:string}>} proposedRoles
 * @param {string[]} filledRoleNames  role names that resolved (the bundle)
 * @returns {{ proposedCount:number, resolvedCount:number, resolved:string[], dropped:string[],
 *   missingRequired:string[], complete:boolean }}
 */
export function assessPerspectiveCompleteness(proposedRoles, filledRoleNames) {
  const proposed = (Array.isArray(proposedRoles) ? proposedRoles : []).filter((r) => r && typeof r.role === 'string');
  const filled = new Set(Array.isArray(filledRoleNames) ? filledRoleNames : []);
  const resolved = [];
  const dropped = [];
  const missingRequired = [];
  for (const r of proposed) {
    if (filled.has(r.role)) { resolved.push(r.role); continue; }
    dropped.push(r.role);
    if (REQUIRED_MULT.has(r.multiplicity ?? 'one')) missingRequired.push(r.role);
  }
  return {
    proposedCount: proposed.length,
    resolvedCount: resolved.length,
    resolved,
    dropped,
    missingRequired,
    complete: missingRequired.length === 0,
  };
}
