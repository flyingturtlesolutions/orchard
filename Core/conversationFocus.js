// FC-1 (v2.74.1552, DESIGN_conversation_focus.md) — CONVERSATION FOCUS: the persisted working set of grounded
// entity handles a conversation is HOLDING (a case's record, the last read), and the pure referent binder that
// resolves deictic/definite asks ("show this ticket", "open the task") against it. Restores the dual-plane
// invariant the case spawn broke: the record exists as STRUCTURE here (fields + provenance) and as PROSE in the
// seed's CASE_RECORD fence — code reads this, the model reads that. Focus is working state, NOT memory: it dies
// with the conversation and is never promoted. PURE — no chrome.*, no storage, no LLM.

import { contentTokens } from './groundVocabulary.js';

export const FOCUS_CAP = 5;

// Generic reference words: they match a KIND of entry, not a specific noun — recency (pinned-first) picks.
const GENERIC_RECORD = new Set(['ticket', 'task', 'record', 'claim', 'item', 'case', 'one', 'request', 'entry']);
const GENERIC_LIST = new Set(['list', 'results', 'items', 'them', 'rows', 'these', 'those']);

const _str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));

/** Scalars-only projection: strings sliced, empties dropped, key count capped — an entry stays small enough to
 *  persist on the conversation record. PURE. */
export function pruneFields(obj, { maxKeys = 48, maxStr = 400 } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (n >= maxKeys) break;
    if (v == null || v === '') continue;
    if (typeof v === 'string') { out[k] = v.length > maxStr ? v.slice(0, maxStr) : v; n++; }
    else if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; n++; }
  }
  return n ? out : null;
}

// v2.74.2001 — a probe may name THE RECORD instead of a field. The field follow-up (`chat.js`) matches the ask
// against field NAMES only, so `show me the details for 1Z27691W0310208693` captured the phrase
// "details for 1z27691w0310208693", failed `/^details$/`, matched no key, and fell through to the router — which
// RE-FETCHED the record pinned four seconds earlier (live 14:43). Under the retention model that is the most
// obviously RELATED follow-up there is, and the test could not see it.
//
// The rule is self-validating: strip a trailing `for|on|of|about <ref>` ONLY when <ref> is a value this record
// actually carries. "details for 1Z…" strips because the record holds that tracking number; "details for the
// other package" does not, so an unrelated ask still routes normally. Bounded traversal — a record is already
// depth/'key-capped by the pruner, and this walks the same shape.
const _refNorm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');

function _recordValues(obj, depth = 3, out = new Set(), budget = { n: 240 }) {
  if (!obj || typeof obj !== 'object' || budget.n <= 0) return out;
  for (const v of Object.values(obj)) {
    if (budget.n <= 0) break;
    if (v == null || v === '') continue;
    if (typeof v === 'string' || typeof v === 'number') { const k = _refNorm(v); if (k.length >= 3) { out.add(k); budget.n--; } continue; }
    if (typeof v === 'boolean' || depth <= 0) continue;
    if (Array.isArray(v)) { for (const e of v.slice(0, 6)) { if (e && typeof e === 'object') _recordValues(e, depth - 1, out, budget); else if (typeof e === 'string' || typeof e === 'number') { const k = _refNorm(e); if (k.length >= 3) { out.add(k); budget.n--; } } } continue; }
    _recordValues(v, depth - 1, out, budget);
  }
  return out;
}

/**
 * Strip a trailing record REFERENCE from a follow-up phrase, so a probe that names the record it is asking about
 * reduces to the field/intent word. PURE. Returns the phrase unchanged when the tail is not a value this record
 * carries — which is what keeps an unrelated ask routing normally.
 *   ("details for 1Z27691W0310208693", <record holding that number>) → "details"
 *   ("details for the other package",  <same record>)                → unchanged
 */
export function stripRecordRef(phrase, record) {
  const p = _str(phrase).trim();
  const m = p.match(/^(.*\S)\s+(?:for|on|of|about)\s+(\S.*)$/i);
  if (!m || !record || typeof record !== 'object') return p;
  const tail = _refNorm(m[2]);
  if (tail.length < 3) return p;
  for (const v of _recordValues(record)) { if (v === tail || v.endsWith(tail) || tail.endsWith(v)) return m[1].trim(); }
  return p;
}

/** The record NOUN a leg reads/writes: its name cut at qualifier clauses ("Warranty tasks by status" →
 *  "warranty tasks"). PURE. */
