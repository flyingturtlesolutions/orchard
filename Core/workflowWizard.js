// Core/workflowWizard.js — WW-1 (v2.74.1610, DESIGN_workflow_wizard.md §2/§3/§9/§10): the ＋ Workflow wizard's
// PURE logic. No DOM / chrome / LLM / storage (chat.js renders + drives _orchRunChain; this decides).
//
// The empirical model (§0 ruling 1): a step is RUN, the user approves/declines the RESULT. This module maps a run
// result → an outcome CLASS (so chat.js routes to the right prompt), bridges a chain `ranStep` → body-blind
// provenance, computes the capture/qualify SPLIT suggestions (§10.C), and assembles the save payload. All tested.

import { armTrigger } from './trigger.js';

const _str = (x) => String(x == null ? '' : x).trim();

// ── §3 — the outcome classifier. Reuses the vitals AUTH vocabulary for the transient class (signed-out / session
// / csrf-not-ready — a retry-after-signin fixes it), and the router's honest-gap markers for can't-engage. A run
// that COMPLETED is always 'completed' — the HUMAN judges the result (approve/decline), never a predicted score.
const _TRANSIENT_RE = /signed?[\s-]?out|session[\s-]?expired|not[\s-]?logged[\s-]?in|no[\s-]?session|reauth|csrf|token|401|403|429|rate[\s-]?limit|network|timeout|timed?[\s-]?out|5\d\d/i;
const _GAP_RE = /no[\s-]?(?:leg|capability|match|candidate|way|tool)|op-not-captured|not[\s-]?(?:mapped|captured|armed)|don'?t[\s-]?have|do[\s-]?not[\s-]?have|teach|show[\s-]?me|needs[\s-]?(?:teaching|a[\s-]?leg)/i;

/**
 * Map a step's run RESULT to an outcome class. PURE.
 * @param {{ ok?:boolean, error?:string, status?:number|null, gapKind?:string|null, decomposed?:boolean }} r
 * @returns {'completed'|'split-suggested'|'transient'|'cant-engage'|'hard-fail'}
 */
export function classifyStepOutcome(r = {}) {
  const { ok = false, error = '', status = null, gapKind = null, decomposed = false } = r || {};
  if (decomposed) return 'split-suggested';         // the front door split the step into a mini-chain (§10.C intent split)
  if (ok) return 'completed';                        // ran — the user judges it
  const e = String(error || '');
  if (gapKind) return 'cant-engage';                 // the router named a gap explicitly
  if (status === 401 || status === 403 || status === 429) return 'transient';
  if (_GAP_RE.test(e)) return 'cant-engage';         // honest gap → "show me" (§2)
  if (_TRANSIENT_RE.test(e)) return 'transient';     // auth/rate/net → reason + retry (§2)
  return 'hard-fail';
}

/** Is a class one that should PROMPT to teach (decline path / can't-engage → "show me")? PURE. */
export function outcomeWantsTeach(cls) { return cls === 'cant-engage'; }
/** Is a class a soft, retry-worthy failure (surface a reason, offer retry — never teach)? PURE. */
export function outcomeIsTransient(cls) { return cls === 'transient'; }

/**
 * Which BAR does a finished run get? PURE. v2.74.1688.
 *
 * The wizard's page had three classes and needed four. All of `transient`, `nothing-to-do` and `cant-engage` share
 * `engaged === false` — no `ranStep` was pushed — but only ONE of them is a failure, and the page was treating the
 * absence of a ranStep as proof of one.
 *
 * Live: step 1 "get all new warranty requests" banked with 0 rows (there genuinely were none), step 2 correctly hit
 * the empty-prior stop, and the page rendered *"That step couldn't run — Teach it with a quick demo"* over a step
 * that had worked perfectly. Offering to teach a working capability is worse than saying nothing: it tells the
 * person the system is broken, and invites them to spend minutes demonstrating something already learned.
 *
 * ORDER IS LOAD-BEARING — the three `engaged:false` classes must be tested most-specific first, because the
 * fallback is the failure. This is the §5.5 "name every class including the zeroes" rule applied to outcomes: an
 * empty result is a class, not the absence of one.
 */
