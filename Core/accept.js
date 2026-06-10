// Core/accept.js — SG-5 / PB-7 (R11 + R12): turn a PASSING substrate-grounded trial into durable,
// reviewable, replayable LIBRARY entities — the same primitives a human authors, minted by intent.
//
// "Promote/hydrate on accept": the trial materialized proto-landmarks (Core/landmark) + a throwaway
// fragment/strategy. Accept PROMOTES them — pure builders here produce the saveable records; the
// background handler persists them via StorageManager:
//
//   • Landmark[]  — one per bound role that carries a recoverable identity (selector + role +
//     accessibleName). Saved to the per-Ground registry (uid-keyed). Recoverable via
//     LANDMARK_PROBE_OR_RECOVER. (The full generateLandmarkProfile enrichment is a later slice — the
//     captured fields already make the landmark recoverable.)
//   • Perspective — the intent-scoped composition: { landmarkRefs: [uid…] }, authoredBy:'model'. Appears
//     in the Ground library like a hand-authored one. This is SG-5's "Perspective = derived binding layer".
//   • CapabilityAcceptance — LEAN pointer record: { perspectiveId, landmarkUids[], intent, cover, trial
//     verdict, trialRef }. References the saved entities rather than re-embedding raw selectors.
//   • trialTrace — HEAVY proof (runtime/training, by trialRef): full IntentSpec, lean selection, roles,
//     vector + evidence, compact per-step result.
//
// PURE — no storage, no chrome, no clock beyond an injected `acceptedAt`. The gate (canAccept) refuses to
// build on a failing trial / under-covered completion intent.

import { inferRoleKind, fillOpFor, isTypeableDisclosure } from './trialSynth.js';

export const ACCEPT_SCHEMA = 1;

// djb2 (base36) — same id style as Core/outcomes.js / Core/locale.js.
function _hash(s) {
  const str = String(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Canonical PAGE scope: origin + pathname, query/hash stripped (the page-archetype, not a specific instance).
// Bad parse → the raw string. Keys the Perspective id on the PAGE so query noise (?q=writer vs ?q=philosopher on
// the SAME /jobs page) never forks a duplicate; also the urlMatches scope rung (b3).
function _urlScopePattern(localeUrl) {
  try { const u = new URL(localeUrl); return u.origin + u.pathname; } catch { return String(localeUrl || ''); }
}

/** Stable capability id from the intent + where it's grounded (re-accept upserts the same record). */
export function mintCapabilityId(intent, groundId, localeUrl) {
  return 'cap_' + _hash(`${groundId || ''}|${localeUrl || ''}|${String(intent || '').trim().toLowerCase()}`);
}
/** Stable Perspective id — keyed on the canonical PAGE (origin+pathname), so two searches with different query
 *  strings on the same page reuse ONE perspective instead of forking duplicates (the raw localeUrl query WAS the bug). */
export function mintPerspectiveId(intent, groundId, localeUrl) {
  return 'persp_sg_' + _hash(`${groundId || ''}|${_urlScopePattern(localeUrl)}|${String(intent || '').trim().toLowerCase()}`);
}
/** Stable Landmark uid — same element identity on the same (ground, locale) → same uid (re-accept reuses). */
export function mintLandmarkUid(groundId, localeUrl, lm) {
  return 'lmk_sg_' + _hash(`${groundId || ''}|${localeUrl || ''}|${lm?.role || ''}|${lm?.accessibleName || ''}|${lm?.selector || ''}`);
}
/** Trial-proof reference id derived from the capability id + accept time (one trace per acceptance). */
export function mintTrialRef(capabilityId, acceptedAt) {
  return 'trial_' + _hash(`${capabilityId || ''}|${acceptedAt || Date.now()}`);
}

/**
 * The accept gate. A capability may be accepted ONLY when the trial PASSED, and — for a `complete`
 * intent — only when the completeness floor was met (PB-10: an intent-true library must not save a
 * half-covered form-fill as if it were the whole capability). read/act/navigate accept on a pass alone.
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

/**
 * Build saveable Landmark records from the bound roles' proto-landmarks. PURE. Only roles with a selector
 * AND a recoverable identity (a derived role) become landmarks — the rest (file/collection) replay by
 * selector only and don't need a registry entry. Returns [{ role, uid, record }] preserving order,
 * deduped by uid (same element bound twice → one landmark).
 */
export function buildLandmarkRecords({ roles = [], groundId = '', localeUrl = '', acceptedAt = Date.now() } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(roles) ? roles : [])) {
    const lm = r && r.landmark;
    if (!lm || !lm.selector || !lm.role) continue;   // need a selector + a recoverable role
    const uid = mintLandmarkUid(groundId, localeUrl, lm);
    if (seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      role: r.role,
      uid,
      record: {
        uid,
        groundId: groundId || '',
        selector: lm.selector,
        a11yRole: lm.role || null,
        accessibleName: lm.accessibleName || null,
        hierarchicalContext: lm.hierarchicalContext || null,
        alias: r.role || lm.accessibleName || null,
        lifecycle: 'fresh',
        source: 'sg-accept',
        createdAt: acceptedAt,
      },
    });
  }
  return out;
}

