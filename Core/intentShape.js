// Core/intentShape.js — the canonical intent-SHAPE classifier for Phase B. One source of truth the
// proposal (role budget), trial synth (act/read EXTRACT path), safety classer, and scorer all consume,
// instead of each re-deriving shape from its own divergent verb list.
//
// Motivating failure (DESIGN_phaseB_pipeline §5, BambooHR 2026-05-28): the proposal prompt carries a
// GLOBAL "minimal roles — propose the FEWEST" prior (AnthropicService.js:1885). Right for act-one/read
// intents ("sign in" → 2 roles; "search X" → input+submit); WRONG for completion intents ("apply for
// this job"), where every REQUIRED field is necessary. Shape lets each stage branch instead of guessing.
//
// Robustness model — TWO-TIER fusion (lexical primary, structural tie-breaker):
//   1. LEXICAL is primary. Scan the intent AND the (richer) grounded description for verb/noun cues.
//      On a tie, COMPLETE wins (a genuine complete↔read tie like "fill out and review" is completion).
//   2. STRUCTURAL evidence (required-field count + submit, from Core/formCoverage.enumerateFormFields)
//      only decides when the verb is SILENT. It NEVER overrides an explicit read/act. Rationale: the
//      asymmetric cost — a false `read`/`act` just falls back to today's minimal-role completeness (no
//      worse than status quo), but a false `complete` on a real form page makes the coverage gate fire
//      wrongly. So structural form-evidence (which is exactly the condition where false-complete hurts)
//      must not be allowed to override a confident lexical read/act.
//
// PURE: structural evidence is passed in (no DOM read here). Unit-testable like Core/trialSynth.js.
//
// @module Core/intentShape
// @version 2.74.558

// Verbs implying production/submission across a SET of fields (→ completion).
const COMPLETE_VERB = /\b(apply|fill\s*(?:in|out)?|complete|submit|enter|provide|register|sign\s*up|signup|enrol|enroll|subscribe|book|reserve|order|place\s*order|check\s*out|checkout|purchase|buy|pay|rsvp|request|create|compose|draft|update|edit|configure|set\s*up|setup|schedule|onboard|claim|file)\b/i;
// Nouns implying a multi-field surface (reinforces completion).
const FORM_NOUN = /\b(form|application|registration|sign[\s-]?up|checkout|survey|questionnaire|profile|account|onboarding|details|information|fields?|questions?|enrol+ment)\b/i;
// Verbs implying reading/finding content (→ read).
// Note: "check" is intentionally excluded — it's ambiguous ("check a box" = act, "check the status" =
// read) and was misclassifying action intents. The LLM grounding shape handles the nuanced cases.
const READ_VERB = /\b(find|search|show|list|get|see|view|read|browse|look|compare|monitor|track|scrape|extract|discover|count|fetch|locate|understand)\b/i;
// Verbs implying a single discrete action (→ act).
const ACT_VERB = /\b(click|tap|press|toggle|open|select|choose|log\s*in|login|sign\s*in|signin|log\s*out|logout|add|remove|delete|like|favorite|follow|unfollow|share|download|upload|play|pause|dismiss|close|expand|collapse|enable|disable|accept|approve|reject|confirm|cancel)\b/i;

/**
 * Classify an intent's shape.
 * @param {string} intent  raw or grounded intent text.
 * @param {object} [evidence]  structural page evidence (deterministic; from formCoverage).
 * @param {number} [evidence.requiredFieldCount]  # of page fields marked required.
 * @param {boolean} [evidence.hasSubmit]          a submit control is present.
 * @param {string}  [evidence.groundedIntent]     the LLM-grounded description (richer than raw intent).
 * @returns {{ shape:'complete'|'read'|'act', confidence:number, scores:object, signals:string[],
 *   decidedBy:'lexical'|'structural'|'default' }}
 */