export function stepBarClass({ phase = '', engaged = null, transient = false, nothingToDo = false } = {}) {
  if (phase === 'running') return 'running';
  if (phase !== 'ran') return 'idle';
  if (engaged === false && transient) return 'transient';       // signed out — sign in, then retry
  if (engaged === false && nothingToDo) return 'nothing-to-do';  // ran, and the right answer was nothing
  if (engaged === false) return 'cant-engage';                   // genuinely never ran — the ONLY teach door
  return 'completed';                                            // a result for the human to judge
}

/** Only a genuine can't-engage earns the teach door. PURE — the guard against re-collapsing the four classes. */
export function barWantsTeach(bar) { return bar === 'cant-engage'; }

// ── the chain→record bridge: a `st.ranSteps` entry ({capabilityId, kind, clause, intent, groundId?}) → the
// body-blind provenance the workflow record stores (§10.A / §11: method is DISPLAY, never a binding; NO values).
/**
 * @param {object} ranStep   a chat.js chain `st.ranSteps` entry
 * @param {string} stepText  the wizard step's text (authoritative label)
 * @param {string} [host]    the resolved host, if known
 * @returns {{text:string, via:{kind:string|null,host:string|null,name:string|null}, bankedAt:number}}
 */
export function stepProvenance(ranStep, stepText, host = '', now = 0) {
  const r = (ranStep && typeof ranStep === 'object') ? ranStep : {};
  const kind = _str(r.kind) || null;                                  // 'ride'|'drive'|'navigate'|'fanout'|capability-kind
  const name = _str(r.intent) || _str(r.clause) || null;             // a human label, NOT a captured value
  const out = { text: _str(stepText) || _str(r.clause), via: { kind, host: _str(host) || null, name: name ? name.slice(0, 80) : null }, bankedAt: Number.isFinite(now) ? now : 0 };
  // PP-0c (v2.74.1666, DESIGN_peritem_pipeline.md §8.3) — BANK THE RESOLUTION, not only the phrasing.
  //
  // §8.1's finding: all three replay sites do `wf.subAsks.map((t) => ({ text: t }))`, so `subAsks` are STRINGS
  // and replay RE-INTERPRETS PROSE every run. `steps[]` records the resolution site already, but nothing reads
  // it at replay time — it is display and audit only. Direct evidence that this is not theoretical: the ask
  // "for each result, read task instructions" classified as `fieldread` in one trace and `decompose` in another.
  // Same words, different plan. A workflow banked on the first would silently take the second path later.
  //
  // What is pinned is the PLAN (which leg / which clause kind), never captured VALUES — §11's body-blind rule is
  // unchanged, and this adds no new data to the record beyond what `via` already implies.
  const pin = pinnedClause(r);
  if (pin) out.clause = pin;
  return out;
}

/**
 * The resolvable half of a `ranSteps` entry — what the step RESOLVED TO, as opposed to what it was called.
 * Returns null when the step engaged nothing worth pinning (a nav, a miss), which is a legitimate absence:
 * §8.4 notes not every step type has a clause form, and the record must say WHICH rather than leave a reader
 * to guess.
 */
export function pinnedClause(ranStep) {
  const r = (ranStep && typeof ranStep === 'object') ? ranStep : null;
  if (!r) return null;
  const kind = _str(r.kind);
  const capabilityId = _str(r.capabilityId);
  if (!kind && !capabilityId) return null;
  return {
    kind: kind || null,
    capabilityId: capabilityId || null,
    ...(r.groundId ? { groundId: _str(r.groundId) } : {}),
    // CD-1a phase 2 (v1717) — a fieldRead pin banks the RESOLVED field phrase (+ optional term): schema NAMES,
    // never values, so §11's body-blind rule holds. This is what lets the step run headless — run time re-resolves
    // the phrase against the actual rows and stops honestly on drift/ambiguity (Core/headlessClause).
    ...(kind === 'fieldRead' && _str(r.field) ? { field: _str(r.field).slice(0, 80), ...(_str(r.term) ? { term: _str(r.term).slice(0, 80) } : {}) } : {}),
  };
}