/**
 * b5 (v2.74.766) — mint a VERIFIED outcome Landmark for an in-place (SPA) success region: the swapped-in
 * container the recorder captured as a Fragment's settle selector (b1). PURE. The user demonstrably saw this
 * region appear, so it is verified-by-demonstration. Identity is selector-only for now (the swap marker carried
 * no role/name) → recovery is selector-based until a later capture profiles it. Promoting it to a registry
 * Landmark (and into the Perspective) makes the SUCCESS STATE part of the capability's substrate — monitor-visible
 * via isPerspectiveActive and self-healing-eligible — instead of a free-floating selector in the postcondition.
 * `outcome:true` marks it as a success-state landmark (vs an operative control) for the future outcome-perspective.
 * Returns null when there is no settle region.
 * @returns {object|null}
 */
export function buildResultsLandmarkRecord({ settleSelector, role = null, accessibleName = null, text = null, groundId = '', localeUrl = '', acceptedAt = Date.now() } = {}) {
  const selector = (typeof settleSelector === 'string' && settleSelector.trim()) ? settleSelector.trim() : '';
  if (!selector) return null;
  // b5b — when the recorder captured a11y role/name (e.g. role="region" aria-label="Search results"), the landmark
  // is RECOVERABLE (probe-or-recover by role+name on selector drift). A bare results <div> has neither → selector-
  // only (still a tracked, verified registry entity). uid is keyed on the recoverable identity so re-observing the
  // same region reuses the slot.
  const a11yRole = (typeof role === 'string' && role.trim()) ? role.trim() : null;
  const name = (typeof accessibleName === 'string' && accessibleName.trim()) ? accessibleName.trim() : null;
  const uid = mintLandmarkUid(groundId, localeUrl, { role: a11yRole, accessibleName: name, selector });
  return {
    uid, groundId: groundId || '',
    selector,
    a11yRole, accessibleName: name, hierarchicalContext: null,
    textContent: (typeof text === 'string' && text.trim()) ? text.trim().slice(0, 140) : null,
    alias: name || 'results region', outcome: true,
    lifecycle: 'verified', verifiedBy: 'demonstration', verifiedAt: acceptedAt,
    source: 'observed', createdAt: acceptedAt,
  };
}

/**
 * b3 (v2.74.765) — synthesize a Perspective ACTIVATION PREDICATE tree from the grounded substrate. PURE.
 * A Perspective IS a condition: `isPerspectiveActive` evaluates `predicates` (and/or tree over substrate leaves),
 * and the InteractionMonitor reads the same via `listActivePerspectives`. Without predicates a perspective is
 * "always active" (vacuous) — useless as a gate and invisible to the monitor. We emit:
 *
 *   and( urlMatches(scope, 'contains'),    // bootstrap scope rung — cheap page pre-filter
 *        or(landmarkExists(uid)…) )         // substrate truth — ≥1 operative landmark present (drift-tolerant)
 *
 * (There is no k_of_n operator — `or` over the operative landmarks is the available drift-tolerant form.) The
 * result is the `predicates` ARRAY (implicit top-level AND that `isPerspectiveActive` understands). url-only when
 * no landmarks are grounded yet (the bootstrap state); empty → the perspective stays always-active (back-compat).
 * @returns {Array<object>}
 */
