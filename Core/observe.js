// Core/observe.js — OBS-READ-1: the pure floor for OBSERVATIONS (the KNOW half of Tier-2).
//
// Symmetry with the demonstration path (Path 3 → Fragment): you DEMONSTRATE a fragment (the recorder watches you
// ACT) and it produces an EFFECT; you POINT at an observation (the picker watches you SELECT) and it produces a
// VALUE. A read can't be "recorded" — there's no click to capture — so its authoring path is the picker (Path 1).
//
// This module is the deterministic floor, mirroring observedTrace/observedSegment for fragments:
//   • classifyReadAsk(ask)          — is this ask a QUESTION (a read), and what OUTPUT TYPE does it want?
//   • inferExtractShape(picked)     — from the picked region's context, what comes off the page (text/list/record)?
//   • reconcileOutputType(ask,shape)— fuse the ask's intent with what was actually picked → the final outputType
//   • buildObservationCapability(…) — a durable, MATCHER-COMPATIBLE Observation record (rides the same chat rails)
//
// The outputType vocabulary is the compiler's (Core/orchPlan.OUTPUT_CONNECTION): list→FOREACH, scalar→binding,
// predicate→gate, count→loop. That is the whole point of observations — once captured, the compiler FUSES them
// with fragments for free ("download the cheapest GIF" = observe(list) → analyze(cheapest→scalar) → fragment).
//
// PURE: no DOM / chrome / LLM (the LLM refines classification + locates the region live; this is the floor).
//
// @module Core/observe
// @version 2.74.686

