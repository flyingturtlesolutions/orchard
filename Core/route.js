// Core/route.js — LLM-front-door router cascade (DESIGN_llm_front_door.md §3.2). R-1.
//
// PURE control flow: no chrome / DOM / LLM / storage. The alias lookup, tool retrieval, and the LLM
// router call are INJECTED as async deps, so the cascade is unit-testable with mocks (same pattern as
// Core/orchRun's exec interface). Cheapest-first:
//   Tier-0  exact-alias short-circuit (deterministic, NO LLM)
//   Tier-1  retrieve a small candidate set (never dump-all) -> LLM select + parameterize -> validate
//   -> a RouteDecision the chat entry dispatches: replay | primitive | demonstrate | decompose | clarify
//
// This module only DECIDES; it never executes the DOM and never bypasses the downstream trial/verify
// gate that bounds every cold selection. Anti-hallucination: a selected tool MUST be one we offered.

const _clamp01  = (n) => { const x = Number(n); return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0; };
const _normAsk  = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
// A tool's stable key: a saved capability's id, a primitive's op, or (last resort) its name.
const _toolKey  = (c) => (c && (c.capabilityId || c.op || c.name)) || null;

/**
 * @typedef {Object} RouteDecision
 * @property {'replay'|'primitive'|'demonstrate'|'decompose'|'clarify'} action
 * @property {Object|null} tool        the selected tool (a saved capability or a primitive descriptor)
 * @property {Object} params           parameters the LLM bound from the ask
 * @property {number} confidence       0..1
 * @property {string} reason           why this route (for the decisions log)
 * @property {boolean} [lowConfidence] confidence < minConfidence (caller may choose to confirm)
 * @property {Array<Object>} [candidates] the retrieved palette (transparency / clarify)
 * @property {Array<string>} [subAsks]    decompose sub-asks
 */

/**
 * Route an ask through the cascade. PURE — all I/O via injected async deps (any may be absent).
 * @param {string} ask
 * @param {{
 *   lookupAlias?:   (normAsk:string)=>Promise<{capabilityId:string,name?:string}|null>,
 *   retrieveTools?: (ask:string, k:number)=>Promise<Array<object>>,
 *   callRouter?:    (args:{ask:string, tools:Array<object>})=>Promise<object|null>,
 * }} [deps]
 * @param {{ k?:number, minConfidence?:number }} [opts]
 * @returns {Promise<RouteDecision>}
 */
export async function route(ask, deps = {}, opts = {}) {
  const { lookupAlias, retrieveTools, callRouter } = deps || {};
  const k = Number.isFinite(opts.k) ? opts.k : 8;
  const minConfidence = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0.4;

  const norm = _normAsk(ask);
  if (!norm) return { action: 'clarify', tool: null, params: {}, confidence: 0, reason: 'empty-ask' };

  // ── Tier-0 — exact-alias short-circuit (deterministic, NO LLM, zero cost) ──
  if (typeof lookupAlias === 'function') {
    let hit = null;
    try { hit = await lookupAlias(norm); } catch { hit = null; }
    if (hit && hit.capabilityId) {
      return { action: 'replay', tool: { kind: 'capability', capabilityId: hit.capabilityId, name: hit.name ?? null },
               params: {}, confidence: 1, reason: 'alias-hit' };
    }
  }

  // ── Tier-1 — retrieve a small candidate set (never dump-all), then LLM select + parameterize ──
  let candidates = [];
  if (typeof retrieveTools === 'function') {
    try { const r = await retrieveTools(ask, k); if (Array.isArray(r)) candidates = r; } catch { candidates = []; }
  }
  if (typeof callRouter !== 'function') {
    // No router available — honest fallback; the caller decides (deterministic match or ask the user).
    return { action: 'clarify', tool: null, params: {}, confidence: 0, reason: 'no-router', candidates };
  }
  let out = null;
  try { out = await callRouter({ ask, tools: candidates }); } catch { out = null; }
  if (!out || typeof out !== 'object') {
    return { action: 'clarify', tool: null, params: {}, confidence: 0, reason: 'router-failed', candidates };
  }

  const confidence = _clamp01(out.confidence);
  const params = (out.params && typeof out.params === 'object') ? out.params : {};

  // Compound branch — gate the cross-site / workflow path behind an EXPLICIT decompose signal. Checked
  // BEFORE the gap branch: a decompose plan legitimately carries no single top-level tool (tool == null).
  if (out.needs_decompose === true) {
    return { action: 'decompose', tool: null, params, confidence, reason: out.reason || 'compound',
             subAsks: Array.isArray(out.subAsks) ? out.subAsks.map(String) : [], candidates };
  }
  // Gap branch — the LLM has no suitable tool -> demonstrate / run a trial.
  if (out.needs_demonstration === true || out.tool == null) {
    return { action: 'demonstrate', tool: null, params, confidence, reason: out.reason || 'no-tool', candidates };
  }
  // Anti-hallucination — the selected tool MUST be one we actually offered (else demonstrate, don't dispatch).
  const ref = (typeof out.tool === 'string') ? out.tool : _toolKey(out.tool);
  const selected = candidates.find((c) => _toolKey(c) === ref) || null;
  if (!selected) {
    return { action: 'demonstrate', tool: null, params, confidence, reason: 'tool-not-in-palette', candidates };
  }
  const action = (selected.kind === 'primitive' || selected.op) ? 'primitive' : 'replay';
  return { action, tool: selected, params, confidence, reason: out.reason || `select:${action}`,
           lowConfidence: confidence < minConfidence, candidates };
}