export function buildPerspectivePredicates({ localeUrl = '', landmarkUids = [] } = {}) {
  const scope = _urlScopePattern(localeUrl);
  const urlLeaf = scope ? { kind: 'urlMatches', pattern: scope, mode: 'contains' } : null;
  const lmLeaves = (Array.isArray(landmarkUids) ? landmarkUids : [])
    .filter(Boolean)
    .map((uid) => ({ kind: 'landmarkExists', target: uid }));
  const substrate = lmLeaves.length === 0 ? null : (lmLeaves.length === 1 ? lmLeaves[0] : { operator: 'or', children: lmLeaves });
  if (urlLeaf && substrate) return [{ operator: 'and', children: [urlLeaf, substrate] }];
  if (substrate) return [substrate];
  if (urlLeaf) return [urlLeaf];   // bootstrap: url-only scope until substrate is grounded
  return [];
}

/**
 * b5c (v2.74.768) — build a distinct OUTCOME Perspective (the success-state substrate of ONE in-place phase) plus
 * the fragment postcondition that points at it. PURE. The OPERATIVE perspective is a snapshot of the controls
 * (some are gone post-action), so the success check needs its OWN perspective — just the results landmark(s).
 * `perspective_ref` requires a match:'all' envelope and expands (flattenAssertion) to `selector_present` per
 * landmark; for a single results landmark that's exactly the prior `selector_present` check, so behaviour is
 * unchanged. The gain is a monitor-visible outcome perspective + a substrate-grounded (self-healing-eligible)
 * reference instead of a raw selector buried in the postcondition. `discriminator` keeps each in-place phase's
 * outcome-perspective id distinct. Returns null when there is no results landmark.
 * @returns {{perspective:object, postcondition:object}|null}
 */
export function buildOutcomePerspective({ intent, groundId = '', localeUrl = '', resultsUid, discriminator = '', acceptedAt = Date.now() } = {}) {
  if (!resultsUid) return null;
  const base = (String(intent || '').trim()) || 'capability';
  const outIntent = `${base} · results${discriminator ? ` · ${discriminator}` : ''}`.slice(0, 80);
  const perspective = buildPerspectiveRecord({ intent: outIntent, name: `${base} · results`, spec: { shape: 'observed', target: outIntent }, groundId, localeUrl, landmarkUids: [resultsUid], acceptedAt });
  const postcondition = { match: 'all', conditions: [{ type: 'perspective_ref', perspectiveId: perspective.id }], source: 'outcome-perspective' };
  return { perspective, postcondition };
}

/**
 * b6a (v2.74.775) — the NON-FATAL substrate PRECONDITION for a Fragment: a `perspective_ref` to the entry
 * perspective, tagged `advisory:true`. PURE. This is the SAFE gate b4 was missing. b4's perspective_ref
 * precondition was backed out because it was evaluated FATALLY and flattened (Assertion.flattenAssertion) to
 * "ALL the perspective's landmarks present" — which blocks any multi-fragment capability (landmarks span pages)
 * and any render-on-open reveal. The advisory gate is evaluated INSTEAD by PreconditionGate via
 * `isPerspectiveActive` — the SAME predicate the monitor reads: `and(urlMatches, or(landmarkExists…))`, an OR
 * over landmarks (drift-tolerant) that is fail-closed and NEVER aborts the run; a miss surfaces as an advisory
 * the monitor + editor can read. This is the "one predicate, three consumers" convergence: the gate now reads
 * the perspective's own predicate rather than inventing a fatal all-landmarks check. ARRAY shape (the runtime +
 * editor read fragment conditions as arrays). Returns [] when no perspective is bound (preconditions stay empty).
 * @param {string} perspectiveId
 * @returns {Array<object>}
 */
