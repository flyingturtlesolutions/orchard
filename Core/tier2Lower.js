// Core/tier2Lower.js — SG-T2-1 (Tier-2 Lowering). DESIGN_tier2_lowering.md §4/§7.
//
// Comprehend already emits a multi-shape PROGRAM — the subGoal DAG, each phase carrying its own `shape`
// and a `dependsOn` order. Today the SG path FLATTENS that program into one single-shape Tier-1 fragment
// (DESIGN §1, collapse C-2). This module is the lowering pass that stops the flatten: it walks the subGoal
// DAG and emits a Tier-2 operation — an ordered list of nodes, one per phase — that the cache-tier runtime
// already runs (ExecutionEngine.executeStrategy over a StrategyTree).
//
// SG-T2-1 scope (this slice): FRAGMENTS ONLY. Each act/complete subGoal becomes a fragment node, bound
// PER PHASE by the goal-grounded binder (SG-RES-7, selectionToTrialRoles called once per subGoal over that
// phase's matched features) and ordered by `dependsOn`. read→Observation (SG-T2-3), navigate/wait
// (SG-T2-4), per-phase postconditions (SG-T2-2), Analysis (SG-T2-5), and the RUN_SG_TRIAL/score wiring
// (SG-T2-6) land in later slices. The output here is a PURE intermediate ({ tier, nodes }); SG-T2-6
// materializes it into Fragment records + the runtime Strategy tree.
//
// FORM ATOMICITY across phases: Comprehend often splits one form across two subGoals ("enter-criteria",
// "execute-search"). Because the per-phase binder is goal-grounded, BOTH phases expand to the SAME goal
// membership ({q, location, submit}) — identical role sets. We DEDUP fragment nodes by their role
// signature so a fill-then-submit pair collapses into ONE fragment (you fill+submit the form once), while
// two DISTINCT forms stay two fragments. This is the multi-phase generalization of SG-RES-5/7c.
//
// PURE: no DOM, no LLM, no storage. Unit-testable like the other Core/ stages.
// @module Core/tier2Lower
// @version 2.74.630

import { selectionToTrialRoles } from './bind.js';

// Phases that author a Fragment (a state-transition: fill/click + the navigation it causes). read →
// Observation (SG-T2-3); transform → Analysis (SG-T2-5); navigate is a Tier-2 control node (SG-T2-4).
const FRAGMENT_SHAPES = new Set(['act', 'complete']);
// Content kinds that can serve as a read target / a fragment's RESULT region.
const READ_KINDS = new Set(['collection', 'region', 'composite']);

