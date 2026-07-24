/**
 * Core/stepsPrompt.js — INTENT → WORKFLOW STEPS (v2.74.1669). Pure prompt + parse.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §8 (a banked workflow is a saved PHRASING) · DESIGN_workflow_wizard.md.
 *
 * ── WHY A DEDICATED PROMPT, AND NOT THE TWO THINGS ALREADY AVAILABLE ────────────────────────────────────────
 * Both existing decomposition paths answer a DIFFERENT question, and live traces show each failing in its own way:
 *
 *   · `interpret` is a ROUTER: "what is this ONE ask?". Trace 211913 — "find open warranty tasks were
 *     replacements are requested" classified as `branch` (0.85), then `clarify` (0.95). Neither carries
 *     `subAsks`, so asking a router to decompose returned nothing twice while costing a 13.6k-token call.
 *   · `decomposeAsk` is a CONNECTIVE SPLITTER: its `_CONN` is `and|then|;|,` — no period, no `if`. So
 *     "search shopify for a matching profile. If none is found create a shopify profile." is ONE clause, and
 *     "find open warranty tasks where replacements are requested" is ONE clause. It splits GRAMMAR, not
 *     OPERATIONS, and cannot know the first is a read+filter or the second a find-or-create.
 *
 * ── THE RULE: ONE STEP = ONE LEG = ONE RESULT YOU CAN LOOK AT AND APPROVE ────────────────────────────────────
 * That is the wizard's own contract, stated on its first page, and it is the criterion this prompt optimizes
 * for. A step the user cannot look at and judge is not a step — it is a paragraph, and banking it defers the
 * judgement to a replay nobody is watching (§8.2).
 *
 * A conditional is therefore TWO steps (the test, then the action). A find-or-create is TWO steps (the lookup,
 * then the create). A read-then-filter is TWO steps (the read, then the filter).
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** Upper bound on generated steps. A wizard the user must approve 20 times is a wizard they abandon. */
export const MAX_STEPS = 8;

// ─── Intent → step parameters ───────────────────────────────────────────────────────────────────────────────
// The `deriveIntentSpec` / `buildProposeDirective` pattern from Core/intentShape.js, transposed. That module
// records why it exists, and the same root issue applied here: a STATIC rules block with the intent merely
// appended never lets the intent shape the INSTRUCTIONS. So the parameters are extracted by CODE and the rules
// block is ASSEMBLED from them — the step budget becomes a value the intent sets, not the constant I first wrote.
//
// The extractor is deterministic and the split is not: detecting that a sentence CONTAINS a conditional is
// pattern-matching (structured), while deciding where the operations divide is interpretation (predictive). That
// is the §1.1b rule applied one level up — and it is why these signals go into the prompt as instructions rather
// than being used to split the text directly, which is what `decomposeAsk` does and why it under-splits.