export function buildPerspectiveGate(perspectiveId) {
  const id = (typeof perspectiveId === 'string' && perspectiveId.trim()) ? perspectiveId.trim() : '';
  return id ? [{ type: 'perspective_ref', perspectiveId: id, advisory: true }] : [];
}

/**
 * GA-8 — collect every SUBSTRATE REFERENCE a condition tree makes: the landmark uids of `landmarkExists` leaves and
 * the perspective ids of `perspective_ref` leaves. PURE. Walks arrays, `and`/`or` {operator,children}, and
 * {match,conditions} envelopes. The basis for validateConditionRefs — catching a postcondition that points at a
 * landmark/perspective that was never persisted (a dangling ref "looks broken on every re-trial for a reason no one
 * diagnoses", DESIGN — write-time integrity).
 * @param {*} node
 * @param {{landmarks:string[], perspectives:string[]}} [acc]
 * @returns {{landmarks:string[], perspectives:string[]}}
 */
export function collectConditionRefs(node, acc = { landmarks: [], perspectives: [] }) {
  if (!node) return acc;
  if (Array.isArray(node)) { for (const n of node) collectConditionRefs(n, acc); return acc; }
  if (typeof node !== 'object') return acc;
  if (node.kind === 'landmarkExists' && node.target) acc.landmarks.push(String(node.target));
  if (node.type === 'perspective_ref' && node.perspectiveId) acc.perspectives.push(String(node.perspectiveId));
  if (Array.isArray(node.children)) collectConditionRefs(node.children, acc);
  if (Array.isArray(node.conditions)) collectConditionRefs(node.conditions, acc);
  return acc;
}

/**
 * GA-8 — validate that every substrate ref across `conditionTrees` resolves to a KNOWN landmark uid / perspective id.
 * PURE — the caller supplies the known sets (the records being persisted); an unresolved ref is then confirmed
 * against storage by the caller BEFORE it's reported, so a ref to a pre-existing record isn't false-flagged. Returns
 * the unresolved refs. FAIL-SOFT by design (a diagnostic the builder/editor can act on, never a hard reject).
 * @param {*} conditionTrees  one tree, or an array of condition trees (predicates / pre / postconditions)
 * @param {{landmarkUids?:string[], perspectiveIds?:string[]}} [known]
 * @returns {{ok:boolean, missing:Array<{kind:('landmark'|'perspective'),id:string}>}}
 */
export function validateConditionRefs(conditionTrees, { landmarkUids = [], perspectiveIds = [] } = {}) {
  const knownLm = new Set((Array.isArray(landmarkUids) ? landmarkUids : []).map(String));
  const knownPv = new Set((Array.isArray(perspectiveIds) ? perspectiveIds : []).map(String));
  const refs = { landmarks: [], perspectives: [] };
  for (const t of (Array.isArray(conditionTrees) ? conditionTrees : [conditionTrees])) collectConditionRefs(t, refs);
  const missing = [];
  for (const uid of new Set(refs.landmarks)) if (!knownLm.has(uid)) missing.push({ kind: 'landmark', id: uid });
  for (const pid of new Set(refs.perspectives)) if (!knownPv.has(pid)) missing.push({ kind: 'perspective', id: pid });
  return { ok: missing.length === 0, missing };
}

/**
 * b6b (v2.74.775) — build the DESTINATION perspective for a NAVIGATING Fragment, plus the fragment postcondition
 * that points at it. PURE. A navigating fragment's success is reaching a new NODE (page); the legacy device
 * asserts it as `url_matches` on the destination path — an EDGE fact mis-applied as a node postcondition
 * (DESIGN_t1_condition_model §1). This expresses the same success as SUBSTRATE: a `perspective_ref` to a
 * destination perspective whose single landmark asserts "we reached the destination page-state" (monitor-visible,
 * self-healing-eligible). Mirrors buildOutcomePerspective; `destLandmarkUid` is a grounded landmark ON the
 * destination locale (sourced from the destination's existing grounded perspective — pickDestinationLandmark).
 * Returns null without one (caller keeps `url_matches` — the bootstrap rung — until the destination is grounded
 * or captured, b6c).
 * @returns {{perspective:object, postcondition:object}|null}
 */
