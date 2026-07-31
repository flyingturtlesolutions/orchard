// Core/askScope.js — v2.74.1884 — WHAT SCOPE DOES AN UNSCOPED ASK MEAN?
//
// Live 071412 asked the question three ways and got the same wrong shape each time:
//   "get one open warranty request"  → "There are no open warranty requests in Atlanta West."
//   "get any open warranty request"  → "No open warranty requests in Atlanta West."
//   "get the first warranty task"    → "No warranty tasks found with status 'new' in Atlanta West."
// All three bound `divisionId: ""` — correctly, the ask named no division — and the three-rung ladder then filled it
// with the NARROWEST available scope. For "get open warranty tasks in Charlotte North" that ladder is right. For
// "get ANY open warranty request" it inverts the request: "any" is the user explicitly declining to name a scope, and
// there were 20 open tasks one division over.
//
// So blank is not one thing. It means "no scope named", and an EXISTENTIAL quantifier turns that into "and I mean
// anywhere". This module decides only that — whether the ask carries such a quantifier. What to DO about it (widen
// after an empty scoped read) belongs to the executor.
//
// DELIBERATELY NARROW. The quantifier must be attached to the ASK's object, so a leading determiner-ish word counts
// and a mid-sentence "any" inside a scoped phrase does not: "get any task in Raleigh" already NAMES its scope and the
// explicit rung wins before this is ever consulted — but "one of the Raleigh tasks" must not be read as existential
// either, so an ask that mentions a scope at all is left to the caller's explicit-first ordering.

const _norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// The quantifiers that mean "I don't care which one". `first`/`next`/`latest` are ordinal rather than existential but
// carry the same scope implication — the user wants ONE, from wherever they are.
//
// `a` AND `an` ARE DELIBERATELY ABSENT. They read as quantifiers and are indistinguishable from bare articles at word
// level, which made every one of these a false positive on the first draft: "open a case about the leaking
// dishwasher", "draft a reply to the homeowner", "create a sub-task for this", "get warranty tasks for a homeowner".
// The intent they would add is already carried by any/one/some/first, and an over-eager widen spends 121 reads on an
// ask that never asked about scope. Telling an article from a quantifier needs a parser, not a word list — so this
// list declines to try.
const _EXISTENTIAL = /\b(?:any|one|some|first|next|latest|newest|oldest|another|anything|anywhere)\b/;

// Words that mean the OPPOSITE — a request for the whole set. An ask carrying these is not existential even if it
// also carries "any" ("all of any kind" is not a phrasing anyone uses, but "how many" plus "a" is).
const _COLLECTIVE = /\b(?:all|every|each|total|count|how\s+many|list\s+(?:all|every)|everything)\b/;

/**
 * Does this ask ask for ONE of something, from anywhere? PURE.
 *
 * True only when an existential quantifier is present, no collective quantifier is, and the ask is short enough to be
 * about one thing — a long clause is usually a compound request whose scope comes from elsewhere.
 */
export function isExistentialAsk(ask) {
  const q = _norm(ask);
  if (!q) return false;
  if (_COLLECTIVE.test(q)) return false;
  if (!_EXISTENTIAL.test(q)) return false;
  return q.split(' ').length <= 9;
}

/**
 * v2.74.1891 — AN UNSCOPED AGGREGATE ASK MEANS EVERYTHING I CAN SEE. PURE. (User ruling, 2026-07-30.)
 *
 * Live 16:08, thirty-one seconds apart, both sentences internally honest and the PAIR incoherent:
 *     total open warranty tasks?        → "0 open warranty tasks in Atlanta West"
 *     is there anything open right now? → "Yes — 22 open across all 121 divisions"
 * The existential twin widened past a scope nobody named; the collective one was vetoed by `_COLLECTIVE` and answered
 * from the account's default division. That veto was written when widening cost 121 list reads to return one row; the
 * metric sweep measured 2.2 seconds, and the alternative was answering 0 when the answer was 22.
 *
 * So the two shapes now agree on SCOPE and differ only in what they DO with it: an existential ask wants one from
 * anywhere (stop at the first), an aggregate ask wants the whole number (read them all). Keeping them as separate
 * predicates rather than widening `isExistentialAsk` is deliberate — that function gates the EARLY STOP too, and a
 * collective ask answered by stopping at the first hit would reply to "how many are open" with "here's one".
 *
 * No length cap here, unlike the existential test: length is a proxy for "about one thing", which a total never is.
 * An aggregate ask that NAMES its scope ("how many open in Raleigh") is not this function's problem — the caller only
 * widens an axis the ask left to a default or to the conversation.
 */
export function isCollectiveAsk(ask) {
  const q = _norm(ask);
  return !!q && _COLLECTIVE.test(q);
}

/**
 * Which quantifier earned it? PURE. For the trace line — "widened on 'any'" is checkable, "widened" is not.
 */
export function existentialToken(ask) {
  const m = _norm(ask).match(_EXISTENTIAL);
  return m ? m[0] : '';
}

