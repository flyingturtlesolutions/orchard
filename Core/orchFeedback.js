// Core/orchFeedback.js — ORCH-FB: the corrective-feedback layer for the conversation. PURE.
//
// The gap: when the chat presents the WRONG match or runs the WRONG action, the only recourse was a fixed "Not
// that" button that offered to re-record — and the bad capability/alias STAYED, needing a manual Studio delete.
// This module is the spine of a real feedback loop (👍/👎 + free-text), interpreted into CORRECTIVE OPS that
// mutate the persisted state automatically:
//   • reject_match — the capability is fine, just WRONG for this ask → de-alias (strip the ask) + demote.
//   • reject_run   — it ran but did the wrong thing → demote (negative outcome) + de-alias; offer fix/retract.
//   • wrong_value  — RIGHT capability, WRONG binding (e.g. wrong category) → re-bind + re-run with the correction.
//   • retract      — the capability itself is broken → soft-retract so the matcher never surfaces it again.
//   • undo         — flag (page effects may be irreversible).
//   • affirm       — positive feedback → reinforce the ask→capability alias (the flywheel).
//
//   classifyFeedback(text)          — lexical FLOOR: is this corrective feedback, polarity + coarse kind (LLM refines)
//   planCorrection(kind, context)   — a corrective kind + the last action → a declarative op-plan the bg executes
//   applyRetraction(cap, {now})     — pure: mark a capability retracted (soft-delete, restorable)
//   isActiveCapability(cap)         — the matcher's filter (exclude retracted/disabled) — bad things stop appearing
//
// The LLM WRAPPER (AnthropicService.interpretFeedback, live) handles free-form correction the floor can't —
// "you searched the wrong category, should be Vectors" → {kind:'wrong_value', correction:{CATEGORY:'Vectors'}}.
//
// @module Core/orchFeedback
// @version 2.74.688

export const CORRECTIVE_KINDS = Object.freeze(['reject_match', 'reject_run', 'wrong_value', 'retract', 'undo', 'affirm']);

