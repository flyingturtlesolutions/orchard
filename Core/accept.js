// Core/accept.js — PB-7 (R11 + R12): turn a PASSING substrate-grounded trial into a durable capability.
//
// Per DESIGN_phaseB_pipeline §3 PB-7 + the workspace/runtime split, accept produces TWO artifacts:
//
//   • CapabilityAcceptance — LEAN, lives on the workspace primitive. The re-runnable capability: the
//     IntentSpec essence + the binding (subGoal/role → durable selector) + the cover verdict + the trial
//     verdict + lineage. No raw DOM, no per-step blobs — safe to sync. This is what a later run replays
//     WITHOUT re-comprehending (Comprehend/Select are cached into the binding).
//
//   • trialTrace — HEAVY, lives in runtime/training, referenced by `trialRef`. The full proof: the entire
//     IntentSpec, the selection, the cover detail, the roles, the trial vector + evidence, and the raw
//     per-step result. Evidence for §5 credit assignment and the training pipeline; never synced as
//     authoring data.
//
// Copy-on-accept: the caller holds the materialization as a SESSION DRAFT; on accept it persists both
// artifacts atomically and emits an `accept` outcome; on reject it drops the draft and emits `reject`.
// These functions are PURE — no storage, no chrome, no clock beyond an injected `acceptedAt`.

export const ACCEPT_SCHEMA = 1;

