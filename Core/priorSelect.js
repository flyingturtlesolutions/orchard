// Core/priorSelect.js — PS-1 (v2.74.1982). WHICH prior did the ask mean?
//
// THE PATTERN THIS CLOSES. A conversation accumulates result sets: 24 warranty tasks, then 6 Shopify orders. The
// user then says "read the tracking number on each ORDER" — and the noun is right there in the sentence. Until
// now nothing read it. `_priorForClause` returned `_lastGroundedRead` if it existed, else the FIRST focus entry
// with rows — both of which mean "the most recent", never "the one you named".
//
// Three live failures in one day, each fixed separately downstream, all of them this:
//   13:45  "read the tracking number on each order"  → bound to the 24 TASK rows → matched `Job Number`,
//          reported `24 × "Job Number" → 24 found`. The orders read 90s earlier carried
//          `fulfillments[].trackingInfo.number`; nothing looked at it.
//   12:20  "get their last order"                    → bound to a single RECORD ("27s old") → `MAP ▸ no field —
//          "" absent from 1 row(s)`, while the 5-row list it meant sat one entry down.
//   04:04  "get their last order"                    → bound to the CUSTOMER record → matched `numberOfOrders`.
//
// The codebase already ASKS when a FIELD is ambiguous (pickFieldPath's v1626 rule: "never silently pick; the
// caller asks") and GUESSES when a COLLECTION is. This module applies the same discipline one level up.
//
// It does NOT decide what to read — only which rows are on the table. Selection is by noun, then by shape, and
// it reports `why` so the choice is auditable in one log line instead of a three-fix investigation.

const _STOP = new Set(['the', 'a', 'an', 'of', 'for', 'on', 'in', 'to', 'each', 'every', 'all', 'their', 'them',
  'its', 'this', 'that', 'these', 'those', 'my', 'our', 'get', 'read', 'show', 'list', 'give', 'me', 'and',
  'what', 'whats', 'is', 'are', 'from', 'by', 'with', 'last', 'first', 'recent', 'full', 'details', 'detail']);

const _norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Crude, deliberate singularisation: "orders"->"order", "tasks"->"task", "addresses"->"address". Enough to make
// the ask's plural meet a focus noun's singular; not a linguistics project.
function _stem(w) {
  const s = String(w || '');
  if (s.length > 4 && s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.length > 4 && s.endsWith('sses')) return s.slice(0, -2);
  // -ss/-us/-is are not plural markers: status, address, analysis. Stripping them invents a word ("statu") that
  // matches nothing, which is a silent miss rather than a loud one.
  if (s.length > 3 && s.endsWith('s') && !/(ss|us|is)$/.test(s)) return s.slice(0, -1);
  return s;
}

export function askTokens(ask) {
  return _norm(ask).split(' ').filter((t) => t && !_STOP.has(t)).map(_stem);
}

// "each order", "every task", "their orders" — the ask wants one answer PER ROW, so a list beats a single record
// even when the record is more recent. Live 12:20 took a 1-row record for a "for each" ask and died on it.
export function isPerItem(ask) {
  return /\b(each|every|all|both|their|them|per)\b/i.test(String(ask || ''));
}

function _candidateTokens(c) {
  const text = `${(c && c.noun) || ''} ${(c && c.label) || ''}`;
  return new Set(_norm(text).split(' ').filter(Boolean).map(_stem));
}

/**
 * @param ask         the user's sentence
 * @param candidates  [{ id, noun, label, kind:'list'|'record', rows, at, source }] — newest FIRST
 * @returns { pick, why, matched, ambiguous:[…] }
 *
 * `pick` is null only when there are no candidates at all. A no-noun-match still picks (recency), because
 * refusing to answer a follow-up that today works would be a regression — but `why` says so, and that is the
 * line a future grade reads.
 */
export function selectPrior(ask, candidates, { targetSystem = '' } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c && (c.kind === 'list' || c.kind === 'record'));
  if (!list.length) return { pick: null, why: 'no-candidates', matched: [], ambiguous: [] };

  // v2.74.2006 — THE TARGET'S NAME DOES NOT GET TO VOTE FOR THE SOURCE. A cross-system map's ask necessarily
  // names both ends ("for each open task in Raleigh, get the homeowner's last order in SHOPIFY"), so the target
  // system's own prior result competes with the source list on the target's own name. Live 19:10:18, with the
  // source finally surviving eviction (v2005): both scored 2 —
  //   shopify orders  ← order, shopify        (56s old)
  //   warranty tasks  ← task, raleigh         (1m52s old)
  // — tied, both lists, so recency picked Shopify and the map collapsed into a self-map that read a field named
  // "the last order for". Dropping the target's token leaves `order` voting for Shopify (1) and `task,raleigh`
  // for the tasks (2), and the source wins on its own merits.
  // Deliberately NOT excluding same-system candidates outright: a genuine self-map ("get the tracking number of
  // each order" over Shopify rows) is legitimate and must still bind to those rows. This only removes the
  // target's NAME from the vote, never the candidate.
  const _sysTok = new Set(askTokens(targetSystem));
  const toks = askTokens(ask).filter((t) => !_sysTok.has(t));
  const perItem = isPerItem(ask);

  const scored = list.map((c, i) => {
    const ct = _candidateTokens(c);
    const hits = toks.filter((t) => ct.has(t));
    return { c, i, hits };
  });

  const matched = scored.filter((s) => s.hits.length);
  if (!matched.length) {
    // Nobody carries the ask's nouns. Recency, as before — but say it, so a wrong pick is visible.
    return { pick: list[0], why: toks.length ? `no-noun-match (${toks.join(',')}) → most-recent` : 'no-noun → most-recent', matched: [], ambiguous: [] };
  }

  // Best noun overlap wins. On a tie, a per-item ask prefers a LIST; otherwise recency (candidates are newest
  // first, and Array.prototype.sort is stable, so equal entries keep that order).
  const best = Math.max(...matched.map((s) => s.hits.length));
  const top = matched.filter((s) => s.hits.length === best);
  const ranked = perItem
    ? [...top].sort((a, b) => (a.c.kind === b.c.kind ? 0 : a.c.kind === 'list' ? -1 : 1))
    : top;

  // Two DIFFERENT nouns matching equally well is the ambiguity worth surfacing ("tasks" and "orders" both hit).
  // Two entries of the SAME noun is not — that is just an older copy of the same set.
  const distinct = new Set(ranked.map((s) => _norm(s.c.noun || s.c.label || '')));
  return {
    pick: ranked[0].c,
    why: `noun:${ranked[0].hits.join(',')}${perItem ? ' per-item→list' : ''}`,
    matched: matched.map((s) => s.c),
    ambiguous: distinct.size > 1 ? ranked.map((s) => s.c) : [],
  };
}

// One line, for the log. Names WHICH set was bound and why — the missing word that made three separate fixes
// necessary before anyone could see the rows were wrong.
export function describePick(pick, why) {
  if (!pick) return 'none';
  const size = pick.kind === 'list' ? `${(pick.rows || []).length} row(s)` : 'record';
  return `${pick.kind} "${pick.label || pick.noun || '?'}" (${pick.noun || '?'}, ${size}) [${why}]`;
}