export function nounFromLeg(leg) {
  const name = _str(leg && leg.name).toLowerCase();
  const head = name.split(/\s+by\s+|\s+for\s+|\s+with\s+|\s*\(/)[0].trim();
  return head || 'record';
}

// noun → tokens (+ naive singulars, so "task" matches an entry built from "warranty tasks")
function _nounTokens(noun) {
  const toks = contentTokens(_str(noun));
  const out = new Set();
  for (const t of toks) { out.add(t); if (t.length > 3 && t.endsWith('s')) out.add(t.slice(0, -1)); }
  return [...out];
}

function _provenance(leg, params, labels) {
  const tool = (leg && leg.tool) || {};
  const p = {
    groundId: _str(tool.groundId) || null,
    host: _str(tool.origin || tool.appHost || tool.host).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '') || null,
    recipeId: _str(tool.recipeId) || null,
    itemUrl: _str(tool.itemUrl) || null,
    // JK-1 (v2.74.1989) — the LOOKUP LADDER. `chat.js:5709` reads `srcLeg.tool.joinKey` to build `_declared`;
    // dropped, `_declared` is null, the ladder is empty, and a map whose ask names no field (which the router is
    // INSTRUCTED to produce — interpretPrompt.js:37 says OMIT itemField UNLESS the ask names one) has nothing to
    // infer the join from. Live, same ask, same leg, same sidecar: on the REAL leg
    // `6 × shopify lookup via a 7-rung ladder → 6 matched, 0 no-match, 0 failed`; on a focus-reconstructed leg
    // `field still not found · asked itemField: ""` with no rungs at all.
    // Third field this function has silently dropped — `also` at PV-1, `matchOn`/`label` alongside it. An
    // enumeration of every `srcLeg.tool.*` read says joinKey is the LAST one: drill(12) groundId(12) joinKey(3)
    // recipeId(1). Capped at 12 to match normalizeRungs' own ceiling.
    ...(Array.isArray(tool.joinKey) && tool.joinKey.length
      ? { joinKey: tool.joinKey.slice(0, 12).map((k) => (k && typeof k === 'object' ? { ...k } : _str(k))).filter(Boolean) }
      : {}),
    // PV-1 (v2.74.1984) — CARRY THE WHOLE DRILL, not three of its six fields. Provenance existed so a focus entry
    // could be re-drilled, and it kept via/from/param while dropping `also`, `matchOn` and `label`. `also` is the
    // SIDECAR list: `vs_warranty_tasks` declares `also: ['vs_task_contacts']`, and that sidecar is the only source
    // of `ContactEmail` — the key the warranty→order chain rides on.
    // Live proof, same ask twice in one hour: at 13:43 the module prior supplied the REAL leg and the map logged
    // `enriched 7/7 via vs_warranty_task +1 sidecar → field "ContactEmail"`; at 14:45 a focus-reconstructed leg
    // gave `enriched 6/6 via vs_warranty_task → field still not found` and the map died on an empty field name.
    // Latent since provenance was written (the focus path only ran when the module prior was dead); PS-1 made
    // that path reachable while the prior is alive, which turned a rare bug into the common one.
    // Whole-object, not another hand-picked subset — that choice is what created this.
    drill: (tool.drill && tool.drill.via && tool.drill.from) ? {
      via: _str(tool.drill.via), from: _str(tool.drill.from), param: _str(tool.drill.param) || 'id',
      ...(_str(tool.drill.matchOn) ? { matchOn: _str(tool.drill.matchOn) } : {}),
      ...(Array.isArray(tool.drill.label) ? { label: tool.drill.label.slice(0, 12).map(_str).filter(Boolean) } : {}),
      // `also` entries are catalog data (a string id, or {id,from,param,pick,extract}) and must stay
      // structured-clonable — focus is persisted to chrome.storage.
      ...(Array.isArray(tool.drill.also) && tool.drill.also.length
        ? { also: tool.drill.also.slice(0, 4).map((a) => (a && typeof a === 'object' ? { ...a } : _str(a))).filter(Boolean) }
        : {}),
    } : null,
    params: pruneFields(params, { maxKeys: 8, maxStr: 80 }),
    labels: pruneFields(labels, { maxKeys: 8, maxStr: 80 }),
  };
  return p;
}

/** A RECORD focus entry (a single grounded item: a case's dossier, a drilled read). Returns null without a
 *  label or any content to hold. PURE. */
