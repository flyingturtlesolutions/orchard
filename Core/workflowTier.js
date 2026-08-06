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
 * ride precedes it (phase 2 extraction 1, v1717 — `ctx.priorRead` says so); a banked WRITE is 'sw' only when a
 * MAP precedes it (`ctx.priorMap`, v2.74.2044 — a ride is not enough, see the write branch); everything else
 * → 'panel'.
 */
export function stepTier(step, { priorRead = false, priorMap = false } = {}) {
  const s = (step && typeof step === 'object') ? step : {};
  const via = (s.via && typeof s.via === 'object') ? s.via : {};
  const kind = String(via.kind || '').trim();
  if (kind === 'navigate') return 'sw';
  if (RIDE_KINDS.has(kind)) {
    const c = s.clause;
    // a ride is only headless-safe if the SW can resolve it without the router: a pinned clause naming its ground.
    const resolvable = c && typeof c === 'object' && (c.capabilityId || c.kind) && c.groundId;
    if (!resolvable) return 'panel';
    // v2.74.2047 — the v2046 'each' demotion is FLIPPED: Core/rideEach.runEachSweep gives the SW the RIDE_EACH
    // fan-out (enumerate from the leg's resolve `via` state → bounded-concurrent per-value invokes → group-tagged
    // {rows} aggregate), so an each-swept READ now fills headless — the demotion's rationale ("the SW invoke
    // DROPS 'each' … and has no fan-out") is gone. RESIDUE, still fail-closed but at RUN time rather than tier
    // time (the tier sees only the PIN, never the recipe, so it cannot tell the cases apart here):
    //   · a hand-forged/drifted pin binding 'each' on a param whose recipe declares no `resolve`+`each:true`
    //     spec — runRideStep answers `each-not-sweepable` (non-transient, accrues disarm strikes) instead of
    //     dropping the sentinel into a wrong-scope read;
    //   · an 'each' binding on a ride whose recipe is a WRITE — runRideStep's write gate parks it before the
    //     bindings are read (a sweep never runs an unattended write).
    return 'sw';
  }
  // CD-1a phase 2, extraction 1 (v1717) — a fieldRead step runs headless (Core/headlessClause.runFieldReadStep)
  // ONLY when (a) its pin BANKED the field phrase (a legacy pin needs the panel's interpreter) and (b) an earlier
  // ride step produces the rows it reads (the own-record subset; the per-item DRILL stays panel). Fail closed.
  if (kind === 'fieldRead') {
    const c = s.clause;
    return (priorRead && c && typeof c === 'object' && c.field) ? 'sw' : 'panel';
  }
  // v2.74.2036 — banked map (target leg + valueParam) after a prior ride; write after a prior MAP (v2.74.2044).
  if (kind === 'map') {
    const c = s.clause;
    const resolvable = priorRead && c && typeof c === 'object'
      && c.capabilityId && c.groundId && c.valueParam;
    return resolvable ? 'sw' : 'panel';
  }
  if (kind === 'write') {
    const c = s.clause;
    // v2.74.2044 — a write needs a prior MAP, not just any read: the SW write runner (Core/headlessWrite
    // .runWriteStep) sources its candidates EXCLUSIVELY from state.lastMisses/lastMapRan/lastMapLookup, which
    // only runMapStep hydrates — a bare ride threads lastValue/lastLeg. Under `priorRead` a ride→write workflow
    // tiered 'sw': the card claimed "runs every N", the panel due-on-open scan skipped it (tier says the SW owns
    // it), and every SW fire ended 'partial' with the write failing 'no-misses' — silently forever ('partial'
    // accrues no disarm strikes). Fail closed to 'panel', where the interpreter can supply what no map banked.
    return (priorMap && c && typeof c === 'object' && (c.capabilityId || c.kind === 'write')) ? 'sw' : 'panel';
  }
  return 'panel';   // fail closed — any kind the SW driver can't run demotes the whole workflow
}