// Lexical floors, checked in PRIORITY order. Retract (destructive) and undo are most specific; "not that"
// (wrong choice) outranks the generic "wrong" (wrong result); affirm is the positive fallthrough.
const _RETRACT  = /\b(delete|remove|forget|get ?rid of|discard|throw (?:away|out)|don'?t (?:ever )?save|never save|unlearn|drop)\b[^.]*\b(that|this|it|capability|thing)\b|\bthat'?s? broken\b|\bit'?s broken\b/i;
const _UNDO     = /\b(undo|revert|roll ?back|go back|take (?:that|it) back|put (?:that|it) back)\b/i;
const _NOT_THAT = /\bnot (?:that|this|it|what i)\b|\bwrong (?:one|choice|option|capability)\b|\b(?:a )?different (?:one|option)\b|\bsomething else\b|\bnope\b|\bno,? (?:not|that'?s| different)/i;
const _WRONG    = /\b(?:that'?s )?(?:wrong|incorrect|not (?:right|correct)|a mistake|messed up)\b|\bdid(?:n'?t| not) work\b|\bdid the wrong\b|\bthat'?s not (?:it|right)\b/i;
const _AFFIRM   = /\b(?:yes|yep|yeah|correct|perfect|exactly|that'?s (?:it|right|correct|perfect)|spot on|good (?:job|one)|nailed it|works? (?:great|now)?|thank)\b/i;

/**
 * Classify a user message as corrective FEEDBACK. PURE lexical floor (the LLM wrapper refines, esp. wrong_value
 * with an extracted correction). Returns isFeedback:false for ordinary asks so the normal turn path is unaffected.
 * @param {string} text
 * @returns {{isFeedback:boolean, polarity:('negative'|'positive'|null), kind:(string|null), confidence:number}}
 */
export function classifyFeedback(text) {
  const s = String(text || '').trim();
  if (!s) return { isFeedback: false, polarity: null, kind: null, confidence: 0 };
  if (_RETRACT.test(s))  return { isFeedback: true, polarity: 'negative', kind: 'retract', confidence: 0.85 };
  if (_UNDO.test(s))     return { isFeedback: true, polarity: 'negative', kind: 'undo', confidence: 0.8 };
  if (_NOT_THAT.test(s)) return { isFeedback: true, polarity: 'negative', kind: 'reject_match', confidence: 0.8 };
  if (_WRONG.test(s))    return { isFeedback: true, polarity: 'negative', kind: 'reject_run', confidence: 0.7 };
  if (_AFFIRM.test(s))   return { isFeedback: true, polarity: 'positive', kind: 'affirm', confidence: 0.65 };
  return { isFeedback: false, polarity: null, kind: null, confidence: 0 };
}

const _op = (op, capabilityId, groundId, extra = {}) => (capabilityId ? { op, capabilityId, groundId: groundId || null, ...extra } : null);

/**
 * Map a corrective KIND + the LAST ACTION's context → a declarative op-plan the background applies (each op is
 * an existing primitive: removeAlias / OUTCOMES-emit / a retract flag / accreteAlias / a re-run). PURE.
 * @param {string} kind  one of CORRECTIVE_KINDS
 * @param {{capabilityId?:string, groundId?:string, ask?:string, correction?:object, alternatives?:any[]}} context
 * @returns {{ops:object[], followup:string, say:string}}
 */
export function planCorrection(kind, context = {}) {
  const cap = context.capabilityId || null;
  const gid = context.groundId || null;
  const ask = context.ask || '';
  switch (kind) {
    case 'reject_match':
      // De-alias the wrong phrase, but do NOT globally demote — the capability is fine for ITS OWN asks; a wrong
      // MATCH is not a broken capability. The ask-specific penalty comes from feedbackLearn.feedbackAdjustment
      // (similarity to this rejected phrase). demote is reserved for reject_run/undo, where it actually misbehaved.
      return {
        ops: [_op('de_alias', cap, gid, { phrase: ask })].filter(Boolean),
        followup: (context.alternatives && context.alternatives.length) ? 'alternatives' : 'record',
        say: 'Got it — that wasn’t the right match. I’ll stop suggesting it for this.',
      };
    case 'reject_run':
      return {
        ops: [_op('demote', cap, gid, { reason: 'rejected_run' }), _op('de_alias', cap, gid, { phrase: ask })].filter(Boolean),
        followup: 'fix_or_retract',
        say: 'Sorry — that did the wrong thing. Want me to fix it or remove it?',
      };
    case 'wrong_value':
      return context.correction
        ? { ops: [_op('rebind', cap, gid, { bindings: context.correction })].filter(Boolean), followup: 'rerun', say: 'Right capability, wrong value — re-running with the correction.' }
        : { ops: [], followup: 'ask_value', say: 'Right idea — what should it have used instead?' };
    case 'retract':
      return { ops: [_op('retract', cap, gid)].filter(Boolean), followup: 'none', say: 'Removed it — it won’t come up again. (Restorable in Studio.)' };
    case 'undo':
      return { ops: [_op('demote', cap, gid, { reason: 'undo' })].filter(Boolean), followup: 'none', say: 'I can’t auto-undo what already happened on the page, but I’ve flagged it and won’t prefer it.' };
    case 'affirm':
      return { ops: [_op('confirm_alias', cap, gid, { phrase: ask })].filter(Boolean), followup: 'none', say: 'Great — I’ll remember that.' };
    default:
      return { ops: [], followup: 'none', say: '' };
  }
}

/** PURE — soft-retract a capability (restorable). The matcher excludes it via isActiveCapability; nothing is hard-deleted. */
export function applyRetraction(capability, { now } = {}) {
  if (!capability || typeof capability !== 'object') return capability;
  return { ...capability, retracted: true, retractedAt: now != null ? now : (capability.retractedAt || null) };
}

/** PURE — the matcher's activeness filter: a retracted/disabled capability never surfaces again (no Studio trip). */
export function isActiveCapability(capability) {
  return !!capability && capability.retracted !== true && capability.disabled !== true;
}
