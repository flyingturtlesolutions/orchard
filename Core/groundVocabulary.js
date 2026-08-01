// TRT-1 (v2.74.1546, DESIGN_target_routing.md §4) — ground VOCABULARY FINGERPRINTS + ask affinity.
// A ground's fingerprint is DERIVED from what the library already banked — ride-leg param schemas (names, hints,
// enums), leg names/`does` prose, taught-walk params + their option vocabularies, capability intents + aliases,
// read-result field keys — NEVER a hand-curated keyword list (the `foreach` lexicon lesson: curated lists rot;
// derived ones rebuild themselves when a walk is taught or a leg harvested). Affinity is a deterministic,
// zero-LLM RANKING signal: it picks candidates ("division" → vendorsuite), never run authority (ORCH-G still
// decides auto vs confirm). Collisions ("ticket" lives on zendesk AND vendorsuite) stay honestly weak via
// distinctiveness weighting. PURE — no chrome.*, no storage.

/** Orchard's OWN nouns — command/spawn grammar, excluded from every fingerprint AND from ask content tokens
 *  (§4 rule 3): otherwise every fan-out ask ("…in a new case") smells like every ground. */
export const ORCHARD_NOUNS = new Set([
  'case', 'cases', 'desk', 'desks', 'sweep', 'sweeps', 'routine', 'routines', 'conversation', 'conversations',
  'subtask', 'subtasks', 'sub-task', 'sub-tasks', 'thread', 'threads', 'chat', 'chats', 'canvas', 'studio',
  'ground', 'grounds', 'capability', 'capabilities', 'workflow', 'workflows',
]);

// Ask-side grammar: quantifiers/spawn/cadence words + bare function words. Kept SMALL — distinctiveness
// weighting (not this list) is what demotes common verbs like "open" (they appear in many fingerprints).
const _GRAMMAR = new Set([
  'foreach', 'each', 'every', 'all', 'per', 'the', 'a', 'an', 'in', 'on', 'at', 'to', 'into', 'onto', 'of',
  'for', 'with', 'and', 'or', 'then', 'new', 'own', 'its', 'their', 'my', 'me', 'it', 'them', 'this', 'that',
  'please', 'also', 'now',
  // v2.74.1914 — the CLOSED CLASSES. Live 125712: the pre-ask warm followed TARGET to vendorsuite six times in a
  // row on matches like "(how)", "(can, you)", "(any)" — words generic in ENGLISH, not in the corpus.
  // Distinctiveness is corpus-relative: it demotes "open" because many grounds speak it, but it CANNOT demote a
  // function word that only one ground's does-prose happens to contain. Closed classes don't grow with the
  // catalog, so a curated list is safe HERE — the rot lesson applies to open-class nouns/verbs, which stay out
  // of this set and under distinctiveness weighting.
  'how', 'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'does', 'did', 'done', 'are', 'was', 'were', 'has', 'have', 'had', 'been', 'being', 'not', 'than',
  'you', 'your', 'yours', 'our', 'ours', 'they', 'she', 'her', 'hers', 'him', 'his',
  'any', 'some', 'none', 'both', 'either', 'neither', 'few', 'several', 'many', 'much', 'most', 'more', 'less', 'least',
]);

/** Tokenize free text → lowercase content terms (≥3 chars, non-grammar, non-Orchard). Trailing-s singularized
 *  (len>3) so "tasks" meets a fingerprint's "task". PURE. */
export function contentTokens(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    const t = (raw.length > 3 && raw.endsWith('s')) ? raw.slice(0, -1) : raw;
    if (_GRAMMAR.has(raw) || _GRAMMAR.has(t) || ORCHARD_NOUNS.has(raw) || ORCHARD_NOUNS.has(t)) continue;
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

// Split an identifier-ish key (TicketId, AddressLine1, project_name) into content terms.
function _keyTerms(key) {
  return contentTokens(String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2'));
}

/**
 * Build a ground's vocabulary fingerprint from its banked artifacts. Sources (§4 table):
 *   legs         — ride legs / recipes: { name, does, params:[{name,hint,enum?}] } (paramSchema-shaped inputs
 *                  are pre-flattened by the caller; this stays storage-agnostic)
 *   capabilities — sg capabilities: { intent, aliases:[], params:[{name, vocabulary?:[]}] }
 *   readKeys     — recent read-result field keys (TicketId, ProjectName, …)
 * Returns a plain { term → count } object (counts are per-source occurrences; affinity uses presence +
 * cross-ground distinctiveness, so exact counts only break ties). PURE.
 */
export function vocabularyFingerprint({ legs = [], capabilities = [], readKeys = [] } = {}) {
  const fp = Object.create(null);
  const add = (term) => { if (term) fp[term] = (fp[term] || 0) + 1; };
  const addText = (text) => { for (const t of contentTokens(text)) add(t); };
  for (const leg of (Array.isArray(legs) ? legs : [])) {
    if (!leg) continue;
    addText(leg.name); addText(leg.does);
    for (const p of (Array.isArray(leg.params) ? leg.params : [])) {
      if (!p) continue;
      addText(p.name); addText(p.hint);
      for (const v of (Array.isArray(p.enum) ? p.enum : [])) addText(v);
    }
  }
  for (const c of (Array.isArray(capabilities) ? capabilities : [])) {
    if (!c) continue;
    addText(c.intent);
    for (const al of (Array.isArray(c.aliases) ? c.aliases : [])) addText(al);
    for (const p of (Array.isArray(c.params) ? c.params : [])) {
      if (!p) continue;
      addText(p.name);
      for (const v of (Array.isArray(p.vocabulary) ? p.vocabulary : []).slice(0, 100)) addText(v);
    }
  }
  for (const k of (Array.isArray(readKeys) ? readKeys : [])) for (const t of _keyTerms(k)) add(t);
  return fp;
}

/**
 * Rank grounds by vocabulary affinity to an ask's content. Distinctiveness-weighted (IDF-ish): a term found in
 * ONE fingerprint scores 1, in k fingerprints 1/k — so "warranty"/"division" (one ground) dominate "open"/"task"
 * (many). Returns DESC by score, zero-score grounds omitted; `matchedTerms` makes every ranking explainable in
 * the TARGET ▸ trace line. PURE.
 * @param {string|string[]} askOrTokens
 * @param {Array<{groundId:string, fp:Object}>} fingerprints
 * @returns {Array<{groundId:string, score:number, matchedTerms:string[]}>}
 */
export function scoreAskAffinity(askOrTokens, fingerprints) {
  const tokens = Array.isArray(askOrTokens) ? askOrTokens : contentTokens(askOrTokens);
  const fps = (Array.isArray(fingerprints) ? fingerprints : []).filter((f) => f && f.groundId && f.fp);
  if (!tokens.length || !fps.length) return [];
  // term → how many grounds speak it (distinctiveness denominator)
  const spread = Object.create(null);
  for (const t of tokens) { let n = 0; for (const f of fps) if (f.fp[t]) n++; if (n) spread[t] = n; }
  const out = [];
  for (const f of fps) {
    let score = 0; const matched = [];
    for (const t of tokens) { if (f.fp[t]) { score += 1 / spread[t]; matched.push(t); } }
    if (score > 0) out.push({ groundId: f.groundId, score: Math.round(score * 1000) / 1000, matchedTerms: matched });
  }
  out.sort((a, b) => b.score - a.score || String(a.groundId).localeCompare(String(b.groundId)));
  return out;
}
