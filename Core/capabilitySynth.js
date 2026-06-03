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
    preconditions: { match: 'all', conditions: [] },
    postconditions: { match: 'all', conditions: [] },
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
    const rawJson = JSON.stringify(ph[i].actions);
    // Wire only the params whose placeholders actually appear in THIS fragment's actions.
    const names = new Set();
    let m; PLACEHOLDER.lastIndex = 0;
    while ((m = PLACEHOLDER.exec(rawJson))) if (declared.has(m[1])) names.add(m[1]);
    const paramBindings = {};
    for (const nm of names) { paramBindings[nm] = { kind: 'strategy_param', name: nm }; usedNames.add(nm); }
    fragments.push({
      id: fragmentId, groundId,
      name: `${ph[i].label} — steps`.slice(0, 80),
      description: ph[i].label || '',
      rawJson,
      params: [...names],
      preconditions: { match: 'all', conditions: [] },
      postconditions: { match: 'all', conditions: [] },
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
