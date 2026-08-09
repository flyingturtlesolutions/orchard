// Core/deskMatch.js — v2.74.2104 (DESIGN_exerciser_mvp.md §5b.1) — WHICH DESK DID THE ASK NAME?
//
// The pure half of OPEN_DESK. Kept out of chat.js because the dangerous failure here is SILENT: a fuzzy match
// that picks the wrong desk sends every later step of a test to the wrong place, and the trace still looks
// clean — the same silent-wrong class this project has paid for repeatedly (the multi-panel guess in
// exercise.cjs, the `open #N`-drills-a-row case). A matcher that can be wrong quietly must be testable.
//
// THE LADDER, and it stops deliberately early:
//   1. exact (case/space-insensitive)
//   2. unique case-insensitive PREFIX
//   3. unique "contains"
//   → anything else is a MISS or an AMBIGUITY, both of which name the real candidates back to the user.
//
// No edit distance, no token soup, no "closest". Naming the desks that exist is a better answer than guessing
// one, because the user can act on it and a wrong guess is undetectable from the outside.

const _norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * @param {string} name the desk name as the ask said it
 * @param {Array<{id: string, title: string}>} desks the user's desks/views
 * @returns {{ok: true, desk: object, how: 'exact'|'prefix'|'contains'} |
 *           {ok: false, reason: 'no-name'|'none'|'no-match'|'ambiguous', candidates: string[]}}
 */
export function matchDesk(name, desks) {
  const q = _norm(name);
  const list = (Array.isArray(desks) ? desks : []).filter((d) => d && _norm(d.title));
  if (!q) return { ok: false, reason: 'no-name', candidates: list.map((d) => String(d.title)) };
  if (!list.length) return { ok: false, reason: 'none', candidates: [] };

  const exact = list.filter((d) => _norm(d.title) === q);
  if (exact.length === 1) return { ok: true, desk: exact[0], how: 'exact' };
  // Two desks with the SAME name is a real state (duplicate titles are not prevented); refuse rather than
  // take the first, which would be a coin flip recorded as a decision.
  if (exact.length > 1) return { ok: false, reason: 'ambiguous', candidates: exact.map((d) => String(d.title)) };

  const prefix = list.filter((d) => _norm(d.title).startsWith(q));
  if (prefix.length === 1) return { ok: true, desk: prefix[0], how: 'prefix' };
  if (prefix.length > 1) return { ok: false, reason: 'ambiguous', candidates: prefix.map((d) => String(d.title)) };

  const contains = list.filter((d) => _norm(d.title).includes(q));
  if (contains.length === 1) return { ok: true, desk: contains[0], how: 'contains' };
  if (contains.length > 1) return { ok: false, reason: 'ambiguous', candidates: contains.map((d) => String(d.title)) };

  return { ok: false, reason: 'no-match', candidates: list.map((d) => String(d.title)) };
}

/**
 * The user-facing sentence for a refusal. Names what EXISTS — a refusal that only says "no" makes the user
 * guess twice. PURE.
 */
export function deskRefusal(res, name) {
  const named = String(name || '').trim();
  const list = (res && Array.isArray(res.candidates) ? res.candidates : []).slice(0, 8);
  const asList = list.length ? list.map((t) => `**${t}**`).join(' · ') : '';
  switch (res && res.reason) {
    case 'no-name':   return `Which desk? You have: ${asList || 'none yet'}.`;
    case 'none':      return 'You have no desks yet.';
    case 'ambiguous': return `More than one desk matches "${named}": ${asList}. Which one?`;
    default:          return `I don't have a desk called "${named}". You have: ${asList || 'none yet'}.`;
  }
}