export function classifyIntentShape(intent, evidence = {}) {
  const { requiredFieldCount = 0, hasSubmit = false, groundedIntent = '' } = evidence || {};
  // Scan intent + grounded description together — the grounded text is authored by the model that
  // understood full scope, so it rescues weak raw intents ("apply for this jop").
  const text = `${String(intent || '')} ${String(groundedIntent || '')}`.trim();
  const signals = [];

  let complete = 0, read = 0, act = 0;
  if (COMPLETE_VERB.test(text)) { complete += 2; signals.push('complete-verb'); }
  if (FORM_NOUN.test(text))     { complete += 1; signals.push('form-noun'); }
  if (READ_VERB.test(text))     { read += 2; signals.push('read-verb'); }
  if (ACT_VERB.test(text))      { act += 1; signals.push('act-verb'); }

  const scores = { complete, read, act };
  const lexTop = Math.max(complete, read, act);
  const hasForm = requiredFieldCount >= 2;     // a genuine multi-field surface (login's 2 fields → see tier-2 note)
  // PRIMACY: when BOTH a read and a complete verb appear, the EARLIER one is the user's MAIN action.
  // A subordinate/hypothetical clause ("VIEW the description before deciding whether to apply") must not
  // flip a read intent to complete — position beats the tie-favors-complete rule.
  const completeAt = complete > 0 ? text.search(COMPLETE_VERB) : Infinity;
  const readAt = read > 0 ? text.search(READ_VERB) : Infinity;

  let shape, decidedBy;
  if (lexTop === 0) {
    // Tier 2: verb is silent → let structural form-evidence decide. Never reached when a verb fired,
    // so this can't override an explicit read/act.
    if (hasForm) { shape = 'complete'; decidedBy = 'structural'; signals.push('structural-form'); }
    else { shape = 'act'; decidedBy = 'default'; }
  } else {
    decidedBy = 'lexical';
    if (complete > 0 && read > 0) {
      // Both fired → the leading verb is the primary action.
      shape = readAt < completeAt ? 'read' : 'complete';
      signals.push('primacy');
    } else if (complete > 0 && complete >= lexTop) shape = 'complete';  // COMPLETE takes ties vs act
    else if (read === lexTop && read >= act) shape = 'read';
    else shape = 'act';
    if (shape === 'complete' && hasForm) signals.push('structural-form');  // reinforces confidence, not the choice
  }

  // Confidence: lexical margin (top over runner-up), normalized; a structural-only call is a low-conf guess.
  const ranked = Object.values(scores).sort((a, b) => b - a);
  let confidence;
  if (decidedBy === 'structural') confidence = hasSubmit ? 0.4 : 0.3;
  else if (decidedBy === 'default') confidence = 0;
  else {
    confidence = Math.min(1, (ranked[0] - (ranked[1] || 0)) / Math.max(2, ranked[0]));
    if (shape === 'complete' && hasForm) confidence = Math.min(1, confidence + 0.25);  // structural agreement
  }
  return { shape, confidence: Math.round(confidence * 100) / 100, scores, signals, decidedBy };
}

/**
 * Does this intent demand exhaustive field coverage (so the global "minimal roles" prior should be
 * FLIPPED to "all required fields")? True only for completion intents. Accepts the same evidence.
 * @param {string} intent
 * @param {object} [evidence]
 * @returns {boolean}
 */
export function isCompletionIntent(intent, evidence = {}) {
  return classifyIntentShape(intent, evidence).shape === 'complete';
}

// ─── Intent → prompt parameters ─────────────────────────────────────────────
// The root issue the prototype was missing: `proposePerspectives` uses a STATIC rules block (a global
// "minimal roles / 2-3 options / don't enumerate forms" prior) with the intent merely appended as text,
// so the intent never shapes the INSTRUCTIONS. The fix is to extract structured parameters from the
// intent and ASSEMBLE the rules block from them — the minimalism prior becomes one *value* of a
// `completeness` parameter the intent sets, not a constant.
//
// The extractor is swappable (deterministic here; the grounding LLM can emit an IntentSpec later). The
// ASSEMBLY (buildProposeDirective) is the invariant that fixes the bug.

const CARDINALITY = {
  complete: { min: 1, max: 1 },   // a completion task has ONE correct perspective — never shard it
  read:     { min: 2, max: 3 },
  act:      { min: 1, max: 2 },
};

/**
 * Extract the proposal parameters from an intent (+ structural evidence).
 * @param {string} intent
 * @param {object} [evidence]  { requiredFieldCount, hasSubmit, groundedIntent, requiredFieldLabels }
 * @returns {{ shape:string, completeness:'exhaustive'|'minimal', cardinality:{min:number,max:number},
 *   mustCover:string[], confidence:number, signals:string[], decidedBy:string }}
 */
