// Core/workflowTier.js — CD-1a (DESIGN_cadence.md §4.5 / §11.3): the HEADLESS GATE. A workflow's banked per-step
// provenance → 'sw' | 'panel'. PURE.
//
// The tier answers one question: can the service-worker driver run this whole workflow with the panel shut? It is
// also the honest label §7.3 demands — a tier-'sw' workflow says "runs every 4h", a tier-'panel' one says "due
// every 4h" — so the surface stops lying by construction rather than by wording.
//
// FAIL CLOSED. `via.kind` is NOT a closed enum: stepProvenance copies it verbatim from `ranSteps`, and chat.js
// pushes capability kinds and `null` through _record / _resumeAfterDemo. So an unrecognized kind must default to
// 'panel', never throw and never be switched exhaustively — the invariant §4.5 states in bold.
//
// Phase 1 admits only what the SW can resolve DETERMINISTICALLY, with no routing LLM:
//   · a 'navigate' step (open/ensure a tab), and
//   · a ride/connector step that carries a PINNED clause (kind + a groundId to read the recipe from) — which
//     exists only now that §2.1 lets `steps[].clause` reach storage. A ride with no pinned resolution would need
//     the router to re-interpret it, which is panel-tier work → demote.
// Phase 2 widens the set as each clause runner is extracted into runDriver.

const RIDE_KINDS = new Set(['connector', 'ride']);   // a curated/harvested ride leg — the API-less read/act class

/**
 * One step's tier. PURE. A pinned ride is 'sw'; a nav is 'sw'; a banked FIELD READ is 'sw' when a value-producing
 * ride precedes it (phase 2 extraction 1, v1717 — `ctx.priorRead` says so); everything else → 'panel'.
 */
export function stepTier(step, { priorRead = false } = {}) {
  const s = (step && typeof step === 'object') ? step : {};
  const via = (s.via && typeof s.via === 'object') ? s.via : {};
  const kind = String(via.kind || '').trim();
  if (kind === 'navigate') return 'sw';
  if (RIDE_KINDS.has(kind)) {
    const c = s.clause;
    // a ride is only headless-safe if the SW can resolve it without the router: a pinned clause naming its ground.
    const resolvable = c && typeof c === 'object' && (c.capabilityId || c.kind) && c.groundId;
    return resolvable ? 'sw' : 'panel';
  }
  // CD-1a phase 2, extraction 1 (v1717) — a fieldRead step runs headless (Core/headlessClause.runFieldReadStep)
  // ONLY when (a) its pin BANKED the field phrase (a legacy pin needs the panel's interpreter) and (b) an earlier
  // ride step produces the rows it reads (the own-record subset; the per-item DRILL stays panel). Fail closed.
  if (kind === 'fieldRead') {
    const c = s.clause;
    return (priorRead && c && typeof c === 'object' && c.field) ? 'sw' : 'panel';
  }
  return 'panel';   // fail closed — any kind the SW driver can't run demotes the whole workflow
}

/**
 * The workflow's tier: 'sw' only when EVERY step is headless-safe, else 'panel'. PURE. An empty step list is
 * 'panel' — no proven provenance means no promise the SW can keep. One non-sw step demotes the whole run, because
 * a workflow that runs 3 of 5 steps headless and then needs the panel is a tier-'panel' workflow that lies.
 * Steps are judged IN ORDER: a fieldRead is headless only downstream of a value-producing ride (nav produces none).
 */
export function workflowTier(wf) {
  const steps = Array.isArray(wf && wf.steps) ? wf.steps : [];
  if (!steps.length) return 'panel';
  let priorRead = false;
  for (const s of steps) {
    if (stepTier(s, { priorRead }) !== 'sw') return 'panel';
    const kind = String(((s && s.via) || {}).kind || '').trim();
    if (RIDE_KINDS.has(kind)) priorRead = true;   // a ride READ stocks the chain state a fieldRead consumes
  }
  return 'sw';
}

/** Is this workflow eligible to fire headless on the clock (tier 'sw')? PURE — the scanner's fire/defer branch. */
export function runsHeadless(wf) {
  return workflowTier(wf) === 'sw';
}
