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
// @version 2.74.661

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

  // Depth (PAGEMODEL_SPEC `reveals` edge): a feature hidden behind a disclosure can't
  // be typed/clicked until its trigger is CLICKED to reveal it. Follow each picked
  // feature's `revealedBy` back-edge to the trigger and emit those reveal clicks FIRST
  // (deduped by selector), so a hidden search field is opened before TYPE. Triggers
  // resolved here are remembered so the acts loop below doesn't click them twice.
  let unverified = 0;
  const revealed = new Set();
  for (const f of [...fills, ...acts]) {
    if (!f.hidden || !f.revealedBy) continue;
    const trig = features[f.revealedBy];
    if (!trig || !trig.selector || revealed.has(trig.selector)) continue;
    revealed.add(trig.selector);
    if (trig.selectorVerified === false) unverified++;
    actions.push({ action: 'CLICK', selector: trig.selector });
  }

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
    if (revealed.has(f.selector)) continue;   // already emitted as a reveal trigger above
    if (f.selectorVerified === false) unverified++;
    actions.push({ action: 'CLICK', selector: f.selector });
  }

  const actionable = actions.filter((a) => a.action !== 'NAVIGATE').length;
  if (!picked.length) warnings.push('goal has no linked features (achievableVia empty) — nothing to do but navigate');
  if (revealed.size) warnings.push(`${revealed.size} disclosure step(s) injected to reveal hidden controls — review the step order`);
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

/**
 * Turn a draft (from synthesizeCapabilityDraft) into the persistable Fragment + Strategy records
 * the execution store expects (slice 2/3). PURE — the caller mints the ids and does the saves.
 *
 * Shape contract (verified against StorageManager + CapabilityAPI):
 *  - Fragment: { id, groundId, name, description, rawJson:JSON.stringify(actions), params:[names],
 *    preconditions/postconditions envelopes, healthStatus } — rawJson actions use {{PARAM}} which
 *    TemplateWalker substitutes from the fragment's paramBindings.
 *  - Strategy: { id, groundId, name, goal, params:[{name,kind:'scalar',type,required}],
 *    fragmentSteps:[{type:'fragment',fragmentId,paramBindings}] }. saveStrategy's
 *    #migrateStrategyShape lifts fragmentSteps → implementations envelope; status becomes 'ready'
 *    because there's ≥1 executable (fragment) node. Each strategy param flows into the fragment
 *    via a {kind:'strategy_param', name} binding.
 *
 * @param {object} draft  output of synthesizeCapabilityDraft
 * @param {{groundId:string, fragmentId:string, strategyId:string}} ids
 * @returns {{ fragment:object, strategy:object } | null}
 */
export function buildCapabilityRecords(draft, { groundId, fragmentId, strategyId } = {}) {
  if (!draft || !groundId || !fragmentId || !strategyId) return null;
  const now = Date.now();
  const paramNames = (Array.isArray(draft.params) ? draft.params : []).map((p) => p.name);

  const fragment = {
    id: fragmentId,
    groundId,
    name: `${draft.name} — steps`.slice(0, 80),
    description: draft.goal || '',
    rawJson: JSON.stringify(Array.isArray(draft.actions) ? draft.actions : []),
    params: paramNames,
    preconditions: [],    // ARRAY shape — the runtime reads fragment conditions as arrays (an envelope is silently skipped)
    postconditions: [],
    healthStatus: 'untested',
    lastExecutedAt: null,
    synthesized: true,                 // provenance: auto-authored from a goal, not hand-built
    createdAt: now,
    updatedAt: now,
  };

  const paramBindings = {};
  for (const name of paramNames) paramBindings[name] = { kind: 'strategy_param', name };

  const strategy = {
    id: strategyId,
    groundId,
    name: draft.name,
    goal: draft.goal || '',
    params: (Array.isArray(draft.params) ? draft.params : []).map((p) => ({
      name: p.name, kind: 'scalar', type: 'string', required: p.required !== false,
    })),
    fragmentSteps: [{ type: 'fragment', fragmentId, paramBindings }],
    aliases: [],
    outcomeSignal: null,
    synthesized: true,                 // provenance marker (a draft for review, not vetted)
    createdAt: now,
    updatedAt: now,
  };

  return { fragment, strategy };
}

