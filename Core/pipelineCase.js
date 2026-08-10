/**
 * Core/pipelineCase.js — the per-item CASE (v2.74.1665). Pure half.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §5.7 (what a case contains, and what a re-run does) · §9.3 (read the
 * existing shape first).
 *
 * ── §9.3 SAID "READ THEIRS FIRST". THE READ SAID: NEITHER FITS. ──────────────────────────────────────────────
 * A "case" today is a `Conversation` row, and the two paths that mint one do not share a definition:
 *
 *   · The DOSSIER FAN-OUT case is a sub-task conversation with **no status field at all** — existence IS open,
 *     and the only close is deletion. `ConversationStore.patchMeta`'s allow-list is closed, so adding a verdict
 *     is a store change rather than a field addition. (The incident path already proves the failure mode: it
 *     patches `summary` and `resolvedAt`, neither of which is on the allow-list, and both writes are silently
 *     dropped — so `resolvedAt` is never set and every VITALS_CHANGED re-patches forever.)
 *   · Ledger and proposals key by `instanceId`, which every case under one desk SHARES — so N per-item cases'
 *     actions land in one undifferentiated pile with no back-link.
 *   · `_runChildTask` collapses three distinct outcomes into `'needs-you'` and then DISCARDS the status: it is a
 *     return value, tallied and dropped. Failed vs never-ran is unrepresentable, which is the single distinction
 *     a per-item pipeline needs most.
 *
 * ── SO: THE VITALS SIDECAR, WHICH IS THE ONE THAT WORKS ──────────────────────────────────────────────────────
 * `Core/vitals.js` keeps an incident's REAL state (`status`, `openedAt`, `closedAt`, `evidence[]`) in its own
 * store and treats the conversation as a RENDER SHELL joined by a deterministic id. That is the precedent §9.3
 * points at, and this file mirrors it deliberately — including `upsertCase`'s open-or-append, which is the
 * closest existing analogue to per-stage verdicts and the thing that stops case-spam on a re-run.
 *
 * PURE: no storage, no clock, no chrome. The caller owns persistence and supplies `now`.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));
const _arr = (v) => (Array.isArray(v) ? v : []);

export const CASE_CAP = 200;        // total cases kept per pipeline (closed age out first, never an open one)
export const TIMELINE_CAP = 24;     // per-case stage/action entries (newest kept)

/** Terminal states. `blocked` is distinct from `failed`: we REFUSED to act, rather than tried and could not. */
export const CASE_STATES = Object.freeze(['open', 'done', 'failed', 'blocked', 'closed']);

/**
 * The record REFERENCE whitelist — never the record body (§5.7: "label + source record ref"). Copying the body
 * would duplicate customer data into a second store and put it on every render path.
 *
 * `division` (v2.74.2156) is a REFERENCE field, not body: on VendorSuite a task is addressable only as
 * (division, row text) — the division is the SCOPE half of the ref, the way `host` is for a URL-addressable
 * record. Without it a banked case can name its task and still not reach it.
 *
 * v2.74.2170 — shared by create AND append so the two shapes cannot drift; a field added here reaches both.
 */
export const CASE_REF_FIELDS = Object.freeze(['ref', 'host', 'url', 'division']);

/** Project a caller-supplied record to the reference whitelist, every field a string. PURE. */
function _recordRef(record) {
  if (!record || typeof record !== 'object') return null;
  const out = {};
  for (const k of CASE_REF_FIELDS) out[k] = _str(record[k]);
  return out;
}

/**
 * v2.74.2172 — THE ITEM KEY: a case's identity is its RECORD, never its position in the run.
 *
 * The caller was passing the array INDEX as `itemId` (`const id = String(i)`), so `caseId` resolved to
 * `pc_<pipeline>_<position>`. Every consequence of that is visible in one live line:
 *   `AUDIT ▸ case division lookup MISS want="#[ticket] · [address]" matched=y div="" of 200 case(s);
 *    labels: "03" · "01" · "01" · "01"`
 * — 200 cases at CASE_CAP, the oldest still carrying the v1617 claim-sequence labels, and a case that matched
 * the wanted label while holding no division. With position as identity:
 *   · index 3 of today's list is a DIFFERENT task from index 3 of yesterday's, so a re-run APPENDS one task's
 *     run onto another task's case — a chimera whose label came from one row and whose record came from another;
 *   · the backfill added at v2170 then writes today's division onto yesterday's label, which is exactly the
 *     `divbanked 2/2` + `divsrc=none` pair: both true, of two different cases;
 *   · `openItemIds` reads as "position 3 is under review", which is meaningless across runs.
 *
 * The rule: the record's own id when it has one, else a positional fallback that is explicitly MARKED as one so
 * a reader can never mistake it for a record key. PURE.
 */