// ── §10.C — SPLIT suggestions. TARGET split is capture-time (deterministic, from the resolver's system tokens);
// INTENT split is qualify-time (the front door's decompose verdict). Both PURE — chat.js supplies the inputs.
/**
 * Capture-time TARGET split: does one step name ≥2 distinct systems? PURE.
 * @param {string[]} systemTokens  distinct connector-system tokens the resolver found in the step (already deduped)
 * @returns {{split:boolean, systems:string[]}}
 */
export function targetSplitSuggestion(systemTokens) {
  const sys = [...new Set((Array.isArray(systemTokens) ? systemTokens : []).map((s) => _str(s).toLowerCase()).filter(Boolean))];
  return { split: sys.length >= 2, systems: sys };
}
/**
 * Qualify-time INTENT split: the front door returned a decompose verdict → adopt its sub-asks as steps. PURE.
 * @param {string[]} decomposeSubAsks  the verdict's subAsks
 * @returns {{split:boolean, steps:string[]}}
 */
export function intentSplitSuggestion(decomposeSubAsks) {
  const steps = (Array.isArray(decomposeSubAsks) ? decomposeSubAsks : []).map(_str).filter(Boolean);
  return { split: steps.length >= 2, steps };
}

// ── the save payload (§2.4 / §10.E). `ask` = the UMBRELLA INTENT (recall matches it), NOT the name. `subAsks` =
// the step texts. `steps` = the provenance array. status:'ready' only when EVERY step is approved.
/**
 * @param {{ ask?:string, name?:string, steps?:Array<{text:string, approved?:boolean, provenance?:object}> }} w
 * @param {number} [now]
 * @returns {{ ask:string, name:string|null, subAsks:string[], steps:Array, status:'ready'|'draft', qualifiedAt:number }|null}
 */
export function buildWorkflowSave(w, now = 0) {
  const steps = Array.isArray(w && w.steps) ? w.steps : [];
  const subAsks = steps.map((s) => _str(s && s.text)).filter(Boolean);
  if (subAsks.length < 2) return null;                               // the store rejects <2 anyway — fail early, honestly
  const allApproved = steps.every((s) => s && s.approved === true);
  const ask = _str(w && w.ask) || _str(w && w.name) || subAsks.join('; ');   // umbrella; last resort is the joined steps
  const payload = {
    ask,
    name: _str(w && w.name) || null,
    subAsks,
    steps: steps.map((s) => (s && s.provenance) ? s.provenance : { text: _str(s && s.text), via: { kind: null, host: null, name: null }, bankedAt: 0 }),
    status: allApproved ? 'ready' : 'draft',
    qualifiedAt: allApproved ? (Number.isFinite(now) ? now : 0) : 0,
    // PP-0c (v2.74.1666) — §8.4's migration note: "a record banked before this change and one banked after are
    // not equally trustworthy, and nothing currently distinguishes them. Consider stamping the schema version
    // rather than inferring from field presence." Inferring from `clause`'s presence would conflate "banked
    // before the feature existed" with "banked after, by a step that legitimately has no clause form".
    schema: WORKFLOW_SCHEMA,
  };
  // CD-6.6 (DESIGN_cadence.md §6.6/§7) — the optional cadence stage arms a trigger AT SAVE. Only a READY workflow
  // (every step approved) can carry an armed cadence — a draft is not schedulable (§7 naming-first + status gate).
  // The honest label (runs vs due) is the tier's job, computed later; here we just arm the field.
  const cadence = Number(w && w.cadenceMinutes);
  if (allApproved && Number.isFinite(cadence) && cadence > 0) {
    const trig = armTrigger(cadence, now);
    if (trig) payload.trigger = trig;
  }
  return payload;
}

