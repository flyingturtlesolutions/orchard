/**
 * @file Studio/LocaleForm.js
 * @description Locale-related helpers used by Studio's Ground card.
 *
 * ── v2.72.45 (Pass 17g iter) restructure ─────────────────────────────
 *
 * Locale authoring (name, description, URL pattern, landmarks, save) was
 * moved into the debugger sidepanel. Studio no longer hosts a Locale
 * form. This file shrunk from ~280 lines to a small set of helpers used
 * only by the Ground card:
 *
 *   - deleteLocale(localeId)      — confirm-and-delete, with usage count
 *   - setupLocaleForm({...})      — kept as a no-op shim so existing
 *                                    studio.js imports don't have to
 *                                    change (it stores refreshGroundList
 *                                    so deleteLocale can refresh after).
 *
 * The launch path ("+ Locale" → opens debugger sidepanel) lives in
 * studio.js's launchLocaleCapture; it doesn't need the form module at
 * all.
 *
 * @module Studio/LocaleForm
 * @author Agent HUB
 * @version 2.72.45
 */

import { StorageManager } from '../Services/StorageManager.js';
import { toast } from '../shared.js';
import { walkStrategyConditions } from './conditionWalker.js';

let _refreshGroundList = null;

export async function deleteLocale(localeId) {
  const loc = await StorageManager.getLocale(localeId);
  if (!loc) return;
  const usageCount = await countLocaleUsages(localeId, loc.groundId);
  let msg = `Delete Locale "${loc.name}"? This cannot be undone.`;
  if (usageCount > 0) {
    msg = `Delete Locale "${loc.name}"?\n\n⚠ ${usageCount} reference${usageCount === 1 ? '' : 's'} to this locale exist in primitives' pre/post envelopes — deleting will leave them broken until updated.\nThis cannot be undone.`;
  }
  if (!confirm(msg)) return;
  const res = await new Promise(r => chrome.runtime.sendMessage({
    type: 'DELETE_LOCALE', payload: { localeId },
  }, r));
  if (!res?.success) {
    toast(`Delete failed: ${res?.error ?? 'unknown'}`, 'err');
    return;
  }
  toast('Locale deleted');
  if (typeof _refreshGroundList === 'function') {
    await _refreshGroundList();
  }
}

async function countLocaleUsages(localeId, groundId) {
  let count = 0;
  const strategies = await StorageManager.listStrategies(groundId);
  const fragments  = await StorageManager.listFragments(groundId);
  const observations = await StorageManager.listObservations(groundId);
  const analyses     = await StorageManager.listAnalyses(groundId);

  for (const s of strategies) {
    walkStrategyConditions(s.fragmentSteps ?? [], (cond) => {
      if (cond?.type === 'locale_ref' && cond.localeId === localeId) count++;
    });
    [...(s.preconditions?.conditions ?? []), ...(s.postconditions?.conditions ?? [])].forEach(c => {
      if (c?.type === 'locale_ref' && c.localeId === localeId) count++;
    });
  }
  for (const f of fragments) {
    [...(f.preconditions ?? []), ...(f.postconditions ?? [])].forEach(c => {
      if (c?.type === 'locale_ref' && c.localeId === localeId) count++;
    });
  }
  for (const o of observations) {
    [...(o.preconditions ?? []), ...(o.postconditions ?? [])].forEach(c => {
      if (c?.type === 'locale_ref' && c.localeId === localeId) count++;
    });
  }
  for (const a of analyses) {
    [...(a.preconditions?.conditions ?? a.preconditions ?? []),
     ...(a.postconditions?.conditions ?? a.postconditions ?? [])].forEach(c => {
      if (c?.type === 'locale_ref' && c.localeId === localeId) count++;
    });
  }
  return count;
}

export function setupLocaleForm({ refreshGroundList }) {
  _refreshGroundList = refreshGroundList;
}
