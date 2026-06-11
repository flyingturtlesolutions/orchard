// Services/Engine/nodeRegistry.js — CR-X1a (v2.74.947): THE strategy node-type registry.
//
// Before this, "what node types exist + where their children live + how a node is described" was
// re-stated at ~8 non-UI sites (ExecutionEngine's three dispatch chains, StrategyTree's
// normalize/walkNodes/computeIterationScopes/validateStrategyBody) with DISAGREEING unknown-type
// handling (skip-warn vs hard-fail vs silent-null). This module is the single source of truth for
// the TYPE LIST, the CHILD-LIST shape, and the human label.
//
// ── TO ADD A NODE TYPE ──
//   1. THIS file: NODE_TYPES + describeNode + (if it has children) childLists.
//   2. ExecutionEngine.#NODE_EXEC: wire the type to its executor (a startup alarm logs on drift).
//   3. StrategyTree normalizeNode: the type's canonical shape (X1c reads the type list from here).
//   4. The Studio node form (authoring UI).
//
// EXECUTION stays in ExecutionEngine (#NODE_EXEC) rather than here by design: the executors are
// private engine methods (JS #-private cannot be referenced from another module), and they need the
// engine's whole private surface. The registry owns the METADATA; the engine wires the verbs and
// asserts its wiring matches NODE_TYPES at startup.
//
// PURE — no chrome, no DOM. @module Services/Engine/nodeRegistry

/** The canonical node-type list (dispatch + validation read THIS). Order is cosmetic. */
export const NODE_TYPES = Object.freeze([
  'fragment', 'foreach', 'wait', 'pause', 'sieve', 'detect',
  'loop', 'try', 'navigate', 'scroll', 'observation', 'in_new_tab',
]);

/**
 * Cheap human-readable label for a node — pause-state events, progress emits, debugger rows.
 * (Moved verbatim from ExecutionEngine.#describeNodeForPause.)
 * @param {Object} node
 * @returns {string}
 */
export function describeNode(node) {
  if (!node) return '?';
  if (node.type === 'fragment') return `Fragment ${node.fragmentId ?? ''}`.trim();
  if (node.type === 'foreach')  return `FOREACH ${node.over ?? ''} as ${node.as ?? ''}`.trim();
  if (node.type === 'wait')     return 'WAIT';
  if (node.type === 'pause')    return 'PAUSE';
  if (node.type === 'sieve')    return `SIEVE ${node.source ?? '?'} → ${node.output ?? '?'}`;
  if (node.type === 'detect')   return `DETECT (${node.branches?.length ?? 0} branch(es))`;
  if (node.type === 'loop')     return 'LOOP while …';
  if (node.type === 'try')      return 'TRY';
  if (node.type === 'navigate') return `NAVIGATE ${node.mode ?? '?'}`;
  if (node.type === 'scroll') {
    const d = node.distance;
    let dStr = '?';
    if (d?.kind === 'literal') dStr = d.value;
    else if (d?.kind === 'strategy_param') dStr = `{{${d.name}}}`;
    else if (d?.kind === 'iteration_variable') dStr = `{{${d.name}}}`;
    return `SCROLL by ${dStr} viewport(s)`;
  }
  if (node.type === 'observation') return `OBSERVATION ${node.observationId ?? '?'}`;
  if (node.type === 'in_new_tab') return 'IN_NEW_TAB';
  return node.type;
}

/**
 * Where a node's CHILDREN live — every body-shaped list under the node, in walk order. The shape
 * mirrors StrategyTree.walkNodes' authoritative descent (X1c rewires the walkers onto this):
 *   foreach → body · detect → each branch body, then default · loop → body · try → body, recover ·
 *   in_new_tab → [trigger] (a single node, walked as a one-element list), then body.
 * Leaf types return []. This is the ONE `node.type` switch that remains in Services (CR-X1 accept).
 * @param {Object} node
 * @returns {Array<Array<Object>>} list of child-node lists (possibly empty arrays; never null)
 */
export function childLists(node) {
  if (!node) return [];
  switch (node.type) {
    case 'foreach':    return [node.body ?? []];
    case 'detect':     return [...(node.branches ?? []).map((b) => b?.body ?? []), node.default ?? []];
    case 'loop':       return [node.body ?? []];
    case 'try':        return [node.body ?? [], node.recover ?? []];
    case 'in_new_tab': return [node.trigger ? [node.trigger] : [], node.body ?? []];
    default:           return [];
  }
}
