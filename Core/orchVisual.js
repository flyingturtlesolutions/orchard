// Core/orchVisual.js — ORCH-CB: the VISUAL observation floor — ground a read in what the LLM SEES, not a selector.
//
// A DOM observation reads an element's exact text (mechanism); a VISUAL observation hands Claude a screenshot of the
// region and a description, and reads its MEANING (Services/ImageReadCapture.image_read). That's the right
// instrument for a SEMANTIC condition a selector can't answer — "are there actual results, or just suggestions /
// a 'no matches' banner?" — because the distinction lives in headings/layout, not the markup the selector sees.
// This module is the PURE floor: turn a condition into a vision prompt, and a vision result into a predicate input.
// No DOM / chrome / network. See specs/DESIGN_intent_orchestration.md (grounding=mechanism, the LLM=meaning).
//
// @module Core/orchVisual

/**
 * Turn a CONDITION phrase into a vision-read description that COUNTS the real items and treats empty/decoy states as
 * zero. PURE. "there are any jobs" → "Count how many ACTUAL jobs … a 'no results' / 'suggested' section counts as
 * ZERO … reply with a single number." This is what makes a visual condition robust to the decoy problem (a
 * zero-results page showing suggested items of the same archetype).
 * @param {string} conditionText
 * @returns {string}
 */
export function describeForCondition(conditionText) {
  const subj = String(conditionText || '').trim()
    .replace(/^\s*(if|when|whenever|unless|once|in case)\s+/i, '')                       // a conditional keyword
    .replace(/^\s*(are|is|was|were|do|does|did|has|have|can|could)\s+(there|the\s+page|it|we|you|i)\b\s*/i, '')  // a QUESTION form: "are there", "does it have", "do you see"
    .replace(/^\s*(see|find|show|count|tell\s+me|give\s+me|read)\s+(me\s+)?/i, '')        // a read verb ("do you SEE …")
    .replace(/^\s*there\s+(are|is|was|were)\s+/i, '')                                     // a DECLARATIVE form: "there are"
    .replace(/^\s*(a|an|any|some|no)\s+/i, '')                                            // a leading quantifier
    .replace(/\?+\s*$/, '')
    .trim() || 'matching items';
  return [
    `Look at this screenshot of a web page and count how many ACTUAL ${subj} it is currently showing as the RESULTS of the user's search/list.`,
    `Rules:`,
    `- If the page shows a "no results" / "no matching" / "0 results" / "nothing found" message, the answer is 0 — even if other items are visible elsewhere.`,
    `- Do NOT count items under a "suggested" / "you might like" / "similar" / "recommended" / "popular" / "sponsored elsewhere" heading — those are NOT results of this search.`,
    `- Do NOT count headers, filters, ads, navigation, breadcrumbs, or the search box itself.`,
    `- Reply with ONLY a single integer (0, 1, 12, …) — the count of real ${subj}. No words, no punctuation.`,
  ].join('\n');
}

/**
 * Adapt an image_read result ({items, confidence, rationale}) into a predicate input ({value, items, count}). PURE.
 * For a COUNT / PREDICATE read the description asked for a NUMBER, so items[0] holds the count (parse it; "no/none"
 * → 0); for a LIST / SCALAR read the items ARE the values. Critically, `count` is carried explicitly so an
 * existence predicate uses the model's count, not `items.length` (a single "0" item must mean zero, not one).
 * @param {{items?:string[], confidence?:number}|null} llmRes
 * @param {string} [outputType]
 * @returns {{value:string, items:string[], count:number}}
 */
export function visualToInput(llmRes, outputType = 'count') {
  const items = (llmRes && Array.isArray(llmRes.items)) ? llmRes.items.map((s) => String(s == null ? '' : s).trim()).filter(Boolean) : [];
  const ot = String(outputType || '').toLowerCase();
  if (ot === 'count' || ot === 'predicate') {
    const first = items[0] || '';
    const m = first.match(/-?\d[\d,]*/);
    let count;
    if (m) count = parseInt(m[0].replace(/,/g, ''), 10);
    else if (/^(no|none|zero|nothing)\b/i.test(first)) count = 0;
    else count = items.length;   // the model returned a list rather than a number → its length is the count
    return { value: first, items, count: Number.isFinite(count) ? count : items.length };
  }
  return { value: items.join('\n'), items, count: items.length };
}

/**
 * Build a VISUAL observation capability (rides the same matcher rails as a DOM observation; effect:'read'). PURE
 * (the caller stamps id/time + captures the rect). `observe.visual = { mode, description, scrollY }` is what the
 * runtime reads: screenshot the region (mode 'viewport' = the visible tab) → readImage(description).
 * @returns {object} observation capability record
 */
