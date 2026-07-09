// Core/ticketEvidence.js — FL-10a (v2.74.1383). The Zendesk/aircall EVIDENCE EXTRACTOR behind the sweep's drill
// phase: deterministic per-ticket facts (sentiment, commitments, transcript quotes, identity keys) from full
// ticket threads, so the propose model judges from EVIDENCE instead of subject lines — and so unattended
// execution can be gated on CODE-verified proof, never on the model's say-so.
//
// Layer honesty: this is CONNECTOR-DOMAIN knowledge (like the recipes in connectorRecipes.js), NOT fleet-harness
// logic. The harness stays app-blind: a list recipe declares `drill: { via: '<read recipeId>' }` (data), the
// harness runs the machinery, and THIS module knows what an aircall comment looks like. Ground truth for every
// pattern: logs/run/zendesk-queue-workflow-spec.md (the Claude Code MVP's field map, §3) — "Call Sentiment:"
// lives in an internal comment BODY (not a tag/field); requester_id is a PLACEHOLDER on aircall tickets and
// SHARED on SAS intakes (identity must match on body email/phone/name/#ref instead); a bare "Call Initiated"
// stub populates its call-intelligence (`ci-*` tags + transcript) up to ~an hour AFTER creation.
//
// PURE: no chrome / DOM / LLM / storage. Everything here is testable from fixtures.

