// Core/setupSpec.js — AS-1 (v2.74.1186; AS-4 v2.74.1241 — multi-connection): the per-app setup spec
// (DESIGN_conversations.md §6A). PURE: no chrome / DOM / LLM / storage.
//
// Setup binds the app's CONNECTION SET — the sites it operates on. Each entry IS a connection (the live logged-in tab
// is the session-ride origin, §6A). AS-4 (2026-06-25): setup is SEQUENTIAL + immediately-verified — pick a site, the
// live flow verifies it (open/probe via the CX-7 connection layer), it accretes; repeat until the user says "done".
// So `connections` is an ACCUMULATOR, not a single slot, and a `done` flag marks the end of the sequence (≥1 required).
// The same `addConnection` lets a site accrete LATER too (post-setup, via a connect command) — setup is just the first
// pass of the same mechanism. Two slots:
//   1. connections — "which sites?"  → the verified connection list. REQUIRED (≥1). The only prompted slot.
//   2. shape        — "how it runs"  → interactive / watch / run; PRE-BOUND from the archetype, never prompted (AS-3 edit).
//
// FOCUS is NOT a setup slot (2026-06-24): what the app DOES accretes at RUNTIME via the teach/trial flywheel + the
// learning scheme (DESIGN_apps_learning.md). SEED gives the goal/role, SETUP gives the sites, CHAT+LEARNING the caps.
//
// A COMPLETED spec collapses to a config patch (`specToConfig` → `connections[]` + a derived `allowedOrigins` fence;
// `target` = the primary connection, kept for back-compat readers). Pure transforms only; the guided verified bind
// loop (AS-2, chat.js) is the live wiring.

import { ARCHETYPES } from './appDef.js';

const _str = (x) => (typeof x === 'string' ? x.trim() : '');

export const SETUP_KINDS = Object.freeze(['connections', 'shape']);        // the binding slots (only connections is prompted)
export const SHAPE_MODES = Object.freeze(['interactive', 'watch', 'run']);

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
 * v2.74.1339 (review P1-6/setup) — shape a typed answer into a connection `{origin,label}`, or null. PURE.
 * The setup verifier's generic probe classifies only the tab's FINAL-URL SHAPE (no reachability signal), so a
 * bare word like "gmail" was shaped to `https://gmail`, "verified", and banked as a real connection that then
 * poisoned every interpret `target`. The floor here: a real PUBLIC host has a DOT (a TLD) — "gmail"/"help"/"done!"
 * are rejected and the modal re-prompts, while "mail.google.com"/"support.deako.com" pass. `localhost[:port]` is
 * the one dotless exception (dev). Whole sentences already fail (a space is not a valid host char).
 */
export function originFromText(text) {
  const raw = _str(text);
  if (!raw) return null;
  // Parse with an EXPLICIT scheme only; otherwise prefix https:// and re-parse. (A bare `localhost:3000` would
  // otherwise parse as scheme `localhost:` + opaque path — silently defeating the dev exception below.)
  let u = null;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : ('https://' + raw.replace(/^\/+/, ''))); } catch { /* */ }
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname;
  const dotted = host.includes('.') && !/^\.|\.$|\.\./.test(host) && /[a-z]/i.test(host.split('.').pop() || '');   // needs a real TLD label
  const isLocal = /^localhost$/i.test(host);
  if (!dotted && !isLocal) return null;
  return { origin: u.origin, label: host.replace(/^www\./, '') };
}

/** One connection: `{ origin, label }`. origin REQUIRED (it IS the connection); label defaults to the origin. PURE. */
function normalizeConnection(value) {
  const v = (value && typeof value === 'object') ? value : null;
  const origin = _str(v && v.origin);
  if (!origin) return null;
  return { origin, label: _str(v && v.label) || origin };
}

/** Normalize + dedup a connection LIST by origin (first wins). PURE. */
function dedupConnections(list) {
  const out = []; const seen = new Set();
  for (const c of (Array.isArray(list) ? list : [])) {
    const n = normalizeConnection(c);
    if (!n || seen.has(n.origin)) continue;
    seen.add(n.origin); out.push(n);
  }
  return out;
}

/**
 * Normalize a slot VALUE by kind. PURE. Returns the cleaned value, or null when unbound (so a malformed bind can't
 * corrupt the spec).
 *   connections → [{origin,label}]  (the accumulator; accepts an array or a single conn to seed; null = empty/unbound)
 *   shape       → { mode∈SHAPE_MODES, subAgents:bool, cadence:string|null }
 */