/**
 * SG-T2-ACC — assemble a MULTI-fragment capability from a Tier-2 op's ordered phases: ONE Fragment per phase
 * + ONE Strategy that chains them via `fragmentSteps` (the Strategy model already runs N fragments in order).
 * Mirrors buildCapabilityRecords but for the multi-phase op. PURE: the CALLER synthesizes each phase's action
 * list — crucially RE-SYNTHESIZED WITHOUT the trial's commit-deferral, so the persisted fragment includes the
 * real commit CLICK and a REPLAY actually applies the filter (the trial only proved reachability). Steps keep
 * their inline `landmark` (SG-LM-3) so replay self-heals via probe-or-recover without a registry round-trip.
 * OBS-4b — `params` (optional) declares reusable inputs: any action `value`/`selector` carrying a `{{NAME}}`
 * placeholder is wired through. Each fragment's `params` + `paramBindings` are derived by SCANNING that
 * fragment's actions for the placeholders that actually appear (so bindings match real templates, never a
 * stale list); `strategy.params` is the union, each `{kind:'strategy_param', name}` so the value flows
 * scope → fragment → InjectionService.injectParams at replay. When `params` is empty, behaviour is unchanged
 * (all-literal actions, no bindings — the prior contract).
 *
 * @param {Array<{label:string, actions:object[]}>} phases  ordered phases with synthesized action lists
 * @param {{groundId:string, strategyId:string, fragmentIds:string[], name?:string, goal?:string, now?:number,
 *          params?:Array<{name:string,label?:string,value?:string}>}} ids
 * @returns {{fragments:object[], strategy:object}|null}  null when nothing is runnable / ids are short
 */
