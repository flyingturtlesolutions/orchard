/**
 * @file Studio/conditionWalker.js
 * @description Generic visitor for all condition objects in a strategy
 * tree. Used by reference-counting code (assertion usages, perspective
 * usages) and any future code that needs to inspect every condition
 * regardless of where it sits in the tree (DETECT branches, LOOP exit
 * checks, WAIT_FOR conditions, FOREACH/TRY/IN_NEW_TAB body recursion).
 *
 * Extracted from studio.js as part of the per-form decomposition (Pass
 * 17b). Lives under Studio/ rather than Services/ because it's a
 * studio-authoring concern — runtime evaluation has its own walker
 * pattern in TemplateWalker.checkConditions.
 *
 * @module Studio/conditionWalker
 * @author Agent HUB
 */

/**
 * Walk all condition objects in a strategy body, calling visitor(cond)
 * on each one. Recurses into DETECT branches, LOOP body, FOREACH body,
 * TRY body+recover, and IN_NEW_TAB body. Conditions on DETECT/LOOP/WAIT
 * are surfaced individually whether they're stored as a single object
 * or wrapped in a {match, conditions} envelope.
 *
 * @param {Array} body - strategy fragmentSteps array
 * @param {Function} visitor - called with each condition object
 */
export function walkStrategyConditions(body, visitor) {
  if (!Array.isArray(body)) return;
  for (const node of body) {
    if (!node || typeof node !== 'object') continue;
    // DETECT branches each carry a condition (which may be Assertion or single)
    if (node.type === 'detect') {
      for (const b of node.branches ?? []) {
        const conds = b.condition?.conditions ?? (b.condition ? [b.condition] : []);
        conds.forEach(visitor);
        walkStrategyConditions(b.body ?? [], visitor);
      }
      walkStrategyConditions(node.default ?? [], visitor);
    } else if (node.type === 'loop') {
      const conds = node.condition?.conditions ?? (node.condition ? [node.condition] : []);
      conds.forEach(visitor);
      walkStrategyConditions(node.body ?? [], visitor);
    } else if (node.type === 'wait' && node.mode === 'condition') {
      const conds = node.condition?.conditions ?? (node.condition ? [node.condition] : []);
      conds.forEach(visitor);
    } else if (node.type === 'foreach') {
      walkStrategyConditions(node.body ?? [], visitor);
    } else if (node.type === 'try') {
      walkStrategyConditions(node.body ?? [], visitor);
      walkStrategyConditions(node.recover ?? [], visitor);
    } else if (node.type === 'in_new_tab') {
      walkStrategyConditions(node.body ?? [], visitor);
    }
  }
}
