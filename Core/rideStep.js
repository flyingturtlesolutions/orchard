// Core/rideStep.js — CD-1a (DESIGN_cadence.md §9.4 / §2.2): the SHARED pinned-ride / nav STEP primitive.
//
// §9.4's rule for CD-1a phase 2: the panel driver and the SW driver "must be ONE module with two reporters, never
// two implementations." The clause LOOP is Core/runDriver.runWorkflow; THIS is the other half — the per-step
// execution of the subset both hosts run identically (a step pinned to a ride leg, or a nav). The SW scheduler
// (background/handlers/cadence.js) and the panel's tier-'sw' workflow replay both call `runRideStep`, so the
// resolution → leg → INVOKE_SESSION path exists once, not twice.
//
// PURE decision + injected IO (readRecipes / invoke / the reporter's gate) — the runUpsert / branchClause pattern.
// Returns the runDriver runStep contract: { ok, value?, park?, parkedRunId?, error? }.

import { recipeToLeg } from './connectorLeg.js';
import { canonicalAppForHost } from './connectorRecipes.js';
import { planExec } from './execPlan.js';
import { armable } from './rideRecipe.js';
import { eachSweptParam, hasEachSentinel, runEachSweep } from './rideEach.js';   // v2.74.2047 — the SW-side EACH sweep

// v2.74.2045 — hop-2 parity for the DIRECT projection. A seeded per-Ground record (recipeFromCatalogEntry)
// stores no `app`, and recipeToLeg — the single field-reader — refuses a record without one. The panel never
// noticed: it reads through harvestedRecipeLegs, which defaults app/origin before projecting
// (connectorRecipes.js:1278). This runner called recipeToLeg raw, so EVERY curated seeded recipe failed
// `no-leg` on the clock while the same record ran fine in the panel (live 2026-08-06 14:00Z:
// `STEP ▸ 1/3 connector cap=vs_warranty_tasks → fail(no-leg)` on each scheduled fire). Invariant-#3 shape:
// a projection hop that bypasses hop 2's defaulting.
function _projectLeg(rec, groundId) {
  return recipeToLeg(
    { ...rec, app: rec.app || canonicalAppForHost(rec.origin || rec.appHost || ''), groundId },
    { account: 'me', trusted: true },
  );
}
// v2.74.2047 — exported for every OTHER SW-side projection (headlessMap's target leg, headlessWrite's create
// leg, cadence's lastLeg threading): each of them called recipeToLeg raw and inherited the same seeded-record
// no-leg class this helper closed in v2045. One projection, everywhere the SW projects.
export const projectRideLeg = _projectLeg;

/**
 * v2.74.2043 — WRITE AUTHORITY, stamped where the decision is actually known. PURE.
 *
 * The executor belt (background/handlers/connector.js, at BOTH INVOKE_SESSION and SESSION_REPLAY) fails closed on
 * any non-GET without proof that something authorized it. Until now the ONLY proof it accepted was `confirmed`,
 * which the panel sets after a human clicks. The consequence was that DESIGN_cadence.md §8's product ruling —
 * internal + reversible writes complete unattended — was not executable at all: Core/headlessWrite computed
 * gate-`auto`, invoked, and got `write-needs-confirm` back, which it tallied as `failed`.
 *
 * The fix is deliberately NOT "set confirmed:true from the clock". Two distinct authorities exist and the audit
 * trail must keep them apart, because they answer different questions after the fact ("who approved this?"):
 *   · `confirmed`   — a PERSON approved THIS write. Only ever set by a human-facing surface.
 *   · `gateCleared` — Core/pipelineGate returned `auto` for this leg: internal, reversible, declared. No person.
 * Collapsing the second into the first would make every unattended write indistinguishable from a click.
 *
 * FAIL-CLOSED, and the reason this lives in one function: a caller that cannot produce a gate verdict cannot
 * produce a write. Only the literal verdict `auto` stamps; every other decision (queued/refused/absent/malformed)
 * stamps nothing and the belt refuses downstream. `humanApproved` outranks the gate — an approved queued write is
 * a human's act, and is recorded as one.
 *
 * @param {object} payload            the planExec INVOKE_SESSION payload
 * @param {{gate?:{decision:string}|null, humanApproved?:boolean}} authority
 * @returns {object} a NEW payload (never mutates the plan's)
 */
