// Core/brainRun.js — compose the brain loop into one runnable (DESIGN_inference_layer.md §4). IL-2 (v2.74.1111).
//
// PURE-with-injected-deps: this is the GLUE that turns the four separate cores (palette · agentLoop · execPlan ·
// the think seam) into a single `runBrain(goal, ctx, deps)`. Everything impure is a dep:
//   • retrieve(goal,k)  — the learned tool-RAG source (R-2) for assemblePalette
//   • brain(stepCtx)    — the think seam (AnthropicService.stepBrain)
//   • exec(plan)        — SEND a dispatch plan to its executor and return the raw reply (the ONE live wire:
//                         the background handler injects the real REPLAY_SG_CAPABILITY / OPEN_URL_NEW_TAB / …
//                         message send; executors self-busy-mark, so exec doesn't)
// So the composition is unit-testable end to end with mocks; the live handler is just the dep injection.

import { agentLoop } from './agentLoop.js';
import { assemblePalette } from './palette.js';
import { planExec, toObservation } from './execPlan.js';

const keyOf = (leg) => (leg && (leg.key ?? leg.capabilityId ?? leg.op ?? leg.name)) || null;

/**
 * Run the brain on a goal. PURE — all I/O via injected deps.
 * @param {string} goal
 * @param {{tabId?:number, groundId?:string}} ctx     the active page context (for execPlan)
 * @param {{
 *   retrieve?: (goal:string,k:number)=>Promise<Array<object>>,
 *   brain?:    (stepCtx:object)=>Promise<object>,            // → Decision
 *   exec?:     (plan:object)=>Promise<object>,               // send a planExec plan → executor reply
 *   outcomes?: (key:string)=>object, rules?:Array<object>, env?:object,
 *   verifyDone?: Function, isAborted?: ()=>boolean,
 * }} [deps]
 * @param {{ maxSteps?:number, k?:number, budget?:object, scope?:object }} [opts]
 * @returns {Promise<import('./agentLoop.js').LoopResult>}
 */
export async function runBrain(goal, ctx = {}, deps = {}, opts = {}) {
  const { retrieve, brain, exec, outcomes, rules, env, verifyDone, isAborted } = deps || {};
  const k = Number.isFinite(opts.k) ? opts.k : 8;

  // The palette is re-assembled each step (a new tab/ground/connector can change availability — §4.3).
  const palette = (g, scope) => assemblePalette(g, scope, { retrieve, env, rules, outcomes }, { k });

  // runTool = plan the dispatch (pure §4.2) → send via the injected exec → normalize to an Observation. A
  // non-dispatchable leg (missing ground/tab, greenfield connector) returns the #1 structuredFailure so the
  // brain re-engages instead of the loop dying.
  const runTool = async (leg, params) => {
    const plan = planExec(leg, params, ctx);
    if (!plan.ok) return { ok: false, structuredFailure: { where: keyOf(leg) || '?', reason: plan.reason }, reason: plan.reason };
    if (typeof exec !== 'function') return { ok: false, structuredFailure: { where: plan.channel, reason: 'no-exec' }, reason: 'no-exec' };
    let reply = null;
    try { reply = await exec(plan); }
    catch (e) { return { ok: false, structuredFailure: { where: plan.channel, reason: (e && e.message) || 'exec-threw' }, reason: 'exec-threw' }; }
    return toObservation(reply, plan);
  };

  return agentLoop(goal, { palette, callBrain: brain, runTool, verifyDone, isAborted }, opts);
}
