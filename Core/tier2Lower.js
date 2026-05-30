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
// @version 2.74.625

import { selectionToTrialRoles } from './bind.js';

// Phases that author a Fragment (a state-transition: fill/click + the navigation it causes). read →
// Observation and transform → Analysis arrive in later slices; navigate is a Tier-2 control node (SG-T2-4).
const FRAGMENT_SHAPES = new Set(['act', 'complete']);

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
 * Lower a Comprehend subGoal program into a Tier-2 operation (cache tier). SG-T2-1: fragment nodes only.
 * @param {object} spec       IntentSpec (uses target + subGoals[].{id,label,shape,dependsOn}).
 * @param {object} selection  Select output — uses `matches` (subGoalId → featureId[]).
 * @param {object} [locale]   Locale (features + goals) — for per-phase goal-grounded binding.
 * @returns {{tier:string, nodes:Array<{type:'fragment',subGoalIds:string[],label:string,shape:string,roles:object[]}>}}
 */
export function lowerToTier2(spec, selection, locale = null) {
  const subGoals = (spec && Array.isArray(spec.subGoals)) ? spec.subGoals : [];
  const matches = (selection && selection.matches && typeof selection.matches === 'object' && !Array.isArray(selection.matches)) ? selection.matches : {};
  const ordered = topoOrder(subGoals);

  const nodes = [];
  const bySig = new Map();   // role-signature → fragment node (dedup identical forms across phases)
  for (const sg of ordered) {
    if (!sg || !FRAGMENT_SHAPES.has(sg.shape)) continue;   // SG-T2-1: act/complete → Fragment only
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
    bySig.set(sig, node);
    nodes.push(node);
  }
  return { tier: 'cache', nodes };
}