// v2.74.1709 — bare "all" was a false COLLECTION signal ("get all open tasks" is one bulk read, not a per-item
// pass), so it inflated the floor and told the model to add a step that isn't there. Dropped; the genuine
// per-item markers (each / every / for each / per X / those / them / the ones) stay.
const _COLLECTION = /\b(each|every|for ?each|per (?:item|task|row|one|record)|them|those|the ones|any that)\b/i;
const _CONDITIONAL = /\b(if|unless|when|whenever|otherwise|else|in case)\b/i;
const _FINDCREATE = /\b(?:create|add|make|open)\b[^.?!]{0,40}\b(?:if|when|unless)\b|\b(?:if|when)\b[^.?!]{0,40}\b(?:none|no match|not found|missing|does ?n[o']t exist)\b|\bor create\b/i;
// v2.74.1709 — several write-verbs are also common NOUNS ("the order", "a result set", "the blog post"). The
// determiner lookbehind excludes the noun sense so a floor is not inflated by "tasks by order number" etc.
const _WRITE = /(?<!\b(?:the|a|an|this|that|these|those|its|our|their|your|my|no|by|in|of|result|blog|word)\s)\b(create|draft|send|post|update|add|delete|remove|set|assign|close|order|submit|save|write|reply|email|message)\b/i;
const _READFILTER = /\b(find|get|list|show|search|fetch|pull)\b[^.?!]{0,60}\b(where|that|which|with|containing|asking for|requesting|marked)\b/i;

/**
 * Extract the step parameters from an intent. PURE.
 *
 * @returns {{scale:{min:number,max:number}, collection:boolean, conditional:boolean, findCreate:boolean,
 *   write:boolean, readFilter:boolean, signals:string[], decidedBy:string}}
 */
export function deriveStepSpec(intent, evidence = {}) {
  const s = _str(intent);
  const signals = [];

  const collection = _COLLECTION.test(s); if (collection) signals.push('collection');
  const conditional = _CONDITIONAL.test(s); if (conditional) signals.push('conditional');
  const findCreate = _FINDCREATE.test(s); if (findCreate) signals.push('find-or-create');
  const write = _WRITE.test(s); if (write) signals.push('write');
  const readFilter = _READFILTER.test(s); if (readFilter) signals.push('read+filter');

  // The floor is the sum of the operations the text PROVABLY contains: each detected shape is at least two
  // steps, and they compose. This is a floor and not a target — it tells the model how far it is under-splitting
  // if it returns fewer, and never inflates a genuinely simple request (no signals → 1..3).
  let min = 1;
  if (readFilter) min += 1;                 // the read and the filter
  if (collection) min += 1;                 // the per-item pass over what was read
  if (findCreate) min += 1;                 // the lookup and the create
  else if (conditional) min += 1;           // the test and the action (find-or-create already counted its own)
  if (write && !findCreate) min += 1;       // the write, on its own

  const llm = ['read', 'act', 'complete'].includes(evidence.llmShape) ? evidence.llmShape : null;
  return {
    scale: { min: Math.min(min, MAX_STEPS), max: MAX_STEPS },
    collection, conditional, findCreate, write, readFilter,
    signals,
    decidedBy: llm ? 'llm' : (signals.length ? 'lexical' : 'default'),
  };
}

/**
 * Assemble the rules block from a StepSpec. PURE.
 *
 * This is the invariant `buildProposeDirective` identifies as the actual fix — the prompt is defined by the
 * intent's parameters rather than by a constant. Each detected shape contributes a rule naming the split it
 * implies, so the model is told what it is looking at rather than left to notice.
 */
export function buildStepsDirective(spec = {}) {
  const { scale = { min: 1, max: MAX_STEPS }, collection, conditional, findCreate, write, readFilter } = spec;
  const lines = [];

  if (scale.min > 1) {
    lines.push(`- This looks like AT LEAST ${scale.min} separate actions. Returning fewer usually means two are bundled (the common mistake) — but this is an estimate from the wording, so if the request genuinely is simpler, trust the request over this count.`);
  } else {
    lines.push('- This may genuinely be one action. If it is, return one step — do not pad it.');
  }
  if (readFilter) lines.push('- It asks for things MATCHING A CONDITION. Reading the list and narrowing it are SEPARATE steps: the read first, in their words, then the filter as its own step.');
  if (collection) lines.push('- It works over a COLLECTION (each / every / those). Anything done per-item is its own step, and it comes AFTER the step that produces the list.');
  if (findCreate) lines.push('- It contains a FIND-OR-CREATE. That is always two steps: look it up, then create it when missing. Never one step — the lookup is the thing that decides whether the create should happen at all.');
  else if (conditional) lines.push('- It contains a CONDITION. The test and the action it guards are separate steps, always.');
  if (write) lines.push('- It ends in a WRITE (something changes). The write is its own final step and is never bundled with the lookup before it — a person approves the write separately from the thing that found its target.');

  return lines.join('\n');
}

/**
 * Sanitize a proposed step list. PURE. Runs AFTER parsing and is the code-side guarantee layer.
 *
 * Every model stage in the perspective loop is bracketed by a sanitizer immediately after; this is that
 * bracket. Clamp and drop, never rewrite meaning — the text is what the user will read and approve, so
 * silently editing it would put words in their mouth.
 */
export function sanitizeSteps(steps, { max = MAX_STEPS } = {}) {
  const out = [];
  const dropped = [];
  for (const raw of (Array.isArray(steps) ? steps : [])) {
    if (typeof raw !== 'string') { dropped.push({ why: 'not a string', raw }); continue; }
    let t = _str(raw).replace(/^\s*\d+[.)]\s*/, '').replace(/^[-•·]\s*/, '');
    if (!t || t === '[object Object]') { dropped.push({ why: 'empty or placeholder', raw }); continue; }
    if (t.length < 3) { dropped.push({ why: 'too short to judge', raw }); continue; }
    if (t.length > 200) t = `${t.slice(0, 197)}…`;
    // Leg machinery leaking into a step the user is meant to read in their own terms.
    if (/\b[a-z][a-z0-9]*_[a-z0-9_]{3,}\b/.test(t) || /\/api\/|\{"|https?:\/\//.test(t)) {
      dropped.push({ why: 'names machinery (leg id / endpoint / payload) instead of an action', raw: t });
      continue;
    }
    if (out.some((x) => x.toLowerCase() === t.toLowerCase())) { dropped.push({ why: 'duplicate', raw: t }); continue; }
    out.push(t);
    if (out.length >= max) break;
  }
  return { steps: out, dropped };
}

// v2.74.1714 — QUANTIFIER FIDELITY, the guarantee half (the prompt rule above is the teach half).
//
// Live (trace 172653): "…and for each, show primary homeowner's contact information in new case" decomposed to
// "show primary homeowner's contact information in new case" — the model kept every word EXCEPT the quantifier,
// and that one dropped token re-routed the step off the fan-out (which drills per-item detail and opens a case
// per item) onto the single-bulk-case engine. The decomposer is a router in disguise: quantifier fidelity is a
// routing-correctness property, so it gets a deterministic backstop, not just a prompt rule.
//
// Deliberately NARROW, in keeping with "code does not get to invent a split it cannot verify": this only fires
// when the INTENT carries a per-item quantifier and NO step kept one — restoring the user's own signal, never
// adding one they didn't say. The repaired text is still shown on the plan page for approval before anything runs.
const _QUANT_PHRASE = /\b(for\s+each|for-?each|each|every|per\s+(?:item|task|row|one|record))\b/i;

/**
 * Re-attach a per-item quantifier the model dropped. PURE.
 *
 * @returns {{steps:string[], restored:null|{quantifier:string, stepIndex:number}}}
 */
export function restoreQuantifier(intent, steps) {
  const s = _str(intent);
  const list = (Array.isArray(steps) ? steps : []).map(_str).filter(Boolean);
  if (!list.length) return { steps: list, restored: null };
  const m = s.match(_QUANT_PHRASE);
  if (!m) return { steps: list, restored: null };                              // the ask never quantified
  if (list.some((t) => _QUANT_PHRASE.test(t))) return { steps: list, restored: null };   // the model kept it
  // The quantified CLAUSE is the text after the quantifier (to the sentence end); its owner is the step sharing
  // the most words with it. Ties/thin overlap → leave everything alone (a wrong owner is worse than the gap —
  // the coverage report and the plan reviewer still see the un-quantified step).
  const tail = s.slice(m.index + m[0].length).split(/[.?!]/)[0].toLowerCase();
  const tw = new Set(tail.split(/[^a-z0-9']+/).filter((w) => w.length > 2));
  let best = -1; let bestN = 0; let tied = false;
  list.forEach((t, i) => {
    const n = t.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 2 && tw.has(w)).length;
    if (n > bestN) { best = i; bestN = n; tied = false; }
    else if (n === bestN && n > 0 && i !== best) tied = true;   // two equal owners = no confident owner
  });
  if (best < 0 || bestN < 2 || tied) return { steps: list, restored: null };
  // Normalized prefix form: "for each, <step>". Any per-item quantifier restores as this — it is the collection
  // semantics the user stated, it reads naturally ahead of any verb, and it is the form the foreach gate matches.
  const out = list.slice();
  out[best] = `for each, ${out[best]}`;
  return { steps: out, restored: { quantifier: m[1].toLowerCase(), stepIndex: best } };
}

/**
 * Coverage check (§ the `assessPerspectiveCompleteness` analogue): did the proposal meet the floor its own
 * signals imply, and does anything still look compound? PURE.
 *
 * Reports; never repairs. The repair is a re-ask of the offending step (a model job) or an edit by the person
 * reading it (a human job) — code does not get to invent a split it cannot verify.
 */
export function assessStepCoverage(steps, spec = {}) {
  const list = (Array.isArray(steps) ? steps : []).filter(Boolean);
  const min = (spec.scale && spec.scale.min) || 1;
  const compound = list.filter(looksCompound);
  return {
    count: list.length,
    expectedMin: min,
    underSplit: list.length < min,
    compound,
    complete: list.length >= min && compound.length === 0,
  };
}

/**
 * Feed a rejected/edited step back into the next proposal. PURE — mirrors `rejectionContext` in Core/proposals.js,
 * where "rejections stick" is what stops a re-roll from re-offering the thing just refused.
 */
export function stepRejectionContext(rejected = [], edited = []) {
  const r = (Array.isArray(rejected) ? rejected : []).map(_str).filter(Boolean).slice(0, 6);
  const e = (Array.isArray(edited) ? edited : []).filter((p) => p && _str(p.from) && _str(p.to)).slice(0, 6);
  if (!r.length && !e.length) return '';
  const lines = [];
  if (r.length) { lines.push('They REJECTED these steps — do not offer them again, in any wording:'); for (const x of r) lines.push(`  · ${x}`); }
  if (e.length) { lines.push('They REWROTE these — match the corrected phrasing and granularity:'); for (const p of e) lines.push(`  · "${_str(p.from)}" → "${_str(p.to)}"`); }
  return lines.join('\n');
}

/**
 * Build the decomposition request. PURE.
 *
 * The primitive vocabulary is included on purpose: naming the operation kinds is what lets the model split on
 * OPERATIONS instead of punctuation, which is the entire difference from the connective splitter.
 */
export function buildStepsMessages(intent, { host = '', spec = null, rejectionContext = '', groundFacts = '' } = {}) {
  const _spec = spec || deriveStepSpec(intent);
  const directive = buildStepsDirective(_spec);
  const system = [
    'You break a request into the FEWEST steps such that each one is a single result a person can run and check on',
    'its own. FEWEST, not smallest — never split an action from the thing that completes it (see below).',
    '',
    // The role separation, transposed from proposePerspectives' second sentence ("You do NOT pick elements or
    // write selectors; you name the roles and describe what fills each"). Same two-phase shape, same reason:
    //   perspective:  name ROLES  → resolveRoles picks SELECTORS → code verifies against the live DOM
    //   workflow:     name STEPS  → the wizard RUNS it           → PP-0c banks what it resolved to
    // Naming and resolving are different jobs. A model asked to do both in one pass invents the half it cannot
    // check — which is why resolveRoles is a separate call and states "a wrong selector is worse than a gap".
    // The same holds here: a wrong leg is worse than an unresolved step, because a wrong leg RUNS.
    'A step is a NAMED ACTION in the user\'s own words. You do NOT pick legs or write parameters — you say what',
    'each step should do, and the system works out which capability answers it by RUNNING it and showing the',
    'result. Never name a connector, endpoint, leg id, or parameter value. Never guess a filter, field name, id,',
    'status or date the user did not say. If a detail is missing, leave the step in their words and let the run',
    'surface the gap. THEIR WORDS ARE NOT A LEG: if they say "Shopify", write "Shopify" — never the machinery',
    '(`shopify_create_customer`, `/admin/api/customers.json`, `{"status":"open"}`).',
    '',
    'THE RULE — one step = one action = one result a person can look at and approve.',
    'If a step would produce two results, or do something a person could approve separately, SPLIT IT.',
    '',
    'Common kinds of single step. The examples come from DIFFERENT sites on purpose — the SHAPE is what matters,',
    'not the nouns; never carry a name from one example into a request that did not use it:',
    '  · READ A LIST            — "get this week\'s calendar events"',
    '  · READ A FIELD PER ITEM  — "read the vendor note on each one"',
    '  · SORT / FILTER          — "which of those are still unresolved?"',
    '  · LOOK UP EACH ELSEWHERE — "look each caller up in the CRM"',
    '  · GO SOMEWHERE           — "open the billing dashboard"',
    '  · ONE WRITE              — "send each of them a reminder"',
    '  · PRESENT IN A CASE      — "open a case for each listing what it needs". A case is a local review record',
    '                             that SHOWS what a prior step read — a DESTINATION, not an afterthought.',
    '',
    'ORDER so each step has its input: anything done to "each" / "those" comes AFTER the step that produced them,',
    'and anything that shows / files / writes X comes AFTER the step that read X.',
    '',
    // v2.74.1714 — QUANTIFIER FIDELITY. Live: "…and for each, show primary homeowner's contact information in
    // new case" came back as "show primary homeowner's contact information in new case" — same words minus the
    // quantifier, and that one dropped word re-routed the step to a different engine (a single bulk case instead
    // of one case per item, with no per-item detail read). The quantifier is not decoration; it is load-bearing.
    'KEEP THE QUANTIFIER. If they say work happens "for each" / "each" / "every one" / "per item", the step that',
    'does that work must SAY so ("for each, show its contact info in a new case" / "show each one\'s status").',
    'Dropping the quantifier changes the meaning from one-result-per-item to one result total, and the plan will',
    'run it that way. Their quantifier is part of their words — keep it in the step that owns it.',
    '',
    'SPLIT THESE APART — each is more than one step. These are the common UNDER-splitting mistakes:',
    '  · "find X where Y"                → READ the list, THEN filter it. Two steps.',
    '  · "look it up, and create it if',
    '     it is missing"                 → the LOOKUP, THEN the create. Two steps.',
    '  · "if <test> then <action>"       → the TEST, THEN the action. Two steps, always.',
    '  · a sentence with a full stop in',
    '    the middle                      → almost always two steps.',
    '',
    'BUT THESE ARE ONE STEP — over-splitting is just as wrong, and it is the mistake you are MORE prone to, so',
    'weigh it equally. Do NOT split an action from what completes it:',
    '  · a PRESENTATION and its target  → "display / show / list X IN A CASE" is ONE step: "open a case showing X".',
    '    The case is WHERE X appears; never a bare "display X" and then a dangling "open a case". (A case shows',
    '    only what a prior step READ — so if X is per-item detail, the READ of X is its own step BEFORE the case.)',
    '    A PER-ITEM presentation keeps its quantifier IN the one step: "show each one\'s contact info in a new',
    '    case" — never a de-quantified "show contact info in a case".',
    '  · a LOOK-UP and its key          → "search the CRM for their email" is ONE step, not "get the email" and',
    '    then "look them up".',
    '  · a READ and its columns         → "get the tickets with their status" is ONE read, not a read then a fetch.',
    '',
    'Write each step as a short instruction in the user\'s own words. Do not add steps they did not ask for. If',
    'the request is genuinely one action, return the single step — do not pad it.',
    '',
    // The intent-derived block goes LAST among the rules and is introduced as being about THIS request, so it
    // reads as more specific than the general rules above rather than as a competing restatement of them.
    ...(directive ? ['ABOUT THIS PARTICULAR REQUEST:', directive, ''] : []),
    // v2.74.1672 — the SUBSTRATE FACTS, last and marked as authoritative. The perspective prompts use the same
    // device for the same reason: "KNOWN PRIORS (authoritative — these were ESTABLISHED by automated resolution,
    // not guesses)". Telling the model WHY a fact outranks its own judgement is what stops it reasoning past
    // one. These come from the site's own capability declarations, and they force splits no wording could.
    ...(_str(groundFacts) ? [
      'WHAT THIS SITE ACTUALLY SUPPORTS (read from its capabilities — authoritative WHERE THEY SPEAK; trust them',
      'over a guess about step count, but where they are silent, use your judgment):',
      _str(groundFacts),
      '',
    ] : []),
    `Reply with JSON only: {"steps":["…","…"]}. At most ${MAX_STEPS}.`,
  ].join('\n');

  const user = [
    host ? `They are working on: ${_str(host)}` : '',
    '',
    'Break this into steps:',
    _str(intent),
    ...(_str(rejectionContext) ? ['', _str(rejectionContext)] : []),
  ].filter(Boolean).join('\n');

  return { system, user, spec: _spec };
}

/**
 * Re-ask for ONE step that still looks compound. PURE prompt.
 *
 * The completeness-by-construction move, adapted. The perspective loop can APPEND what the model dropped
 * because code independently knows the answer (the form oracle read the DOM). Here code can only DETECT an
 * under-split, never perform it — splitting prose is the predictive half. So the repair is a second, narrower
 * model call on the offending step alone, which is a much easier question than the original.
 */
export function buildResplitMessages(step) {
  const system = [
    'You split ONE instruction into the separate actions it contains.',
    '',
    'Each action must be something a person could run and check on its own. The usual splits:',
    '  · a look-up and the create that follows it when nothing was found',
    '  · a test and the action it guards',
    '  · a read and the filter that narrows it',
    '',
    'Keep their words. Do not name connectors, endpoints, leg ids or parameters. Do not add anything they did',
    'not say. If it genuinely is ONE action, return it unchanged as a single item.',
    '',
    'Reply with JSON only: {"steps":["…","…"]}. At most 4.',
  ].join('\n');
  return { system, user: `Split this into its separate actions:\n${_str(step)}` };
}

/**
 * Parse + validate. PURE.
 *
 * Strict in the safe direction: anything that is not a usable instruction string is dropped rather than shown.
 * A malformed step is worse than a missing one here, because the user is being asked to APPROVE each — and a
 * step they cannot read is a step they cannot judge. (Live at v2.74.1666: "[object Object]" reached the queue,
 * was approved by a click, and went to the front door as an ask.)
 */
export function parseStepsOutput(raw, { max = MAX_STEPS } = {}) {
  let obj = null;
  if (raw && typeof raw === 'object') obj = raw;
  else {
    const m = String(raw ?? '').match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
  }
  const list = (obj && Array.isArray(obj.steps)) ? obj.steps : [];
  const out = [];
  for (const s of list) {
    if (typeof s !== 'string') continue;                 // an object here is the v1666 bug's shape — drop it
    const t = _str(s).replace(/^\s*\d+[.)]\s*/, '');     // strip a numbering prefix the model added anyway
    if (t.length < 3 || t.length > 200) continue;
    if (t === '[object Object]') continue;
    if (out.some((x) => x.toLowerCase() === t.toLowerCase())) continue;   // dedupe
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Does this look like it still holds more than one action? PURE — a cheap post-check on whatever produced the
 * steps, so an under-split result is VISIBLE rather than silently accepted.
 *
 * Deliberately a hint and not a gate: it flags for the log and the user, and never rewrites a step. The
 * splitting judgement belongs to the model that has the whole sentence, or to the person reading it.
 */
export function looksCompound(step) {
  const s = _str(step);
  if (!s) return false;
  return /\.\s+\S/.test(s)                                   // a full stop mid-step
    || /\b(?:if|unless|when|otherwise|else)\b/i.test(s)      // a conditional
    || /\b(?:and then|then)\b/i.test(s)                      // an explicit sequence
    || /,\s*(?:and\s+)?(?:create|add|update|send|draft|delete|remove|set)\b/i.test(s);   // a trailing write
}

/** Steps that still look compound, for the honest note under a generated list. */
export function compoundSteps(steps) {
  return (Array.isArray(steps) ? steps : []).filter(looksCompound);
}