export function caseItemKey(row, index = 0) {
  const r = (row && typeof row === 'object') ? row : {};
  const ref = _str(r.TaskId ?? r.TicketId ?? r.TaskNumber ?? r.ClaimNumber ?? r.id ?? r.Id);
  return ref ? ref : `idx:${Number(index) || 0}`;
}

/** The deterministic id — one case per (pipeline, item), which is what makes the re-run rule checkable. */
export function caseId(pipeline, itemId) {
  const p = _str(pipeline).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 24) || 'pipeline';
  const i = _str(itemId).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48) || 'item';
  return `pc_${p}_${i}`;
}

/**
 * Open-or-append. If an OPEN case exists for (pipeline, item), APPEND to its timeline; else create.
 *
 * This is `upsertIncident`'s shape and for the same reason: a re-run over the same list must grow ONE case's
 * timeline rather than minting a second case for the same record. §5.7 states the rule from the other side —
 * an item with an open case is skipped and counted as `already-open` — and these two are the same invariant
 * enforced at two layers, which is why the id is deterministic rather than random.
 */
export function upsertCase(list, { pipeline, itemId, label = '', runId = '', record = null, line = '', now = 0 } = {}) {
  const l = _arr(list).slice();
  if (!_str(pipeline) || !_str(itemId)) return { list: l, opened: false, id: '', record: null };
  const id = caseId(pipeline, itemId);
  const i = l.findIndex((x) => x && x.id === id && x.state === 'open');

  if (i >= 0) {
    const c = { ...l[i] };
    if (line) c.timeline = [..._arr(c.timeline), { at: Number(now) || 0, line: _str(line).slice(0, 160) }].slice(-TIMELINE_CAP);
    if (runId) c.runIds = [...new Set([..._arr(c.runIds), _str(runId)])].slice(-8);
    // v2.74.2170 — BACKFILL THE REFERENCE. Until now the append branch wrote only the timeline and the run id, so
    // a case's `label` and `record` were frozen at the shape they had the FIRST time the item was seen — and a
    // re-run is the norm here, not the exception. That is why `PIPELINE ▸ cases … div 2/2` and `divsrc=none` were
    // both true at once: the panel BUILT a division and sent it, the store found the case already open, and threw
    // the payload's record away. Every case in the live store was opened before `division` joined this whitelist,
    // so no amount of re-running could ever have banked one.
    //
    // FILL BLANKS ONLY, never overwrite. A stored non-empty value is the reading taken when the row was first
    // read; a later run that has lost the division (stale context, a narrower read) must not be able to erase it.
    // That makes the merge MONOTONE — it can only ever add information — which is the property that lets it run
    // unconditionally on every append without a policy about which read wins.
    if (!_str(c.label) && _str(label)) c.label = _str(label).slice(0, 120);
    const inc = _recordRef(record);
    if (inc) {
      const cur = _recordRef(c.record);
      if (!cur) c.record = inc;
      else {
        const merged = {}; let changed = false;
        for (const k of CASE_REF_FIELDS) { merged[k] = cur[k] || inc[k]; if (merged[k] !== cur[k]) changed = true; }
        if (changed) c.record = merged;
      }
    }
    l[i] = c;
    return { list: l, opened: false, id, record: c.record || null };
  }

  const _rec = _recordRef(record);   // the whitelist lives in CASE_REF_FIELDS — create and append share it
  l.push({
    id,
    pipeline: _str(pipeline),
    itemId: _str(itemId),
    label: _str(label).slice(0, 120),
    record: _rec,
    state: 'open',
    verdict: '',
    branch: null,
    openedAt: Number(now) || 0,
    closedAt: null,
    runIds: runId ? [_str(runId)] : [],
    stages: [],
    actions: [],
    timeline: line ? [{ at: Number(now) || 0, line: _str(line).slice(0, 160) }] : [],
  });

  // Cap: age out CLOSED first. Never evict an open case — an open case is work someone still owes a decision on.
  while (l.length > CASE_CAP) {
    const j = l.findIndex((x) => x && x.state !== 'open');
    if (j < 0) break;
    l.splice(j, 1);
  }
  // `record` rides the return so the CALLER can report what the STORE holds rather than what it sent — the v2137
  // lesson ("a swallowed write is indistinguishable from a write that happened") one layer down.
  return { list: l, opened: true, id, record: _rec };
}

/** Record the BRANCH outcome on a case — arm | none | unknown, with the reason and any arms it also matched. */
export function setBranch(list, id, { outcome, arm = '', why = '', skipped = [] } = {}) {
  const l = _arr(list).slice();
  const i = l.findIndex((x) => x && x.id === _str(id));
  if (i < 0) return l;
  l[i] = {
    ...l[i],
    branch: {
      outcome: _str(outcome) || 'unknown',
      arm: _str(arm),
      why: _str(why).slice(0, 200),
      skippedArms: _arr(skipped).map(_str).filter(Boolean),
    },
  };
  return l;
}