export function deriveIntentSpec(intent, evidence = {}) {
  // LLM-extracted shape/completeness (from groundIntent) is PRIMARY when present — the grounding model
  // understands intent far better than lexical regexes ("update my phone" → complete+minimal). The
  // lexical+structural classifier is the fallback (offline / grounding not run). Either way the directive
  // assembly below is identical — only the extractor differs.
  const SHAPES = ['read', 'act', 'complete'];
  const llmShape = SHAPES.includes(evidence.llmShape) ? evidence.llmShape : null;
  const llmCompleteness = ['exhaustive', 'minimal'].includes(evidence.llmCompleteness) ? evidence.llmCompleteness : null;

  let shape, confidence, signals, decidedBy;
  if (llmShape) {
    shape = llmShape;
    decidedBy = 'llm';
    confidence = 0.9;
    signals = ['llm-grounded'];
  } else {
    const c = classifyIntentShape(intent, evidence);
    shape = c.shape; confidence = c.confidence; signals = c.signals; decidedBy = c.decidedBy;
  }

  // completeness: trust the LLM's call when it gave one (it can tell exhaustive "apply" from targeted
  // "update my phone"); else derive from shape.
  const completeness = llmCompleteness || (shape === 'complete' ? 'exhaustive' : 'minimal');
  // A targeted completion (minimal) still wants one perspective, but not the full-form cardinality.
  const cardinality = (shape === 'complete' && completeness === 'minimal')
    ? { min: 1, max: 1 }
    : (CARDINALITY[shape] || CARDINALITY.act);

  const mustCover = Array.isArray(evidence.requiredFieldLabels)
    ? evidence.requiredFieldLabels.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
    : [];
  return { shape, completeness, cardinality, mustCover, confidence, signals, decidedBy };
}

/**
 * Assemble the proposal RULES BLOCK from an IntentSpec. This replaces the static minimal-roles rules in
 * proposePerspectives — the prompt is now defined by the intent's parameters.
 * @param {object} spec  from deriveIntentSpec.
 * @returns {string} a `-`-bulleted rules block to inject into the system prompt.
 */
export function buildProposeDirective(spec = {}) {
  const { shape = 'act', completeness = 'minimal', cardinality = CARDINALITY.act, mustCover = [] } = spec;
  const lines = [];

  if (completeness === 'exhaustive') {
    // Completion intent — flip the prior: completeness is the goal, ONE perspective, never shard.
    lines.push('- Propose EXACTLY ONE perspective: the complete operation that accomplishes the intent.');
    lines.push('- COMPLETENESS IS THE GOAL. Include a role for EVERY field the user must fill or choose to accomplish the intent, PLUS the submit/commit control. Do NOT minimize, do NOT omit fields, do NOT split the task across multiple options. A perspective that misses a required field is a FAILURE, not a "focused" view.');
    if (mustCover.length) {
      const list = mustCover.slice(0, 60).map((f) => `"${f}"`).join(', ');
      lines.push(`- The page marks these fields as REQUIRED — your single perspective MUST include a role for each: ${list}. Add any further fields the intent needs that are not in this list (the list is a floor, not a ceiling).`);
      lines.push('- For EACH role that fills one of those required fields, set "field" to that field\'s label COPIED VERBATIM from the list above (exact string). This binds the role to the real control. Omit "field" only for roles that fill no listed field.');
    }
    lines.push('- Fields that are present but NOT required to submit may be included with multiplicity "optional".');
    lines.push('- Give each field role a clear kebab-case name derived from its label (e.g. "first-name", "email", "desired-pay"); the submit control is an action role (e.g. "submit-application").');
  } else if (shape === 'complete') {
    // Targeted completion — a specific field/subset the intent names, not the whole form.
    lines.push('- Propose ONE focused perspective: ONLY the specific field(s) the intent names, plus the submit/save control that commits the change. Do NOT enumerate the whole form — only what the intent targets.');
    lines.push('- Give each role a clear kebab-case name derived from its label; the commit control is an action role (e.g. "save", "update").');
  } else if (shape === 'read') {
    lines.push(`- Propose ${cardinality.min}-${cardinality.max} distinct perspectives; each a COHERENT view serving the intent — not a grab-bag.`);
    lines.push('- MINIMAL roles: the input(s) the user acts on, the submit/trigger, and a content/result role to read (multiplicity "many" for a list). Do NOT enumerate unrelated page elements.');
  } else {
    lines.push(`- Propose ${cardinality.min}-${cardinality.max} perspective(s); each MINIMAL: the trigger that starts the action plus the target control it reaches (≈2-3 roles). Do NOT enumerate every element of a form/modal/menu.`);
    lines.push('- Example: "sign in with Google" → login-trigger + google-signin (≈2 roles), NOT username/password/facebook/close.');
  }
  return lines.join('\n');
}