// Observation extract shape from the read feature's kind (mapped to the runtime Observation vocabulary at
// materialization, SG-T2-6): a list of items vs a structured record vs a flat text region.
const _extractShape = (kind) => (kind === 'collection' ? 'list' : (kind === 'composite' ? 'record' : 'text'));
// A scope binding name from a feature's identity — UPPER_SNAKE, stable, non-empty.
const _scopeName = (f) => {
  const base = String((f && (f.label || f.id)) || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return base || 'RESULT';
};

/**
 * SG-T2-4 — build a navigate node for a `navigate` phase. PURE. Prefer a direct URL (the matched feature's
 * href → mode:'url'); otherwise click the matched nav/action control (mode:'click', mapped to a CLICK at
 * materialization, SG-T2-6). Returns null when the phase has no navigable target.
 * @returns {{type:'navigate',subGoalIds:string[],label:string,mode:string,url?:string,selector?:string}|null}
 */
export function buildNavigateNode(sg, matches, locale) {
  const feats = (locale && locale.features && typeof locale.features === 'object') ? locale.features : {};
  const ids = (sg && matches && Array.isArray(matches[sg.id])) ? matches[sg.id] : [];
  const label = (sg && sg.label && String(sg.label).trim()) || (sg && sg.id) || '';
  for (const id of ids) {
    const f = feats[id];
    if (!f || f.decoy === true) continue;
    if (f.href) return { type: 'navigate', subGoalIds: [sg.id], label, mode: 'url', url: f.href };
    if (f.selector && (f.kind === 'navigation' || f.kind === 'action' || f.kind === 'disclosure')) return { type: 'navigate', subGoalIds: [sg.id], label, mode: 'click', selector: f.selector };
  }
  return null;
}

// SG-T2-4 — a node that hands the page to the next state (a committing fragment's submit, or a navigate).
function _hasSubmitRole(node, locale) {
  const feats = (locale && locale.features && typeof locale.features === 'object') ? locale.features : {};
  return !!(node && node.type === 'fragment' && Array.isArray(node.roles) && node.roles.some((r) => {
    const f = feats[r.featureId]; return f && f.interaction && f.interaction.effect === 'submit';
  }));
}
const _transitions = (node, locale) => !!node && (node.type === 'navigate' || _hasSubmitRole(node, locale));
function _firstSelector(node) {
  if (!node) return null;
  if (node.type === 'fragment' && Array.isArray(node.roles) && node.roles[0]) return node.roles[0].selector || null;
  if (node.type === 'observation' && Array.isArray(node.extracts) && node.extracts[0]) return node.extracts[0].selector || null;
  return null;
}

/**
 * SG-T2-4 — insert `wait` nodes across TRANSITION boundaries: after a node that hands the page to the next
 * state (a committing fragment or a navigate), wait for the NEXT node's first selector before proceeding,
 * so a phase never races a not-yet-loaded page (the executor's mid-trial navigation race). PURE.
 * @returns {Array} nodes with wait nodes interleaved
 */
export function insertWaits(nodes, locale) {
  const list = Array.isArray(nodes) ? nodes : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    out.push(list[i]);
    const next = list[i + 1];
    if (next && _transitions(list[i], locale)) {
      const sel = _firstSelector(next);
      if (sel) out.push({ type: 'wait', mode: 'condition', condition: { type: 'selector_present', selector: sel }, timeoutMs: 8000, pollIntervalMs: 150, reason: 'settle after transition' });
    }
  }
  return out;
}

/**
 * SG-T2-3 — build an Observation node for a `read` phase: capture its matched content region(s) into Scope.
 * PURE. Reads the read subGoal's matched features, keeps the content kinds (collection/region/composite),
 * and emits one extract per region ({ selector, output, shape }). Returns null when the phase matched no
 * readable region (nothing to observe) so the caller drops it.
 * @returns {{type:'observation',subGoalIds:string[],label:string,extracts:object[]}|null}
 */
export function buildObservationNode(sg, matches, locale) {
  const feats = (locale && locale.features && typeof locale.features === 'object') ? locale.features : {};
  const ids = (sg && matches && Array.isArray(matches[sg.id])) ? matches[sg.id] : [];
  const extracts = [];
  const seen = new Set();
  for (const id of ids) {
    const f = feats[id];
    if (!f || !READ_KINDS.has(f.kind) || !f.selector || f.decoy === true || seen.has(id)) continue;
    seen.add(id);
    extracts.push({ selector: f.selector, output: _scopeName(f), shape: _extractShape(f.kind) });
  }
  if (!extracts.length) return null;
  return { type: 'observation', subGoalIds: [sg.id], label: (sg.label && String(sg.label).trim()) || sg.id, extracts };
}

/**
 * SG-T2-2 — derive the STRUCTURAL-FLOOR postcondition for a fragment node (decision C). PURE: no LLM. A
 * committing fragment (one with an effect:submit role) must produce an observable transition; the strongest
 * predicate we can assert purely is "the goal's RESULT region is present after the commit." We scope the
 * result region by GOAL (a collection/region/composite feature sharing the committing control's goal) to
 * avoid asserting an unrelated region. When none is derivable we return null — an HONEST absence, not a
 * false floor; the per-subGoal LLM successCondition (SG-T2-5) or effect observation (PB-8) fills the gap.
 * Fill-only fragments (no submit) have no independent terminal effect → null (verified by the downstream
 * commit). Postcondition shape matches Fragment pre/post conditions + the UniversalGate `condition` model.
 * @returns {{match:string, conditions:object[], source:string}|null}
 */