/**
 * Append a stage verdict. A stage that never ran simply has no entry — §5.7's rule that "a case missing a stage
 * and a case with a failed stage must not look identical" is enforced by never synthesizing a placeholder.
 */
export function addStage(list, id, { name, verdict, detail = '', error = null } = {}) {
  const l = _arr(list).slice();
  const i = l.findIndex((x) => x && x.id === _str(id));
  if (i < 0) return l;
  const entry = {
    name: _str(name) || 'stage',
    verdict: _str(verdict) || 'unknown',
    detail: _str(detail).slice(0, 300),
    ...(error ? { error: _str(error && error.message ? error.message : error).slice(0, 200) } : {}),
  };
  l[i] = { ...l[i], stages: [..._arr(l[i].stages), entry].slice(-TIMELINE_CAP) };
  return l;
}

/** Append an action with its approval state — the thing the gate reviews. */
export function addAction(list, id, { what, state, ref = '' } = {}) {
  const l = _arr(list).slice();
  const i = l.findIndex((x) => x && x.id === _str(id));
  if (i < 0) return l;
  const entry = { what: _str(what), state: _str(state) || 'refused', ref: _str(ref) };
  l[i] = { ...l[i], actions: [..._arr(l[i].actions), entry].slice(-TIMELINE_CAP) };
  return l;
}

/** Close a case with a terminal state. An unrecognized state becomes `failed` rather than being accepted. */
export function closeCase(list, id, { state = 'done', verdict = '', now = 0 } = {}) {
  const l = _arr(list).slice();
  const i = l.findIndex((x) => x && x.id === _str(id));
  if (i < 0) return l;
  const s = CASE_STATES.includes(state) && state !== 'open' ? state : 'failed';
  l[i] = { ...l[i], state: s, verdict: _str(verdict).slice(0, 200), closedAt: Number(now) || 0 };
  return l;
}

/** The OPEN cases for a pipeline, newest first. */
export function openCases(list, pipeline = '') {
  const p = _str(pipeline);
  return _arr(list)
    .filter((x) => x && x.state === 'open' && (!p || x.pipeline === p))
    .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
}

/** The item ids with an open case — feeds `markAlreadyOpen`, which is §5.7's re-run rule. */
export function openItemIds(list, pipeline = '') {
  return openCases(list, pipeline).map((c) => c.itemId);
}

/**
 * A one-line peek for the Rail. The existing case row renders `summary` off the index, and there is no status
 * glyph on it — so the state has to lead the string or it is invisible to a reviewer scanning the list.
 */
export function casePeek(c) {
  if (!c) return '';
  const mark = c.state === 'open' ? '○' : c.state === 'done' ? '✓' : c.state === 'blocked' ? '⛔' : c.state === 'failed' ? '✗' : '·';
  const arm = c.branch && c.branch.outcome === 'arm' ? c.branch.arm
    : c.branch && c.branch.outcome ? c.branch.outcome : '';
  const bits = [arm, c.verdict || (c.stages.length ? `${c.stages.length} stage${c.stages.length === 1 ? '' : 's'}` : '')].filter(Boolean);
  return `${mark} ${c.label || c.itemId}${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
}

/**
 * The case's most recent ACTION, as a line for the list. PURE. Empty when it has none.
 *
 * v2.74.2134 — the cases list is where the warranty contact decisions are reviewed, so the row has to say what is
 * owed and by whom. `queued-for-approval` is the affordance the per-item pipeline spec (§5.7) names for exactly
 * this, and a row that shows only "open" cannot distinguish "waiting on a person" from "nothing happened yet".
 */
export function caseActionLine(c) {
  const acts = (c && Array.isArray(c.actions)) ? c.actions.filter(Boolean) : [];
  if (!acts.length) return '';
  const a = acts[acts.length - 1];
  const state = _str(a.state);
  const mark = state === 'queued-for-approval' ? '▸ awaiting you'
    : state === 'done' ? '✓ done'
      : state === 'refused' ? '· declined'
        : `· ${state || 'unknown'}`;
  return `${mark} — ${_str(a.what)}`;
}

/** Honest tally across a pipeline's cases, every class including the zeroes (§5.5). */
export function caseTally(list, pipeline = '') {
  const p = _str(pipeline);
  const cs = _arr(list).filter((x) => x && (!p || x.pipeline === p));
  const n = { open: 0, done: 0, failed: 0, blocked: 0, closed: 0 };
  for (const c of cs) if (n[c.state] !== undefined) n[c.state]++;
  return `${cs.length} case${cs.length === 1 ? '' : 's'} — ${n.open} open · ${n.done} done · ${n.blocked} blocked · ${n.failed} failed`;
}
