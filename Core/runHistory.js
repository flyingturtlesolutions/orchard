// Core/runHistory.js — CD-5 (DESIGN_cadence.md §6.3 / §6.4): the run-history ENTRY shape, tally, and per-workflow
// retention with a VISIBLE truncation notice. PURE. The store (Services/Storage/WorkflowRunStore.js) wraps these;
// the SW reporter's done() and the panel's manual runs both write through the same shape.
//
// History is RUN-level (§6.3): one row per fire — "09:00 · auto · 22 items · 6 matched · 2 parked". Deep
// per-item state still lives in pipelineRun / cases; v2.74.2027 adds a COMPACT capped `items[]` of body-blind
// labels (no-match / created / …) so the history overlay can drill the outcomes without a gl join. The
// `verdict` reuses Core/pipelineRun's run verdict (already computed and thrown away on every scheduled path today)
// plus the cadence-only terminal states a scheduled run can reach.

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** The initiation stamp (§6.5, 4-way since v1746): auto = the scanner · manual = a panel ▶ · headless = ⚡ /
 * WORKFLOW_RUN_FIRE · resume = approve-and-continue. The paths genuinely behave differently (the pre-1730 scope
 * split proved it), so an audit that can't distinguish them can't catch that class. Legacy entries → 'manual'. */
export const HISTORY_TRIGGERS = Object.freeze(['auto', 'manual', 'headless', 'resume']);

/**
 * A run's terminal verdict: the five pipelineRun verdicts + the two states only a SCHEDULED run reaches —
 * `parked` (a write stopped it for a human, §8) and `disarmed` (auto-disarm on failure/orphan, §7.2). Keeping
 * these in one enum is what lets the surface say "ran and is waiting on you" vs "ran clean" (§8's load-bearing
 * distinction) from a single field.
 */
export const HISTORY_VERDICTS = Object.freeze(['complete', 'partial', 'failed', 'empty', 'running', 'parked', 'disarmed']);

export const HISTORY_CAP = 100;   // per WORKFLOW, never global — the action-ledger's shared cap-500 is the cautionary tale (§6.4)

/** Compact drill-down kinds banked on a history entry (v2.74.2027). Body-blind labels only — never row bodies. */
export const HISTORY_ITEM_KINDS = Object.freeze(['no-match', 'created', 'queued', 'blocked', 'unfillable']);
export const HISTORY_ITEM_CAP = 40;   // per entry — enough to name the misses/creates without bloating wfruns:

/**
 * Normalize one drill-down item. PURE. Drops unknown kinds; truncates label/id/note.
 * @returns {{kind:string, label:string, id?:string, note?:string}|null}
 */
export function normalizeHistoryItem(raw) {
  const o = (raw && typeof raw === 'object') ? raw : null;
  if (!o) return null;
  const kind = _str(o.kind);
  if (!HISTORY_ITEM_KINDS.includes(kind)) return null;
  const label = _str(o.label).slice(0, 80);
  if (!label) return null;
  const id = _str(o.id).slice(0, 60);
  const note = _str(o.note).slice(0, 80);
  return { kind, label, ...(id ? { id } : {}), ...(note ? { note } : {}) };
}

/** Cap + normalize a list of drill-down items. Prefer no-match/created when over cap. PURE. */
export function normalizeHistoryItems(list, { cap = HISTORY_ITEM_CAP } = {}) {
  const arr = Array.isArray(list) ? list : [];
  const c = Math.max(1, Number(cap) || HISTORY_ITEM_CAP);
  const out = [];
  for (const raw of arr) {
    const n = normalizeHistoryItem(raw);
    if (n) out.push(n);
  }
  if (out.length <= c) return out;
  // Prefer the outcomes a person drills for (misses + creates) when truncating.
  const prefer = new Set(['no-match', 'created']);
  const kept = out.filter((x) => prefer.has(x.kind));
  if (kept.length >= c) return kept.slice(0, c);
  const rest = out.filter((x) => !prefer.has(x.kind));
  return [...kept, ...rest].slice(0, c);
}

/** Group items by kind (stable kind order). PURE. */
export function groupHistoryItems(items) {
  const groups = Object.create(null);
  for (const k of HISTORY_ITEM_KINDS) groups[k] = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    if (it && groups[it.kind]) groups[it.kind].push(it);
  }
  return groups;
}

/** Cap for banked per-run trace lines on a history entry (v2.74.2030). */
export const HISTORY_TRACE_CAP = 80;