/** Record schema. 1 = phrasing only (pre-PP-0c). 2 = steps may carry a pinned `clause`. */
export const WORKFLOW_SCHEMA = 2;

/** Was this record banked before clause-pinning existed? Then a missing clause is EXPECTED, not a drift signal. */
export function isPrePinned(wf) {
  return !wf || Number(wf.schema || 1) < 2;
}

/**
 * PP-0c (v2.74.1666) — build the REPLAY PLAN for a saved workflow. PURE.
 *
 * §8.3: replay prefers the banked clause and falls back to re-interpreting `text` when absent. §10.4 completes
 * that, and the completion is the whole point:
 *
 *   · clause ABSENT (banked before this feature) → fall back to text. Expected, fine, and counted.
 *   · clause PRESENT but NO LONGER RESOLVABLE (the leg was re-declared, the ground disconnected) → **STOP AND
 *     FLAG.** Never silently re-interpret.
 *
 * The second case is the hazard, because the obvious implementation reuses the same fallback for both and that
 * is a fail-open of exactly the v1639 kind: the workflow keeps running and quietly does something else, with no
 * signal. A drift check that can be bypassed by a fallback is not a drift check.
 *
 * @param {object} wf                         the saved workflow record
 * @param {(clause:object) => boolean} canResolve  does this pinned clause still resolve? (injected — the caller
 *                                            owns the palette; this module stays pure)
 * @returns {{clauses:Array, pinned:number, loose:number, stale:Array, runnable:boolean}}
 *          `stale` entries STOP the run; `loose` counts steps replayed from text (expected for old records).
 */
export function replayPlan(wf, canResolve = null) {
  const subAsks = Array.isArray(wf && wf.subAsks) ? wf.subAsks : [];
  const steps = Array.isArray(wf && wf.steps) ? wf.steps : [];
  const clauses = [];
  const stale = [];
  let pinned = 0; let loose = 0;

  for (let i = 0; i < subAsks.length; i++) {
    const text = _str(subAsks[i]);
    const step = steps[i] && typeof steps[i] === 'object' ? steps[i] : null;
    const clause = step && step.clause && typeof step.clause === 'object' ? step.clause : null;

    if (!clause) { loose++; clauses.push({ text }); continue; }

    const ok = typeof canResolve === 'function' ? !!canResolve(clause) : true;
    if (!ok) {
      stale.push({ index: i, text, clause });
      continue;                                   // NOT pushed as loose text — that would be the silent re-interpret
    }
    pinned++;
    clauses.push({ text, pinned: clause });
  }

  return { clauses, pinned, loose, stale, runnable: stale.length === 0 };
}

/** The one-line replay disposition (§5.5). Says what was pinned, what fell back, and what stopped the run. */
export function replayLine(plan) {
  const p = plan || { pinned: 0, loose: 0, stale: [] };
  const bits = [`${p.pinned} pinned`, `${p.loose} from text`];
  if (p.stale && p.stale.length) bits.push(`${p.stale.length} STALE`);
  return `WORKFLOW ▸ replay — ${bits.join(' · ')}${p.runnable ? '' : ' → STOPPED (a banked step no longer resolves)'}`;
}

/** Wizard progress: can it save, and why not. PURE (drives the Save button's enabled state + copy). */
export function wizardProgress(steps) {
  const s = Array.isArray(steps) ? steps : [];
  const total = s.length;
  const approved = s.filter((x) => x && x.approved === true).length;
  const unproven = total - approved;
  return {
    total, approved, unproven,
    canSaveReady: total >= 2 && unproven === 0,                       // proven → launch-page card + cadence-eligible
    canSaveDraft: total >= 2 && unproven > 0,                         // draft → saved, but not on the launch page (§2.4)
  };
}
