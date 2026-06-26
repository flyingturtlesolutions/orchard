// Core/setupFlow.js — AS-2a (v2.74.1188; AS-4 v2.74.1241 — sequential multi-connection): the pure setup-flow
// controller (DESIGN_conversations.md §6A). PURE: no chrome / DOM / LLM / storage.
//
// Composes the AS-1 spec transforms (Core/setupSpec.js) into a step-by-step state machine the live bind flow
// (AS-2b, chat.js) RENDERS + drives. Setup is a SEQUENTIAL verified loop (AS-4): the live side picks a site, VERIFIES
// it (open/probe via the CX-7 connection layer), then feeds the verified connection back here to accrete; the step
// then asks for "another, or done". So a step is one of:
//   • stage 'first' — no connection yet → prompt for the first site (required), offering reuse candidates;
//   • stage 'more'  — ≥1 connected → "add another site, or say done" (carries the `connected` list);
//   • done          — the user said done → here is the banked config.
// The live side stays a dumb renderer + the verifier: show the step, verify the pick, feed back the verified conn (or
// a `{done:true}` signal). All decision logic is here and tested. A connection is only ever fed back AFTER it verifies.

import {
  buildSetupSpec, normalizeSetupSpec, bindSlot, nextUnboundSlot, isSetupComplete, specToConfig,
  addConnection, markSetupDone, connectionsOf,
} from './setupSpec.js';

// A "done" signal from the live side (the user finished adding sites). `{done:true}` is canonical; 'done' is accepted.
function _isDone(answer) {
  return answer === 'done' || !!(answer && typeof answer === 'object' && answer.done === true);
}

/**
 * The current step for a spec. PURE.
 * @returns {{done:false, slot:'connections', kind:'connections', stage:'first'|'more', prompt:string,
 *            candidates:Array, connected:Array}} while sites are still being added,
 *          or {{done:true, config:object}} once the user signals done with ≥1 connection.
 */
export function setupStep(spec) {
  const s = normalizeSetupSpec(spec);
  if (isSetupComplete(s)) return { done: true, config: specToConfig(s) };
  const connected = connectionsOf(s);
  const have = new Set(connected.map((c) => c.origin));
  const open = (cands) => (Array.isArray(cands) ? cands : []).filter((c) => c && !have.has(c.origin));   // drop already-connected
  const slot = nextUnboundSlot(s);
  if (slot) {
    return { done: false, slot: slot.key, kind: slot.kind, stage: 'first', prompt: slot.prompt, candidates: open(slot.candidates), connected };
  }
  // ≥1 connection, not yet done → the sequential "add another / done" stage.
  const connSlot = s.slots.find((x) => x.kind === 'connections');
  return { done: false, slot: 'connections', kind: 'connections', stage: 'more',
    prompt: 'Add another site, or say “done”.', candidates: open(connSlot && connSlot.candidates), connected };
}

/**
 * Begin setup for an app definition. PURE. Existing session-ride connections become reuse candidates. The first step
 * prompts the `connections` slot (shape is pre-bound).
 * @returns {{spec:object, step:object}}
 */
export function startSetup(def, { connections = [] } = {}) {
  const spec = buildSetupSpec(def, { connections });
  return { spec, step: setupStep(spec) };
}

/**
 * Advance the sequential loop from a live answer, then re-step. PURE.
 *   • a `{done:true}` / 'done' answer → finish (ignored before the first connection — you can't bank zero sites);
 *   • any other answer → a VERIFIED connection `{origin,label}` to accrete (dedup by origin; a bad shape is rejected,
 *     so the same step repeats and the live side re-prompts).
 * A no-op once complete.
 * @returns {{spec:object, step:object}}
 */
export function advanceSetup(spec, answer) {
  const s = normalizeSetupSpec(spec);
  if (isSetupComplete(s)) return { spec: s, step: setupStep(s) };
  if (_isDone(answer)) {
    const next = connectionsOf(s).length > 0 ? markSetupDone(s) : s;   // "done" before any site is ignored
    return { spec: next, step: setupStep(next) };
  }
  const next = addConnection(s, answer);                               // a verified connection → accrete
  return { spec: next, step: setupStep(next) };
}

/**
 * Explicitly (re)bind a NAMED slot — for shape overrides and AS-3 edits, outside the sequential connection loop. PURE.
 * @returns {{spec:object, step:object}}
 */
export function bindSetupSlot(spec, key, answer) {
  const next = bindSlot(normalizeSetupSpec(spec), key, answer);
  return { spec: next, step: setupStep(next) };
}

/** Is this spec fully bound (≥1 connection + done)? PURE. Convenience over setupSpec.isSetupComplete. */
export function setupDone(spec) {
  return isSetupComplete(spec);
}