/**
 * Decision-worthy orch lines kept when joining by time window alone. The Logger main ring (500) rotates INFO
 * away under load while WARN/ERROR survive in the problems sidecar — a bare time window then surfaces only
 * noise like `GET /workspaces → 500` (live Trace regression after a busy session). PURE helper.
 */
const _TRACE_KEEP_RE = /\b(WORKFLOW|MAP|WRITE|RUN|UPSERT|DISPATCH|INTERPRET|ORCH_MATCH|BRANCH|FIELD_READ|PIPELINE|GATE|FOCUS|PRESENCE|INVOKE|SPAN|ROUTE|ACCEPT|WF_PRESET)\b|\bORCH_LOG\b/;
const _TRACE_NOISE_RE = /^(GET |POST |PUT |PATCH |DELETE |Message:|VITALS_|PAYLOAD ▸|API call )/;

/** Normalize banked trace lines `{t,m}`. PURE. */
export function normalizeHistoryTrace(list, { cap = HISTORY_TRACE_CAP } = {}) {
  const arr = Array.isArray(list) ? list : [];
  const c = Math.max(1, Number(cap) || HISTORY_TRACE_CAP);
  const out = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const m = _str(raw.m || raw.message).slice(0, 240);
    if (!m) continue;
    const t = _str(raw.t || raw.timestamp).slice(0, 40);
    out.push({ ...(t ? { t } : {}), m });
    if (out.length >= c) break;
  }
  return out;
}

/** Format banked or filtered log lines for the Trace panel. PURE. */
export function formatTraceLines(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  return arr.map((l) => {
    if (!l || typeof l !== 'object') return '';
    const t = _str(l.t || l.timestamp);
    const m = _str(l.m || l.message);
    return t ? `${t} ${m}` : m;
  }).filter(Boolean).join('\n');
}

/**
 * Filter persisted Logger entries for one history run. Join key is `runId` (stamped on WORKFLOW ▸ start/end);
 * time window `[at − pad, at + ms + pad]` covers MAP/WRITE lines that don't repeat the id.
 * v2.74.2030 — time-window hits must look like orch decision lines; otherwise the problems-sidecar leftovers
 * (HTTP 500s, Message: chatter) impersonate the run after the INFO ring rotates. PURE.
 */
export function filterLogsForRun(logs, { at = 0, ms = 0, runId = '', padMs = 5000 } = {}) {
  const arr = Array.isArray(logs) ? logs : [];
  const rid = _str(runId);
  const start = Number.isFinite(at) && at > 0 ? at : 0;
  const dur = Math.max(0, Number(ms) || 0);
  const pad = Math.max(0, Number(padMs) || 0);
  if (!rid && !start) return [];
  const t0 = start ? start - pad : 0;
  const t1 = start ? start + dur + pad : 0;
  return arr.filter((e) => {
    if (!e || typeof e !== 'object') return false;
    const msg = String(e.message || '');
    if (rid && msg.includes(rid)) return true;
    if (!start) return false;
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (!(Number.isFinite(ts) && ts >= t0 && ts <= t1)) return false;
    if (_TRACE_NOISE_RE.test(msg)) return false;
    return _TRACE_KEEP_RE.test(msg);
  });
}

/**
 * Normalize one run entry. PURE. Everything optional defaults to an honest empty; unknown trigger/verdict fall to
 * the safe value rather than being stored raw.
 *
 * @param {{at?:number, trigger?:string, verdict?:string, counts?:object, parkedRunId?:string, why?:string,
 *          coalesced?:number, ranAt?:number, items?:Array}} f
 */
