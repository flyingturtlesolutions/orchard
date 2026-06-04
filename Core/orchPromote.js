// Core/orchPromote.js — the converge promotion brain: turn an ACCEPTED T2 control-flow composite (matcher-only
// sgCapability) into a CANONICAL, runnable Strategy record — Studio-visible, ParamForm-launchable, one runtime.
//
// This is the orchestration layer ABOVE the pure translator (orchTranslate). It:
//   1. resolves each leaf step's capabilityId → a Strategy ref (fragment) or a materialized Observation (read),
//      via INJECTED async callbacks (the handler does the StorageManager I/O — this stays mockable/testable);
//   2. runs translatePlan to map the ORCH IR → a Strategy plan tree;
//   3. VALIDATES the translated tree (the validate-at-promote gate, R7) — only a clean tree is promoted;
//   4. assembles the canonical Strategy record (mirrors capabilitySynth.buildTier2CapabilityRecords' shape).
//
// EVERYTHING is additive + fail-safe: any unresolved leaf (e.g. a VISUAL condition with no selector), a foreach,
// or a validation miss → { ok:false }. The caller then keeps the composite as a matcher-only cap and runs it via
// the ORCH walkPlan interpreter exactly as before (R7). Nothing the converge adds can break a working composite.
//
// @module Core/orchPromote
// @version 2.74.745

import { translatePlan } from './orchTranslate.js';
import { isVisualObservation } from './orchVisual.js';

const _NODE_TYPES = new Set(['fragment', 'wait', 'observation', 'detect']);

/**
 * Materialize a CANONICAL Observation record from an ORCH observation sgCapability, for the converge. PURE.
 * The shape is VERIFIED against the live protocol:
 *   • cache-tier `list_of_records` extract → content script OBSERVE_LIST does `querySelectorAll(target)` (one
 *     record per match) → ExecutionEngine tags it `list(...)`. ALWAYS a list, so 0 matches → list([]) → count 0,
 *     sidestepping the image_read 0→scalar('') collapse that would mis-open an "if there are any …" gate.
 *   • `target` is a SELECTOR STRING (NOT {selector}) — OBSERVE_LIST indexes it directly.
 *   • `fields` MUST be non-empty (OBSERVE_LIST rejects an empty fields array); the field VALUE is irrelevant for a
 *     count/exists gate — each matched container still yields one item — so a trivial descendant field suffices.
 *   • `output` = the observe STEP id, so the downstream orch_predicate condition (binding = step id) reads it.
 * Returns null for a VISUAL observation or one with no selector → the promote fails closed → matcher-only (R7).
 * @returns {object|null}
 */
export function buildConvergeObservationRecord(cap, outputName, { observationId, now } = {}) {
  if (!cap || cap.kind !== 'observation') return null;
  if (isVisualObservation(cap)) return null;
  const ex0 = (cap.observe && Array.isArray(cap.observe.extracts) && cap.observe.extracts[0]) || null;
  const selector = ex0 && ((ex0.archetype && ex0.archetype.selector) || ex0.selector);
  if (!selector) return null;
  const ts = Number.isFinite(now) ? now : 0;
  return {
    id: observationId,
    groundId: cap.groundId || null,
    name: `${cap.intent || cap.name || 'observation'} — converged`.slice(0, 80),
    // An expression of intent (what it READS), not the bare intent string.
    description: `Read ${cap.intent || cap.name || 'a list'} — the items matching "${String(selector)}"`.slice(0, 280),
    output: outputName,
    shape: 'list',
    params: [],
    // ARRAY shape — the runtime reads observation conditions as arrays (an envelope is silently skipped); kept
    // consistent with authored observations + fragments. Empty here (a converge read has no gate of its own).
    preconditions: [],
    postconditions: [],
    implementations: [{
      tier: 'cache',
      // target = plain selector string; fields non-empty (value unused for a count gate, but the guard requires it).
      extracts: [{ shape: 'list_of_records', target: String(selector), fields: [{ name: 'value', selector: '*' }], output: outputName }],
    }],
    synthesized: true,
    createdAt: ts, updatedAt: ts,
  };
}
const _BIND_KINDS = new Set(['literal', 'strategy_param', 'iteration_variable']);

