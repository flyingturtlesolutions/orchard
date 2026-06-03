// Core/orchTurn.js — ORCH-C core: map a matcher decision into the assistant's TURN PLAN.
//
// The chat shell's brain, factored out of rendering. PURE (no DOM / chrome / LLM): it turns a Core/orchMatch
// decision into { what to SAY, what ACTION the shell should take }. The shell renders `say` and wires the
// `action` (run a grounded capability, confirm an irreversible/low-confidence one, disambiguate, suggest a
// navigate, or ask for a demonstration). The matcher's `reason` codes drive BOTH the copy and the action —
// the funnel's internals are directly the UX (docs/DESIGN_intent_orchestration.md §3–§4).
//
// Keeping this pure means the assistant's conversational logic is unit-testable without a live page or DOM,
// and any chat surface (the existing chat.js, a future mode) consumes the same brain.
//
// @module Core/orchTurn
// @version 2.74.665

const _q = (s) => `“${String(s == null ? 'that' : s).trim() || 'that'}”`;   // “…”

/**
 * Plan the assistant's response to a matcher decision. PURE.
 * @param {object} match  a Core/orchMatch result: { decision:'auto'|'propose'|'miss', reason, candidate,
 *                         capabilityId, alternatives[], scoped:{here,reachable,off} }
 * @returns {{ action:'run'|'confirm'|'disambiguate'|'navigate'|'record', say:string, reason:string,
 *             capabilityId?:string, params?:object[], options?:object[], irreversible?:boolean }}
 *   - run         → fire REPLAY_SG_CAPABILITY now (auto-fire; reversible + confident)
 *   - confirm     → one-tap "try it?" (low-confidence) or "can't be undone" (irreversible) before REPLAY
 *   - disambiguate→ offer `options` (two close contenders)
 *   - navigate    → the capability exists but on another Locale of this Ground
 *   - record      → MISS: ask for a demonstration (start the OBS recorder)
 */
export function planAssistantTurn(match) {
  const d = match || {};
  const cap = d.candidate || null;
  const name = cap ? (cap.intent || 'that') : 'that';
  const params = (cap && Array.isArray(cap.params)) ? cap.params : [];
  const reason = d.reason || '';

  if (d.decision === 'auto') {
    return { action: 'run', reason, capabilityId: d.capabilityId || (cap && cap.id) || null, params, say: `Okay — running ${_q(name)}.` };
  }

  if (d.decision === 'propose') {
    if (reason === 'ambiguous') {
      const options = (d.alternatives || []).slice(0, 3);
      const list = options.map((o) => _q(o && o.intent)).join(' or ');
      return { action: 'disambiguate', reason, options, say: list ? `Did you mean ${list}?` : 'Which one did you mean?' };
    }
    if (reason === 'irreversible-confirm') {
      return { action: 'confirm', reason, capabilityId: d.capabilityId || (cap && cap.id) || null, params, irreversible: true, say: `This will ${_q(name)}, which can't be undone. Want me to go ahead?` };
    }
    return { action: 'confirm', reason, capabilityId: d.capabilityId || (cap && cap.id) || null, params, say: `I think ${_q(name)} covers this — want me to try it?` };
  }

  // MISS — distinguish "exists elsewhere on this site" from "nothing here / nothing at all".
  const reachable = !!(d.scoped && d.scoped.reachable > 0);
  if (reachable && reason !== 'no-capability') {
    return { action: 'navigate', reason, say: `I know how to do that — but it lives on another part of the site, not this page. Want to head there?` };
  }
  if (reason === 'no-capability') {
    return { action: 'record', reason, say: `I don't have anything for this site yet — can you show me how?` };
  }
  return { action: 'record', reason, say: `I don't know how to do that here yet — can you show me?` };
}
