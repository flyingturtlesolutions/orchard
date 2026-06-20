// Core/ilStandin.js — fold the single-shot stand-in (ORCH_MATCH + JUDGE) through agentLoop (IL-3, v2.74.1130).
//
// The .1118 stand-in shipped OUTSIDE the loop: ask → ORCH_MATCH (the substrate picks + binds over the live page,
// the part it does well) → JUDGE (Orchard, the user's stand-in, picks WHICH candidate to run) → run. This
// composes that SAME decision THROUGH agentLoop at maxSteps=1, so loop@1 ≡ stand-in (DESIGN_inference_layer.md
// §8 Phase-1 parity): the substrate matcher IS the loop's palette (re-grounded each step), JUDGE is the think
// seam (callIl), and at maxSteps=1 the chosen act is handed BACK un-executed for the caller's rich runner
// (_orchRun, with its HITL/param gates). Raising maxSteps later turns the SAME composition into the multi-step
// stand-in (re-match → judge → execute → observe → re-think) with NO new machinery — the whole point of the fold.
//
// Why this and not ilRun.js: the dormant ilRun path assembles a THIN tool-RAG palette + a generic step prompt,
// which underperformed the substrate matcher (the .1118 lesson — it ran "halo illustrations" as one keyword).
// The stand-in delegates the pick+bind to ORCH_MATCH (affordance-aware) and only JUDGES. That delegation is the
// load-bearing difference, so it lives in its own composition. PURE-with-injected-deps (`offer`/`judge`); chat.js
// injects the live message sends.

import { agentLoop } from './agentLoop.js';

/**
 * A matched candidate {id,intent,bindings} → a page OfferedLeg. JUDGE picks the CAPABILITY; the substrate's
 * already-bound values ride along as the leg's `bindings` (never re-bound — the .1117 "halo" bug). PURE.
 */
export function candidateToLeg(c) {
  const id = c && (c.id || c.ref || c.capabilityId);
  if (!id) return null;
  const bindings = (c.bindings && typeof c.bindings === 'object') ? c.bindings : {};
  return {
    key: id, name: c.intent || c.name || id, domain: 'page', mode: 'act', source: 'learned',
    params: Object.keys(bindings), bindings, tool: { capabilityId: id, intent: c.intent || c.name || null },
  };
}

/** An OfferedLeg → the {id,intent,bindings} shape JUDGE_MATCH consumes (judgePrompt.buildJudgeMessages). PURE.
 *  Prefers a builtin leg's `does` (the action description JUDGE reasons over) and falls back to `name`. */
export function legToCandidate(l) {
  return { id: l.key, intent: l.does || l.name, bindings: l.bindings || {} };
}

/**
 * Mirror the .1118 stand-in pick logic EXACTLY: a valid in-set ref wins; an explicit `null` ref is a reject;
 * an absent/unparseable verdict auto-picks ONLY when there is a single candidate (the user would have confirmed
 * it) — otherwise don't guess. PURE.
 */
export function pickFromVerdict(verdict, legs) {
  const list = Array.isArray(legs) ? legs : [];
  const byKey = new Map(list.map((l) => [l.key, l]));
  if (verdict && verdict.ref && byKey.has(verdict.ref)) return byKey.get(verdict.ref);
  if (verdict && verdict.ref === null) return null;            // explicit reject (better to ask than mis-run)
  if (list.length === 1) return list[0];                       // single → auto-pick (parity)
  return null;
}

/**
 * Run the stand-in through agentLoop. PURE — all I/O via injected deps.
 * @param {string} goal
 * @param {{
 *   offer?: (goal:string)=>Promise<{candidates:Array<object>, builtins?:Array<object>, groundId?:string, match?:object}>,   // ORCH_MATCH + alternatives (+ builtin read legs on a miss)
 *   judge?: (goal:string, candidates:Array<object>)=>Promise<{ref:(string|null), reason?:string}|null>,  // JUDGE_MATCH
 *   isAborted?: ()=>boolean,
 * }} [deps]
 * @param {{ maxSteps?:number, budget?:object }} [opts]
 * @returns {Promise<{status:string, decision:(object|null), steps:number, groundId:(string|null), match:(object|null)}>}
 */
export async function runIlStandin(goal, deps = {}, opts = {}) {
  const { offer, judge, isAborted } = deps || {};
  let groundId = null;
  let match = null;

  // palette = the substrate's matched candidates (re-grounded each step), normalized to page legs. Surfaces the
  // raw match + groundId for the caller's dispatch (the rich runner needs the param schema + ground).
  const palette = async (g) => {
    let res = null;
    try { res = (typeof offer === 'function') ? await offer(g) : null; } catch { res = null; }
    if (res && typeof res === 'object') {
      if (res.groundId != null) groundId = res.groundId;
      if (res.match !== undefined) match = res.match;
    }
    const cands = (res && Array.isArray(res.candidates)) ? res.candidates : [];
    // IL-3b — builtin Browser/Self legs (already-normalized OfferedLegs) join the page candidates; the substrate
    // offers them on a page miss so JUDGE can pick "list tabs" / "what can I do here" instead of dead-ending.
    const builtins = (res && Array.isArray(res.builtins)) ? res.builtins.filter((l) => l && l.key) : [];
    return [...cands.map(candidateToLeg).filter(Boolean), ...builtins];
  };

  // callIl = JUDGE over the offered candidates → an act decision (the pick), or a needs (answer/reject). No
  // candidates ⇒ the substrate missed ⇒ hand to the meta ANSWER path (needs:answer).
  const callIl = async (ctx) => {
    const legs = Array.isArray(ctx.palette) ? ctx.palette : [];
    if (!legs.length) return { kind: 'needs', needs: { kind: 'answer' }, params: {}, confidence: 0, reason: 'no-candidates' };
    let verdict = null;
    try { verdict = (typeof judge === 'function') ? await judge(ctx.goal, legs.map(legToCandidate)) : null; } catch { verdict = null; }
    const pick = pickFromVerdict(verdict, legs);
    if (pick) return { kind: 'act', leg: pick, params: pick.bindings || {}, confidence: 1, reason: (verdict && verdict.reason) || '' };
    // No fit. PAGE legs were offered ⇒ "didn't fit — rephrase" (reject); a builtins-only palette (a page miss) ⇒
    // hand to the meta ANSWER instead (don't tell the user to rephrase a "what tabs?" that just didn't match a leg).
    const hasPage = legs.some((l) => l && l.domain === 'page');
    return { kind: 'needs', needs: { kind: hasPage ? 'reject' : 'answer', reason: (verdict && verdict.reason) || '' }, params: {}, confidence: 0, reason: 'judge-reject' };
  };

  const maxSteps = (Number.isFinite(opts.maxSteps) && opts.maxSteps > 0) ? Math.floor(opts.maxSteps) : 1;
  const result = await agentLoop(goal, { palette, callIl, isAborted }, { ...opts, maxSteps });
  return { status: result.status, decision: result.decision, steps: result.steps, groundId, match };
}