/**
 * Structural floor for a translated Strategy plan tree — the validate-at-promote gate. PURE.
 * Confirms every node is a known type, every Observation carries an id, every DETECT condition is a
 * well-formed orch_predicate (binding + parseable specJson), and every fragment binding kind is recognized.
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateTranslatedTree(fragmentSteps) {
  const errors = [];
  if (!Array.isArray(fragmentSteps) || !fragmentSteps.length) return { ok: false, errors: ['translated tree is empty'] };
  const walk = (nodes, where) => {
    for (const n of (Array.isArray(nodes) ? nodes : [])) {
      if (!n || !_NODE_TYPES.has(n.type)) { errors.push(`${where}: unknown node type "${n && n.type}"`); continue; }
      if (n.type === 'fragment') {
        if (!n.fragmentId) errors.push(`${where}: fragment node missing fragmentId`);
        for (const [k, b] of Object.entries(n.paramBindings || {})) {
          if (!b || !_BIND_KINDS.has(b.kind)) errors.push(`${where}: fragment binding "${k}" has bad kind "${b && b.kind}"`);
        }
      } else if (n.type === 'observation') {
        if (!n.observationId) errors.push(`${where}: observation node missing observationId`);
      } else if (n.type === 'wait') {
        if (!(Number.isFinite(n.durationMs) && n.durationMs >= 0)) errors.push(`${where}: wait node bad durationMs`);
      } else if (n.type === 'detect') {
        const branches = Array.isArray(n.branches) ? n.branches : [];
        if (!branches.length) errors.push(`${where}: detect node has no branches`);
        branches.forEach((br, i) => {
          const conds = (br && br.condition && Array.isArray(br.condition.conditions)) ? br.condition.conditions : [];
          if (!conds.length) errors.push(`${where}: detect branch ${i} has no conditions`);
          for (const c of conds) {
            if (!c || c.type !== 'orch_predicate') { errors.push(`${where}: detect branch ${i} condition is "${c && c.type}", expected orch_predicate`); continue; }
            if (!c.binding) errors.push(`${where}: orch_predicate missing binding`);
            try { JSON.parse(c.specJson || ''); } catch { errors.push(`${where}: orch_predicate specJson is not valid JSON`); }
          }
          walk(br && br.body, `${where}.branch[${i}]`);
        });
        walk(n.default, `${where}.default`);
      }
    }
  };
  walk(fragmentSteps, 'root');
  return { ok: errors.length === 0, errors };
}

/**
 * Assemble the canonical Strategy record from a successful translation. PURE.
 * Mirrors capabilitySynth.buildTier2CapabilityRecords' strategy shape exactly so saveStrategy's
 * #migrateStrategyShape lifts it the same way (fragmentSteps → implementations, status → 'ready').
 */
export function assembleStrategy(cap, translation, { strategyId, now } = {}) {
  const ts = Number.isFinite(now) ? now : 0;   // caller stamps a real timestamp after return (Date.now() is unavailable in some pure contexts)
  const intent = String((cap && cap.intent) || (cap && cap.goal) || 'Composite').slice(0, 120);
  return {
    id: strategyId,
    groundId: (cap && cap.groundId) || null,
    name: intent.slice(0, 80),
    goal: String((cap && cap.goal) || intent).slice(0, 200),
    params: Array.isArray(translation.params) ? translation.params : [],
    fragmentSteps: translation.fragmentSteps,
    aliases: Array.isArray(cap && cap.aliases) ? cap.aliases.filter(Boolean).slice(0, 12) : [],
    outcomeSignal: null,
    synthesized: true,                 // provenance: converged from an ORCH composite, not hand-built
    fromComposite: (cap && cap.id) || null,   // back-reference for Studio / dedup
    createdAt: ts, updatedAt: ts,
  };
}

/**
 * Promote a control-flow composite cap into a canonical Strategy. Resolves leaves via injected async I/O,
 * translates, validates, and assembles. The ONLY async surface — kept thin so the handler is a pure adapter.
 *
 * @param {object} cap  the composite sgCapability (controlFlow, steps = ORCH IR, params, signature)
 * @param {{
 *   resolveFragmentCap: (capabilityId:string, step:object) => Promise<{fragmentSteps:object[]}|null>,
 *   resolveObserveCap:  (capabilityId:string, step:object) => Promise<{observationId:string}|null>,
 *   strategyId: string,
 *   now?: number
 * }} deps
 * @returns {Promise<{ok:boolean, strategy?:object, translation?:object, errors:string[]}>}
 */
export async function promoteComposite(cap, deps = {}) {
  const { resolveFragmentCap, resolveObserveCap, strategyId, now } = deps;
  if (!cap || !cap.controlFlow || !Array.isArray(cap.steps) || !cap.steps.length) {
    return { ok: false, errors: ['not a control-flow composite (only quantified/conditional composites converge)'] };
  }
  if (!strategyId) return { ok: false, errors: ['strategyId required'] };

  const errors = [];
  const resolved = {};
  const leaves = [];
  const collect = (arr) => { for (const s of (arr || [])) { if (!s) continue; if (s.kind === 'fragment' || s.kind === 'observe') leaves.push(s); if (Array.isArray(s.body)) collect(s.body); } };
  collect(cap.steps);

  for (const s of leaves) {
    try {
      if (s.kind === 'fragment') {
        if (s.clickItem) { errors.push(`fragment ${s.id} is a synthetic clickItem — unsupported`); continue; }
        const r = typeof resolveFragmentCap === 'function' ? await resolveFragmentCap(s.capabilityId, s) : null;
        if (r && Array.isArray(r.fragmentSteps) && r.fragmentSteps.length) resolved[s.id] = { kind: 'fragment', fragmentSteps: r.fragmentSteps };
      } else if (s.kind === 'observe') {
        const r = typeof resolveObserveCap === 'function' ? await resolveObserveCap(s.capabilityId, s) : null;
        if (r && r.observationId) resolved[s.id] = { kind: 'observation', observationId: r.observationId };
      }
    } catch (e) { errors.push(`resolve ${s.id}: ${e && e.message ? e.message : e}`); }
  }

  const plan = { steps: cap.steps };
  const paramDefaults = {};
  for (const p of ((cap.signature && cap.signature.params) || [])) if (p && p.name) paramDefaults[p.name] = p.sample;
  const t = translatePlan(plan, resolved, { params: Array.isArray(cap.params) ? cap.params : [], paramDefaults });
  if (!t.ok) return { ok: false, errors: [...errors, ...t.errors] };

  const v = validateTranslatedTree(t.fragmentSteps);
  if (!v.ok) return { ok: false, errors: [...errors, ...v.errors] };

  return { ok: true, strategy: assembleStrategy(cap, t, { strategyId, now }), translation: t, errors };
}