export function buildDestinationPerspective({ intent, groundId = '', destLocaleUrl = '', destLandmarkUid, discriminator = '', acceptedAt = Date.now() } = {}) {
  if (!destLandmarkUid) return null;
  const base = (String(intent || '').trim()) || 'capability';
  const outIntent = `${base} · destination${discriminator ? ` · ${discriminator}` : ''}`.slice(0, 80);
  const perspective = buildPerspectiveRecord({ intent: outIntent, name: `${base} · destination`, spec: { shape: 'observed', target: outIntent }, groundId, localeUrl: destLocaleUrl, landmarkUids: [destLandmarkUid], acceptedAt });
  const postcondition = { match: 'all', conditions: [{ type: 'perspective_ref', perspectiveId: perspective.id }], source: 'destination-perspective' };
  return { perspective, postcondition };
}

/**
 * b6b (v2.74.775; guarded v2.74.776) — choose a grounded landmark ON the destination page to anchor a navigating
 * fragment's destination perspective. PURE. Returns a landmarkRef Explore/authoring already grounded on the
 * destination (so "it is present" is a real "we arrived" signal), or null when there's nothing safe to anchor on
 * (caller keeps url_matches). Two guards keep b6b from minting degenerate / duplicate destination perspectives:
 *
 *   1. CROSS-PAGE only — if `opts.sourceUrl` is the SAME canonical page (origin+pathname) as the destination, this
 *      is a same-page change (e.g. re-searching ON the results page, query/hash only), NOT a new node → null. (A
 *      destination perspective there would just echo the operative perspective — the "odd duplicate" b6b produced.)
 *   2. NOT an operative control — skip any landmark in `opts.excludeUids` (this capability's own operative set), so
 *      the arrival anchor is never one of the controls the fragment itself drives (which persist across the nav).
 *
 * @param {object[]} existing  perspectives on the ground (StorageManager.listPerspectives)
 * @param {string} destLocaleUrl  the navigation destination url
 * @param {{sourceUrl?:string, excludeUids?:string[]}} [opts]
 * @returns {string|null}
 */
export function pickDestinationLandmark(existing, destLocaleUrl, { sourceUrl = '', excludeUids = [] } = {}) {
  const scope = _urlScopePattern(destLocaleUrl);
  if (!scope) return null;
  if (sourceUrl && _urlScopePattern(sourceUrl) === scope) return null;   // guard 1 — same page, not a new node
  const exclude = new Set((Array.isArray(excludeUids) ? excludeUids : []).filter(Boolean));
  for (const p of (Array.isArray(existing) ? existing : [])) {
    if (!p || p.lifecycle === 'deprecated') continue;
    if (_urlScopePattern(p.localeUrl) !== scope) continue;       // a perspective grounded ON the destination page
    const refs = (Array.isArray(p.landmarkRefs) ? p.landmarkRefs : []).filter(Boolean);
    const pick = refs.find((u) => !exclude.has(u));              // guard 2 — not one of THIS capability's operative controls
    if (pick) return pick;
  }
  return null;
}

/**
 * Build the Perspective record (the intent-scoped composition over the promoted landmarks). PURE.
 * Saved via StorageManager.savePerspective; #withPerspectiveComposition derives the landmark nodes from
 * landmarkRefs. authoredBy:'model' marks it as automated (vs. human-picked). b3 — carries an activation
 * `predicates` tree so the perspective is a real condition (gate + monitor), not vacuously always-active.
 */
