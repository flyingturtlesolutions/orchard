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
// @version 2.74.488

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