/**
 * v2.74.1897 — IS THIS A SUPERLATIVE OVER GROUPS? PURE. Returns 'max' | 'min' | null.
 *
 * Live (gl 18:36), asked twice four minutes apart: `which division has the most open tasks?` →
 * *"**23** open (openwarrantytasks) across all 121 divisions, in 12 of 121."* That is a total, not a division. The
 * fan had summed 121 per-division numbers and thrown away which was which — an argmax over data already in hand.
 *
 * DISTINCT FROM `askedMetric`, which answers "which measure"; this answers "ranked how". Both are needed: "the most
 * OPEN tasks" names a measure AND a ranking, and either alone gives the wrong sentence. Kept out of the ordinal
 * family (`newest`/`oldest`) on purpose — those rank RECORDS by a field, this ranks GROUPS by a count.
 */
const _SUPERLATIVE_MAX = /\b(?:most|highest|largest|biggest|greatest|worst|top)\b/;
const _SUPERLATIVE_MIN = /\b(?:fewest|least|lowest|smallest|best)\b/;
export function superlativeAsk(ask) {
  const q = _norm(ask);
  if (!q) return null;
  if (_SUPERLATIVE_MAX.test(q)) return 'max';
  if (_SUPERLATIVE_MIN.test(q)) return 'min';
  return null;
}

/**
 * v2.74.1889 — WHICH MEASURE IS THE ASK ABOUT? PURE. Returns {label, value} or null when it cannot tell.
 *
 * WHY THIS EXISTS. `is there anything open right now?` is an existential ask by every test in this module — and live
 * (gl 09:48) it answered *"No, there are no open warranty tasks in **Atlanta West**"*, a division the user never named,
 * while eighteen open tasks sat in ten others. The widen never ran, and the reason was one line upstream:
 *
 *     if (rowsFromValue(value).length) return false;   // it found something — that IS the answer
 *
 * A STATS payload always returns one envelope row, so "found something" was true while the thing asked about was ZERO.
 * The widen can see an empty ROW LIST and cannot see an empty COUNT. Twin doors again: the same ask routed to the LIST
 * leg widens correctly (its `array[0]` trips the test), and routing to the stats leg blinds it — which v1888 made MORE
 * likely, because it made the stats leg the better answer for counts.
 *
 * THE DISCRIMINATING-TOKEN RULE. A payload's measures are labelled by their own bucket names
 * (`newwarrantytasks` · `openwarrantytasks` · `fixedwarrantytasks`), so "which one did they mean" is a word-match — but
 * a token EVERY label carries ("warranty") says nothing about which, and matching on it would sum all three and
 * conclude "there is something" from the 400 fixed ones. So only a token that separates the labels counts. That keeps
 * this site-agnostic: no open/new/fixed vocabulary is hardcoded, and any app whose counts are keyed by state works.
 *
 * Several matched labels are SUMMED ("how many open and fixed…"), because the question they answer — is there any —
 * is satisfied by either.
 */
export function askedMetric(ask, metrics) {
  const m = (metrics && typeof metrics === 'object' && !Array.isArray(metrics)) ? metrics : null;
  if (!m) return null;
  const labels = Object.keys(m).filter((k) => typeof m[k] === 'number' && Number.isFinite(m[k]));
  if (!labels.length) return null;
  const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Camel/underscore segments, when the label has any: `TotalOpen` → [total, open]. `openwarrantytasks` has none, which
  // is why the head of the squashed run counts too.
  const segs = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const sq = labels.map((l) => ({ label: l, s: squash(l), w: segs(l) }));
  // v2.74.1889 — A SHORT TOKEN MUST NOT MATCH MID-WORD. Its own test caught this: "any" is inside "comp**any**totals",
  // so `any?` picked a company total. The codebase already learned this twice (`fieldPhraseCandidates`' 4-char rung
  // floor, `pickFieldPath`'s `_MIN_SUBSTR`) — but a flat floor of 4 would drop "new", a real status word. So the rule is
  // POSITIONAL rather than a length cut: an exact segment, or the head of the run, or (4+) anywhere.
  const _match = (x, t) => x.w.includes(t) || x.s.startsWith(t) || (t.length >= 4 && x.s.includes(t));
  const toks = [...new Set(_norm(ask).split(' ').filter((t) => t.length >= 3))];
  const hits = (t) => sq.filter((x) => _match(x, t)).length;
  const disc = toks.filter((t) => { const h = hits(t); return h >= 1 && (h < sq.length || sq.length === 1); });
  if (!disc.length) return null;
  const matched = sq.filter((x) => disc.some((t) => _match(x, t)));
  if (!matched.length) return null;
  // v2.74.1890 — the TOKENS that earned the match ride along: they are the user's own words for the measure
  // ("open"), and a sentence built from them beats one built from the payload's key ("openwarrantytasks").
  const tokens = disc.filter((t) => matched.some((x) => _match(x, t)));
  return { label: matched.map((x) => x.label).join(' + '), value: matched.reduce((n, x) => n + m[x.label], 0), tokens };
}