export function buildPerspectiveRecord({ intent, name = null, spec = {}, groundId = '', localeUrl = '', landmarkUids = [], acceptedAt = Date.now() } = {}) {
  const baseIntent = String(intent || '').trim() || spec.target || 'capability';
  return {
    id: mintPerspectiveId(intent, groundId, localeUrl),
    groundId: groundId || '',
    // A Perspective is the intent's substrate SELECTION (GROUND_SPEC §3 — a purpose-scoped, intent-driven selection
    // of a Locale's Features bound to roles), NOT the Fragment (the action). So it must not share the fragment's
    // display name: default to "<intent> · landmarks"; callers (the outcome perspective) override the qualifier.
    name: ((name && String(name).trim()) || `${baseIntent} · landmarks`).slice(0, 80),
    landmarkRefs: Array.isArray(landmarkUids) ? landmarkUids.slice() : [],
    predicates: buildPerspectivePredicates({ localeUrl, landmarkUids }),   // b3 — substrate activation condition
    authoredBy: 'model',
    authoredAt: acceptedAt,
    intent: String(intent || '').trim(),
    shape: spec.shape || 'act',
    localeUrl: _urlScopePattern(localeUrl) || '',   // canonical PAGE (origin+pathname) — the page-archetype scope, not a query instance
    source: 'sg-accept',
  };
}

/**
 * v2.74.772 — qualify a proto-perspective against EXISTING perspectives on the same locale, to dedup by SUBSTRATE
 * instead of the (volatile, LLM-phrased) intent string. A Perspective IS the landmark SELECTION on a page
 * (GROUND_SPEC §3), so an existing perspective on the SAME canonical page (origin+pathname) with the SAME landmark
 * SET is the same perspective — reuse it. ("Search jobs by title" and "…by keyword" select identical landmarks →
 * ONE perspective, not two.) The intent becomes a label, not the identity key. PURE. Returns the matching
 * perspective (caller reuses its id) or null. Exact-set match for now; overlap tolerance is a future refinement.
 * @param {object[]} existing  perspectives on the ground (StorageManager.listPerspectives)
 * @param {{localeUrl?:string, landmarkUids?:string[]}} proto
 * @returns {object|null}
 */
export function findMatchingPerspective(existing, { localeUrl = '', landmarkUids = [] } = {}) {
  const scope = _urlScopePattern(localeUrl);
  const wanted = new Set((Array.isArray(landmarkUids) ? landmarkUids : []).filter(Boolean));
  if (!scope || wanted.size === 0) return null;   // no page or no substrate to match on → can't qualify
  for (const p of (Array.isArray(existing) ? existing : [])) {
    if (!p || p.lifecycle === 'deprecated') continue;
    if (_urlScopePattern(p.localeUrl) !== scope) continue;   // must be the SAME page
    const have = new Set((Array.isArray(p.landmarkRefs) ? p.landmarkRefs : []).filter(Boolean));
    if (have.size === wanted.size && [...wanted].every((u) => have.has(u))) return p;   // identical landmark SET
  }
  return null;
}

// Lean replay binding: each bound role's durable selector + kind/fieldType + its recoverable landmark.
// TRANSITIONAL — SG-LM-4 promotes to a Perspective + Landmarks (the durable layer), but the current
// REPLAY_SG_CAPABILITY still runs off this binding. SG-LM-5 migrates replay to the saved Perspective and
// drops this field. Until then it's carried so every checkpoint stays runnable; it now includes the
// `landmark` so even binding-driven replay is recoverable.
function _leanBinding(roles) {
  return (Array.isArray(roles) ? roles : [])
    .filter((r) => r && typeof r.role === 'string')
    .map((r) => {
      const b = { role: r.role, selector: r.selector || null };
      if (r.featureId) b.featureId = r.featureId;
      if (r.multiplicity) b.multiplicity = r.multiplicity;
      if (r.kind) b.kind = r.kind;
      if (r.fieldType) b.fieldType = r.fieldType;
      if (r.hidden) b.hidden = true;
      if (r.revealedBy) b.revealedBy = r.revealedBy;
      if (r.landmark) b.landmark = r.landmark;
      return b;
    });
}