export function runHistoryEntry(f = {}) {
  const at = Number.isFinite(f.at) && f.at > 0 ? f.at : 0;
  const ranAt = Number.isFinite(f.ranAt) && f.ranAt > 0 ? f.ranAt : 0;
  const coalesced = Number.isFinite(f.coalesced) && f.coalesced > 1 ? Math.floor(f.coalesced) : 0;
  const ms = Number.isFinite(f.ms) && f.ms > 0 ? Math.round(f.ms) : 0;
  // §6.5 — the FIRST failing step: a bare `failed` verdict is not auditable. Body-blind: the step's own banked
  // text + a short error word, never values.
  const fsRaw = (f.failedStep && typeof f.failedStep === 'object') ? f.failedStep : null;
  const failedStep = fsRaw && Number.isFinite(fsRaw.i)
    ? { i: Math.max(0, Math.floor(fsRaw.i)), text: _str(fsRaw.text).slice(0, 120), error: _str(fsRaw.error).slice(0, 80) }
    : null;
  const items = normalizeHistoryItems(f.items);
  const trace = normalizeHistoryTrace(f.trace);
  return {
    at,
    trigger: HISTORY_TRIGGERS.includes(f.trigger) ? f.trigger : 'manual',
    verdict: HISTORY_VERDICTS.includes(f.verdict) ? f.verdict : 'failed',
    counts: (f.counts && typeof f.counts === 'object') ? { ...f.counts } : null,
    ...(f.parkedRunId ? { parkedRunId: _str(f.parkedRunId) } : {}),          // §8 — points at the wfp_ case
    ...(f.why ? { why: _str(f.why).slice(0, 200) } : {}),                    // the disarm reason / stop cause
    ...(coalesced ? { coalesced } : {}),                                     // §7.2 — "3 due-times collapsed"
    ...(ranAt && ranAt !== at ? { ranAt } : {}),                             // §7.3 — due 09:00 · ran 14:32
    ...(ms ? { ms } : {}),                                                   // §6.5 — wall-clock duration
    ...(failedStep ? { failedStep } : {}),
    ...(f.runId ? { runId: _str(f.runId).slice(0, 40) } : {}),               // §6.5 — the gl/case join key
    ...(f.contentId ? { contentId: _str(f.contentId).slice(0, 40) } : {}),   // §6.5 — the "earlier steps" edit marker
    ...(f.resumedFrom ? { resumedFrom: _str(f.resumedFrom).slice(0, 40) } : {}),   // §6.5 — park→approve→complete as one story
    ...(items.length ? { items } : {}),                                      // v2.74.2027 — compact drill-down
    ...(trace.length ? { trace } : {}),                                      // v2.74.2030 — durable Trace (survives log ring)
  };
}

/** Append an entry to a workflow's history, evicting oldest past the PER-WORKFLOW cap. PURE — returns a new array. */
export function appendRun(list, entry, { cap = HISTORY_CAP } = {}) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  const c = Math.max(1, Number(cap) || HISTORY_CAP);
  return [...arr, entry].slice(-c);
}

/**
 * The truncation notice (§6.4): "auditable" and "silently evicts" cannot both be true — so when the retained list
 * is shorter than the lifetime total, the surface SAYS "showing the last 50 of 214" rather than presenting a
 * truncated list as a complete one. Empty string when nothing was dropped. PURE.
 */
export function truncationNotice(shownCount, total) {
  const s = Math.max(0, Number(shownCount) || 0);
  const t = Math.max(s, Number(total) || 0);
  return t > s ? `showing the last ${s} of ${t}` : '';
}

/** Render a run's counts compactly ("22 items · 6 matched · 2 parked"). Known keys only; PURE.
 * v2.74.2026 — the map/write outcome keys (`noMatch` / `created` / …) join the allow-list. Without them a
 * warranty→Shopify history row could only say "3 steps · 20 rows → complete" — scale without outcome. */
export function describeRunCounts(counts) {
  const c = (counts && typeof counts === 'object') ? counts : null;
  if (!c) return '';
  const bits = [];
  if (Number.isFinite(c.items)) bits.push(`${c.items} item${c.items === 1 ? '' : 's'}`);
  if (c.steps) bits.push(`${c.steps} step${c.steps === 1 ? '' : 's'}`);
  // Prefer `items` (map total) when both exist — `rows` was the lastValue fallback and double-counts scale.
  if (c.rows && !Number.isFinite(c.items)) bits.push(`${c.rows} row${c.rows === 1 ? '' : 's'}`);   // §6.5 — scale
  if (c.done && c.done !== c.steps) bits.push(`${c.done} done`);
  if (c.matched) bits.push(`${c.matched} matched`);
  if (c.noMatch) bits.push(`${c.noMatch} no-match`);
  if (c.noField) bits.push(`${c.noField} no-field`);
  if (c.created) bits.push(`${c.created} created`);
  if (c.queued) bits.push(`${c.queued} queued`);
  if (c.blocked) bits.push(`${c.blocked} blocked`);
  if (c.unfillable) bits.push(`${c.unfillable} unfillable`);
  if (c.parked) bits.push(`${c.parked} parked`);
  if (c.failed) bits.push(`${c.failed} failed`);
  return bits.join(' · ');
}