export function stampWriteAuthority(payload, { gate = null, humanApproved = false } = {}) {
  const p = (payload && typeof payload === 'object') ? { ...payload } : {};
  // never let a caller smuggle authority in through the params/plan
  delete p.confirmed; delete p.gateCleared;
  if (humanApproved === true) { p.confirmed = true; return p; }
  if (gate && typeof gate === 'object' && gate.decision === 'auto') { p.gateCleared = true; return p; }
  return p;
}

const _pinOf = (clause) => {
  const p = clause && (clause.pinned || clause.clause);
  return (p && typeof p === 'object') ? p : null;
};

/**
 * Resolve a pin's capabilityId against stored recipes. Accepts the bare recipe id (SW / map pins) OR a legacy
 * connector leg.key (`me.app.id@host`) that panel qualify historically banked. PURE.
 */
export function findRecipeByCapId(recipes, capabilityId) {
  const capId = String(capabilityId || '').trim();
  if (!capId) return null;
  const list = Array.isArray(recipes) ? recipes : [];
  const byId = list.find((r) => r && r.id === capId);
  if (byId) return byId;
  // legacy: me.<app>.<id>@<host> — id is the segment before @ after the second dot
  const bare = capId.includes('@') ? capId.slice(0, capId.indexOf('@')) : capId;
  const parts = bare.split('.');
  if (parts.length >= 3) {
    const id = parts.slice(2).join('.');   // ids are usually undotted; join keeps odd ids intact
    const hit = list.find((r) => r && r.id === id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Does a pinned clause still resolve? — replayPlan's drift check (§2.1). A ground + capability that reads back an
 * ARMABLE recipe resolves; anything else is drift → the caller STOPS the run rather than re-interpreting prose.
 * A loose (unpinned) step is legitimately resolvable (there is nothing pinned to have drifted). Injected readRecipes.
 * @param {object} clause
 * @param {{ readRecipes:(groundId:string)=>Promise<Array> }} io
 * @returns {Promise<boolean>}
 */
export async function rideStepResolvable(clause, { readRecipes } = {}) {
  const pin = _pinOf(clause);
  if (!pin) return true;
  if (String(pin.kind || '').trim() === 'navigate') return true;
  // v1717 — MIRROR chat.js `_wfReplayPlan`'s rule exactly (§9.4: the panel and SW must hold ONE notion of "a
  // resolvable pin", or replays diverge): a KIND-ONLY pin (fieldRead / branch / map / case — no capabilityId)
  // names no leg, so there is no leg to have drifted; its own drift check happens at RUN time (e.g. the field
  // re-resolves against the actual rows). Only a leg-bearing pin is checked against the recipe store.
  const groundId = pin.groundId, capId = pin.capabilityId;
  if (!capId) return true;
  if (!groundId) return false;   // a leg pin that lost its ground IS drift
  try {
    const recs = (typeof readRecipes === 'function' ? await readRecipes(groundId) : []) || [];
    const rec = findRecipeByCapId(recs, capId);
    // v2.74.2045 — resolvable must include PROJECTION: the drift check answered "fine" (recipe present, armable)
    // while the runner's recipeToLeg immediately failed `no-leg` on the same record — a plan/run disagreement of
    // exactly the vacuity class §2.1 exists to prevent. _projectLeg is the runner's own projection, so the two
    // halves cannot diverge again.
    const leg = (rec && armable(rec)) ? _projectLeg(rec, groundId) : null;
    if (!leg || !leg.tool) return false;
    // v2.74.2047 — and EACH-SWEEPABILITY, the same parity rule one layer up: runRideStep now answers
    // `each-not-sweepable` for a sentinel whose recipe never declared `resolve` + `each:true`, so a drifted
    // each-pin passing this check would re-execute its prefix (including gate-'auto' writes) every due tick
    // until auto-disarm. Judged with the runner's own predicate — the two halves cannot diverge.
    const b = (pin.bindings && typeof pin.bindings === 'object') ? pin.bindings : null;
    if (b && hasEachSentinel(b)) {
      const swept = eachSweptParam(leg, b);
      if (swept && !swept.sweepable) return false;
    }
    return true;
  } catch { return false; }
}

/**
 * Run ONE pinned-ride / nav step.
 *
 * - a NAV step is a no-op success (the ride's ephemeral tab carries its own URL);
 * - a pinned READ ride resolves → leg → INVOKE_SESSION through the injected `invoke`;
 * - a WRITE (writePolicy has no 'auto' — safetyClass !== 'auto', or rec.write) consults the reporter's gate: it
 *   PARKS unless the gate returns `true` (§8). The SW reporter's gate returns 'park'; a panel reporter can approve
 *   live. No reporter ⇒ 'park' (fail safe — nobody is watching).
 *
 * @param {object} clause  a replayPlan clause carrying `.pinned` ({kind, capabilityId, groundId})
 * @param {{ readRecipes:Function, invoke:Function, reporter?:object, runId?:string, workflowId?:string, onEach?:Function }} io
 *        `onEach(done, total, label)` — per-completion progress of an each SWEEP (v2.74.2047); the cadence host
 *        uses it to keep the in-flight run marker alive across a long fan. Never called outside a sweep.
 * @returns {Promise<{ok?:boolean, value?:*, park?:boolean, parkedRunId?:string, error?:string, each?:object}>}
 */
export async function runRideStep(clause, { readRecipes, invoke, reporter = null, runId = '', workflowId = '', onEach = null } = {}) {
  const pin = _pinOf(clause);
  const kind = String((pin && pin.kind) || '').trim();
  if (kind === 'navigate' || (!pin && /navigate/i.test((clause && clause.text) || ''))) return { ok: true, value: null };

  const groundId = pin && pin.groundId;
  const capId = pin && pin.capabilityId;
  if (!groundId || !capId) return { ok: false, error: 'unpinned-step' };

  let recs = [];
  try { recs = (typeof readRecipes === 'function' ? await readRecipes(groundId) : []) || []; } catch { recs = []; }
  const rec = findRecipeByCapId(recs, capId);
  if (!rec) return { ok: false, error: 'recipe-gone' };
  if (!armable(rec)) return { ok: false, error: 'not-armed' };

  const isWrite = rec.write === true || (rec.safetyClass && rec.safetyClass !== 'auto');
  let humanApproved = false;   // v2.74.2044 — set only when the reporter's gate cleared THIS write (a person)
  if (isWrite) {
    const decision = (reporter && typeof reporter.gate === 'function')
      ? await reporter.gate({ workflowId, step: clause && clause.text, recipe: rec.name || capId, groundId })
      : 'park';
    if (decision !== true) return { park: true, parkedRunId: runId };
    // v2.74.2044 — a gate `true` IS a human's act (the panel confirm bar; makeResumeReporter's one-approval
    // contract, Core/runDriver.js:148-151), and it must ride to the executor belt as `confirmed`
    // (stampWriteAuthority). Pre-2044 this was dropped here, so an approved resume invoked with NO authority,
    // the belt refused `write-needs-confirm`, and the run re-parked — every approval silently discarded.
    // Mirrors Core/headlessWrite.js's v2043 wiring. No `gate` threads here: runRideStep has no pipelineGate
    // path — every write consults the reporter (the unattended gate-'auto' door is scoped to headlessWrite).
    humanApproved = true;
  }

  const params = (pin && pin.bindings && typeof pin.bindings === 'object') ? pin.bindings : null;

  // v2.74.2047 — the EACH SWEEP (Core/rideEach.js): an each-swept READ now runs the fan-out the v2046 tier
  // demotion honestly declared missing, instead of dropping the sentinel (v1730) into a `needs-<param>` refusal
  // or a silent default-scope read. READS ONLY — a write parked above before bindings were read, and
  // runEachSweep refuses non-'ask' legs anyway. The exact token 'each' on a param whose recipe never declared
  // `resolve` + `each:true` is answered HONESTLY (`each-not-sweepable`, a non-transient failure that accrues
  // disarm strikes) rather than dropped: the tier promotes on the PIN alone (it cannot see the recipe), so THIS
  // is where that residue fails closed. Off-axis 'all'/'every' literals fall through untouched (eachSweptParam
  // returns null) — they are legitimate VALUES, not axes.
  if (!isWrite && hasEachSentinel(params)) {
    const leg = _projectLeg(rec, groundId);
    if (!leg || !leg.tool) return { ok: false, error: 'no-leg' };
    const swept = eachSweptParam(leg, params);
    if (swept && swept.sweepable) return runEachSweep(leg, params, { invoke, onEach });
    if (swept) return { ok: false, error: 'each-not-sweepable' };
  }

  // v1730 — the pin's banked bindings give the headless run its QUALIFIED scope (literal-safe filtered inside).
  return invokeRideRecipe(rec, groundId, { invoke, params, literalSafeParams: true, humanApproved });
}

/**
 * §12 (v1715) — the ONE resolve→plan→invoke: recipe → leg (recipeToLeg) → plan (planExec, INVOKE_SESSION only) →
 * the injected invoke. Both runRideStep AND the vitals canary ride THIS, so the runner exists once — §12.1's
 * recurring-bug argument ("every time this codebase has held two of something that should be one, a defect lived
 * in the gap") applied to the runner itself.
 * @returns {Promise<{ok:boolean, value?:*, error?:string, status?:number|null}>}
 */
export async function invokeRideRecipe(rec, groundId, { invoke, params = null, literalSafeParams = false, gate = null, humanApproved = false } = {}) {
  const leg = _projectLeg(rec, groundId);
  if (!leg || !leg.tool) return { ok: false, error: 'no-leg' };
  // v2.74.1730 — banked bindings ride the headless run, LITERAL-SAFE only: the SW has no ID-resolve layer, so an
  // 'each' sweep value or a resolve-marked param would go into the URL verbatim (the DK-8b http-400 class).
  // Dropping them falls back to the leg's default scope — the pre-1730 behavior, never worse. (v2.74.2047: an
  // each-swept READ never reaches here any more — runRideStep routes it to Core/rideEach.runEachSweep upstream;
  // this filter remains the belt for every OTHER caller — headless map lookups, the vitals canary, writes.)
  let p = (params && typeof params === 'object' && !Array.isArray(params)) ? { ...params } : {};
  if (literalSafeParams) {
    const marked = (leg.tool.resolve && typeof leg.tool.resolve === 'object') ? new Set(Object.keys(leg.tool.resolve)) : new Set();
    for (const k of Object.keys(p)) { if (p[k] === 'each' || marked.has(k)) delete p[k]; }
  }
  const plan = planExec(leg, p, {});
  if (!plan || plan.ok === false || plan.channel !== 'INVOKE_SESSION') return { ok: false, error: 'no-plan' };
  const payload = stampWriteAuthority(plan.payload, { gate, humanApproved });
  let r = null;
  try { r = (typeof invoke === 'function') ? await invoke(payload) : null; } catch (e) { return { ok: false, error: (e && e.message) || 'invoke-threw' }; }
  const ok = !!(r && r.success !== false);
  return ok ? { ok: true, value: (r && r.value), status: (r && r.status) || null }
            : { ok: false, error: (r && r.error) || 'invoke-failed', status: (r && r.status) || null };
}