export function focusRecordEntry({ label, noun, fields, leg = null, params = null, labels = null, pinned = false, at = 0 } = {}) {
  const lbl = _str(label).slice(0, 80);
  // v2.74.2001 — a RECORD keeps its SHAPE too. RT-1 (v1991) generalised the pruner to descend precisely so a
  // stored row stops being scalars-only, then wired `_pruneDeep` into `focusListEntry` and left this call site on
  // `pruneFields`. So a pinned LIST held nested structure and a pinned RECORD did not — the "one of N call sites"
  // class, fifth instance.
  // Live 14:43: `show me the details for 1Z…` on a record pinned 4s earlier logged
  // `FIELD_FOLLOWUP ▸ no field match — fall through to routing` and RE-FETCHED from UPS. The record had 245+
  // fields with everything meaningful one or two levels down (`trackDetails[0].packageStatus`,
  // `trackDetails[0].milestones[n].{date,time,location,name}`); scalars-only retention kept none of it, so there
  // was nothing to consult and the fall-through was correct behaviour on an empty cupboard.
  // The record's own budget is preserved — 48 keys / 400 chars, NOT `_pruneDeep`'s tighter defaults — so flat
  // records are byte-identical to before (the 400 matters: a VendorExplanation's conclusion lives at its end).
  // Depth 3 / arrayCap 6 then reach the milestone chain without unbounding what rides chrome.storage.
  const f = _pruneDeep(fields, { maxKeys: 48, maxStr: 400 });
  if (!lbl || !f) return null;
  const n = _str(noun) || nounFromLeg(leg);
  return { kind: 'record', noun: n, nounTokens: _nounTokens(n), label: lbl, fields: f, provenance: _provenance(leg, params, labels), ...(pinned ? { pinned: true } : {}), at: at || 0 };
}

/** A LIST focus entry (a grounded read's row set — held for field/render follow-ups; acting on it is FC-6). PURE. */
// CT-1 (v2.74.1990) — THE LADDER'S CONTACT LIST IS NOT A SCALAR, AND `pruneFields` ONLY KEEPS SCALARS.
// `ladderValues` (Core/peritemMap.js:310) resolves a contact rung from `row['__contacts']` — an ARRAY of contact
// objects attached by the sidecar merge (chat.js:5759, "keep the FULL contact list; the ladder needs each
// contact's roles"). It never consults the flat columns. `pruneFields` has branches for string/number/boolean and
// none for arrays or objects, so the list was dropped unconditionally on the way into storage — nothing to do
// with the maxKeys cap.
// Live, same ask and same 6 rows, differing only in where the rows came from:
//   fresh read      MAP ▸ 6 × shopify lookup via a 7-rung ladder (hits: primary contact email x5, other x1) → 6 matched
//   focus-bound     MAP ▸ 6 × shopify lookup via a 7-rung ladder (no rung hit) → 0 matched, 6 no-match
// The rungs were there both times (JK-1 restored joinKey); the VALUES were not.
// Bounded like everything else that rides chrome.storage: 6 contacts, 12 scalar fields each.
// RT-1 (v2.74.1991) — GENERALISED: a stored row keeps its SHAPE, not just its scalars.
// `_keepContacts` rescued one key by name. The round-trip contract test then found a fourth casualty of the same
// flattening: `pickFieldPath` walks nested objects and array elements to depth 4 (v1903, added precisely so
// `fulfillments[].trackingInfo[].number` and `variants.edges[].node.price` are findable), and a scalars-only row
// has no such paths. That is why `read the tracking number on each order` reported `field STILL absent` off a
// focus-bound set all day: the tracking number was in the read, and storage threw the structure away.
// Rescuing keys one name at a time is what produced `also`, `joinKey`, `__contacts` and this — four incidents,
// one cause. So the pruner now descends, bounded on every axis, and the contract is asserted by a test rather
// than by a list of remembered names.
function _pruneDeep(obj, { maxKeys = 24, maxStr = 200, depth = 3, arrayCap = 6 } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (n >= maxKeys) break;
    if (v == null || v === '') continue;
    if (typeof v === 'string') { out[k] = v.length > maxStr ? v.slice(0, maxStr) : v; n++; continue; }
    if (typeof v === 'number' || typeof v === 'boolean') { out[k] = v; n++; continue; }
    if (depth <= 0) continue;
    if (Array.isArray(v)) {
      const kept = v.slice(0, arrayCap)
        .map((e) => (e && typeof e === 'object' ? _pruneDeep(e, { maxKeys, maxStr, depth: depth - 1, arrayCap })
          : (typeof e === 'string' ? e.slice(0, maxStr) : (typeof e === 'number' || typeof e === 'boolean' ? e : null))))
        .filter((e) => e != null);
      if (kept.length) { out[k] = kept; n++; }
      continue;
    }
    const sub = _pruneDeep(v, { maxKeys, maxStr, depth: depth - 1, arrayCap });
    if (sub) { out[k] = sub; n++; }
  }
  return n ? out : null;
}

