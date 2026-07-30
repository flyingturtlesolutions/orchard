// Core/corpusFind.js — v2.74.1875 — the pure half of the FIRST SYNTHETIC LEG (`vs_task_find`).
//
// WHY A SYNTHETIC LEG. VendorSuite has no search bar — confirmed by the user, so this is not a harvesting miss.
// The site offers list-by-(division,status) and get-by-INTERNAL-id, and nothing that accepts the number a human
// actually holds (a TicketId). The catalog even says so: `displayId: ['TicketId','TaskNumber']` declares "this is
// what users quote" while every keyed leg's param is `machineOnly: true`. So find-by-human-identifier has to be
// COMPOSED from the shapes that exist: scan the (division × status) grid, filter rows, stop early on a unique id.
//
// SITE-AGNOSTIC BY CONSTRUCTION. Nothing here knows about VendorSuite: the caller passes the axis values, the
// field names, and the timing constants. The same functions serve any (collection, detail, child) triple — which
// is the point, since Zendesk tickets/comments and Shopify orders/line-items already have that shape.
//
// The impure half (the actual reads, the progress line, the abort) stays in chat.js. Everything decidable
// WITHOUT a network call lives here so it can be tested: what kind of query this is, which cells to visit and in
// what order, what it will cost, whether a row matches, and what may honestly be concluded at the end.

const _norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

