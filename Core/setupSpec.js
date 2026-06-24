// Core/setupSpec.js — AS-1 (v2.74.1186): the setup spec — the per-app binding checklist (DESIGN_conversations.md
// §6A). PURE: no chrome / DOM / LLM / storage.
//
// Every app — builtin or custom — is CONFIGURED before it's useful, the same way a workflow is decomposed into
// banked steps (the user's framing). Setup binds three slots, captured verbatim from the user's own words:
//   1. target  — "what sites?"            → a CONNECTION. target ≡ connection: the live logged-in tab IS the
//                                            session-ride origin (§6A). REQUIRED.
//   2. focus   — "what workflow/object?"  → the queue/object/workflow the app works (tickets, unread email,
//                                            listings). REQUIRED.
//   3. shape   — "how?"                   → the run-shape (interactive / watch / run; sub-agents; cadence). The
//                                            ARCHETYPE templates the default, so this is pre-bound + optional to
//                                            override.
// Progressive (prompt one unbound slot at a time → `nextUnboundSlot`) + reuse-then-teach (offer existing
// connections as the target slot's `candidates` before teaching a new one). A COMPLETED spec collapses to a config
// patch (`specToConfig`) that AS-3 banks onto the app — like a workflow's banked steps. This slice is the schema +
// the pure transforms only; the guided bind flow (AS-2) and the bank/edit wiring (AS-3) are later slices.
//
// `allowedOrigins` is a SCOPE-LIMITER derived from the bound target, NOT the target-discovery mechanism (§6A): the
// target comes from the live connection; allowedOrigins just fences where the app may operate.

import { ARCHETYPES } from './appDef.js';

const _str = (x) => (typeof x === 'string' ? x.trim() : '');

export const SETUP_KINDS = Object.freeze(['target', 'focus', 'shape']);     // the ordered binding slots
export const SHAPE_MODES = Object.freeze(['interactive', 'watch', 'run']);

// The archetype → default run-shape map (the archetype TEMPLATES the shape, §6A). Operators work a queue with the
// user; monitors watch read-only; executors run a task to its stopping point and may fan out sub-tasks. True cadence
// firing is the interface→backend split (deferred, decision #3) — 'on-run' is the v1 stand-in.
const _SHAPE_BY_ARCHETYPE = {
  operator: { mode: 'interactive', subAgents: false, cadence: null },
  monitor:  { mode: 'watch',       subAgents: false, cadence: 'on-run' },
  executor: { mode: 'run',         subAgents: true,  cadence: null },
};
const _DEFAULT_SHAPE = { mode: 'interactive', subAgents: false, cadence: null };

/** The default run-shape for an archetype (the template). PURE. Unknown archetype → the interactive default. */
export function archetypeShape(archetype) {
  return { ...(_SHAPE_BY_ARCHETYPE[archetype] || _DEFAULT_SHAPE) };
}

/**
 * Normalize a slot VALUE by kind. PURE. Returns the cleaned value, or null if unusable (→ the slot stays unbound,
 * so a malformed bind can never corrupt the spec).
 *   target → { origin, label }  (origin REQUIRED — it IS the connection; label defaults to the origin)
 *   focus  → string (≤120)
 *   shape  → { mode∈SHAPE_MODES, subAgents:bool, cadence:string|null }
 */
export function normalizeSlotValue(kind, value) {
  if (kind === 'target') {
    const v = (value && typeof value === 'object') ? value : null;
    const origin = _str(v && v.origin);
    if (!origin) return null;                                  // a target MUST carry an origin (the connection)
    return { origin, label: _str(v && v.label) || origin };
  }
  if (kind === 'focus') {
    const s = _str(value);
    return s ? s.slice(0, 120) : null;
  }
  if (kind === 'shape') {
    const v = (value && typeof value === 'object') ? value : null;
    if (!v) return null;
    return {
      mode: SHAPE_MODES.includes(v.mode) ? v.mode : 'interactive',
      subAgents: !!v.subAgents,
      cadence: _str(v.cadence) || null,
    };
  }
  return null;
}