export function focusListEntry({ label, noun, rows, leg = null, params = null, labels = null, at = 0 } = {}) {
  const lbl = _str(label).slice(0, 80);
  const rs = (Array.isArray(rows) ? rows : []).slice(0, 6).map((r) => _pruneDeep(r)).filter(Boolean);
  if (!lbl || !rs.length) return null;
  const n = _str(noun) || nounFromLeg(leg);
  return { kind: 'list', noun: n, nounTokens: _nounTokens(n), label: lbl, rows: rs, provenance: _provenance(leg, params, labels), at: at || 0 };
}

/** Push an entry onto a focus set: newest first, dedupe by kind+label+host (update-in-place moves to front),
 *  cap FOCUS_CAP with PINNED entries exempt from eviction. Returns a NEW array. PURE. */
export function pushFocus(list, entry, cap = FOCUS_CAP) {
  const cur = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!entry) return cur;
  const key = (e) => `${e.kind}·${_str(e.label).toLowerCase()}·${(e.provenance && e.provenance.host) || ''}`;
  const k = key(entry);
  const rest = cur.filter((e) => key(e) !== k);
  const merged = cur.find((e) => key(e) === k);
  const next = [{ ...entry, ...(merged && merged.pinned ? { pinned: true } : {}) }, ...rest];
  if (next.length <= cap) return next;
  // evict from the tail, skipping pinned
  for (let i = next.length - 1; i >= 0 && next.length > cap; i--) { if (!next[i].pinned) next.splice(i, 1); }
  return next.slice(0, Math.max(cap, next.filter((e) => e.pinned).length));
}

// ── The referential gate: lexical SHAPE only — binding requires entry evidence. ──
const _VERB = '(?:show|open|view|display|pull\\s+up|bring\\s+up)';

/** Is this ask a REFERENCE to something at hand? Returns { verb, noun, deictic } or null. An explicit ≥3-digit
 *  run is never a reference (the record-number intercepts own it). PURE. */
export function referentialAsk(text) {
  const t = _str(text).trim();
  if (!t || /\d{3,}/.test(t)) return null;
  let m = t.match(new RegExp(`^${_VERB}\\s+(?:me\\s+)?(?:this|that)\\b\\s*([\\w][\\w\\s'-]*?)?\\s*$`, 'i'));
  if (m) { const n = m[1] === undefined ? null : _cleanNoun(m[1]); if (n !== undefined) return { verb: t.match(/^\w+/)[0].toLowerCase(), noun: n, deictic: 'demonstrative' }; return null; }
  m = t.match(new RegExp(`^${_VERB}\\s+(?:me\\s+)?the\\s+([\\w][\\w\\s'-]*?)\\s*$`, 'i'));
  if (m) { const n = _cleanNoun(m[1]); if (n !== undefined && n !== null) return { verb: t.match(/^\w+/)[0].toLowerCase(), noun: n, deictic: 'definite' }; return null; }
  m = t.match(new RegExp(`^${_VERB}(?:\\s+me)?(?:\\s+it)?\\s*$`, 'i'));
  if (m) return { verb: t.match(/^\w+/)[0].toLowerCase(), noun: null, deictic: 'bare' };
  return null;
}

// VENUE words name a PLACE, not a record — "show the warranty section" is the section-opener's ask, never a
// referent. "page" is the exception: a record's page IS its venue ("show this ticket page" ≡ "show this
// ticket"), so it strips instead of rejecting.
const _VENUE_RE = /\b(?:section|dashboard|queue|board|screen|site|website|home|homepage|menu|panel|settings?)\b/i;

