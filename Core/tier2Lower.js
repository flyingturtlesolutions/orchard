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
// @version 2.74.627

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

/**
 * Lower a Comprehend subGoal program into a Tier-2 operation (cache tier).
 *   act/complete → fragment node (SG-T2-1, goal-grounded per phase, form-atomic dedup, postcondition SG-T2-2)
 *   read         → observation node (SG-T2-3)
 *   navigate/transform → later slices (SG-T2-4/5).
 * @param {object} spec       IntentSpec (uses target + subGoals[].{id,label,shape,dependsOn}).
 * @param {object} selection  Select output — uses `matches` (subGoalId → featureId[]).
 * @param {object} [locale]   Locale (features + goals) — for per-phase goal-grounded binding.
 * @returns {{tier:string, nodes:Array<object>}}  nodes in dependency order, mixed fragment/observation.
 */
export function lowerToTier2(spec, selection, locale = null) {
  const subGoals = (spec && Array.isArray(spec.subGoals)) ? spec.subGoals : [];
  const matches = (selection && selection.matches && typeof selection.matches === 'object' && !Array.isArray(selection.matches)) ? selection.matches : {};
  const ordered = topoOrder(subGoals);

  const nodes = [];
  const bySig = new Map();   // role-signature → fragment node (dedup identical forms across phases)
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
      // SG-T2-2 — attach the structural-floor postcondition (decision C). Omitted (not null-stamped) when
      // none is derivable, so the node stays clean for the LLM-refinement pass (SG-T2-5).
      const pc = deriveStructuralPostcondition(node, locale);
      if (pc) node.postcondition = pc;
      bySig.set(sig, node);
      nodes.push(node);
    } else if (sg.shape === 'read') {
      const obs = buildObservationNode(sg, matches, locale);   // SG-T2-3 — read → Observation
      if (obs) nodes.push(obs);
    }
    // navigate / transform phases: SG-T2-4 / SG-T2-5.
  }
  return { tier: 'cache', nodes };
}
