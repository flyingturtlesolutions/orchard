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
// @version 2.74.541

const FILL_KINDS = new Set(['input']);
const ACT_KINDS  = new Set(['action', 'navigation', 'disclosure']);
const READ_KINDS = new Set(['collection', 'region', 'composite']);

const READ_VERB = /\b(find|search|show|list|get|see|view|read|browse|capture|extract|check|look|compare|monitor|track|scrape)\b/i;

/** Classify a role's kind: prefer the bound feature's kind, else infer from the role name. */
export function inferRoleKind(role, feature) {
  if (feature && typeof feature.kind === 'string' && feature.kind) return feature.kind;
  const n = String(role || '').toLowerCase();
  if (/(input|search|query|email|password|field|textbox|address|phone|quantity|amount|message|comment|keyword|term)/.test(n)) return 'input';
  if (/(result|item|card|row|listing|product|tile|entry|post|cell|article)/.test(n)) return 'collection';
  if (/(submit|button|action|add-to|buy|checkout|send|save|apply|continue|next|confirm|sign-in|signin|login|search-submit)/.test(n)) return 'action';
  if (/(trigger|toggle|expand|disclosure|dropdown|open|reveal|menu-button)/.test(n)) return 'disclosure';
  if (/(link|nav|menu|tab|breadcrumb)/.test(n)) return 'navigation';
  return 'action';   // default: treat an unknown role as an actionable control
}

/** A representative value to type into a free-text input for the trial (self-contained run). */
export function trialValueFor(role, intent) {
  const s = String(intent || '');
  const q = /["“'']([^"”'']{2,60})["”'']/.exec(s);                       // a quoted phrase
  if (q) return q[1].trim();
  const m = /\b(?:search(?:\s+for)?|find|look\s+for|enter|type|query)\s+(.{2,40}?)(?:\s+(?:on|in|at|from|and|then|with)\b|[.?!]|$)/i.exec(s);
  if (m) return m[1].trim();
  const n = String(role || '').toLowerCase();
  if (n.includes('email')) return 'test@example.com';
  if (n.includes('quantity') || n.includes('amount')) return '1';
  return 'test';                                                          // safe generic
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
      return { ...r, _kind: inferRoleKind(r.role, feature), _verified: !!(feature && feature.selectorVerified) };
    });

  const actions = [];
  const trialInputs = [];
  const skipped = [];
  const warnings = [];
  if (navigateUrl) actions.push({ action: 'NAVIGATE', value: navigateUrl });

  const fills = list.filter((r) => FILL_KINDS.has(r._kind));
  const acts  = list.filter((r) => ACT_KINDS.has(r._kind));
  const reads = list.filter((r) => READ_KINDS.has(r._kind));

  // 1. Reveal hidden controls first (open the trigger that discloses them).
  const revealed = new Set();
  for (const r of [...fills, ...acts]) {
    if (!r.hidden || !r.revealedBy) continue;
    const trig = list.find((c) => c.role === r.revealedBy);
    if (!trig || !trig.selector || revealed.has(trig.selector)) continue;
    revealed.add(trig.selector);
    actions.push({ action: 'CLICK', selector: trig.selector });
  }

  // 2. Fill inputs with concrete trial values (so the trial is self-contained, no param binding).
  for (const r of fills) {
    if (!r.selector) { skipped.push({ role: r.role, why: 'no selector' }); continue; }
    const value = trialValueFor(r.role, intent);
    actions.push({ action: 'TYPE', selector: r.selector, value });
    trialInputs.push({ role: r.role, selector: r.selector, value });
  }

  // 3. Click action controls (skip any already clicked as a reveal trigger).
  for (const r of acts) {
    if (!r.selector) { skipped.push({ role: r.role, why: 'no selector' }); continue; }
    if (revealed.has(r.selector)) continue;
    actions.push({ action: 'CLICK', selector: r.selector });
  }

  // 4. READ-shaped intent: EXTRACT the content/collection role as the proof of what's surfaced.
  // (A search intent is both: it fills+submits AND then extracts results.)
  const readish = reads.length > 0 && (fills.length === 0 ? true : READ_VERB.test(intent));
  let extractRole = null;
  if (readish) {
    const readRole = reads.find((r) => r.selector);
    // EXTRACT writes to scope under `target` (TemplateWalker), surfacing in the run's extractedValues
    // → the read-intent proof ("did the Perspective actually surface the content?").
    if (readRole) { actions.push({ action: 'EXTRACT', selector: readRole.selector, target: 'TRIAL_RESULT' }); extractRole = readRole.role; }
  }
  const shape = extractRole ? 'read' : 'act';

  const actionable = actions.filter((a) => a.action !== 'NAVIGATE').length;
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

  // Defer the commit: probe its reachability instead of clicking it.
  actions[termIdx] = { action: 'EXTRACT', selector: termSel, target: 'TRIAL_TERMINAL' };
  return { safetyClass: 'irreversible', actions, deferred: [termSel] };
}