// Required-role multiplicities (mirrors trialSynth.assessPerspectiveCompleteness) — a fillable param is
// "required" unless its role is optional/conditional.
const REQUIRED_MULT = new Set(['one', 'many']);

/** Stable, slug-style param key from a role name (unique within a binding). */
function _paramKey(role) {
  return String(role || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'param';
}

/**
 * SG-INV-1 — derive a UI-ready PARAM SCHEMA from the bound roles. A "param" is a fillable input role
 * (inferRoleKind === 'input'); the trial filled these with generic values (trialSynth.trialValueFor),
 * but an INVOCATION supplies the user's real value. Buttons/links/the success action are NOT params.
 * Each param carries its fill op (text|select|file — the SAME rule the trial synth used), the durable
 * selector, and the saved Landmark uid when the role is recoverable, so a future invocation can bind a
 * value to the exact landmark-backed step with NO LLM. Data-only — nothing here runs or fills. PURE.
 * @returns {Array<{key:string,role:string,label:string,fillOp:string,fieldType:(string|null),selector:(string|null),landmarkUid:(string|null),required:boolean}>}
 */
export function buildParamSchema({ roles = [], groundId = '', localeUrl = '' } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(roles) ? roles : [])) {
    if (!r || typeof r.role !== 'string') continue;
    if (inferRoleKind(r) !== 'input' && !isTypeableDisclosure(r)) continue;   // fillable inputs + typeable disclosures (combobox, v2.74.913) are params
    const key = _paramKey(r.role);
    if (seen.has(key)) continue;
    seen.add(key);
    const lm = r.landmark;
    out.push({
      key,
      role: r.role,
      label: (lm && lm.accessibleName) || r.role,
      fillOp: fillOpFor(null, r),                           // 'text' | 'select' | 'file'
      fieldType: r.fieldType || null,
      selector: r.selector || null,
      landmarkUid: (lm && lm.selector && lm.role) ? mintLandmarkUid(groundId, localeUrl, lm) : null,
      required: REQUIRED_MULT.has(r.multiplicity ?? 'one'),
    });
  }
  return out;
}

/**
 * SG-INV-1 — capture the DEFERRED terminal (the irreversible commit the trial proved REACHABLE but did
 * NOT fire — classifyTrialSafety swapped its CLICK → an EXTRACT probe). A future invocation can ARM it
 * (fire the real submit) behind explicit user confirmation. Returns null when nothing was deferred
 * (read/reversible op). `armed:false` is intrinsic — the data model never arms a submit by default. PURE.
 * @returns {{role:(string|null),selector:string,safetyClass:string,landmarkUid:(string|null),landmark:(object|null),armed:boolean}|null}
 */
export function buildTerminalDescriptor({ roles = [], deferred = [], safetyClass = null, groundId = '', localeUrl = '' } = {}) {
  const sels = (Array.isArray(deferred) ? deferred : []).filter(Boolean);
  if (!sels.length) return null;
  const termSel = sels[sels.length - 1];                    // the last deferred selector = terminal commit
  const r = (Array.isArray(roles) ? roles : []).find((x) => x && x.selector === termSel) || null;
  const lm = r && r.landmark;
  return {
    role: r ? r.role : null,
    selector: termSel,
    safetyClass: safetyClass || 'irreversible',
    landmarkUid: (lm && lm.selector && lm.role) ? mintLandmarkUid(groundId, localeUrl, lm) : null,
    landmark: lm ? { role: lm.role || null, accessibleName: lm.accessibleName || null, selector: lm.selector || null } : null,
    armed: false,                                           // an invocation must explicitly opt in to fire
  };
}

/**
 * Build the LEAN CapabilityAcceptance pointer record. PURE. References the saved Perspective + Landmarks
 * (the durable layer); also carries a transitional `binding` for the current replay path (see _leanBinding).
 * SG-INV-1 adds `params` (fillable inputs an invocation supplies) + `terminal` (the deferred commit it can
 * arm) — data-only; no invocation path consumes them yet.
 */