/** Compact duration ("24s" / "480ms" / "3m10s"). PURE. */
export function describeMs(ms) {
  const m = Math.round(Number(ms) || 0);
  if (m <= 0) return '';
  if (m < 1000) return `${m}ms`;
  const s = Math.round(m / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60 ? `${s % 60}s` : ''}`;
}

/**
 * The one-line run row (§6.3). "09:00 · auto · <counts> → verdict". `clock` is the caller's formatted ran-time;
 * `dueClock` (§7.3, v1715) is the formatted DUE-time when it differs — the row then leads "due 09:00 · ran 14:32",
 * the honesty stamp §7.3 mandates (a schedule whose first lesson is that it does not keep its word is worse than
 * no schedule). PURE.
 */
export function describeRun(entry, clock = '', dueClock = '', { currentContentId = '' } = {}) {
  const e = (entry && typeof entry === 'object') ? entry : {};
  const when = (_str(dueClock) && _str(dueClock) !== _str(clock)) ? `due ${_str(dueClock)} · ran ${_str(clock)}` : _str(clock);
  const bits = [when, e.trigger || 'manual'];
  if (e.resumedFrom) bits.push(`continues ${e.resumedFrom}`);               // §6.5 — park→approve→complete, one story
  // §6.5 — the failing step IS the story of a failed run; total from counts when known.
  if (e.failedStep && Number.isFinite(e.failedStep.i)) {
    const total = e.counts && e.counts.total ? `/${e.counts.total}` : '';
    bits.push(`failed at step ${e.failedStep.i + 1}${total}${e.failedStep.text ? ` — “${e.failedStep.text}”` : ''}${e.failedStep.error ? ` (${e.failedStep.error})` : ''}`);
  }
  const counts = describeRunCounts(e.counts);
  if (counts) bits.push(counts);
  if (e.ms) bits.push(describeMs(e.ms));                                     // §6.5 — duration
  if (e.coalesced) bits.push(`${e.coalesced} due-times collapsed`);
  const tail = e.verdict === 'parked' ? 'parked — waiting on you' : (e.verdict || 'failed');
  // §6.5 — the WHY renders (it was stored-and-hidden — the finding that opened this section); a disarm carries
  // its re-arm hint, because the row is the only place a person learns their automation stopped (§7.2).
  // v2.74.2029 — partial ALWAYS carries a brief why (banked, or derived): bare "→ partial" reads like a failure.
  let whyText = _str(e.why);
  if (!whyText && e.verdict === 'partial') {
    whyText = explainPartialWhy({
      done: e.counts && e.counts.done,
      total: e.counts && e.counts.total,
      errors: e.counts && e.counts.failed,
    });
  }
  const why = whyText ? ` — ${whyText}${e.verdict === 'disarmed' ? ' (re-arm with ⏱)' : ''}` : '';
  // §6.5 — the edit marker: this run used an EARLIER revision of the steps than the record now holds.
  const edited = (e.contentId && _str(currentContentId) && e.contentId !== _str(currentContentId)) ? ' · earlier steps' : '';
  return `${bits.filter(Boolean).join(' · ')} → ${tail}${why}${edited}`;
}

/**
 * Brief explanation for a `partial` history row (v2.74.2029). PURE.
 * Prefers an explicit stopWhy from the chain; else "finished N of M steps" / error count.
 */
export function explainPartialWhy({ done = 0, total = 0, errors = 0, stopWhy = '' } = {}) {
  const explicit = _str(stopWhy).slice(0, 160);
  if (explicit) return explicit;
  const d = Number.isFinite(done) ? Math.max(0, Math.floor(done)) : 0;
  const t = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  const err = Number.isFinite(errors) ? Math.max(0, Math.floor(errors)) : 0;
  if (d > 0 && t > d) return `finished ${d} of ${t} steps`;
  if (err > 0) return `${err} step${err === 1 ? '' : 's'} had an error`;
  return 'not all steps finished';
}

/** Rolling counts across a workflow's retained history (feeds the overlay header). PURE. */
export function historyTally(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  const n = Object.create(null);
  for (const v of HISTORY_VERDICTS) n[v] = 0;
  let auto = 0;
  for (const e of arr) { n[e.verdict] = (n[e.verdict] || 0) + 1; if (e.trigger === 'auto') auto++; }
  return { total: arr.length, auto, manual: arr.length - auto, byVerdict: n };
}
