// Core/workflows.js — cross-Locale Workflows: the `partOf` layer ABOVE the Locale.
//
// A Locale models ONE page archetype; a Workflow is a multi-page JOURNEY composed over the
// Ground siteMap — an ordered path through archetypes, following the nav (`leadsTo`/`link`)
// edges that connect them (e.g. home → category → product → cart → checkout). PAGEMODEL_SPEC
// §1 lists `partOf` (composite flow) as the one deferred edge type; this is its cross-Locale
// realization: each archetype on the path is `partOf` the workflow.
//
// This module supplies the NAVIGATION BACKBONE — which pages, in what order, via which control
// — as pure graph operations over the siteMap. The per-step page actions come from each
// Locale's capability synthesis (Core/capabilitySynth); a runnable workflow stitches the two:
// for each step, NAVIGATE via the prior step's link control, then run that archetype's goal.
//
// PURE: no DOM / chrome / storage. Graph ops over the siteMap {nodes, edges}.
//
// @module Core/workflows
// @version 2.74.492

import { synthesizeCapabilityDraft } from './capabilitySynth.js';

/** Forward adjacency: archetypeId → [{ to, via, label }] from the siteMap link edges. */
export function buildAdjacency(map) {
  const adj = new Map();
  for (const e of (map && Array.isArray(map.edges) ? map.edges : [])) {
    if (!e || !e.from || !e.to || e.from === e.to) continue;   // ignore self-loops
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push({ to: e.to, via: e.via || null, label: e.label || '' });
  }
  return adj;
}

/** Entry archetypes: nodes with no incoming edge (else, if the graph is fully cyclic, all nodes). */
export function roots(map) {
  const nodes = (map && map.nodes) || {};
  const ids = Object.keys(nodes);
  if (!ids.length) return [];
  const hasIncoming = new Set();
  for (const e of (map && Array.isArray(map.edges) ? map.edges : [])) {
    if (e && e.from && e.to && e.from !== e.to) hasIncoming.add(e.to);
  }
  const r = ids.filter((id) => !hasIncoming.has(id));
  return r.length ? r : ids;   // fully cyclic → every node is a candidate start
}

/**
 * Navigation paths (ordered archetype-id lists) reaching `targetId`, via siteMap edges. BFS so
 * shortest paths come first; simple paths only (no repeated archetype); bounded by maxDepth
 * (hops) and maxPaths. Starts from `from` if given, else from every root.
 *
 * @param {{nodes?:Object, edges?:Array}} map
 * @param {string} targetId
 * @param {{from?:string, maxDepth?:number, maxPaths?:number}} [opts]
 * @returns {string[][]} paths, shortest first
 */
export function pathsTo(map, targetId, { from = null, maxDepth = 6, maxPaths = 12 } = {}) {
  const nodes = (map && map.nodes) || {};
  if (!targetId || !nodes[targetId]) return [];
  const adj = buildAdjacency(map);
  const starts = from ? (nodes[from] ? [from] : []) : roots(map);
  const found = [];
  const seen = new Set();
  for (const start of starts) {
    if (found.length >= maxPaths) break;
    const queue = [[start]];
    while (queue.length && found.length < maxPaths) {
      const path = queue.shift();
      const last = path[path.length - 1];
      if (last === targetId) {
        const key = path.join('>');
        if (!seen.has(key)) { seen.add(key); found.push(path); }
        continue;
      }
      if (path.length - 1 >= maxDepth) continue;       // hop budget
      for (const nb of (adj.get(last) || [])) {
        if (path.includes(nb.to)) continue;            // simple path (no cycles)
        queue.push([...path, nb.to]);
      }
    }
  }
  return found.sort((a, b) => a.length - b.length).slice(0, maxPaths);
}

/**
 * Hydrate a raw archetype-id path into a Workflow skeleton: per-step archetype metadata + the
 * nav control (`via`) used to reach the NEXT step. This is the `partOf` composition — the
 * ordered steps a runnable workflow would chain (NAVIGATE via `via`, then run that step's goal).
 *
 * @returns {{ start, target, length, fullyModeled:boolean,
 *             steps:Array<{archetypeId,name,status,urlPattern,goals:string[],via:(string|null),viaLabel:string,terminal:boolean}> }}
 */
export function workflowFromPath(map, path) {
  const nodes = (map && map.nodes) || {};
  const ids = Array.isArray(path) ? path : [];
  const ek = (a, b) => a + '>' + b;
  const edgeOf = new Map();
  for (const e of (map && Array.isArray(map.edges) ? map.edges : [])) {
    if (e && e.from && e.to && !edgeOf.has(ek(e.from, e.to))) edgeOf.set(ek(e.from, e.to), e);
  }
  const steps = ids.map((id, i) => {
    const n = nodes[id] || {};
    const next = ids[i + 1];
    const edge = next ? edgeOf.get(ek(id, next)) : null;
    return {
      archetypeId: id,
      name: n.name || id,
      status: n.status || 'unknown',
      urlPattern: n.urlPattern || null,
      goals: Array.isArray(n.goals) ? n.goals : [],
      via: edge ? (edge.via || null) : null,
      viaLabel: edge ? (edge.label || '') : '',
      terminal: !next,
    };
  });
  return {
    start: ids[0] ?? null,
    target: ids[ids.length - 1] ?? null,
    length: steps.length,
    fullyModeled: steps.length > 0 && steps.every((s) => s.status === 'modeled'),
    steps,
  };
}