export function normalizeSlotValue(kind, value) {
  if (kind === 'connections') {
    const arr = Array.isArray(value) ? value : (value != null ? [value] : []);
    const deduped = dedupConnections(arr);
    return deduped.length ? deduped : null;                  // empty = unbound (uniform with the slot model)
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
 * Derive the setup checklist for an app definition. PURE.
 * `connections` is REQUIRED and starts empty (the only prompted slot, looped sequentially); `shape` is PRE-BOUND from
 * the archetype template. Existing session-ride connections become the connections slot's reuse `candidates`.
 * @returns {{ appId:string, archetype:string|null, done:boolean, slots:Array }}
 */
export function buildSetupSpec(def, { connections = [] } = {}) {
  const d = (def && typeof def === 'object') ? def : {};
  const appId = _str(d.id) || _str(d.appId);
  const archetype = ARCHETYPES.includes(d.archetype) ? d.archetype : null;
  const slots = [
    { key: 'connections', kind: 'connections', required: true, value: null, candidates: dedupConnections(connections),
      prompt: 'Which site should this app work on? Sign in to it in a tab, then pick it here — add as many as it needs.' },
    { key: 'shape', kind: 'shape', required: false, value: archetypeShape(archetype), candidates: [],
      prompt: 'How should it run?' },
  ];
  return { appId, archetype, done: false, slots };
}

/** Normalize / rehydrate a persisted spec: migrate the legacy single `target` slot → `connections`, drop junk,
 *  re-normalize values + candidates, preserve the `done` finish flag. PURE. */
export function normalizeSetupSpec(spec) {
  const s = (spec && typeof spec === 'object') ? spec : {};
  const slots = (Array.isArray(s.slots) ? s.slots : [])
    .map((sl) => {
      if (!sl) return null;
      const kind = sl.kind === 'target' ? 'connections' : sl.kind;     // legacy single-target → the accumulator
      if (!SETUP_KINDS.includes(kind)) return null;
      const isConn = kind === 'connections';
      return {
        key: isConn ? 'connections' : (_str(sl.key) || kind),
        kind,
        required: !!sl.required,
        value: sl.value == null ? null : normalizeSlotValue(kind, sl.value),
        candidates: (Array.isArray(sl.candidates) ? sl.candidates : [])
          .map((c) => (isConn ? normalizeConnection(c) : normalizeSlotValue(kind, c))).filter(Boolean),
        prompt: _str(sl.prompt),
      };
    })
    .filter(Boolean);
  return { appId: _str(s.appId), archetype: ARCHETYPES.includes(s.archetype) ? s.archetype : null, done: !!s.done, slots };
}

/** The bound connections (the accumulator), in order. PURE. */
export function connectionsOf(spec) {
  const sl = normalizeSetupSpec(spec).slots.find((x) => x.kind === 'connections');
  return (sl && Array.isArray(sl.value)) ? sl.value : [];
}

/**
 * Append a (live-verified) connection to the set — dedup by origin. PURE, copy-on-write. A bad conn is ignored. This
 * is the sequential-setup bind AND the post-setup accretion path (same mechanism).
 */
export function addConnection(spec, conn) {
  const s = normalizeSetupSpec(spec);
  const n = normalizeConnection(conn);
  if (!n) return s;
  const slots = s.slots.map((sl) => (sl.kind !== 'connections' ? sl
    : { ...sl, value: dedupConnections([...(sl.value || []), n]) }));
  return { ...s, slots };
}

/** Remove a connection by origin. PURE, copy-on-write. (Post-setup "disconnect"; never empties below the floor here —
 *  the floor is enforced at completion via isSetupComplete.) */
export function removeConnection(spec, origin) {
  const key = _str(origin);
  const s = normalizeSetupSpec(spec);
  const slots = s.slots.map((sl) => (sl.kind !== 'connections' ? sl
    : { ...sl, value: ((sl.value || []).filter((c) => c.origin !== key)).length ? (sl.value || []).filter((c) => c.origin !== key) : null }));
  return { ...s, slots };
}

/** Signal the user finished adding sites (the sequential-setup "done"). PURE. Only completes setup with ≥1 connection. */
export function markSetupDone(spec, done = true) {
  return { ...normalizeSetupSpec(spec), done: !!done };
}

/**
 * Bind a value to a slot — returns a NEW spec (pure, copy-on-write). For `connections` this REPLACES the set (use
 * `addConnection` for the sequential append); used for `shape` overrides + AS-3 edits. A bad value / unknown key is a
 * no-op so a malformed bind can't corrupt the spec.
 */
export function bindSlot(spec, key, value) {
  const s = normalizeSetupSpec(spec);
  const k = _str(key);
  let touched = false;
  const slots = s.slots.map((sl) => {
    if (sl.key !== k) return sl;
    const v = normalizeSlotValue(sl.kind, value);
    if (v == null) return sl;
    touched = true;
    return { ...sl, value: v };
  });
  return touched ? { ...s, slots } : s;
}

/** The next REQUIRED + unbound slot (the first prompt). PURE. Null once `connections` has ≥1 entry (then the live flow
 *  runs the sequential "add another / done" loop until markSetupDone). */
export function nextUnboundSlot(spec) {
  return normalizeSetupSpec(spec).slots.find((sl) => sl.required && sl.value == null) || null;
}

/** Is setup complete? PURE. ≥1 bound connection AND the user signaled done (the sequence is finished). */
export function isSetupComplete(spec) {
  const s = normalizeSetupSpec(spec);
  return !!s.done && connectionsOf(s).length > 0;
}

/**
 * Collapse a COMPLETED spec into the config patch AS-3 banks. PURE. Returns null if incomplete. Shape:
 *   { connections:[{origin,label}], target:{origin,label}, allowedOrigins:[origin…], shape:{…} }
 * `connections` is the set; `target` = the PRIMARY connection (kept for back-compat readers — id/label/isConfiguredDef);
 * `allowedOrigins` is the derived SCOPE fence over ALL connection origins (§6A). No `focus` — learned at runtime.
 */
export function specToConfig(spec) {
  const s = normalizeSetupSpec(spec);
  if (!isSetupComplete(s)) return null;
  const byKey = Object.fromEntries(s.slots.map((sl) => [sl.key, sl.value]));
  const connections = connectionsOf(s);
  return {
    connections,
    target: connections[0] || null,
    allowedOrigins: connections.map((c) => c.origin),
    shape: byKey.shape || archetypeShape(s.archetype),
  };
}