// ── the observed comment/body grammar (spec §3 — body-pattern matched, never author-id config) ──────────────────
const CI_TAG_RE = /^ci-/;
const SENTIMENT_RE = /(?:^|\n)\s*Call Sentiment:\s*([A-Za-z]+)/i;          // "Call Sentiment:  POSITIVE" (double space observed)
const ACTION_ITEM_RE = /(?:^|\n)\s*Action Item:\s*([^\n]{1,200})/i;        // presence = an OPEN COMMITMENT (spec §4.1.5)
const TRANSCRIPT_RE = /(?:^|\n)\s*Call transcription\b/i;
const VOICEMAIL_RE = /Voicemail:\s*(Yes|No)/i;
const CUSTOMER_LINE_RE = /^\+?[\d][\d\s()+.-]*Aircall new contact:\s*(.+)$/i;  // "+1772… Aircall new contact: <utterance>"
const STUB_BODY = 'call initiated';
// identity keys (spec §4.2 — priority: #ref > email > phone > name; requester_id ONLY between plain tickets)
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?1?[\s.(-]*\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}(?!\d)/g;     // US-shaped (the workspace's reality); normalized to last-10 digits
const REF_RE = /(?:ticket|case)(?:\s*(?:number|no\.?))?\s*(?:is\s*)?#?\s*(\d{4,10})|#\s?(\d{4,10})/gi;
const NAME_LABEL_RE = /(?:^|\n)[|\s]*(?:customer\s+)?name[|\s]*[:|][|\s]*([A-Za-z][A-Za-z .'’-]{2,40})/i;

const _str = (v) => (typeof v === 'string' ? v.trim() : '');
const _clean = (s) => String(s || '').replace(/[<>`]/g, "'");   // quotes ride inside prompt fences — keep them fence-clean

/** Find the primary array-of-objects in a read value (tickets list / {results:[…]} / {comments:[…]}). PURE. */
export function listRows(value) {
  if (Array.isArray(value)) return value.some((x) => x && typeof x === 'object') ? value : [];
  if (!value || typeof value !== 'object') return [];
  let best = null;
  for (const v of Object.values(value)) {
    if (Array.isArray(v) && v.some((x) => x && typeof x === 'object') && (!best || v.length > best.length)) best = v;
  }
  return best || [];
}

const _phoneKey = (raw) => { const d = String(raw).replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
const _nameKey = (raw) => String(raw).toLowerCase().replace(/[^a-z]/g, '');
/** Bounded edit distance (≤2) for fuzzy name matching ("Latonya"/"Latanya", spec §4.2.4). */
function _editLe2(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length] <= 2;
}
const _namesMatch = (a, b) => !!a && !!b && (a === b || (a.length >= 6 && b.length >= 6 && _editLe2(a, b)));

/**
 * Deterministic evidence extract for ONE ticket: the list row (tags/description/assignee — already read) + its
 * full comment thread (the drill read). Everything the solve/merge/hold rubrics key on. PURE.
 */
export function extractTicketEvidence(row, comments, { now = Date.now() } = {}) {
  const r = (row && typeof row === 'object') ? row : {};
  const tags = Array.isArray(r.tags) ? r.tags.map(String) : [];
  const klass = tags.includes('sas_flex') ? 'sas' : (tags.includes('aircall') ? 'aircall' : 'other');
  const ciTags = tags.filter((t) => CI_TAG_RE.test(t));
  const cs = (Array.isArray(comments) ? comments : []).filter((c) => c && typeof c.body === 'string');
  let sentiment = null, actionItem = null, transcriptBody = '', voicemail = null;
  for (const c of cs) {
    const b = c.body;
    const sm = b.match(SENTIMENT_RE); if (sm) sentiment = sm[1].toUpperCase();
    const am = b.match(ACTION_ITEM_RE); if (am) actionItem = _clean(am[1]).slice(0, 140);
    if (TRANSCRIPT_RE.test(b)) transcriptBody = b;
    const vm = b.match(VOICEMAIL_RE); if (vm) voicemail = /yes/i.test(vm[1]);
  }
  const transcript = !!transcriptBody;
  const descr = String(r.description || '');
  const populated = ciTags.length > 0 || transcript;
  const stub = descr.trim().toLowerCase() === STUB_BODY && !populated;
  // identity scan — description + bodies, bounded per source (contact tables/refs sit near the top; transcripts
  // contribute the caller phone via their speaker lines)
  const hay = [descr.slice(0, 4000), ...cs.map((c) => c.body.slice(0, 4000))].join('\n');
  const emails = [...new Set((hay.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))].slice(0, 6);
  const phones = [...new Set((hay.match(PHONE_RE) || []).map(_phoneKey).filter(Boolean))].slice(0, 6);
  const selfId = r.id != null ? String(r.id) : '';
  const refs = []; let m;
  const refRe = new RegExp(REF_RE.source, 'gi');
  while ((m = refRe.exec(hay)) !== null) { const id = m[1] || m[2]; if (id && id !== selfId && !refs.includes(id)) refs.push(id); if (refs.length >= 6) break; }
  const names = []; const nm = descr.match(NAME_LABEL_RE); if (nm) names.push(_clean(nm[1]).trim());
  // confirmation quotes — the CUSTOMER's last transcript utterances (the "she confirmed" evidence, spec §9.3)
  const confirmLines = transcriptBody
    ? transcriptBody.split('\n').map((l) => { const c = l.trim().match(CUSTOMER_LINE_RE); return c ? _clean(c[1]).trim() : null; }).filter((q) => q && q.length >= 8).slice(-2).map((q) => q.slice(0, 120))
    : [];
  const created = Date.parse(r.created_at || '');
  return {
    id: selfId, subject: _clean(String(r.subject || '')).slice(0, 80), status: _str(String(r.status || '')),
    klass, answered: tags.includes('answered_call'), ciTags, stub, populated,
    sentiment, actionItem, transcript, voicemail, confirmLines,
    identity: { emails, phones, names, refs },
    assigneeId: r.assignee_id ?? null, requesterId: r.requester_id ?? null,
    ageMs: Number.isFinite(created) ? Math.max(0, now - created) : null,
    updatedAt: r.updated_at || null, commentCount: cs.length,
  };
}

/**
 * The SOLVABLE rubric as code (spec §4.1) — the checks that are deterministically checkable. Customer-confirmation
 * itself stays the model's judgment (it must QUOTE the confirming line); this predicate is what unattended
 * execution requires IN ADDITION to the autonomy policy (auto = POSITIVE only, spec §9.2). PURE.
 */
export function solveVerdict(ev, { me = null } = {}) {
  const missing = [];
  if (!(ev.klass === 'aircall' && ev.answered)) missing.push('not an answered call record');
  if (!ev.transcript) missing.push('no transcript');
  if (!(ev.sentiment === 'POSITIVE' || ev.sentiment === 'NEUTRAL')) missing.push(ev.sentiment === 'NEGATIVE' ? 'negative sentiment' : 'no sentiment posted');
  if (ev.actionItem) missing.push('open commitment');
  if (!(me != null && ev.assigneeId != null && String(ev.assigneeId) === String(me))) missing.push('not assigned to me');
  const holds = [];
  if (ev.stub && !ev.populated) holds.push('call intelligence not posted yet — too new to judge');
  if (ev.actionItem) holds.push(`open commitment: ${ev.actionItem}`);
  if (ev.sentiment === 'NEGATIVE') holds.push('negative sentiment — needs a human');
  const eligible = missing.length === 0;
  return { eligible, autoEligible: eligible && ev.sentiment === 'POSITIVE', missing, holds };
}

/** Empty-stub close rubric (spec §9.2): a bare "Call Initiated" with NOTHING after `afterMs` = hang-up/wrong
 * number — reversible to clear (status solved). Younger stubs are HOLDs (call intelligence lags ≤~1h). PURE. */
export function stubCloseVerdict(ev, { afterMs = 4 * 3600e3 } = {}) {
  const bare = ev.stub && !ev.populated;
  const aged = bare && ev.ageMs != null && ev.ageMs >= afterMs;
  return { eligible: aged, autoEligible: aged, tooNew: bare && !aged };
}

/**
 * Same-customer clustering over drilled evidences — union-find on identity keys, priority per spec §4.2:
 * explicit #ticket-ref > email > phone > fuzzy name; requester_id counts ONLY between two plain ('other')
 * tickets (aircall = placeholder ids, SAS = one shared intake user — the spec's hard-won exception). PURE.
 */
export function clusterTickets(evidences) {
  const evs = (Array.isArray(evidences) ? evidences : []).filter((e) => e && e.id);
  const parent = new Map(evs.map((e) => [e.id, e.id]));
  const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); parent.set(x, r); return r; };
  const keysByPair = new Map();
  const link = (a, b, key) => {
    const pk = [a.id, b.id].sort().join('|');
    if (!keysByPair.has(pk)) keysByPair.set(pk, []);
    if (!keysByPair.get(pk).includes(key)) keysByPair.get(pk).push(key);
    parent.set(find(a.id), find(b.id));
  };
  for (let i = 0; i < evs.length; i++) for (let j = i + 1; j < evs.length; j++) {
    const a = evs[i], b = evs[j];
    if (a.identity.refs.includes(b.id) || b.identity.refs.includes(a.id)) link(a, b, 'ticket-ref');
    if (a.identity.emails.some((e) => b.identity.emails.includes(e))) link(a, b, 'email');
    if (a.identity.phones.some((p) => b.identity.phones.includes(p))) link(a, b, 'phone');
    if (a.identity.names.some((n) => b.identity.names.some((n2) => _namesMatch(_nameKey(n), _nameKey(n2))))) link(a, b, 'name');
    if (a.klass === 'other' && b.klass === 'other' && a.requesterId != null && String(a.requesterId) === String(b.requesterId)) link(a, b, 'requester');
  }
  const groups = new Map();
  for (const e of evs) { const r = find(e.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(e.id); }
  const out = [];
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const matchedBy = [];
    for (const [pk, keys] of keysByPair) { const [x, y] = pk.split('|'); if (ids.includes(x) && ids.includes(y)) for (const k of keys) if (!matchedBy.includes(k)) matchedBy.push(k); }
    out.push({ ids: ids.slice().sort(), matchedBy });
  }
  return out;
}

/**
 * Merge advice for one cluster (spec §4.2): survivor = the richer/owned thread (plain thread > call record,
 * mine > theirs, then oldest). CROSS-AGENT survivor → advice 'solve-own' (never merge into another agent's
 * ticket — solve your own record and note the duplicate). `me` unknown + an assigned survivor = cross-agent
 * (fail closed). PURE.
 */
export function mergeAdvice(cluster, byId, { me = null } = {}) {
  const members = cluster.ids.map((id) => byId.get(id)).filter(Boolean);
  if (members.length < 2) return null;
  const score = (e) => (e.klass === 'other' ? 4 : 0) + (me != null && e.assigneeId != null && String(e.assigneeId) === String(me) ? 2 : 0) + (e.populated ? 1 : 0);
  const survivor = members.slice().sort((a, b) => (score(b) - score(a)) || ((a.ageMs ?? 0) < (b.ageMs ?? 0) ? 1 : -1))[0];   // score, then OLDER wins
  const crossAgent = survivor.assigneeId != null && !(me != null && String(survivor.assigneeId) === String(me));
  // FL-10e — a survivor that is already solved/closed means the ISSUE WAS ALREADY HANDLED (the MVP's checklist
  // hit "routinely shows the issue was already handled"): merging into it is impossible (Zendesk refuses) and
  // pointless — clear the fresh duplicate instead.
  const alreadyHandled = survivor.status === 'solved' || survivor.status === 'closed';
  return {
    survivorId: survivor.id,
    sourceIds: cluster.ids.filter((id) => id !== survivor.id),
    crossAgent, alreadyHandled, matchedBy: cluster.matchedBy,
    advice: (crossAgent || alreadyHandled) ? 'solve-own' : 'merge',
  };
}

/**
 * Triage v2 (FL-10e, v2.74.1384): LANE-PARTITIONED budget — the first live fire proved a single ranked list is
 * scope-blind: the newest unassigned inflow (assignment candidates, which need NO drill — they're list-level
 * decisions) outscored MY open tickets, the only ones the solve rubric can ever apply to, so the closeable
 * tickets were never read. Lanes spend the budget by PURPOSE:
 *   D — held re-checks (poll-until-populated: seen 'held' entries still in the queue) — always first, ≤3
 *   A — MY solve candidates (mineIds; populated/answered/newest first) — the protected majority share
 *   B — merge candidates (#ref rows + their referenced counterparts + SAS intakes) — ≤2 seed slots
 *   C — aged bare stubs (close candidates, ≥2h old) — ≤2 seed slots
 * Leftover budget backfills A → B → C. `seen` skips unchanged already-judged rows everywhere. PURE.
 */
export function pickDrillCandidates(rows, { cap = 8, seen = {}, mineIds = null, now = Date.now() } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id != null);
  const byId = new Map(list.map((r) => [String(r.id), r]));
  const budget = Math.max(1, cap);
  const tagsOf = (r) => (Array.isArray(r.tags) ? r.tags : []);
  const hasCi = (r) => tagsOf(r).some((t) => CI_TAG_RE.test(String(t)));
  const isStubRow = (r) => String(r.description || '').trim().toLowerCase() === STUB_BODY && !hasCi(r);
  const ageOf = (r) => { const c = Date.parse(r.created_at || ''); return Number.isFinite(c) ? Math.max(0, now - c) : null; };
  const hasRef = (r) => new RegExp(REF_RE.source, 'i').test(`${r.subject || ''}\n${r.description || ''}`);
  const skip = (id, r) => { const sn = seen && seen[id]; return !!sn && sn.s === 'done' && sn.u === (r.updated_at || null); };
  const picked = new Map();   // id → {id, row, lane}
  const take = (r, lane) => { const id = String(r.id); if (!picked.has(id)) picked.set(id, { id, row: r, lane }); };
  const room = () => budget - picked.size;

  // D — held stubs re-check (cheap re-reads; the "re-checked next sweep" promise), bounded so bursts can't eat the budget
  const held = list.filter((r) => { const sn = seen && seen[String(r.id)]; return !!sn && sn.s === 'held'; });
  for (const r of held.slice(0, Math.min(3, budget))) take(r, 'held');

  // A — my open tickets, judgeable first: populated (ci-* visible in list tags) > answered > newest
  const laneA = list
    .filter((r) => mineIds && mineIds.has(String(r.id)) && !picked.has(String(r.id)) && !skip(String(r.id), r))
    .sort((a, b) => (Number(hasCi(b)) - Number(hasCi(a)))
      || (Number(tagsOf(b).includes('answered_call')) - Number(tagsOf(a).includes('answered_call')))
      || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const aShare = Math.max(1, Math.ceil(room() * 0.6));
  for (const r of laneA.slice(0, Math.min(aShare, room()))) take(r, 'mine');

  // B — merge candidates: #ref carriers first (strongest identity signal), then SAS intakes; pull ref counterparts in
  const laneB = list
    .filter((r) => !picked.has(String(r.id)) && !skip(String(r.id), r) && (hasRef(r) || tagsOf(r).includes('sas_flex')))
    .sort((a, b) => (Number(hasRef(b)) - Number(hasRef(a))) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  for (const r of laneB.slice(0, Math.min(2, room()))) take(r, 'merge');
  for (const c of [...picked.values()]) {
    if (room() <= 0) break;
    const re = new RegExp(REF_RE.source, 'gi'); let m;
    const text = `${c.row.subject || ''}\n${c.row.description || ''}`;
    while ((m = re.exec(text)) !== null && room() > 0) {
      const rid = m[1] || m[2];
      if (rid && rid !== c.id && byId.has(rid) && !picked.has(rid) && !skip(rid, byId.get(rid))) take(byId.get(rid), 'merge');
    }
  }

  // C — aged bare stubs (close candidates once the verdict window passes)
  const laneC = list
    .filter((r) => !picked.has(String(r.id)) && !skip(String(r.id), r) && isStubRow(r) && (ageOf(r) ?? 0) >= 2 * 3600e3)
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));   // oldest first
  for (const r of laneC.slice(0, Math.min(2, room()))) take(r, 'stub');

  // backfill leftover budget: more of mine, then merge, then stubs
  for (const r of laneA) { if (room() <= 0) break; take(r, 'mine'); }
  for (const r of laneB) { if (room() <= 0) break; take(r, 'merge'); }
  for (const r of laneC) { if (room() <= 0) break; take(r, 'stub'); }
  return [...picked.values()];
}

// ── FL-10e — the EVIDENCE BANK: compact per-ticket facts persisted in fleetSeen so RELATEDNESS works ACROSS
// fires (clustering used to see only the ≤8 tickets of one run — same-customer pairs essentially never met, and
// an already-solved twin was invisible). Identity keys stored raw: they already live in the conversation records
// and proposal evidence in the same chrome.storage; the LLM-egress path is unchanged (the bank never rides the
// prompt — only match-key NAMES + counterpart ids/status do). ──────────────────────────────────────────────────

/** Evidence → the compact bank entry persisted per ticket. PURE. */
export function toBankEntry(ev, { now = Date.now() } = {}) {
  return {
    e: ev.identity.emails.slice(0, 3), p: ev.identity.phones.slice(0, 3), n: ev.identity.names.slice(0, 2), r: ev.identity.refs.slice(0, 4),
    k: ev.klass, sen: ev.sentiment || null, ai: !!ev.actionItem, as: ev.assigneeId ?? null, st: ev.status || '',
    cr: ev.ageMs != null ? now - ev.ageMs : null, pop: !!ev.populated, cc: ev.commentCount || 0, sub: ev.subject.slice(0, 50),
  };
}

/** Bank entry → an evidence-shaped object clusterTickets/mergeAdvice can consume. PURE. */
export function bankEvidence(id, b, { now = Date.now() } = {}) {
  return {
    id: String(id), subject: String(b.sub || ''), status: String(b.st || ''), klass: b.k || 'other',
    answered: false, ciTags: [], stub: false, populated: !!b.pop,
    sentiment: b.sen || null, actionItem: b.ai ? '(from a prior sweep)' : null, transcript: false, voicemail: null, confirmLines: [],
    identity: { emails: Array.isArray(b.e) ? b.e : [], phones: Array.isArray(b.p) ? b.p : [], names: Array.isArray(b.n) ? b.n : [], refs: Array.isArray(b.r) ? b.r : [] },
    assigneeId: b.as ?? null, requesterId: null,
    ageMs: b.cr != null ? Math.max(0, now - b.cr) : null, updatedAt: null, commentCount: b.cc || 0, fromBank: true,
  };
}

/** Roll the fleetSeen pass-state after a drill: judged rows marked done, holds marked held (re-drill next fire),
 * each carrying its bank entry; bounded to `cap` newest entries. PURE — returns a fresh object. */
export function updateSeen(seen, drilled, { now = Date.now(), cap = 200 } = {}) {
  const next = { ...(seen && typeof seen === 'object' ? seen : {}) };
  for (const d of (Array.isArray(drilled) ? drilled : [])) {
    if (!d || !d.id) continue;
    next[String(d.id)] = { u: d.updatedAt || null, s: d.held ? 'held' : 'done', at: now, ...(d.bank ? { b: d.bank } : {}) };
  }
  const ids = Object.keys(next);
  if (ids.length > cap) {
    ids.sort((a, b) => (next[b].at || 0) - (next[a].at || 0));
    for (const id of ids.slice(cap)) delete next[id];
  }
  return next;
}

/** Derive MY agent id from mine-scoped list rows (a `pulse {scope:'mine'}` read's assignees are all me): exactly
 * one distinct non-null id → that's me; anything else → null (downstream checks fail CLOSED). PURE. */
export function deriveMe(rows) {
  const ids = new Set();
  for (const r of (Array.isArray(rows) ? rows : [])) { if (r && r.assignee_id != null) ids.add(String(r.assignee_id)); }
  return ids.size === 1 ? [...ids][0] : null;
}

const _fmtAge = (ms) => { if (ms == null) return 'age n/a'; const m = Math.round(ms / 60000); return m < 60 ? `${m}m old` : (m < 2880 ? `${Math.round(m / 60)}h old` : `${Math.round(m / 1440)}d old`); };

/**
 * Render the drill's findings as the prompt's <TICKET_EVIDENCE> lines: per-ticket facts + verdict + customer
 * quotes, then the same-customer clusters with their merge advice. Quotes/subjects are customer content —
 * fence-cleaned here, and the block's note marks them data-never-instructions. PURE.
 */
export function renderTicketEvidence(evidences, advices, { verdicts = null, me = null } = {}) {
  const lines = [];
  for (const ev of (Array.isArray(evidences) ? evidences : [])) {
    const v = verdicts && verdicts.get ? verdicts.get(ev.id) : null;
    const who = ev.assigneeId == null ? 'unassigned' : (me != null && String(ev.assigneeId) === String(me) ? 'assigned to me' : 'ANOTHER AGENT’S');
    lines.push(`#${ev.id} "${ev.subject}" — ${ev.klass}${ev.answered ? ' answered' : ''}${ev.stub ? ' STUB' : ''} · ${who} · sentiment ${ev.sentiment || 'n/a'} · ${ev.actionItem ? `OPEN COMMITMENT: ${ev.actionItem}` : 'no open commitment'} · ${_fmtAge(ev.ageMs)} · ${ev.commentCount} comment(s)`);
    for (const q of ev.confirmLines) lines.push(`  customer: "${q}"`);
    if (v) {
      const verdictWord = v.holds && v.holds.length ? `HOLD — ${v.holds[0]}`
        : (v.autoSolve ? 'solve-eligible (pre-checked, auto-grade)' : (v.solveEligible ? 'solve-eligible (pre-checked)' : (v.closeEligible ? 'close-eligible — aged empty stub (propose status solved)' : `not solve-eligible (${(v.missing || []).join('; ') || 'insufficient evidence'})`)));
      lines.push(`  → ${verdictWord}`);
    }
  }
  for (const a of (Array.isArray(advices) ? advices : [])) {
    if (!a) continue;
    const tail = a.alreadyHandled
      ? ' is already solved/closed — the issue WAS ALREADY HANDLED: the fresh record is a duplicate of a resolved issue; solve/close it, do NOT merge'
      : (a.crossAgent ? ' is ANOTHER AGENT’S — do NOT merge; solve your own record and note the duplicate' : ` — merge #${a.sourceIds.join(', #')} into it`);
    lines.push(`SAME CUSTOMER (matched by ${a.matchedBy.join(' + ') || 'unknown'}): #${a.ids ? a.ids.join(', #') : [a.survivorId, ...a.sourceIds].sort().join(', #')} → survivor #${a.survivorId}${tail}`);
  }
  return lines;
}
