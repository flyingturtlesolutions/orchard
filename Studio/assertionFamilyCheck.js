/**
 * @file Studio/assertionFamilyCheck.js
 * @description Assertion-ref family-compat check. Given a list of
 * conditions, for each assertion_ref look up the referenced assertion
 * and check that its body's conditions only use families allowed by
 * the consuming primitive.
 *
 * Used by:
 *   - Fragment review-panel save (page-only context)
 *   - Analysis save (scope-only context)
 *   - Future strategy-level pre/post saves (page+scope)
 *
 * Extracted from studio.js (Pass 17f) so multiple form modules can use
 * it without crossing back into studio.js. Originally lived inside the
 * Fragment review panel section.
 *
 * @module Studio/assertionFamilyCheck
 * @author Agent HUB
 * @version 2.72.36
 */

import { StorageManager } from '../Services/StorageManager.js';
import { getFamily } from '../Services/Assertion.js';

/**
 * Walk `conditions`, finding assertion_ref entries. For each, load the
 * referenced assertion and check whether its body uses any family
 * outside `allowedFamilies`. Returns a list of incompatible references
 * (empty if all clear).
 *
 * Missing references (assertion_ref pointing to a deleted assertion)
 * are not flagged here — that's a separate error class. Reference-family
 * conditions inside the referenced assertion (assertion_ref nested) are
 * skipped; only direct families count for this check.
 *
 * @param {Array} conditions
 * @param {Array<string>} allowedFamilies — e.g. ['page'], ['scope'], or ['page','scope']
 * @param {string} groundId — used by callers for error messages; not used internally
 * @returns {Promise<Array<{assertionId, name, foreignFamilies}>>}
 */
export async function checkAssertionRefFamilies(conditions, allowedFamilies, groundId) {
  const allowed = new Set(allowedFamilies);
  const incompat = [];
  for (const cond of conditions ?? []) {
    if (cond?.type !== 'assertion_ref' || !cond.assertionId) continue;
    let pred = null;
    try {
      pred = await StorageManager.getAssertion(cond.assertionId);
    } catch (_) { pred = null; }
    if (!pred) continue;  // missing reference — different error class, not our concern
    const refConds = Array.isArray(pred.body?.conditions) ? pred.body.conditions : [];
    const foundFamilies = new Set();
    for (const rc of refConds) {
      const fam = getFamily(rc?.type);
      if (fam && fam !== 'reference' && !allowed.has(fam)) foundFamilies.add(fam);
    }
    if (foundFamilies.size > 0) {
      incompat.push({
        assertionId: cond.assertionId,
        name: pred.name ?? cond.assertionId,
        foreignFamilies: [...foundFamilies],
      });
    }
  }
  return incompat;
}