export function deriveStructuralPostcondition(node, locale) {
  const roles = (node && Array.isArray(node.roles)) ? node.roles : [];
  const feats = (locale && locale.features && typeof locale.features === 'object') ? locale.features : {};
  let submitGoals = null;
  for (const r of roles) {
    const f = feats[r.featureId];
    if (f && f.kind === 'action' && f.interaction && f.interaction.effect === 'submit' && Array.isArray(f.goals) && f.goals.length) { submitGoals = new Set(f.goals); break; }
  }
  if (!submitGoals) return null;   // fill-only / submit carries no goal → no derivable transition
  for (const f of Object.values(feats)) {
    if (f && READ_KINDS.has(f.kind) && f.selector && f.decoy !== true && Array.isArray(f.goals) && f.goals.some((g) => submitGoals.has(g))) {
      return { match: 'all', conditions: [{ type: 'selector_present', selector: f.selector }], source: 'structural' };
    }
  }
  return null;
}

/**
 * Order subGoals so every phase comes after the phases it `dependsOn`. Stable: original order breaks ties,
 * so a well-formed (already roughly-ordered) program is preserved. Degrades gracefully on a cycle —
 * remaining nodes are appended in original order rather than dropped. PURE. O(n^2), n tiny.
 * @param {Array<{id:string,dependsOn?:string[]}>} subGoals
 * @returns {Array} the same objects, dependency-ordered
 */
export function topoOrder(subGoals) {
  const list = Array.isArray(subGoals) ? subGoals.filter((s) => s && s.id) : [];
  const known = new Set(list.map((s) => s.id));
  const remaining = list.slice();
  const emitted = new Set();
  const order = [];
  while (remaining.length) {
    let progressed = false;
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i];
      const deps = (Array.isArray(s.dependsOn) ? s.dependsOn : []).filter((d) => known.has(d));
      if (deps.every((d) => emitted.has(d))) {
        order.push(s); emitted.add(s.id); remaining.splice(i, 1); progressed = true; break;   // restart → original-order preference
      }
    }
    if (!progressed) { for (const s of remaining) { order.push(s); emitted.add(s.id); } break; }   // cycle → flush in order
  }
  return order;
}