// A leading ACTION verb makes the ask a COMMAND, not a standalone read — even when it embeds a selection clause
// ("download the CHEAPEST gif" is observe+analyze+fragment, which the COMPILER decomposes, not a pure read). This
// guard runs first so a superlative inside a command doesn't get mis-read as a value question.
const _COMMAND = /^\s*(please\s+|can you\s+|could you\s+|i'?d? ?(want|like) to\s+)?(download|buy|order|purchase|add|remove|delete|clear|click|tap|press|open|close|dismiss|filter|sort|send|post|submit|upload|play|pause|sign\s?up|sign\s?in|log\s?in|log\s?out|register|book|reserve|apply|install|enable|disable|toggle|navigate|go to|create|edit|update|save|share|follow|subscribe|check\s?out)\b/i;

// Read-intent patterns, checked in PRIORITY order (most specific first). A bare trailing "?" also marks a read.
const _COUNT = /\bhow many\b|\bnumber of\b|\bcount (of|the)\b|\bhow many .* are\b/i;
const _PREDICATE = /\b(is|are)\s+there\b|\bin stock\b|\b(is|are|it)\b[^?]*\b(available|present|listed|enabled|free|sold ?out)\b|\bdoes\b[^?]*\b(have|exist|include|offer|support)\b|\bcan i\b/i;
const _LIST = /\blist\b|\bwhat are\b|\ball (of )?(the|them)\b|\bevery\b|\bwhich\b|\bnames? of\b|\bshow (me )?all\b|\btitles? of\b/i;
const _SCALAR = /\bwhat('s| is| are)?\b|\bhow much\b|\b(price|value|title|name|cost|rating|score|total|count) of\b|\bthe (first|top|last|cheapest|highest|lowest|best|latest)\b/i;

/**
 * Classify an ask as a READ (a question) and infer the OUTPUT TYPE it wants. PURE. The lexical floor; the LLM
 * refines it live. A command ("search for music") returns isRead:false — the chat routes it to the fragment path.
 * @param {string} ask
 * @returns {{isRead:boolean, outputType:('count'|'predicate'|'list'|'scalar'|null), confidence:number}}
 */
export function classifyReadAsk(ask) {
  const s = String(ask || '').trim();
  if (!s) return { isRead: false, outputType: null, confidence: 0 };
  if (_COMMAND.test(s)) return { isRead: false, outputType: null, confidence: 0 };   // a command (maybe composite) → not a standalone read
  const q = /\?\s*$/.test(s);
  let outputType = null;
  if (_COUNT.test(s)) outputType = 'count';
  else if (_PREDICATE.test(s)) outputType = 'predicate';
  else if (_LIST.test(s)) outputType = 'list';
  else if (_SCALAR.test(s)) outputType = 'scalar';
  const isRead = !!outputType || q;
  // A matched pattern is a strong signal; a bare "?" with no pattern is a weak read (default scalar).
  const confidence = outputType ? (q ? 0.9 : 0.75) : (q ? 0.4 : 0);
  return { isRead, outputType: outputType || (isRead ? 'scalar' : null), confidence };
}

/**
 * Infer the EXTRACT SHAPE — what physically comes off the page — from the picked region's context. PURE. Mirrors
 * tier2Lower's feature-kind → shape mapping (collection→list, composite→record, region→text). The content script
 * supplies the live context (repeated siblings / sub-fields); this maps it to the shape vocabulary.
 * @param {{kind?:string, repeated?:boolean, siblingCount?:number, fieldCount?:number}} picked
 * @returns {'list'|'record'|'text'}
 */
export function inferExtractShape(picked) {
  const p = picked || {};
  if (p.kind === 'collection' || p.repeated === true || (p.siblingCount | 0) >= 3) return 'list';
  if (p.kind === 'composite' || (p.fieldCount | 0) >= 2) return 'record';
  return 'text';   // region / single value
}

/**
 * Fuse the ASK's intent (what the user wants to know) with the SHAPE actually picked (what's on the page) → the
 * final compiler OUTPUT TYPE. PURE. The ask wins when it's explicit (you can COUNT a list, or read the FIRST of
 * one); otherwise the shape decides (a list stays a list; text/record is a single value).
 * @param {('count'|'predicate'|'list'|'scalar'|null)} askOutputType
 * @param {('list'|'record'|'text')} shape
 * @returns {'count'|'predicate'|'list'|'scalar'}
 */
export function reconcileOutputType(askOutputType, shape) {
  if (askOutputType === 'count' || askOutputType === 'predicate' || askOutputType === 'scalar') return askOutputType;
  if (askOutputType === 'list') return 'list';
  return shape === 'list' ? 'list' : 'scalar';   // no explicit ask → the shape decides
}

const _slugUpper = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const _outName = (s) => _slugUpper(s).split('_').slice(0, 3).join('_') || 'VALUE';

/**
 * Build a durable, MATCHER-COMPATIBLE Observation capability. PURE (the caller stamps id/time). The record rides
 * the SAME rails as a fragment capability — the matcher normalizes any candidate to {id, intent, aliases, effect,
 * groundId, reversible, params}, so an Observation needs only those fields to be matched + ranked unchanged. The
 * `observe` body + `outputType` are what the read-runner and the compiler consume.
 *   - effect:'read' + reversible:true  → a read has no side effect; the chat can run it without a confirm gate.
 *   - observe.extracts[{selector, output, shape, landmark}] → how the runtime EXTRACTs (selector + self-healing lmk).
 *   - outputType → the compiler's control-flow connection (list→foreach, scalar→binding, predicate→gate, count→loop).
 * @returns {object} Observation capability record
 */
export function buildObservationCapability(input) {
  const i = input || {};
  const intent = String(i.intent || i.ask || '').slice(0, 200);
  const lmk = i.landmark || null;
  const ex = i.extract || {};
  const shape = ex.shape || (lmk ? inferExtractShape(lmk) : 'text');
  const outputType = i.outputType || reconcileOutputType(classifyReadAsk(i.ask || intent).outputType, shape);
  const selector = ex.selector || (lmk && lmk.selector) || null;
  return {
    id: i.id || null,
    kind: 'observation',
    effect: 'read',
    reversible: true,
    intent,
    goal: String(i.goal || intent).slice(0, 200),
    name: String(i.name || i.goal || intent).slice(0, 120),
    aliases: Array.isArray(i.aliases) ? i.aliases.filter(Boolean).slice(0, 12) : [],
    groundId: i.groundId || null,
    outputType,
    observe: {
      extracts: [{
        selector,
        output: ex.output || _outName(intent),
        shape,
        ...(lmk ? { landmark: lmk } : {}),
      }],
    },
    params: Array.isArray(i.params) ? i.params : [],
    synthesized: true,
  };
}