// djb2 (base36) — same id style as Core/outcomes.js / Core/locale.js.
function _hash(s) {
  const str = String(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Stable-ish capability id from the intent + where it's grounded. */
export function mintCapabilityId(intent, groundId, localeUrl) {
  return 'cap_' + _hash(`${groundId || ''}|${localeUrl || ''}|${String(intent || '').trim().toLowerCase()}`);
}

/** Trial-proof reference id derived from the capability id + accept time (one trace per acceptance). */
export function mintTrialRef(capabilityId, acceptedAt) {
  return 'trial_' + _hash(`${capabilityId || ''}|${acceptedAt || Date.now()}`);
}

/**
 * The accept gate. A capability may be accepted ONLY when the trial PASSED, and — for a `complete`
 * intent — only when the completeness floor was met (PB-10: an intent-true library must not save a
 * half-covered form-fill as if it were the whole capability). read/act/navigate accept on a pass alone;
 * their cover floor is the required sub-goals, already reflected in `cover.complete`.
 * @returns {{ ok:boolean, reason:string }}
 */
export function canAccept({ trial = null, cover = null, spec = null } = {}) {
  if (!trial || trial.verdict !== 'trial-pass') {
    return { ok: false, reason: `trial did not pass (${trial?.verdict || 'no trial'})` };
  }
  const shape = (spec && spec.shape) || (cover && cover.shape) || 'act';
  if (shape === 'complete' && cover && cover.complete !== true) {
    return { ok: false, reason: `completion intent is not covered: ${cover.reason || 'incomplete'}` };
  }
  return { ok: true, reason: 'trial passed' + (shape === 'complete' ? ' and completeness floor met' : '') };
}

// Normalize a cover verdict (either shape from Core/cover.js) into a lean, schema-stable summary.
function _leanCover(cover) {
  if (!cover || typeof cover !== 'object') return { complete: false, reason: 'no cover verdict' };
  const out = { complete: cover.complete === true, reason: cover.reason || '' };
  if (cover.shape === 'complete') {
    out.completionCount = cover.completionCount ?? 0;
    out.operableCount = cover.operableCount ?? 0;
    out.orphanRequired = Array.isArray(cover.orphanRequired) ? cover.orphanRequired.slice() : [];
    out.hasSuccessAction = !!cover.hasSuccessAction;
  } else {
    out.requiredSubGoals = Array.isArray(cover.requiredSubGoals) ? cover.requiredSubGoals.slice() : [];
    out.unmetSubGoals = Array.isArray(cover.unmetSubGoals) ? cover.unmetSubGoals.slice() : [];
  }
  return out;
}

// A binding entry is a role bound to a feature with a durable selector — the replayable essence.
function _leanBinding(roles) {
  return (Array.isArray(roles) ? roles : [])
    .filter((r) => r && typeof r.role === 'string')
    .map((r) => {
      const b = { role: r.role, selector: r.selector || null };
      if (r.featureId) b.featureId = r.featureId;
      if (r.multiplicity) b.multiplicity = r.multiplicity;
      // kind + fieldType make the binding self-contained — replay reproduces the same op without the
      // live feature (featureIds drift on re-Explore). Carry them through to the saved capability.
      if (r.kind) b.kind = r.kind;
      if (r.fieldType) b.fieldType = r.fieldType;
      if (r.hidden) b.hidden = true;
      if (r.revealedBy) b.revealedBy = r.revealedBy;
      return b;
    });
}

/**
 * Build the LEAN CapabilityAcceptance record. PURE.
 * @param {object} args
 * @param {string} args.intent          raw user intent.
 * @param {object} args.spec            IntentSpec (Comprehend).
 * @param {object} args.cover           cover verdict (Core/cover.js coverComplete).
 * @param {Array}  args.roles           bound roles (Core/bind.js selectionToTrialRoles).
 * @param {object} args.trial           trial score (Core/trialSynth.js scoreTrial).
 * @param {string} args.groundId
 * @param {string} args.localeUrl
 * @param {number} [args.acceptedAt]
 * @param {string} [args.trialRef]      if the caller already minted one (keeps lean↔heavy linked).
 * @returns {object} CapabilityAcceptance
 */
export function buildCapabilityAcceptance({ intent, spec = {}, cover = null, roles = [], trial = null, groundId = '', localeUrl = '', acceptedAt = Date.now(), trialRef = null } = {}) {
  const id = mintCapabilityId(intent, groundId, localeUrl);
  const ref = trialRef || mintTrialRef(id, acceptedAt);
  const subGoals = (Array.isArray(spec.subGoals) ? spec.subGoals : [])
    .map((g) => ({ id: g.id, label: g.label || '', shape: g.shape || 'act', scope: g.scope || 'required' }));
  return {
    schema: ACCEPT_SCHEMA,
    id,
    kind: 'substrate-capability',
    intent: String(intent || '').trim(),
    shape: spec.shape || (cover && cover.shape) || 'act',
    safety: spec.safety || 'benign',
    target: spec.target || '',
    groundId: groundId || '',
    localeUrl: localeUrl || '',
    subGoals,
    binding: _leanBinding(roles),
    cover: _leanCover(cover),
    trial: trial ? { verdict: trial.verdict, score: trial.score ?? null, vector: trial.vector || null, trialRef: ref } : { verdict: 'unknown', score: null, vector: null, trialRef: ref },
    decidedBy: spec.decidedBy || 'unknown',
    acceptedAt,
    lifecycle: 'fresh',
  };
}

// Pull a compact per-step proof out of the raw ExecutionEngine result (defensive: shape varies).
function _trialSteps(result) {
  const frag = (result && Array.isArray(result.stepResults)) ? result.stepResults[0] : null;
  const actions = frag && Array.isArray(frag.actions) ? frag.actions
    : (frag && Array.isArray(frag.lastActions) ? frag.lastActions : []);
  return actions.map((a) => ({
    action: a.action || a.kind || '',
    selector: a.selector || a.target || a.resolvedSelector || '',
    outcome: a.outcome || (a.error ? 'failure' : 'success'),
    ...(a.error ? { error: String(a.error).slice(0, 200) } : {}),
  }));
}

/**
 * Build the HEAVY trialTrace (runtime/training). PURE.
 * @returns {object} trialTrace — referenced by capability.trial.trialRef.
 */
export function buildTrialTrace({ capabilityId, trialRef, intent, spec = {}, selection = null, cover = null, roles = [], trial = null, result = null, groundId = '', localeUrl = '', acceptedAt = Date.now() } = {}) {
  // Keep selection lean-ish: matches + orphans + boundary ids, not the full feature objects.
  const leanSelection = selection ? {
    matches: selection.matches || {},
    orphanRequired: Array.isArray(selection.orphanRequired) ? selection.orphanRequired.map((f) => f.id) : [],
    boundary: selection.boundary ? {
      requiredFields: (selection.boundary.requiredFields || []).map((f) => f.id),
      successAction: selection.boundary.successAction ? selection.boundary.successAction.id : null,
    } : null,
  } : null;
  return {
    schema: ACCEPT_SCHEMA,
    trialRef: trialRef || mintTrialRef(capabilityId, acceptedAt),
    capabilityId: capabilityId || null,
    intent: String(intent || '').trim(),
    groundId: groundId || '',
    localeUrl: localeUrl || '',
    acceptedAt,
    intentSpec: spec || null,
    selection: leanSelection,
    cover: cover || null,
    roles: Array.isArray(roles) ? roles : [],
    trial: trial ? { verdict: trial.verdict, score: trial.score ?? null, vector: trial.vector || null, evidence: Array.isArray(trial.evidence) ? trial.evidence : [] } : null,
    steps: _trialSteps(result),
  };
}

/**
 * One-call convenience: gate + build both artifacts. Returns { ok, reason } when the gate blocks,
 * else { ok:true, capability, trace }. The background handler persists `capability` (workspace) and
 * `trace` (runtime), links them via `trialRef`, and emits the `accept` outcome.
 */
export function buildAcceptance(args = {}) {
  const gate = canAccept(args);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const acceptedAt = args.acceptedAt || Date.now();
  const capability = buildCapabilityAcceptance({ ...args, acceptedAt });
  const trace = buildTrialTrace({ ...args, capabilityId: capability.id, trialRef: capability.trial.trialRef, acceptedAt });
  return { ok: true, capability, trace };
}