// An IDENTIFIER is a single token that is mostly digits — "4867009", "#4867009", "TK-4867009", "10835071".
// Deliberately narrow: a word ("Misty") and a phrase ("Misty Creek") are TEXT, and the two kinds get different
// matching AND different stopping rules, so mis-classifying one costs either precision or a wasted full scan.
const _IDENT_RE = /^[a-z]{0,4}[-#]?\d{4,}$/;

/**
 * What kind of query is this? PURE.
 *   identifier → EXACT match against id fields, and a hit ENDS the scan (ids are unique).
 *   text       → substring match across text fields, and the scan runs to completion (there may be more).
 * Returns { kind: 'identifier'|'text', value }.
 */
export function classifyQuery(q) {
  const raw = String(q == null ? '' : q).trim();
  const value = raw.replace(/^#/, '');
  return { kind: _IDENT_RE.test(_norm(value)) ? 'identifier' : 'text', value };
}

// v2.74.1879 — REFERENTIAL QUERIES ARE NOT SEARCH STRINGS. Live 194001: `who do I call about the Misty Creek job`
// had the model emit `params:{"taskId":"prior"}` — a referential word, not an identifier — and the machinery did
// everything else right: the machineOnly redirect fired, the drill walked four statuses, and the automatic fourth
// rung then spent **484 reads and 13.6 seconds searching the corpus for the word "prior"**, concluding "the number
// may be wrong". Pre-v1875 a junk query missed in scope and stopped at four reads; making the escalation automatic
// was correct AND multiplied the cost of every upstream mis-binding by 121.
// v1862 taught `resolveRideParam` that deictic words mean "the one I'm in". The drill's free-text slot never got the
// equivalent, and the v1869 placeholder guard catches `{param}`/`[param]` but not a bare English word. A referential
// term is a REFERENCE to the record at hand — the one thing it can never be is a value to look for.
// Tokens that carry no distinguishing content: deictics/determiners, and the generic nouns a person uses when they
// mean "the one we were just looking at". A query made ENTIRELY of these has nothing to look for in it.
const _EMPTY_TOKENS = new Set([
  'this', 'that', 'these', 'those', 'it', 'its', 'the', 'a', 'an', 'my', 'our', 'mine',
  'prior', 'previous', 'last', 'latest', 'current', 'same', 'above', 'one', 'other', 'another',
  'task', 'job', 'record', 'item', 'thing', 'ticket', 'order', 'entry', 'row', 'case', 'work', 'number',
]);

/**
 * Is this query a REFERENCE rather than a value? PURE. True → resolve the referent or ask; NEVER scan for it.
 *
 * A token-set predicate rather than a phrase list: a query is referential when EVERY token is content-free, so
 * "the task", "that one", "my last job" and "it" all qualify while "Misty Creek", "job 4867009" and "that street"
 * do not — one distinguishing token is enough to make it a real query. Empty counts too: the caller's behaviour is
 * identical (do not search), even though empty is not literally a reference.
 *
 * The asymmetry is deliberate. A false positive costs one clarifying question; a false negative costs 484 reads,
 * 13.6 seconds, and a sentence telling the user their own number is probably wrong.
 */
export function isReferentialQuery(q) {
  const toks = String(q == null ? '' : q).trim().toLowerCase().split(/[\s,.'’-]+/).filter(Boolean);
  if (!toks.length) return true;
  return toks.every((t) => _EMPTY_TOKENS.has(t));
}

/**
 * Does this row match? PURE.
 * An identifier must equal an ID field OUTRIGHT — the pre-existing `filterRowsByText` joins every field into one
 * haystack and substring-matches, which would let "4867009" hit a row whose TaskId is "48670091", or match the
 * digits inside an address or a dollar amount. For a unique-id lookup that is a wrong answer, not a loose one.
 * Text keeps the substring behaviour (all tokens must appear somewhere in the row's text fields).
 * Returns the matching FIELD NAME (truthy) or null — the field is worth surfacing: "matched on ClaimNumber"
 * tells the user which of their several numbers was understood.
 */
export function matchRow(row, q, { idFields = [], textFields = [] } = {}) {
  if (!row || typeof row !== 'object') return null;
  const { kind, value } = classifyQuery(q);
  const want = _norm(value);
  if (!want) return null;
  if (kind === 'identifier') {
    for (const f of idFields) {
      const v = row[f];
      if (v == null) continue;
      if (_norm(v).replace(/^#/, '') === want) return f;
    }
    return null;
  }
  // TEXT IS TIERED. Tier 1: all tokens inside ONE field — precise, and it names the field. Tier 2: all tokens
  // anywhere across the text fields, which is what the pre-existing `filterRowsByText` did and what the drill
  // relies on ("123 main st cumming" spans AddressLine1 + city, and rideParamResolve.test.js pins that). Keeping
  // the fallback is the difference between fixing the identifier defect and regressing address recall to fix it.
  // Only IDENTIFIERS lose the haystack — that is the whole v1875 live defect ("1091", a street number, opened a
  // task as though it were a task id, because the joined haystack contained the digits).
  const toks = want.split(' ').filter(Boolean);
  for (const f of textFields) {
    const v = row[f];
    if (v == null) continue;
    if (toks.every((t) => _norm(v).includes(t))) return f;
  }
  const hay = _norm(textFields.map((f) => row[f]).filter((v) => v != null).join(' '));
  if (hay && toks.every((t) => hay.includes(t))) return '*';   // '*' = matched across fields, no single field owns it
  return null;
}

/**
 * The ONE row matcher for the whole family — partition derived from the rows, then match. PURE.
 * A drop-in for `filterRowsByText` (map `.row` for the bare rows), and the point of having it is that the strict
 * identifier rule reaches EVERY caller. v1875's precision fix lived only in the escalation path, so it ran only
 * when the loose matcher had already failed — i.e. never in the case where the loose one was wrong.
 */
export function filterRows(rows, q, labels) {
  const list = Array.isArray(rows) ? rows : [];
  const fields = { idFields: [], textFields: [] };
  for (const row of list) {
    const p = partitionFields(row, labels);
    for (const k of ['idFields', 'textFields']) for (const f of p[k]) if (!fields[k].includes(f)) fields[k].push(f);
  }
  return findInRows(list, q, fields);
}

/**
 * Split a candidate field list into ID fields and TEXT fields by looking at what a real row HOLDS. PURE.
 *
 * The alternative was declaring `idFields`/`textFields` on the recipe — a new catalog field, which is invariant
 * #3's three hops plus the seeded-path risk, for information the data already carries. Deriving it also means a
 * harvested leg nobody hand-annotated gets the same treatment as a curated one.
 *   id   — the value is identifier-shaped (mostly digits, ≥4 of them): TicketId, TaskId, ClaimNumber, JobNumber.
 *   text — the value contains a letter: AddressLine1, CityStateZip, ProjectName.
 * A short bare number like `TaskNumber: "01"` lands in NEITHER, deliberately: it is too weak to key on and too
 * numeric to substring-search, and putting it in textFields would let a text query match "01" inside anything.
 */
export function partitionFields(row, fields) {
  const idFields = []; const textFields = [];
  for (const f of (Array.isArray(fields) ? fields : [])) {
    const v = row && row[f];
    if (v == null || v === '') continue;
    const s = _norm(v);
    if (_IDENT_RE.test(s)) idFields.push(f);
    else if (/[a-z]/i.test(s)) textFields.push(f);
  }
  return { idFields, textFields };
}

/** Every matching row, each tagged with the field that matched. PURE. */
export function findInRows(rows, q, fields) {
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const on = matchRow(row, q, fields);
    if (on) out.push({ row, matchedOn: on });
  }
  return out;
}

/**
 * The cells to visit, in order. PURE. DIVISION-OUTER (v1874's lesson: status-outer made a `closed` record pay
 * three complete passes over every division first), so a hit ends the whole scan at hit-position × statuses.
 *   `division` / `status` given → that axis is pinned to one value, which is how an explicit ask stays cheap.
 *   `deprioritize` → a division already searched by the caller goes LAST. It is the one place we know the record
 *     isn't, so it is re-checked only as cheap insurance against state having moved mid-turn.
 * Returns [{ division:{value,label}, status }].
 */
export function scanCells({ divisions = [], statuses = [], division = null, status = null, deprioritize = null } = {}) {
  const ds = (division != null && String(division) !== '')
    ? divisions.filter((d) => String(d.value) === String(division) || _norm(d.label) === _norm(division))
    : divisions.slice();
  const dep = (deprioritize == null || deprioritize === '') ? null : String(deprioritize);
  const ordered = dep
    ? [...ds.filter((d) => String(d.value) !== dep), ...ds.filter((d) => String(d.value) === dep)]
    : ds;
  const sts = (status != null && String(status) !== '') ? statuses.filter((s) => _norm(s) === _norm(status)) : statuses.slice();
  const plan = [];
  for (const d of ordered) for (const s of sts) plan.push({ division: d, status: s });
  return plan;
}

/**
 * What will this cost? PURE — and it must be answerable BEFORE spending anything, because it is what lets an
 * expensive shape offer instead of surprising the user with a two-minute hang. `worstMs` is the full plan;
 * `expectedMs` assumes a unique identifier is found around halfway (meaningless for a text scan, which always
 * runs to completion — hence null).
 */
// v2.74.1878 — MEASURED, not guessed. 125ms was an eyeball from a single earlier trace and made every estimate
// 31% optimistic (`est=7.6s` against a ~10.9s actual). Two independent live sessions now agree:
//   174833 — 484 cells / 11.075s and 11.098s  → 183ms
//   190346 — 270/6.687s · 484/10.612s · 484/10.470s · 484/11.366s → 198/175/173/188ms, mean 183ms
// Recorded as a measurement with its provenance so it is not "tidied" back to a round number, and EXPORTED so the
// estimate and any future consumer share one source of truth. `_synthRunScan` now logs the observed ms/read on
// every scan, which makes the next calibration a grep instead of arithmetic — and makes drift self-reporting,
// because the gate's honesty IS this number.
export const MEASURED_MS_PER_READ = 183;

export function estimateScan(plan, { perReadMs = MEASURED_MS_PER_READ, concurrency = 8, kind = 'text' } = {}) {
  const reads = Array.isArray(plan) ? plan.length : 0;
  const lanes = Math.max(1, concurrency);
  const worstMs = Math.round((reads * perReadMs) / lanes);
  return { reads, worstMs, expectedMs: kind === 'identifier' ? Math.round(worstMs / 2) : null };
}

/**
 * What may be concluded? PURE. The point of routing the verdict through a function is that it CANNOT outrun the
 * search — and there are now TWO independent ways to fall short of a definite negative:
 *   · the READ was incomplete — `failed > 0` or an unfinished plan (v1874's defect: a 200-of-1454 truncation
 *     reported as "isn't in any of them", about a record that existed) → reason 'unread'.
 *   · the SPACE was incomplete — the axes scanned are a SELECTION of the corpus, not a partition of it. A find
 *     over Shopify's "open unfulfilled orders" or Zendesk's five overlapping views can read every cell it planned
 *     and still know nothing about the rest of the corpus → reason 'coverage'. (Core/synthEntity.js declares it;
 *     anything undeclared resolves to 'selection', so the definite negative is unreachable by default.)
 * `none` therefore requires a complete read over a PARTITION. Everything else is inconclusive, and the caller's
 * copy branches on `reason` so the sentence names which limit it hit.
 * Returns { outcome: 'one'|'many'|'none'|'inconclusive', reason?, matches, reads, failed, complete }.
 */
export function findVerdict({ matches = [], planned = 0, scanned = 0, failed = 0, coverage = 'selection' } = {}) {
  const complete = failed === 0 && scanned >= planned;
  const base = { matches, reads: scanned, failed, complete, coverage };
  if (matches.length === 1) return { outcome: 'one', ...base };
  if (matches.length > 1) return { outcome: 'many', ...base };
  if (!complete) return { outcome: 'inconclusive', reason: 'unread', ...base };
  if (coverage !== 'partition') return { outcome: 'inconclusive', reason: 'coverage', ...base };
  return { outcome: 'none', ...base };
}