export function buildVisualObservation(input) {
  const i = input || {};
  const outputType = i.outputType || 'count';
  const description = String(i.description || '').slice(0, 800);
  const intent = String(i.intent || i.ask || '').slice(0, 200);
  return {
    id: i.id || null,
    kind: 'observation',
    effect: 'read',
    reversible: true,
    via: 'visual',
    intent,
    goal: String(i.goal || intent).slice(0, 200),
    name: String(i.name || intent || 'a visual read').slice(0, 120),
    aliases: Array.isArray(i.aliases) ? i.aliases.filter(Boolean).slice(0, 12) : [],
    groundId: i.groundId || null,
    outputType,
    observe: { visual: { mode: i.mode === 'region' ? 'region' : 'viewport', description, scrollY: Number(i.scrollY) || 0, ...(i.rect ? { rect: i.rect } : {}) } },
    params: [],
    synthesized: true,
  };
}

/** Is this capability a VISUAL observation (read via screenshot + Claude, not a DOM selector)? PURE. */
export function isVisualObservation(cap) {
  return !!(cap && cap.observe && cap.observe.visual && String(cap.observe.visual.description || '').trim());
}

// A param name → a readable label ("EDIT_LOCATION" → "location", "SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY" → "job
// title keywords or company"). PURE.
const _humanParam = (k) => String(k || '').replace(/[_-]+/g, ' ').toLowerCase().replace(/^(edit|search|select|set|choose|filter|sort)\s+/i, '').trim();

/**
 * Render a bindings map (the upstream step's PARAMS — the search criteria) into a human criteria string the vision
 * prompt can use to judge MATCH. PURE. e.g. {SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY:'nurse', EDIT_LOCATION:'mn'} →
 * `job title keywords or company "nurse", location "mn"`. Empty/blank values are skipped.
 * @param {object} bindings
 * @returns {string}
 */
export function renderCriteria(bindings) {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return '';
  const parts = [];
  for (const [k, v] of Object.entries(bindings)) {
    const val = v == null ? '' : String(v).trim();
    if (!val) continue;
    const label = _humanParam(k);
    parts.push(label ? `${label} "${val}"` : `"${val}"`);
  }
  return parts.join(', ');
}

/**
 * Append the search CRITERIA to a visual description at RUN time, so the model judges whether the visible items
 * actually MATCH the user's search — not just whether items of some kind exist. PURE. This is the params-passed-to-
 * the-description fix: a page of unrelated suggestions for a no-match search reads as 0 because none match the
 * criteria. Returns the description unchanged when there are no criteria.
 * @param {string} description
 * @param {string} criteria  the rendered criteria (see renderCriteria)
 * @returns {string}
 */
export function withCriteria(description, criteria) {
  const c = String(criteria || '').trim();
  const d = String(description || '');
  if (!c) return d;
  return `${d}\n- The page should be showing RESULTS for the user's search: ${c}. A visible item that does NOT match that search — a suggestion, recommendation, "popular"/"similar" item, or anything unrelated to the criteria — counts as 0, even if it looks like the same kind of item.`;
}

/**
 * v2.74.946 (CR-D7) — render a plan's steps as the numbered confirm-card lines. Was verbatim-duplicated in
 * chat's two confirm cards (_orchConfirmPlan vs _orchOfferComprehended); this is the SUPERSET version — the
 * comprehended card's steps simply lack bindings/collect/wait, so those affordances render as ''. A gate's
 * CONDITION machinery (the observe it tests + the analyze that judges it) is shown INLINE on the gate line,
 * not as its own numbered steps — a conditional reads as one "if … : …" rather than three. PURE.
 * @param {object[]} steps  plan IR steps ({kind, id, over?, body?, intent?, clause?, bindings?, collect?, ms?})
 * @returns {{lines: string[], shown: number}}  shown = USER-VISIBLE step count (gate machinery folded in)
 */
export function renderPlanLines(steps) {
  const fmt = (b) => Object.keys(b || {}).length ? ` (${Object.entries(b).map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
  const label = (b) => b.kind === 'wait' ? `let it settle (${Math.round((b.ms || 0) / 100) / 10}s)` : (b.intent || b.clause || b.kind);
  const byId = new Map((steps || []).map((s) => [s && s.id, s]));
  const consumed = new Set();
  for (const s of (steps || [])) { if (s && s.kind === 'gate') { const an = byId.get(s.over); if (an) { consumed.add(an.id); if (an.over) consumed.add(an.over); } } }
  let n = 0;
  const lines = [];
  for (const s of (steps || [])) {
    if (!s || consumed.has(s.id)) continue;
    n++;
    if (s.kind === 'foreach' || s.kind === 'loop') {
      lines.push(`${n}. for each item: ${(s.body || []).map(label).filter(Boolean).join(' → ')}${s.collect ? ` (collect ${s.collect})` : ''}`);
    } else if (s.kind === 'gate') {
      const an = byId.get(s.over);
      const cond = (an && (an.intent || an.clause)) || 'it applies';
      lines.push(`${n}. if ${cond}: ${(s.body || []).map((b) => b.intent || b.clause).filter(Boolean).join(' → ')}`);
    } else {
      lines.push(`${n}. ${s.intent || s.clause || s.kind || 'step'}${fmt(s.bindings)}`);
    }
  }
  return { lines, shown: n };
}
