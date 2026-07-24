// Core/rideStep.js — CD-1a (DESIGN_cadence.md §9.4 / §2.2): the SHARED pinned-ride / nav STEP primitive.
//
// §9.4's rule for CD-1a phase 2: the panel driver and the SW driver "must be ONE module with two reporters, never
// two implementations." The clause LOOP is Core/runDriver.runWorkflow; THIS is the other half — the per-step
// execution of the subset both hosts run identically (a step pinned to a ride leg, or a nav). The SW scheduler
// (background/handlers/cadence.js) and the panel's tier-'sw' workflow replay both call `runRideStep`, so the
// resolution → leg → INVOKE_SESSION path exists once, not twice.
//
// PURE decision + injected IO (readRecipes / invoke / the reporter's gate) — the runUpsert / branchClause pattern.
// Returns the runDriver runStep contract: { ok, value?, park?, parkedRunId?, error? }.

import { recipeToLeg } from './connectorLeg.js';
import { planExec } from './execPlan.js';
import { armable } from './rideRecipe.js';

const _pinOf = (clause) => {
  const p = clause && (clause.pinned || clause.clause);
  return (p && typeof p === 'object') ? p : null;
};

/**
 * Does a pinned clause still resolve? — replayPlan's drift check (§2.1). A ground + capability that reads back an
 * ARMABLE recipe resolves; anything else is drift → the caller STOPS the run rather than re-interpreting prose.
 * A loose (unpinned) step is legitimately resolvable (there is nothing pinned to have drifted). Injected readRecipes.
 * @param {object} clause
 * @param {{ readRecipes:(groundId:string)=>Promise<Array> }} io
 * @returns {Promise<boolean>}
 */
export async function rideStepResolvable(clause, { readRecipes } = {}) {
  const pin = _pinOf(clause);
  if (!pin) return true;
  if (String(pin.kind || '').trim() === 'navigate') return true;
  // v1717 — MIRROR chat.js `_wfReplayPlan`'s rule exactly (§9.4: the panel and SW must hold ONE notion of "a
  // resolvable pin", or replays diverge): a KIND-ONLY pin (fieldRead / branch / map / case — no capabilityId)
  // names no leg, so there is no leg to have drifted; its own drift check happens at RUN time (e.g. the field
  // re-resolves against the actual rows). Only a leg-bearing pin is checked against the recipe store.
  const groundId = pin.groundId, capId = pin.capabilityId;
  if (!capId) return true;
  if (!groundId) return false;   // a leg pin that lost its ground IS drift
  try {
    const recs = (typeof readRecipes === 'function' ? await readRecipes(groundId) : []) || [];
    const rec = recs.find((r) => r && r.id === capId);
    return !!(rec && armable(rec));
  } catch { return false; }
}

/**
 * Run ONE pinned-ride / nav step.
 *
 * - a NAV step is a no-op success (the ride's ephemeral tab carries its own URL);
 * - a pinned READ ride resolves → leg → INVOKE_SESSION through the injected `invoke`;
 * - a WRITE (writePolicy has no 'auto' — safetyClass !== 'auto', or rec.write) consults the reporter's gate: it
 *   PARKS unless the gate returns `true` (§8). The SW reporter's gate returns 'park'; a panel reporter can approve
 *   live. No reporter ⇒ 'park' (fail safe — nobody is watching).
 *
 * @param {object} clause  a replayPlan clause carrying `.pinned` ({kind, capabilityId, groundId})
 * @param {{ readRecipes:Function, invoke:Function, reporter?:object, runId?:string, workflowId?:string }} io
 * @returns {Promise<{ok?:boolean, value?:*, park?:boolean, parkedRunId?:string, error?:string}>}
 */
export async function runRideStep(clause, { readRecipes, invoke, reporter = null, runId = '', workflowId = '' } = {}) {
  const pin = _pinOf(clause);
  const kind = String((pin && pin.kind) || '').trim();
  if (kind === 'navigate' || (!pin && /navigate/i.test((clause && clause.text) || ''))) return { ok: true, value: null };

  const groundId = pin && pin.groundId;
  const capId = pin && pin.capabilityId;
  if (!groundId || !capId) return { ok: false, error: 'unpinned-step' };

  let recs = [];
  try { recs = (typeof readRecipes === 'function' ? await readRecipes(groundId) : []) || []; } catch { recs = []; }
  const rec = recs.find((r) => r && r.id === capId);
  if (!rec) return { ok: false, error: 'recipe-gone' };
  if (!armable(rec)) return { ok: false, error: 'not-armed' };

  const isWrite = rec.write === true || (rec.safetyClass && rec.safetyClass !== 'auto');
  if (isWrite) {
    const decision = (reporter && typeof reporter.gate === 'function')
      ? await reporter.gate({ workflowId, step: clause && clause.text, recipe: rec.name || capId, groundId })
      : 'park';
    if (decision !== true) return { park: true, parkedRunId: runId };
  }

  return invokeRideRecipe(rec, groundId, { invoke });
}

/**
 * §12 (v1715) — the ONE resolve→plan→invoke: recipe → leg (recipeToLeg) → plan (planExec, INVOKE_SESSION only) →
 * the injected invoke. Both runRideStep AND the vitals canary ride THIS, so the runner exists once — §12.1's
 * recurring-bug argument ("every time this codebase has held two of something that should be one, a defect lived
 * in the gap") applied to the runner itself.
 * @returns {Promise<{ok:boolean, value?:*, error?:string, status?:number|null}>}
 */
export async function invokeRideRecipe(rec, groundId, { invoke } = {}) {
  const leg = recipeToLeg({ ...rec, groundId }, { account: 'me', trusted: true });
  if (!leg || !leg.tool) return { ok: false, error: 'no-leg' };
  const plan = planExec(leg, {}, {});
  if (!plan || plan.ok === false || plan.channel !== 'INVOKE_SESSION') return { ok: false, error: 'no-plan' };
  let r = null;
  try { r = (typeof invoke === 'function') ? await invoke(plan.payload) : null; } catch (e) { return { ok: false, error: (e && e.message) || 'invoke-threw' }; }
  const ok = !!(r && r.success !== false);
  return ok ? { ok: true, value: (r && r.value), status: (r && r.status) || null }
            : { ok: false, error: (r && r.error) || 'invoke-failed', status: (r && r.status) || null };
}
