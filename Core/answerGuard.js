// Core/answerGuard.js — honesty belt for the ANSWER path (Core/answerPrompt.js → AnthropicService.answerAsk,
// rendered via the IL_ANSWER handler). v2.74.1295.
//
// The answer path REASONS and DESCRIBES; it dispatches NOTHING. So when the user COMMANDED a side-effectful
// act ("create a calendar event", "send the message") and the model's reply CLAIMS it did it ("I've created
// that event ✅ … is now on your calendar"), the claim is false BY CONSTRUCTION — no capability ran behind
// it. The v1289 prompt belt forbids fake tool-call TAGS but not fake success PROSE, so the calendar
// fabrication (orchard-logs-20260627-212709, findings 2026-06-27 21:27) slipped through because the ask was
// framed as a confirmation. This is the deterministic catch: a side-effect COMMAND + a completion CLAIM ⇒
// replace with the honest teach off-ramp. Two-factor (ask AND answer), plus a QUESTION guard, keep it precise:
// a question ("how do I create an event?") or a read ask whose answer legitimately "created a summary" is left
// alone. The prompt rule in answerPrompt.js is the PRIMARY defense; this is the deterministic backstop that
// catches the model when it ignores the rule. PURE + unit-tested.
//
// @module Core/answerGuard

// The ASK commanded an EXTERNAL mutation (not a read / answer / how-to question).
const SIDE_EFFECT_ASK = /\b(create|add|delete|remove|send|share|post|publish|upload|book|reserve|order|buy|purchase|pay|cancel|schedule|reschedule|update|rename|archive|submit|register|subscribe|invite|assign|rsvp|set\s*up)\b/i;

// A QUESTION / how-to — the answer legitimately EXPLAINS rather than claims completion, so don't guard it
// (a leading interrogative/aux, an explicit ask-to-explain, or a trailing "?").
const QUESTION = /^\s*(?:how|what|why|when|where|which|who|can|could|would|should|do|does|did|is|are|will|may|might|explain|tell\s+me|show\s+me|help\s+me|remind\s+me)\b|\?\s*$/i;

// PAST / perfect side-effect verb forms — so "I can create" / "you can schedule" (descriptions) don't match.
const DONE = '(?:created|added|deleted|removed|sent|shared|posted|published|uploaded|booked|reserved|ordered|purchased|paid|cancell?ed|scheduled|rescheduled|updated|renamed|moved|archived|submitted|registered|subscribed|invited|assigned|saved|set\\s*up)';
// First-person completion claim: "I've created", "I have just scheduled", "I went ahead and sent", "I created".
const FIRST_PERSON = new RegExp(`\\bI(?:['’]ve|\\s+(?:have|just|already|now|successfully|went\\s+ahead\\s+and|gone\\s+ahead\\s+and))*\\s+${DONE}\\b`, 'i');
// State completion claim: "is now on your calendar", "has been sent", "your event is now scheduled".
const STATE = new RegExp(`\\b(?:is|are|'s|has\\s+been|have\\s+been|been)\\s+(?:now\\s+|already\\s+|successfully\\s+)?(?:${DONE}|on\\s+your|in\\s+your|live)\\b`, 'i');

/**
 * Does the answer claim a side-effect was COMPLETED, for an ask that COMMANDED one? PURE.
 * @param {string} answer  the model's answer text.
 * @param {string} ask     the user's ask.
 * @returns {boolean}
 */
export function looksLikeFalseCompletion(answer, ask = '') {
  const a = String(answer ?? '');
  const q = String(ask ?? '');
  if (!a || !q) return false;
  if (!SIDE_EFFECT_ASK.test(q)) return false;   // the ask didn't command a mutation → nothing to fake
  if (QUESTION.test(q)) return false;           // a question / how-to legitimately describes, never "did it"
  return FIRST_PERSON.test(a) || STATE.test(a);
}

// The honest replacement: state plainly nothing happened + offer the teach off-ramp (demonstrate-once).
export const HONEST_REPLACEMENT =
  "I can't actually perform that action from here yet — I don't have a saved capability for it on this page, so nothing was changed. If you show me how to do it once, I can do it for you next time.";

/**
 * Neutralize a fabricated completion claim on the answer (no-dispatch) path. PURE.
 * @param {string} answer  the model's answer text.
 * @param {string} ask     the user's ask.
 * @returns {{ answer:string, neutralized:boolean }}
 */
export function neutralizeFalseCompletion(answer, ask = '') {
  if (looksLikeFalseCompletion(answer, ask)) return { answer: HONEST_REPLACEMENT, neutralized: true };
  return { answer: String(answer ?? ''), neutralized: false };
}
