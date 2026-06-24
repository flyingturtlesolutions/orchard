// Core/setupFlow.js — AS-2a (v2.74.1188): the pure setup-flow controller (DESIGN_conversations.md §6A). PURE:
// no chrome / DOM / LLM / storage.
//
// Composes the AS-1 spec transforms (Core/setupSpec.js) into a step-by-step state machine the live bind flow
// (AS-2b, chat.js) just RENDERS: each step is either "prompt for this slot, offering these reuse candidates" or
// "done — here is the banked config." The live side stays a dumb renderer (show the step, feed back the answer);
// all the decision logic is here and tested. Progressive (one unbound slot at a time) + reuse-then-teach (the step
// carries the slot's candidates) fall straight out of nextUnboundSlot / bindSlot.

import {
  buildSetupSpec, normalizeSetupSpec, bindSlot, nextUnboundSlot, isSetupComplete, specToConfig,
} from './setupSpec.js';

/**
 * The current step for a spec. PURE.
 * @returns {{done:false, slot:string, kind:string, prompt:string, candidates:Array}} while a required slot is unbound,
 *          or {{done:true, config:object}} once complete (config = the banked patch from specToConfig).
 */
export function setupStep(spec) {
  const s = normalizeSetupSpec(spec);
  const slot = nextUnboundSlot(s);
  if (!slot) return { done: true, config: specToConfig(s) };
  return { done: false, slot: slot.key, kind: slot.kind, prompt: slot.prompt, candidates: slot.candidates };
}

/**
 * Begin setup for an app definition. PURE. `connections` (existing session-ride origins) become the target slot's
 * reuse candidates. Because shape is pre-bound from the archetype, the first step is the `target` slot.
 * @returns {{spec:object, step:object}}
 */
export function startSetup(def, { connections = [] } = {}) {
  const spec = buildSetupSpec(def, { connections });
  return { spec, step: setupStep(spec) };
}

/**
 * Bind the CURRENT (next-unbound) slot from a user answer, then advance. PURE. The caller never tracks which slot
 * it's on — the answer binds to whatever's next. The answer is shaped per the step's kind (target → {origin,label}
 * or a candidate; focus → string). A bad/ill-shaped answer is rejected by bindSlot, so the slot stays unbound and
 * the SAME step repeats (the live side just re-prompts). A no-op once complete.
 * @returns {{spec:object, step:object}}
 */
export function advanceSetup(spec, answer) {
  const s = normalizeSetupSpec(spec);
  const slot = nextUnboundSlot(s);
  if (!slot) return { spec: s, step: setupStep(s) };
  const next = bindSlot(s, slot.key, answer);
  return { spec: next, step: setupStep(next) };
}

/**
 * Explicitly (re)bind a NAMED slot — for shape overrides and AS-3 edits, outside the progressive required-slot walk.
 * PURE. (The progressive walk via advanceSetup never targets the pre-bound, non-required shape slot.)
 * @returns {{spec:object, step:object}}
 */
export function bindSetupSlot(spec, key, answer) {
  const next = bindSlot(normalizeSetupSpec(spec), key, answer);
  return { spec: next, step: setupStep(next) };
}

/** Is this spec fully bound (all required slots)? PURE. Re-exported convenience over setupSpec.isSetupComplete. */
export function setupDone(spec) {
  return isSetupComplete(spec);
}
