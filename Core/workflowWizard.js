// Core/workflowWizard.js — WW-1 (v2.74.1610, DESIGN_workflow_wizard.md §2/§3/§9/§10): the ＋ Workflow wizard's
// PURE logic. No DOM / chrome / LLM / storage (chat.js renders + drives _orchRunChain; this decides).
//
// The empirical model (§0 ruling 1): a step is RUN, the user approves/declines the RESULT. This module maps a run
// result → an outcome CLASS (so chat.js routes to the right prompt), bridges a chain `ranStep` → body-blind
// provenance, computes the capture/qualify SPLIT suggestions (§10.C), and assembles the save payload. All tested.

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
  return { text: _str(stepText) || _str(r.clause), via: { kind, host: _str(host) || null, name: name ? name.slice(0, 80) : null }, bankedAt: Number.isFinite(now) ? now : 0 };
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
  return {
    ask,
    name: _str(w && w.name) || null,
    subAsks,
    steps: steps.map((s) => (s && s.provenance) ? s.provenance : { text: _str(s && s.text), via: { kind: null, host: null, name: null }, bankedAt: 0 }),
    status: allApproved ? 'ready' : 'draft',
    qualifiedAt: allApproved ? (Number.isFinite(now) ? now : 0) : 0,
  };
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