/**
 * The workflow's tier: 'sw' only when EVERY step is headless-safe, else 'panel'. PURE. An empty step list is
 * 'panel' — no proven provenance means no promise the SW can keep. One non-sw step demotes the whole run, because
 * a workflow that runs 3 of 5 steps headless and then needs the panel is a tier-'panel' workflow that lies.
 * Steps are judged IN ORDER: a fieldRead is headless only downstream of a value-producing ride (nav produces none);
 * a write only downstream of a map (v2.74.2044 — only a map hydrates the misses the SW write consumes).
 */
export function workflowTier(wf) {
  return explainTier(wf).tier;
}

/**
 * v2.74.2043 — WHY, not just what. `workflowTier` answers a yes/no that the cadence scanner acts on silently, so a
 * demotion has been indistinguishable from a pin-bank bug in every trace (the v2038–2042 arc re-diagnosed the same
 * class four times). This names the FIRST demoting step and the predicate it failed. PURE — the caller logs it
 * (`TIER ▸`, registered in Core/decisionMarkers.js); Core stays free of Logger.
 *
 * @returns {{tier:string, stepIndex:number, kind:string, why:string}}  stepIndex -1 when tier is 'sw'.
 */
export function explainTier(wf) {
  const steps = Array.isArray(wf && wf.steps) ? wf.steps : [];
  if (!steps.length) return { tier: 'panel', stepIndex: -1, kind: '', why: 'no banked steps — nothing proves the SW can run it' };
  let priorRead = false;
  let priorMap = false;   // v2.74.2044 — the write gate tracks maps separately (only a map stocks lastMisses)
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const kind = String(((s && s.via) || {}).kind || '').trim();
    if (stepTier(s, { priorRead, priorMap }) !== 'sw') {
      return { tier: 'panel', stepIndex: i, kind: kind || '(none)', why: _whyPanel(s, kind, priorRead, priorMap) };
    }
    if (RIDE_KINDS.has(kind) || kind === 'map') priorRead = true;   // ride/map stock rows for fieldRead
    if (kind === 'map') priorMap = true;                            // map alone stocks misses for write (v2.74.2044)
  }
  return { tier: 'sw', stepIndex: -1, kind: '', why: 'every step is pinned and headless-safe' };
}

/** The failed predicate, in the vocabulary of the pin that would fix it. PURE. */
function _whyPanel(step, kind, priorRead, priorMap) {
  const c = (step && step.clause && typeof step.clause === 'object') ? step.clause : null;
  const missing = (...names) => names.filter((n) => !c || !c[n]).join('+');
  if (!kind) return 'step banked no via.kind';
  if (RIDE_KINDS.has(kind)) {
    if (!c) return 'ride step has no pinned clause — the router would have to re-interpret it';
    // v2.74.2047 — the v2046 "sweeps an 'each' param" arm is gone: an each-swept ride is 'sw' again
    // (Core/rideEach.runEachSweep), so a missing pin field is the only ride demotion left.
    return `ride pin missing ${missing('groundId') || 'capabilityId/kind'}`;
  }
  if (kind === 'fieldRead') {
    if (!priorRead) return 'fieldRead with no value-producing ride before it';
    return 'fieldRead pin banked no field phrase';
  }
  if (kind === 'map') {
    if (!priorRead) return 'map with no value-producing ride before it';
    return `map pin missing ${missing('capabilityId', 'groundId', 'valueParam') || 'fields'}`;
  }
  if (kind === 'write') {
    if (!priorMap) return 'write with no prior map to supply misses';   // v2.74.2044 — a bare ride does not qualify
    return 'write pin banked no capabilityId';
  }
  return `kind '${kind}' has no headless runner (fail-closed)`;
}

/** Is this workflow eligible to fire headless on the clock (tier 'sw')? PURE — the scanner's fire/defer branch. */
export function runsHeadless(wf) {
  return workflowTier(wf) === 'sw';
}