export function buildCapabilityAcceptance({ intent, spec = {}, cover = null, roles = [], trial = null, groundId = '', localeUrl = '', acceptedAt = Date.now(), trialRef = null, perspectiveId = null, landmarkUids = [], deferred = [], safetyClass = null } = {}) {
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
    perspectiveId: perspectiveId || null,
    landmarkUids: Array.isArray(landmarkUids) ? landmarkUids.slice() : [],
    binding: _leanBinding(roles),   // transitional — replay still reads this until SG-LM-5
    params: buildParamSchema({ roles, groundId, localeUrl }),                                  // SG-INV-1 — fillable inputs an invocation supplies
    terminal: buildTerminalDescriptor({ roles, deferred, safetyClass, groundId, localeUrl }),  // SG-INV-1 — the deferred commit it can arm (null when none)
    subGoals,
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
 * Build the HEAVY trialTrace (runtime/training). PURE. Referenced by capability.trial.trialRef and links
 * back to the promoted perspective + landmarks.
 */
export function buildTrialTrace({ capabilityId, trialRef, intent, spec = {}, selection = null, cover = null, roles = [], trial = null, result = null, groundId = '', localeUrl = '', acceptedAt = Date.now(), perspectiveId = null, landmarkUids = [] } = {}) {
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
    perspectiveId: perspectiveId || null,
    landmarkUids: Array.isArray(landmarkUids) ? landmarkUids.slice() : [],
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
 * One-call convenience: gate, then build ALL promotion artifacts. Returns { ok:false, reason } when the
 * gate blocks, else { ok:true, capability, perspective, landmarks:[{role,uid,record}], trace } — all
 * linked (capability.perspectiveId === perspective.id, capability.landmarkUids === landmark uids,
 * capability.trial.trialRef === trace.trialRef). The background handler persists landmarks + perspective
 * via StorageManager and the lean capability + trace via chrome.storage, then emits the `accept` outcome.
 */
/**
 * SG-LM-5 — convert the trial's synthesized actions (which carry an INLINE landmark, used by the trial
 * before any landmark is saved) into Fragment steps that reference the SAVED registry Landmark by uid
 * (`landmarkRef: { uid }`). The persisted Strategy then resolves + recovers via the standard registry
 * path (LandmarkResolver.applyLandmarkRefToStep → LANDMARK_PROBE_OR_RECOVER). Steps whose landmark wasn't
 * promoted (file/collection — no recoverable role) keep their raw selector. PURE.
 * @param {Array} actions  draft.actions (post-safety; deferred submit already an EXTRACT probe).
 */
export function landmarkRefActions(actions, groundId, localeUrl) {
  return (Array.isArray(actions) ? actions : []).map((a) => {
    if (!a || typeof a !== 'object') return a;
    const { landmark, ...rest } = a;
    if (landmark && landmark.role && landmark.selector) {
      return { ...rest, landmarkRef: { uid: mintLandmarkUid(groundId, localeUrl, landmark) } };
    }
    return rest;   // no recoverable landmark → plain selector step
  });
}

export function buildAcceptance(args = {}) {
  const gate = canAccept(args);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const acceptedAt = args.acceptedAt || Date.now();
  const landmarks = buildLandmarkRecords({ roles: args.roles, groundId: args.groundId, localeUrl: args.localeUrl, acceptedAt });
  const landmarkUids = landmarks.map((l) => l.uid);
  const perspective = buildPerspectiveRecord({ intent: args.intent, spec: args.spec, groundId: args.groundId, localeUrl: args.localeUrl, landmarkUids, acceptedAt });
  const capability = buildCapabilityAcceptance({ ...args, acceptedAt, perspectiveId: perspective.id, landmarkUids });
  const trace = buildTrialTrace({ ...args, capabilityId: capability.id, trialRef: capability.trial.trialRef, acceptedAt, perspectiveId: perspective.id, landmarkUids });
  return { ok: true, capability, perspective, landmarks, trace };
}
