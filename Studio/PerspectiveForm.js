/**
 * @file Studio/PerspectiveForm.js
 * @description Perspective-related helpers used by Studio's Ground card.
 *
 * ── v2.72.45 (Pass 17g iter) restructure ─────────────────────────────
 *
 * Perspective authoring (name, description, URL pattern, landmarks, save) was
 * moved into the debugger sidepanel. Studio no longer hosts a Perspective
 * form. This file shrunk from ~280 lines to a small set of helpers used
 * only by the Ground card:
 *
 *   - deletePerspective(perspectiveId)      — confirm-and-delete, with usage count
 *   - setupPerspectiveForm({...})      — kept as a no-op shim so existing
 *                                    studio.js imports don't have to
 *                                    change (it stores refreshGroundList
 *                                    so deletePerspective can refresh after).
 *
 * The launch path ("+ Perspective" → opens debugger sidepanel) lives in
 * studio.js's launchPerspectiveCapture; it doesn't need the form module at
 * all.
 *
 * @module Studio/PerspectiveForm
 * @author Agent HUB
 * @version 2.72.45
 */

import { StorageManager } from '../Services/StorageManager.js';
import { toast } from '../shared.js';
import { walkStrategyConditions } from './conditionWalker.js';

let _refreshGroundList = null;

export async function deletePerspective(perspectiveId) {
  const loc = await StorageManager.getPerspective(perspectiveId);
  if (!loc) return;
  const usageCount = await countPerspectiveUsages(perspectiveId, loc.groundId);
  let msg = `Delete Perspective "${loc.name}"? This cannot be undone.`;
  if (usageCount > 0) {
    msg = `Delete Perspective "${loc.name}"?\n\n⚠ ${usageCount} reference${usageCount === 1 ? '' : 's'} to this perspective exist in primitives' pre/post envelopes — deleting will leave them broken until updated.\nThis cannot be undone.`;
  }
  if (!confirm(msg)) return;
  const res = await new Promise(r => chrome.runtime.sendMessage({
    type: 'DELETE_PERSPECTIVE', payload: { perspectiveId },
  }, r));
  if (!res?.success) {
    toast(`Delete failed: ${res?.error ?? 'unknown'}`, 'err');
    return;
  }
  toast('Perspective deleted');
  if (typeof _refreshGroundList === 'function') {
    await _refreshGroundList();
  }
}

async function countPerspectiveUsages(perspectiveId, groundId) {
  let count = 0;
  const strategies = await StorageManager.listStrategies(groundId);
  const fragments  = await StorageManager.listFragments(groundId);
  const observations = await StorageManager.listObservations(groundId);
  const analyses     = await StorageManager.listAnalyses(groundId);

  for (const s of strategies) {
    walkStrategyConditions(s.fragmentSteps ?? [], (cond) => {
      if (cond?.type === 'perspective_ref' && cond.perspectiveId === perspectiveId) count++;
    });
    [...(s.preconditions?.conditions ?? []), ...(s.postconditions?.conditions ?? [])].forEach(c => {
      if (c?.type === 'perspective_ref' && c.perspectiveId === perspectiveId) count++;
    });
  }
  for (const f of fragments) {
    [...(f.preconditions ?? []), ...(f.postconditions ?? [])].forEach(c => {
      if (c?.type === 'perspective_ref' && c.perspectiveId === perspectiveId) count++;
    });
  }
  for (const o of observations) {
    [...(o.preconditions ?? []), ...(o.postconditions ?? [])].forEach(c => {
      if (c?.type === 'perspective_ref' && c.perspectiveId === perspectiveId) count++;
    });
  }
  for (const a of analyses) {
    [...(a.preconditions?.conditions ?? a.preconditions ?? []),
     ...(a.postconditions?.conditions ?? a.postconditions ?? [])].forEach(c => {
      if (c?.type === 'perspective_ref' && c.perspectiveId === perspectiveId) count++;
    });
  }
  return count;
}

export function setupPerspectiveForm({ refreshGroundList }) {
  _refreshGroundList = refreshGroundList;
}
