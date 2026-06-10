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
// @version 2.74.775

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
export function buildCapabilityRecords(draft, { groundId, fragmentId, strategyId, entryGate } = {}) {
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
    // b6a — the NON-FATAL substrate gate (advisory perspective_ref) when the caller binds one; [] otherwise (the
    // SG-trial accept passes buildPerspectiveGate(perspective.id)). ARRAY shape — the runtime reads conditions as arrays.
    preconditions: Array.isArray(entryGate) ? entryGate.slice() : [],
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

// v2.74.888 — URL slug of a value: lowercase, non-alphanumeric runs → '-', trimmed. "Videos"→"videos",
// "Sound Effects"→"sound-effects" — so a postcondition's "/videos/" segment is recognized as slug(a CATEGORY value).
const _urlSlug = (s) => String(s == null ? '' : s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// v2.74.888 — parameterize a postcondition's url_matches patterns by the params' DEMO values: replace any path
// SEGMENT equal to slug(param.value) with {{PARAM}} (slug("Videos")="videos" → the "/videos/" segment → {{CATEGORY}}).
// So a capability reused with a DIFFERENT bound value VERIFIES against the page it navigates to — the runtime
// substitutes the bound value (+ a slug-tolerant url_matches eval). Longest demo value first so a multi-word value
// wins over a sub-match. PURE. No demo values (empty params) → returned unchanged.
function _parameterizeUrlConditions(postcondition, params) {
  const subs = (Array.isArray(params) ? params : [])
    .filter((p) => p && p.name && p.value != null && String(p.value).trim())
    .map((p) => ({ slug: _urlSlug(p.value), name: p.name }))
    .filter((x) => x.slug.length >= 2)
    .sort((a, b) => b.slug.length - a.slug.length);
  if (!subs.length || !postcondition) return postcondition;
  const tmpl = (c) => {
    if (!c || c.type !== 'url_matches' || typeof c.pattern !== 'string') return c;
    let changed = false;
    const pattern = c.pattern.split('/').map((seg) => {
      const segSlug = _urlSlug(seg);
      if (!segSlug) return seg;
      const hit = subs.find((s) => s.slug === segSlug);
      if (hit) { changed = true; return `{{${hit.name}}}`; }
      return seg;
    }).join('/');
    return changed ? { ...c, pattern } : c;
  };
  if (Array.isArray(postcondition)) return postcondition.map(tmpl);
  if (Array.isArray(postcondition.conditions)) return { ...postcondition, conditions: postcondition.conditions.map(tmpl) };
  return postcondition;
}

export function buildTier2CapabilityRecords(phases, { groundId, strategyId, fragmentIds, name, goal, now, params, entryGate } = {}) {
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
    // v2.74.888 — parameterize this phase's url postconditions by ALL params' demo values FIRST (a postcondition
    // url can name a param an EARLIER phase set — e.g. the category), THEN wire the params whose {{NAME}} appears
    // in this fragment's actions OR its templated postconditions, so the runtime binds + substitutes them.
    const postcondArr = _conditionsArray(_parameterizeUrlConditions(ph[i].postcondition, [...declared.values()]));
    const names = new Set();
    let m; PLACEHOLDER.lastIndex = 0;
    const scanText = `${rawJson} ${JSON.stringify(postcondArr)}`;
    while ((m = PLACEHOLDER.exec(scanText))) if (declared.has(m[1])) names.add(m[1]);
    const paramBindings = {};
    for (const nm of names) { paramBindings[nm] = { kind: 'strategy_param', name: nm }; usedNames.add(nm); }
    fragments.push({
      id: fragmentId, groundId,
      name: `${ph[i].label} — steps`.slice(0, 80),
      description: _describeFragmentActions(ph[i].label, ph[i].actions),   // an expression of intent, not the bare label
      rawJson,
      params: [...names],
      // b6a (v2.74.775) — the ENTRY fragment carries a NON-FATAL substrate gate: a perspective_ref(entry) tagged
      // advisory:true (Core/accept.buildPerspectiveGate, passed in as `entryGate`). b4's fatal perspective_ref was
      // backed out because it flattened to "ALL landmarks present" and PreconditionGate failure is FATAL — blocking
      // multi-fragment caps + render-on-open reveals. The advisory gate is evaluated by isPerspectiveActive (the
      // monitor's own or-over-landmarks predicate, drift-tolerant, fail-closed) and NEVER aborts — it only warns,
      // so the perspective becomes the fragment's visible, monitorable precondition without the b4 brittleness.
      // Only the FIRST fragment gates (it owns the capability's entry page); inner phases run post-transition.
      // ARRAY shape — the runtime + editor read fragment conditions as arrays.
      preconditions: (i === 0 && Array.isArray(entryGate)) ? entryGate.slice() : [],
      postconditions: postcondArr,   // SG-T2-2/5 — carry the phase's success predicate(s); .886 url params templated
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
export function prepareTier1or2Records(phases, { groundId, strategyId, fragmentIds, name, goal, params, now, aliases, fragmentName, fragmentDescription, entryGate } = {}) {
  const recs = buildTier2CapabilityRecords(phases, { groundId, strategyId, fragmentIds, name, goal, params, now, entryGate });
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
 * HS-1 (v2.74.898) — HETEROGENEOUS Tier-2 persist: lower the IR's observation/navigate nodes INTO the
 * Strategy instead of dropping them at ACCEPT. The engine's strategy walker has dispatched
 * `type:'observation'|'navigate'` steps all along (ExecutionEngine 596-618) — only the auto-authoring
 * persist path was fragments-only, which is why a taught "act → read → act" flow could never survive as
 * ONE capability. PURE.
 *
 * Node kinds: `action` ({label, actions, postcondition?}) → Fragment record + fragment step (the existing
 * builder, postcondition templating included); `observation` ({label, extracts:[{selector,output,shape}]})
 * → a cache-tier Observation record (`implementations[0].extracts[{shape,target,output}]` — the engine's
 * post-Ship-A schema) + an `{type:'observation', observationId}` step; `navigate` ({mode:'url', url}) → a
 * `{type:'navigate', mode:'url', url:{kind:'literal'}}` step (click-mode navs are NOT lowered — the click
 * lives in the adjacent fragment's actions). Steps keep the nodes' ORIGINAL order.
 *
 * Pure-action input falls through to prepareTier1or2Records unchanged (bare-T1 taxonomy guard included);
 * any observation/navigate present forces a Strategy (those steps need the walker). At least one action
 * node is required — a capability must DO something.
 *
 * @param {Array<{kind:string}>} nodes
 * @param {object} opts  prepareTier1or2Records opts + observationIds?: string[] (minted per observation node)
 * @returns {{ok:boolean, error?:string, isSingleT1?:boolean, fragments?:object[], strategy?:object|null, observations?:object[]}}
 */
export function prepareHeteroTier2Records(nodes, { groundId, strategyId, fragmentIds, observationIds, name, goal, params, now, aliases, fragmentName, fragmentDescription, entryGate } = {}) {
  const list = (Array.isArray(nodes) ? nodes : []).filter((n) => n && typeof n === 'object');
  const actions = list.filter((n) => n.kind === 'action' && Array.isArray(n.actions) && n.actions.length);
  const hetero = list.some((n) => (n.kind === 'observation' && Array.isArray(n.extracts) && n.extracts.length)
    || (n.kind === 'navigate' && n.mode === 'url' && n.url));
  if (!actions.length) return { ok: false, error: 'no runnable action phases' };
  if (!hetero) {
    const prep = prepareTier1or2Records(actions, { groundId, strategyId, fragmentIds, name, goal, params, now, aliases, fragmentName, fragmentDescription, entryGate });
    return prep.ok ? { ...prep, observations: [] } : prep;
  }
  const recs = buildTier2CapabilityRecords(actions, { groundId, strategyId, fragmentIds, name, goal, params, now, entryGate });
  if (!recs) return { ok: false, error: 'could not assemble capability records' };
  const ts = Number.isFinite(now) ? now : Date.now();
  const observations = [];
  const steps = [];
  let ai = 0, oi = 0;
  for (const n of list) {
    if (n.kind === 'action') {
      if (!(Array.isArray(n.actions) && n.actions.length)) continue;
      const st = recs.strategy.fragmentSteps[ai++];
      if (st) steps.push(st);
    } else if (n.kind === 'observation') {
      if (!(Array.isArray(n.extracts) && n.extracts.length)) continue;
      const observationId = (Array.isArray(observationIds) && observationIds[oi]) || `obs_${strategyId}_${oi}`;
      oi++;
      observations.push({
        id: observationId,
        name: String(n.label || 'Read').slice(0, 120),
        groundId,
        implementations: [{ tier: 'cache', extracts: n.extracts.filter((e) => e && e.selector).map((e) => ({ shape: e.shape || 'text', target: e.selector, output: e.output || 'value' })) }],
        params: [], preconditions: [], postconditions: [],
        synthesized: true, createdAt: ts, updatedAt: ts,
      });
      steps.push({ type: 'observation', observationId });
    } else if (n.kind === 'navigate' && n.mode === 'url') {
      const url = typeof n.url === 'string' ? n.url : (n.url && n.url.value);
      if (url) steps.push({ type: 'navigate', mode: 'url', url: { kind: 'literal', value: String(url) } });
    }
  }
  recs.strategy.fragmentSteps = steps;
  if (Array.isArray(aliases) && aliases.length) recs.strategy.aliases = aliases.slice();
  return { ok: true, isSingleT1: false, fragments: recs.fragments, strategy: recs.strategy, observations };
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
 * v2.74.891 — which of `fragmentIds` must be KEPT (shielded) from a delete sweep: any fragment a SURVIVING
 * strategy still references. A bare-fragment cap can SHARE its backing Fragment with a T2 Strategy
 * (dedup/promotion), so an admin sweep of the cap's fragments would otherwise leave the strategy with a
 * dangling ref — the "missing a step" orphan the deep check (v2.74.889) DETECTS; this prevents the state
 * from FORMING. Refs are collected via collectReferencedPrimitiveIds (fragmentSteps + detect/foreach bodies
 * + the implementations envelope). PURE.
 * @param {string[]} fragmentIds          sweep candidates
 * @param {object[]} strategies           the Ground's live Strategy records
 * @param {Set<string>} [deletingStrategyIds]  strategies being deleted in the SAME op (their refs don't shield)
 * @returns {Set<string>} the subset of fragmentIds to KEEP
 */
export function shieldedFragmentIds(fragmentIds, strategies, deletingStrategyIds = new Set()) {
  const want = new Set((Array.isArray(fragmentIds) ? fragmentIds : []).filter(Boolean));
  const shielded = new Set();
  if (!want.size) return shielded;
  for (const s of (Array.isArray(strategies) ? strategies : [])) {
    if (!s || !s.id || (deletingStrategyIds && deletingStrategyIds.has(s.id))) continue;
    const { fragmentIds: refs } = collectReferencedPrimitiveIds([s]);
    for (const fid of want) if (refs.has(fid)) shielded.add(fid);
  }
  return shielded;
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

// NOTE (v2.74.789) — `wrapObservationAsStrategy` was REMOVED here. It wrapped a cross-Ground READ as a synthetic
// single-`observation`-node Strategy and ran it through ExecutionEngine's #executeObservationNode — which requires
// a persisted getObservation entity by node.observationId and crashed at run time with "OBSERVATION: observationId
// missing". More fundamentally it conflated the act/read split (a read is NOT a Strategy). The READ now runs
// observation-native in WorkflowExecutor._runObservationStep: HOP → replay the antecedent Fragment (ACT) →
// RUN_OBSERVATION (READ) → emit. See Services/WorkflowExecutor.js.