function _cleanNoun(s) {
  if (_VENUE_RE.test(_str(s))) return undefined;   // venue ask — the caller rejects the whole match
  const n = _str(s).toLowerCase().replace(/\b(?:page|please|now|again)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return n || null;
}

/**
 * Bind a referential ask to a focus entry. Deterministic:
 *  - specific noun (∩ entry.nounTokens) outranks generic ("ticket/task/record…"); a specific TIE between two
 *    distinct entries → { ambiguous } (never guess between real alternatives);
 *  - generic / pure-deictic → PINNED first (a case's own record IS "this ticket"), then newest;
 *  - a definite ask ("the X") with NO entry evidence binds nothing — falls through to normal routing.
 * Returns { entry, verb } | { ambiguous: entries, verb } | null. PURE.
 */
export function bindReferent(text, focus) {
  const list = (Array.isArray(focus) ? focus : []).filter((e) => e && e.kind);
  if (!list.length) return null;
  const ref = referentialAsk(text);
  if (!ref) return null;
  const toks = ref.noun ? _nounTokens(ref.noun) : [];
  const scored = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    let specific = 0; let generic = false;
    for (const t of toks) {
      // A generic word ("ticket", "task") is NEVER specific evidence on its own, even when an entry's own
      // vocabulary happens to contain it — otherwise "this ticket" in a warranty case would bind a newer
      // zendesk read over the case's pinned record. "zendesk ticket" is specific via "zendesk".
      if (GENERIC_RECORD.has(t)) { if (e.kind === 'record') generic = true; continue; }
      if (GENERIC_LIST.has(t)) { if (e.kind === 'list') generic = true; continue; }
      if ((e.nounTokens || []).includes(t)) specific++;
    }
    if (!toks.length) { scored.push({ e, score: 1, i }); continue; }   // pure deictic — every entry a candidate; order picks
    const score = specific * 10 + (generic ? 1 : 0);
    if (score > 0) scored.push({ e, score, i });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => (b.score - a.score) || ((b.e.pinned ? 1 : 0) - (a.e.pinned ? 1 : 0)) || (a.i - b.i));
  const top = scored[0];
  if (top.score >= 10) {
    const rival = scored.find((s) => s !== top && s.score === top.score && s.e.label !== top.e.label);
    if (rival) return { ambiguous: [top.e, rival.e], verb: ref.verb };
  }
  return { entry: top.e, verb: ref.verb };
}

// ── Field extraction for the on-site open (the walk's FIND value + the division). ──
const _digits = (v) => { const m = _str(v).match(/\d{5,}/); return m ? m[0] : null; };

/** The record's find/search value: /ticket/ keys → /task number/ → the drill join field → any id-ish ≥6-digit
 *  value → digits in the label. Returns a digit string or null. PURE. */
export function recordFind(entry) {
  const f = (entry && entry.fields) || {};
  const norm = (k) => _str(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
  const byKey = (re) => { for (const [k, v] of Object.entries(f)) { if (re.test(norm(k))) { const d = _digits(v); if (d) return d; } } return null; };
  const fromKey = entry && entry.provenance && entry.provenance.drill && entry.provenance.drill.from;
  return byKey(/ticket/) || byKey(/task\s*(?:number|no\b)/) || (fromKey && _digits(f[fromKey])) || byKey(/\b(?:number|id)\b/) || (() => { const m = _str(entry && entry.label).match(/\d{6,}/); return m ? m[0] : null; })();
}

/** The record's division (the walk's DIVISION option label): a /division/ field, else provenance.labels. PURE. */
export function recordDivision(entry) {
  const f = (entry && entry.fields) || {};
  for (const [k, v] of Object.entries(f)) {
    if (/division/i.test(_str(k)) && typeof v === 'string' && /[a-z]/i.test(v)) return v.trim().slice(0, 40);
  }
  const lbl = entry && entry.provenance && entry.provenance.labels;
  if (lbl) { for (const [k, v] of Object.entries(lbl)) { if (/division/i.test(_str(k)) && typeof v === 'string' && /[a-z]/i.test(v)) return v.trim().slice(0, 40); } }
  return null;
}

/** Back-compat: a pre-FC case (no conv.focus) parses its seed's fenced CASE_RECORD ONCE into a synthetic
 *  record entry — same binder, same opener. Fields from its `Key: value` lines; no provenance. PURE. */
export function focusFromSeedRecord(seed, label = 'case record') {
  const rec = (_str(seed).match(/<CASE_RECORD[^>]*>([\s\S]*?)<\/CASE_RECORD>/i) || [])[1] || '';
  if (!rec.trim()) return null;
  const fields = {};
  for (const line of rec.split('\n')) {
    const m = line.match(/^\s*-?\s*\**([\w][\w ()/-]{0,40}?)\**\s*:\s*(.+?)\s*$/);
    if (m) fields[m[1].trim()] = m[2].trim().slice(0, 400);
  }
  return focusRecordEntry({ label, noun: 'record', fields, pinned: true, at: 0 });
}