// Humanize an UPPER_SNAKE param name into words. SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY → "search job title keywords or company".
function _humanizeParam(n) { return String(n || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim(); }

// A readable hint for a CLICK target when no landmark name is available (the action carries a landmarkRef instead
// of an inline landmark, or the control had no accessible name). Recognizes common commit buttons; else humanizes
// the selector's last id/class token. "button.yosegi-…-primaryButton" → "the primary button".
function _selectorHint(selector) {
  const s = String(selector || '');
  if (/\b(primary|submit|search|find|apply|go|continue|next)\b/i.test(s) || /btn-primary|primaryButton/i.test(s)) return 'the primary button';
  if (/\bbutton\b|\bbtn\b/i.test(s)) return 'the button';
  const m = s.match(/[#.]([A-Za-z][\w-]*)\s*$/);
  if (m) { const w = _humanizeParam(m[1].replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_')); if (w) return `"${w}"`; }
  return 'the control';
}

// A readable "expression of intent" for a Fragment — the bare subGoal label (e.g. "Search") plus a plain-language
// summary of what its actions DO ("enter keywords, enter location, click Find jobs"). Normalizer actions
// (SCROLL_TO / WAIT / WAIT_FOR / NAVIGATE) are skipped; a {{PARAM}} TYPE reads as its humanized param; a CLICK
// reads its landmark name. Falls back to the label when nothing summarizes. PURE.
function _describeFragmentActions(label, actions) {
  const steps = [];
  for (const a of (Array.isArray(actions) ? actions : [])) {
    if (!a || !a.action || a.action === 'SCROLL_TO' || a.action === 'WAIT' || a.action === 'WAIT_FOR' || a.action === 'NAVIGATE') continue;
    const lm = (a.landmark && a.landmark.accessibleName) || '';
    const pm = /\{\{([A-Z0-9_]+)\}\}/.exec(String(a.value || ''));
    if (a.action === 'TYPE')          steps.push(`enter ${pm ? _humanizeParam(pm[1]) : (lm ? lm.toLowerCase() : 'a value')}`);
    else if (a.action === 'SELECT')   steps.push(`choose ${pm ? _humanizeParam(pm[1]) : (lm ? lm.toLowerCase() : 'an option')}`);
    else if (a.action === 'SET_FILE') steps.push('attach a file');
    else if (a.action === 'CLICK')    steps.push(`click ${lm || _selectorHint(a.selector)}`);
    else if (a.action === 'KEY')      steps.push(`press ${a.value || 'Enter'}`);
  }
  const base = String(label || '').trim();
  if (!steps.length) return base;
  const summary = steps.join(', ');
  const cap = summary.charAt(0).toUpperCase() + summary.slice(1);
  return (base ? `${base} — ${cap}` : cap).slice(0, 280);
}

// Anti-bot pacing — interactive actions that need a human-like pause before firing.
const _INTERACTIVE_ACTIONS = new Set(['TYPE', 'SELECT', 'CLICK', 'SET_FILE', 'KEY']);

// Insert a human-cadence WAIT before each interactive action so a replay isn't a rapid-fire burst (the pattern
// bot-detection flags). The WAIT carries base + jitter: the runtime sleeps base + random(0..jitter) ms, so EACH
// replay's timing differs (a constant delay is itself a fingerprint). TYPE is already per-keystroke jittered
// (40–350ms) in the content script, so this only adds the INTER-action gaps. SCROLL_TO / WAIT_FOR (reach/settle)
// are preserved. Applied at the PERSIST boundary so the saved Fragment is paced while the trial stays fast. PURE.
function _paceActions(actions) {
  const out = [];
  for (const a of (Array.isArray(actions) ? actions : [])) {
    if (a && _INTERACTIVE_ACTIONS.has(a.action)) out.push({ action: 'WAIT', value: 350, jitter: 750 });
    out.push(a);
  }
  return out;
}

// Fragment pre/postconditions are read at runtime as ARRAYS (ExecutionEngine: `Array.isArray(fragment.postconditions)`)
// — an envelope-shaped value is silently SKIPPED. A node's postcondition (SG-T2-2 structural ∪ SG-T2-5 LLM) is a
// {match, conditions} envelope, so extract its conditions ARRAY to actually carry the phase's success predicate(s). PURE.
function _conditionsArray(envelopeOrArray) {
  if (Array.isArray(envelopeOrArray)) return envelopeOrArray;
  if (envelopeOrArray && Array.isArray(envelopeOrArray.conditions)) return envelopeOrArray.conditions;
  return [];
}

export function buildTier2CapabilityRecords(phases, { groundId, strategyId, fragmentIds, name, goal, now, params } = {}) {
  const ph = Array.isArray(phases) ? phases.filter((p) => p && Array.isArray(p.actions) && p.actions.length) : [];
  if (!ph.length || !groundId || !strategyId || !Array.isArray(fragmentIds) || fragmentIds.length < ph.length) return null;
  const ts = Number.isFinite(now) ? now : Date.now();
  const declared = new Map((Array.isArray(params) ? params : []).filter((p) => p && p.name).map((p) => [p.name, p]));
  const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;
  const fragments = [];
  const fragmentSteps = [];
  const usedNames = new Set();   // union across fragments → strategy.params
  for (let i = 0; i < ph.length; i++) {
    const fragmentId = fragmentIds[i];
    const pacedActions = _paceActions(ph[i].actions);   // anti-bot: human-cadence WAIT before each interactive action
    const rawJson = JSON.stringify(pacedActions);
    // Wire only the params whose placeholders actually appear in THIS fragment's actions.
    const names = new Set();
    let m; PLACEHOLDER.lastIndex = 0;
    while ((m = PLACEHOLDER.exec(rawJson))) if (declared.has(m[1])) names.add(m[1]);
    const paramBindings = {};
    for (const nm of names) { paramBindings[nm] = { kind: 'strategy_param', name: nm }; usedNames.add(nm); }
    fragments.push({
      id: fragmentId, groundId,
      name: `${ph[i].label} — steps`.slice(0, 80),
      description: _describeFragmentActions(ph[i].label, ph[i].actions),   // an expression of intent, not the bare label
      rawJson,
      params: [...names],
      // Preconditions stay EMPTY for now. A substrate gate via perspective_ref(P) was prototyped (b4) but backed
      // out: perspective_ref expands to "ALL the perspective's landmarks present" and PreconditionGate failure is
      // FATAL, so it blocks any multi-fragment capability (landmarks span pages) and any render-on-open reveal —
      // converting working capabilities into gate failures. The perspective is still the monitorable condition
      // (b3, via isPerspectiveActive, which is non-fatal); the FRAGMENT gate is deferred to b5 (anchor-landmark or
      // non-fatal eval). ARRAY shape — the runtime + editor read fragment conditions as arrays.
      preconditions: [],
      postconditions: _conditionsArray(ph[i].postcondition),   // SG-T2-2/5 — carry the phase's success predicate(s) (was dropped)
      healthStatus: 'untested', lastExecutedAt: null, synthesized: true,
      createdAt: ts, updatedAt: ts,
    });
    fragmentSteps.push({ type: 'fragment', fragmentId, paramBindings });
  }
  const strategy = {
    id: strategyId, groundId,
    name: (name || 'Tier-2 capability').slice(0, 80), goal: goal || '',
    // required:false — replay always supplies the demonstrated default, so a missing value never hard-blocks.
    params: [...usedNames].map((nm) => {
      const d = declared.get(nm);
      return { name: nm, kind: 'scalar', type: 'string', required: false, label: (d && d.label) || nm, default: (d && d.value != null) ? String(d.value) : '' };
    }),
    fragmentSteps, aliases: [], outcomeSignal: null,
    synthesized: true, createdAt: ts, updatedAt: ts,
  };
  return { fragments, strategy };
}

/**
 * T1-as-first-class taxonomy guard (v2.74.762) — decide + shape the records for an accepted op. The ONE place the
 * rule lives, so the SG-trial accept and the demonstration accept can't drift: a SINGLE page-state-bounded phase
 * becomes a bare Fragment (NO Strategy wrapper); ≥2 phases chain into a Strategy. PURE — the caller mints the ids
 * and does the saves. `fragmentName`/`fragmentDescription` (optional) override the lone Fragment's name/description
 * (the demo path has an LLM-polished name); `aliases` (optional) ride onto the Strategy in the ≥2-phase case.
 * @returns {{ok:boolean, error?:string, isSingleT1?:boolean, fragments?:object[], strategy?:(object|null)}}
 */
export function prepareTier1or2Records(phases, { groundId, strategyId, fragmentIds, name, goal, params, now, aliases, fragmentName, fragmentDescription } = {}) {
  const recs = buildTier2CapabilityRecords(phases, { groundId, strategyId, fragmentIds, name, goal, params, now });
  if (!recs) return { ok: false, error: 'could not assemble capability records' };
  const isSingleT1 = recs.fragments.length === 1;
  if (isSingleT1) {
    if (fragmentName) recs.fragments[0].name = String(fragmentName).slice(0, 80);
    if (fragmentDescription) recs.fragments[0].description = String(fragmentDescription);
  } else if (Array.isArray(aliases) && aliases.length) {
    recs.strategy.aliases = aliases.slice();
  }
  return { ok: true, isSingleT1, fragments: recs.fragments, strategy: isSingleT1 ? null : recs.strategy };
}

/**
 * T1-as-first-class (v2.74.753) — collect every fragmentId + observationId referenced as a STEP anywhere in a set
 * of Strategy / Workflow trees (recursing fragmentSteps, detect branches + defaults, foreach/loop/gate bodies, the
 * top-level composition steps, and the implementations envelope). PURE. A primitive IN this set is a building
 * block of a composite; one NOT in it is a STANDALONE T1 — a discrete intent that is its own capability, surfaced
 * first-class by listCapabilities (so a single Fragment isn't double-listed as both a step and a capability).
 * @param {object[]} trees  strategy/workflow records (each may carry fragmentSteps / steps / implementations)
 * @returns {{fragmentIds:Set<string>, observationIds:Set<string>}}
 */
export function collectReferencedPrimitiveIds(trees) {
  const fragmentIds = new Set();
  const observationIds = new Set();
  const walk = (nodes) => {
    for (const n of (Array.isArray(nodes) ? nodes : [])) {
      if (!n || typeof n !== 'object') continue;
      if (n.type === 'fragment' && n.fragmentId) fragmentIds.add(n.fragmentId);
      if (n.type === 'observation' && n.observationId) observationIds.add(n.observationId);
      if (Array.isArray(n.body)) walk(n.body);
      if (Array.isArray(n.default)) walk(n.default);
      if (Array.isArray(n.branches)) for (const b of n.branches) walk(b && b.body);
    }
  };
  for (const t of (Array.isArray(trees) ? trees : [])) {
    if (!t || typeof t !== 'object') continue;
    if (Array.isArray(t.fragmentSteps)) walk(t.fragmentSteps);
    if (Array.isArray(t.steps)) walk(t.steps);
    const impl0 = Array.isArray(t.implementations) && t.implementations[0];
    if (impl0 && impl0.body && impl0.body.tree && Array.isArray(impl0.body.tree.fragmentSteps)) walk(impl0.body.tree.fragmentSteps);
  }
  return { fragmentIds, observationIds };
}

/**
 * T1-as-first-class (v2.74.752) — wrap a SAVED Fragment into a SYNTHETIC one-step Strategy object so it can run
 * through ExecutionEngine.executeStrategy WITHOUT being persisted as a Strategy. PURE. This is the keystone of
 * "a single T1 is saved as itself, not a Strategy": the SAVE path stays wrapper-free (just the Fragment); the
 * wrapper is built at RUN time and thrown away. The synthetic id is `fragment:<id>` — never written to storage,
 * so listCapabilities never sees a phantom Strategy. Fragment params are NAME strings → strategy_param bindings
 * (so the fragment's {{NAME}} placeholders fill from the run's param values), declared as scalar/string.
 * @param {{id:string, groundId?:string, name?:string, description?:string, params?:string[], preconditions?:object, postconditions?:object}} fragment
 * @param {{strategyId?:string, now?:number}} [opts]
 * @returns {object|null} a synthetic Strategy (pass as executeStrategy's inline `strategy`), or null if no fragment
 */
export function wrapFragmentAsStrategy(fragment, { strategyId = null, now } = {}) {
  if (!fragment || !fragment.id) return null;
  const ts = Number.isFinite(now) ? now : 0;
  const paramNames = (Array.isArray(fragment.params) ? fragment.params : []).filter((p) => typeof p === 'string' && p);
  const paramBindings = {};
  for (const nm of paramNames) paramBindings[nm] = { kind: 'strategy_param', name: nm };
  return {
    id: strategyId || `fragment:${fragment.id}`,
    groundId: fragment.groundId || null,
    name: fragment.name || 'Fragment',
    goal: fragment.description || fragment.name || '',
    params: paramNames.map((nm) => ({ name: nm, kind: 'scalar', type: 'string', required: false })),
    fragmentSteps: [{ type: 'fragment', fragmentId: fragment.id, paramBindings }],
    preconditions: (fragment.preconditions && typeof fragment.preconditions === 'object') ? fragment.preconditions : { match: 'all', conditions: [] },
    postconditions: (fragment.postconditions && typeof fragment.postconditions === 'object') ? fragment.postconditions : { match: 'all', conditions: [] },
    synthetic: true,                 // run-time wrapper, NOT a persisted artifact
    createdAt: ts, updatedAt: ts,
  };
}