/**
 * Derive the ordered setup checklist for an app definition. PURE.
 * target + focus are REQUIRED and start unbound; shape is PRE-BOUND from the archetype template (optional override).
 * `connections` (existing session-ride connections) become the target slot's reuse `candidates` (reuse-then-teach).
 * @returns {{ appId:string, archetype:string|null, slots:Array }}
 */
export function buildSetupSpec(def, { connections = [] } = {}) {
  const d = (def && typeof def === 'object') ? def : {};
  const appId = _str(d.id) || _str(d.appId);
  const archetype = ARCHETYPES.includes(d.archetype) ? d.archetype : null;
  const candidates = (Array.isArray(connections) ? connections : [])
    .map((c) => normalizeSlotValue('target', c)).filter(Boolean);
  const slots = [
    { key: 'target', kind: 'target', required: true,  value: null, candidates,
      prompt: 'Which site should this app work on? Sign in to it in a tab, then pick it here.' },
    { key: 'focus',  kind: 'focus',  required: true,  value: null, candidates: [],
      prompt: 'What does it work on there — which queue, object, or workflow?' },
    { key: 'shape',  kind: 'shape',  required: false, value: archetypeShape(archetype), candidates: [],
      prompt: 'How should it run?' },
  ];
  return { appId, archetype, slots };
}

/** Normalize / rehydrate a persisted spec: drop junk slots, re-normalize bound values + candidates. PURE. */
export function normalizeSetupSpec(spec) {
  const s = (spec && typeof spec === 'object') ? spec : {};
  const slots = (Array.isArray(s.slots) ? s.slots : [])
    .filter((sl) => sl && SETUP_KINDS.includes(sl.kind))
    .map((sl) => ({
      key: _str(sl.key) || sl.kind,
      kind: sl.kind,
      required: !!sl.required,
      value: sl.value == null ? null : normalizeSlotValue(sl.kind, sl.value),
      candidates: (Array.isArray(sl.candidates) ? sl.candidates : [])
        .map((c) => normalizeSlotValue(sl.kind, c)).filter(Boolean),
      prompt: _str(sl.prompt),
    }));
  return { appId: _str(s.appId), archetype: ARCHETYPES.includes(s.archetype) ? s.archetype : null, slots };
}

/**
 * Bind a value to a slot — returns a NEW spec (pure, copy-on-write). A value that's bad for the kind is IGNORED (the
 * slot stays unbound) so a malformed bind can't corrupt the spec; an unknown key leaves the spec unchanged.
 */
export function bindSlot(spec, key, value) {
  const s = normalizeSetupSpec(spec);
  const k = _str(key);
  let touched = false;
  const slots = s.slots.map((sl) => {
    if (sl.key !== k) return sl;
    const v = normalizeSlotValue(sl.kind, value);
    if (v == null) return sl;                                  // reject a bad value; leave it unbound
    touched = true;
    return { ...sl, value: v };
  });
  return touched ? { ...s, slots } : s;
}

/** The next REQUIRED + unbound slot (progressive prompting). PURE. Returns the slot, or null when setup is done. */
export function nextUnboundSlot(spec) {
  return normalizeSetupSpec(spec).slots.find((sl) => sl.required && sl.value == null) || null;
}

/** Are all REQUIRED slots bound? PURE. */
export function isSetupComplete(spec) {
  return !nextUnboundSlot(spec);
}

/**
 * Collapse a COMPLETED spec into the config patch AS-3 banks onto the app. PURE. Returns null if setup is incomplete
 * (a required slot is unbound) — a half-bound app is never banked. Shape:
 *   { target:{origin,label}, allowedOrigins:[origin], focus:string, shape:{...} }
 * `allowedOrigins` is the derived SCOPE fence (the bound target's origin), not a separate target list (§6A).
 */
export function specToConfig(spec) {
  const s = normalizeSetupSpec(spec);
  if (!isSetupComplete(s)) return null;
  const byKey = Object.fromEntries(s.slots.map((sl) => [sl.key, sl.value]));
  const target = byKey.target || null;
  return {
    target,
    allowedOrigins: target ? [target.origin] : [],
    focus: byKey.focus || null,
    shape: byKey.shape || archetypeShape(s.archetype),
  };
}