// SG-T2-5 — map an IntentSpec successCondition ([{signal,match}]) to runtime condition objects. The LLM
// half of decision C: a per-subGoal (or intent) success observable becomes a checkable postcondition.
// Only url/text (and an explicitly-selector-shaped element) map page-independently; prose element/value
// observables are not statically checkable (no selector) and are dropped — the structural floor covers them.
export function successToConditions(success) {
  const arr = Array.isArray(success) ? success : [];
  const out = [];
  for (const s of arr) {
    if (!s || !s.match) continue;
    const m = String(s.match).trim();
    if (!m) continue;
    if (s.signal === 'url') out.push({ type: 'url_matches', pattern: m });
    else if (s.signal === 'text') out.push({ type: 'text_present', text: m });
    else if (s.signal === 'element' && /^[#.[]/.test(m)) out.push({ type: 'selector_present', selector: m });
  }
  return out;
}

// Combine the structural floor (SG-T2-2) with LLM-derived conditions (SG-T2-5) into one postcondition.
// Structural-only is returned UNCHANGED (preserves SG-T2-2 shape: match:'all', source:'structural'). When
// LLM conditions are present the merged predicate is match:'any' — any positive signal confirms the phase.
function combinePostcondition(structural, llmConds) {
  const ll = Array.isArray(llmConds) ? llmConds : [];
  const hasStruct = !!(structural && Array.isArray(structural.conditions) && structural.conditions.length);
  if (!hasStruct && !ll.length) return null;
  if (hasStruct && !ll.length) return structural;
  const conditions = [];
  const seen = new Set();
  const add = (c) => { const k = JSON.stringify(c); if (!seen.has(k)) { seen.add(k); conditions.push(c); } };
  if (hasStruct) for (const c of structural.conditions) add(c);
  for (const c of ll) add(c);
  return { match: 'any', conditions, source: hasStruct ? 'structural+llm' : 'llm' };
}

// SG-T2-5 — a read phase that TRANSFORMS prior data (rather than just reading it) authors an Analysis.
const TRANSFORM_HINT = /\b(filter|sort|rank|order|cheapest|priciest|highest|lowest|top|best|worst|select|pick|choose|only|exclude|dedupe|unique|group|count|sum|average|min|max|first|last|nearest|closest)\b/i;
const _analysisOp = (label) => {
  const t = String(label || '').toLowerCase();
  if (/\b(sort|rank|order|cheapest|priciest|highest|lowest|top|best|worst|nearest|closest|first|last)\b/.test(t)) return 'sort';
  if (/\b(count|sum|average|min|max|unique|dedupe|group)\b/.test(t)) return 'aggregate';
  return 'filter';
};
/**
 * SG-T2-5 — build an Analysis node for a transform phase: an op over a prior Observation's scope output.
 * PURE. Returns null when there is no upstream data to transform (caller falls back to an Observation).
 * @returns {{type:'analysis',subGoalIds:string[],label:string,op:string,over:string}|null}
 */
export function buildAnalysisNode(sg, overOutput) {
  if (!sg || !overOutput) return null;
  return { type: 'analysis', subGoalIds: [sg.id], label: (sg.label && String(sg.label).trim()) || sg.id, op: _analysisOp(sg.label), over: overOutput };
}

/**
 * SG-T2-6 — aggregate per-phase outcomes into a Tier-2 verdict. PURE. Each phase node reports whether it
 * passed (its postcondition held / its observation captured / its analysis produced output). A Tier-2 op
 * passes iff EVERY required phase passed — the per-phase replacement for the flat trial's single
 * effectMatch flag. `wait` nodes aren't scored. Optional phases (required:false) don't gate the verdict.
 * @param {Array<{type:string, required?:boolean, passed?:boolean}>} nodeOutcomes
 * @returns {{verdict:'tier2-pass'|'tier2-fail', score:number, phases:number, passed:number, requiredTotal:number, requiredPassed:number}}
 */
export function scoreTier2(nodeOutcomes) {
  const considered = (Array.isArray(nodeOutcomes) ? nodeOutcomes : []).filter((n) => n && n.type !== 'wait');
  const required = considered.filter((n) => n.required !== false);
  const requiredPassed = required.filter((n) => n.passed === true).length;
  const passed = considered.filter((n) => n.passed === true).length;
  const verdict = (required.length > 0 && requiredPassed === required.length) ? 'tier2-pass' : 'tier2-fail';
  const score = considered.length ? Math.round((passed / considered.length) * 100) / 100 : 0;
  return { verdict, score, phases: considered.length, passed, requiredTotal: required.length, requiredPassed };
}

/**
 * Lower a Comprehend subGoal program into a Tier-2 operation (cache tier).
 *   act/complete → fragment node (SG-T2-1, goal-grounded per phase, form-atomic dedup)
 *   read         → observation node (SG-T2-3), or Analysis if it transforms upstream data (SG-T2-5)
 *   navigate     → navigate node (SG-T2-4)
 * Fragment postconditions (SG-T2-2 structural floor + SG-T2-5 per-subGoal successCondition) are attached in
 * a post-pass; settle waits (SG-T2-4) are interleaved last.
 * @param {object} spec       IntentSpec (uses target + subGoals[].{id,label,shape,dependsOn}).
 * @param {object} selection  Select output — uses `matches` (subGoalId → featureId[]).
 * @param {object} [locale]   Locale (features + goals) — for per-phase goal-grounded binding.
 * @returns {{tier:string, nodes:Array<object>}}  nodes in dependency order, mixed fragment/observation.
 */
export function lowerToTier2(spec, selection, locale = null) {
  const subGoals = (spec && Array.isArray(spec.subGoals)) ? spec.subGoals : [];
  const matches = (selection && selection.matches && typeof selection.matches === 'object' && !Array.isArray(selection.matches)) ? selection.matches : {};
  const ordered = topoOrder(subGoals);

  const byId = new Map(subGoals.filter((s) => s && s.id).map((s) => [s.id, s]));
  const nodes = [];
  const bySig = new Map();   // role-signature → fragment node (dedup identical forms across phases)
  let lastObsOutput = null;  // most recent observation's first scope output — the data an Analysis transforms
  for (const sg of ordered) {
    if (!sg) continue;
    if (FRAGMENT_SHAPES.has(sg.shape)) {
      const feats = Array.isArray(matches[sg.id]) ? matches[sg.id] : [];
      // Bind THIS phase in isolation — a mini spec/selection scoped to the single subGoal — so the
      // goal-grounded binder (SG-RES-7) expands the phase's own goal membership, not the whole intent's.
      // BIND VIA THE ELSE-PATH for BOTH act AND complete phases: SG-RES-7 goal-grounding (+ the 7b/7c
      // refinements) lives in bind.js's non-complete branch, and a per-phase mini-selection carries no
      // page-global `boundary` for the complete branch to read. The phase's matched features ARE its floor;
      // goal membership expands them to the whole form. So we pass shape:'act' to the BINDER (else-path) and
      // record the phase's REAL shape on the node. (The complete-branch's required-field net is a page-global
      // Cover concern, handled at the intent level — not per phase.)
      const phaseSpec = { shape: 'act', target: (spec && spec.target) || '', subGoals: [{ ...sg, shape: 'act' }] };
      const phaseSel = { matches: { [sg.id]: feats }, shape: 'act' };
      const roles = selectionToTrialRoles(phaseSpec, phaseSel, locale);
      if (!roles.length) continue;                          // nothing bindable for this phase → no node

      const sig = roles.map((r) => r.featureId).sort().join('|');
      const existing = bySig.get(sig);
      if (existing) { existing.subGoalIds.push(sg.id); continue; }   // same form (fill+submit) → one fragment
      const node = { type: 'fragment', subGoalIds: [sg.id], label: (sg.label && String(sg.label).trim()) || sg.id, shape: sg.shape, roles };
      bySig.set(sig, node);                                 // postcondition attached in the post-pass below
      nodes.push(node);
    } else if (sg.shape === 'read') {
      // SG-T2-5 — a read that TRANSFORMS upstream data (label hints filter/sort/select) authors an Analysis
      // over the prior observation's output; otherwise it reads (Observation).
      if (TRANSFORM_HINT.test(String(sg.label || '')) && lastObsOutput) {
        const an = buildAnalysisNode(sg, lastObsOutput);
        if (an) { nodes.push(an); continue; }
      }
      const obs = buildObservationNode(sg, matches, locale);   // SG-T2-3 — read → Observation
      if (obs) { nodes.push(obs); lastObsOutput = (obs.extracts[0] && obs.extracts[0].output) || lastObsOutput; }
    } else if (sg.shape === 'navigate') {
      const nav = buildNavigateNode(sg, matches, locale);      // SG-T2-4 — navigate → navigate node
      if (nav) nodes.push(nav);
    }
  }

  // SG-T2-2 + SG-T2-5 — postcondition post-pass: structural floor ∪ each fragment's subGoals'
  // successCondition (per-phase LLM refinement, decision C). Done after merges so a fill+submit fragment
  // gathers ALL its phases' success predicates. Omitted when nothing is derivable (no false floor).
  for (const node of nodes) {
    if (node.type !== 'fragment') continue;
    const structural = deriveStructuralPostcondition(node, locale);
    const llmConds = [];
    for (const id of node.subGoalIds) { const sg = byId.get(id); for (const c of successToConditions(sg && sg.successCondition)) llmConds.push(c); }
    const pc = combinePostcondition(structural, llmConds);
    if (pc) node.postcondition = pc; else delete node.postcondition;
  }

  // SG-T2-4 — interleave settle waits across transition boundaries (post-pass over the final node list).
  return { tier: 'cache', nodes: insertWaits(nodes, locale) };
}