/** Convenience: the workflow skeletons reaching `targetId` (pathsTo → workflowFromPath). */
export function workflowsTo(map, targetId, opts = {}) {
  return pathsTo(map, targetId, opts).map((p) => workflowFromPath(map, p));
}

function _normLabel(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?…]+$/, '').trim();
}

/**
 * Stitch a Workflow skeleton + per-step Locale goals into ONE cross-page action sequence — a
 * best-effort runnable DRAFT (same philosophy as capabilitySynth: review before trusting).
 *
 * Sequence: NAVIGATE to the entry page, then per step: run that step's goal (its synthesized
 * CLICK/TYPE actions, with the goal's own NAVIGATE stripped — the workflow owns navigation),
 * then move to the next page by CLICKing that step's link control (`via`), falling back to a
 * direct NAVIGATE to the next page's URL when no link is resolvable. Params from every step's
 * goal are collected (deduped by name; collisions share a binding and are flagged).
 *
 * The output shape matches capabilitySynth's draft, so capabilitySynth.buildCapabilityRecords
 * turns it into the same { fragment, strategy } the execution engine runs — a workflow is just
 * a longer, cross-page Fragment.
 *
 * @param {object} skeleton  workflowFromPath() output
 * @param {{localesByArchetype?:Object, goals?:Object, name?:string}} opts
 *   localesByArchetype: { [archetypeId]: localeModel }  (for via selectors + goal synthesis)
 *   goals:              { [archetypeId]: goalLabel }     (which goal to perform on each step)
 * @returns {{ name, goal, navigateUrl, actions, params, steps, warnings, runnable }}
 */
export function buildWorkflowDraft(skeleton, { localesByArchetype = {}, goals = {}, name = null } = {}) {
  const steps = (skeleton && Array.isArray(skeleton.steps)) ? skeleton.steps : [];
  const actions = [];
  const params = [];
  const paramNames = new Set();
  const warnings = [];
  const stepSummaries = [];
  const concreteUrl = (step, locale) =>
    (step.urlPattern && !/[{]/.test(step.urlPattern)) ? step.urlPattern : (locale?.url || null);

  if (!steps.length) {
    return { name: name || 'Workflow', goal: '', navigateUrl: null, actions, params, steps: [], warnings: ['empty workflow'], runnable: false };
  }

  const first = steps[0];
  const entryUrl = concreteUrl(first, localesByArchetype[first.archetypeId]);
  if (entryUrl) actions.push({ action: 'NAVIGATE', value: entryUrl });
  else warnings.push('no concrete entry URL for the first step');

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const locale = localesByArchetype[step.archetypeId];
    const goalLabel = goals[step.archetypeId];

    // a) this step's goal actions (navigation stripped — the workflow owns it)
    let stepActionCount = 0, missing = false;
    if (goalLabel && locale) {
      const want = _normLabel(goalLabel);
      const goal = locale.goals ? Object.values(locale.goals).find((g) => g && _normLabel(g.label) === want) : null;
      if (goal) {
        const draft = synthesizeCapabilityDraft(goal, locale, { url: null });
        for (const a of draft.actions) {
          if (a.action === 'NAVIGATE') continue;
          actions.push(a); stepActionCount++;
        }
        for (const p of (draft.params || [])) {
          if (paramNames.has(p.name)) { warnings.push(`param "${p.name}" reused across steps — shares one binding`); continue; }
          paramNames.add(p.name); params.push(p);
        }
        if (draft.warnings && draft.warnings.length) warnings.push(`step "${step.name}": ${draft.warnings.join('; ')}`);
      } else {
        missing = true;
        warnings.push(`step "${step.name}": goal "${goalLabel}" not found in its Locale`);
      }
    }
    stepSummaries.push({ archetypeId: step.archetypeId, name: step.name, goal: goalLabel || null, actionCount: stepActionCount, ...(missing ? { missing: true } : {}) });

    // b) navigate INTO the next step: CLICK this step's link control, else direct NAVIGATE
    if (i < steps.length - 1) {
      const next = steps[i + 1];
      const viaFeat = step.via && locale?.features ? locale.features[step.via] : null;
      if (viaFeat && viaFeat.selector) {
        actions.push({ action: 'CLICK', selector: viaFeat.selector });
      } else {
        const nextUrl = concreteUrl(next, localesByArchetype[next.archetypeId]);
        if (nextUrl) {
          actions.push({ action: 'NAVIGATE', value: nextUrl });
          warnings.push(`"${step.name}" → "${next.name}": no resolvable link control; using a direct NAVIGATE`);
        } else {
          warnings.push(`"${step.name}" → "${next.name}": no link and no concrete URL — chain may break here`);
        }
      }
    }
  }

  const actionable = actions.filter((a) => a.action !== 'NAVIGATE').length;
  if (!actionable) warnings.push('no actionable steps resolved — draft only navigates');
  return {
    name: name || `Workflow: ${first.name} → ${steps[steps.length - 1].name}`.slice(0, 80),
    goal: `${first.name} → ${steps[steps.length - 1].name}`,
    navigateUrl: entryUrl,
    actions,
    params,
    steps: stepSummaries,
    warnings,
    runnable: actionable > 0,
  };
}
