// Core/recordLife.js — AU-6 (DESIGN_audit.md §12): the record LIFECYCLE substrate. PURE — no chrome, no DOM, no
// LLM, no clock (`now` is injected everywhere, as in every other pure module here).
//
// ── THE PRINCIPLE (§12.0), because every rule below is a consequence of it ──────────────────────────────────
// A ledger row is one of ORCHARD'S ACTS. `kind`/`id` are the CURRENT STATE of the artifact that act produced.
// When draft #D1099 is completed into order #1234, NO NEW ROW IS CREATED — it is the same record changing kind.
// A human completing a draft did not make Orchard create a second thing, and a second row would double-count an
// act that happened once ("you've created 12 records" becoming 24 because half completed).
//
// ── WHAT THAT FORCES ───────────────────────────────────────────────────────────────────────────────────────
// · IDENTITY SPLITS FROM THE POINTER (§12.1). `id`/`kind` are IMMUTABLE — what Orchard created, forever, and
//   what `describeCreate` renders. `currentId`/`currentKind` are where the artifact IS now. Keeping both is not
//   redundancy: collapsing them would make a completed draft report as "you created an order", which is false.
// · ONE TIMELINE, NOT THREE ARRAYS (§12.1a). Every change is an `{at, type, …}` entry in `events[]`.
//   `currentKind`/`currentId` are a DERIVED CACHE of the newest transition; the timeline is the truth.
// · NO `settled` STATE (§12.2, ruled 2026-08-10). An earlier draft had one, meaning "this can never change
//   again" — falsified by a single sentence: an order can be returned after it ships. `settled` was a
//   PREDICTION, and this system cannot know a record's future from its present. Refunds, unarchives and
//   chargebacks all break it. Dropping it costs nothing: `cold` is view-only, so it consumes no background work.
// · GONE IS AN OBSERVATION, NEVER A FORECAST — a 404, or a delete we performed and the vendor confirmed.
// · A HAND-OFF IS NOT AN EXIT (§12.2). It re-warms: something just changed, and the thing worth seeing often
//   arrives AFTER it (the tracking number appears on the ORDER, days after the DRAFT was created — a model that
//   ended the draft's life at completion would stop watching immediately before the payoff).

const _str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
const _isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const _num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export const WATCH_STATES = Object.freeze(['warm', 'cold', 'gone']);
export const EVENT_TYPES = Object.freeze(['create', 'update', 'transition', 'gone']);
/** Per-record timeline cap. The `create` entry is NEVER evicted — it is the row's reason for existing. */
export const EVENT_CAP = 24;
/** The default warm window when a recipe declares none. 14 days: long enough that an ordinary draft is still
 *  warm when a human gets to it, short enough that an abandoned one stops costing per-record reads. A recipe's
 *  own `warm` always wins (§12.4 — "the warm window is recipe DATA, not code"). */
export const DEFAULT_WARM_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Parse a declared warm window — `'60d'` · `'36h'` · `'90m'` · a raw ms number. PURE.
 * Recipe DATA, not code (§12.4): an order's meaningful window tracks the merchant's return policy, which is not
 * derivable and differs per store; a ticket's is days. Declared, visible, editable — and a malformed value falls
 * back rather than throwing, because a bad string in a catalog must not break the ledger.
 */
export function warmWindowMs(recipe, fallback = DEFAULT_WARM_MS) {
  const raw = recipe && typeof recipe === 'object' ? recipe.warm : recipe;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  const m = _str(raw).trim().match(/^(\d+(?:\.\d+)?)\s*([dhm])$/i);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const unit = m[2].toLowerCase();
  return Math.round(n * (unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000));
}

/** Append to the ONE timeline, capped. The `create` entry survives every eviction (§12.1a). PURE. */
export function appendEvent(events, evt, { cap = EVENT_CAP } = {}) {
  const list = Array.isArray(events) ? events.filter(_isObj) : [];
  if (!_isObj(evt) || !EVENT_TYPES.includes(_str(evt.type))) return list;
  const next = [...list, { ...evt, at: _num(evt.at) }];
  if (next.length <= cap) return next;
  // Evict the oldest NON-create. If the overflow is somehow all creates, keep the newest — never return more
  // than the cap, and never drop the row's reason for existing.
  const out = next.slice();
  while (out.length > cap) {
    const i = out.findIndex((e) => e.type !== 'create');
    if (i < 0) break;
    out.splice(i, 1);
  }
  return out.length > cap ? out.slice(-cap) : out;
}

/**
 * The watch state as of `now`. PURE, and it READS rather than decides: `gone` is terminal and absorbing, a warm
 * window that has elapsed reads `cold`, everything else is `warm`.
 *
 * Deliberately a pure function of the row rather than a stored value that something must remember to update —
 * a stored state drifts the moment one writer forgets, and this one has no way to be wrong.
 */
export function nextWatch(row, now = 0) {
  const r = _isObj(row) ? row : {};
  if (_str(r.watch) === 'gone') return 'gone';
  const until = _num(r.warmUntil);
  if (!until) return _str(r.watch) === 'cold' ? 'cold' : 'warm';   // no window banked → treat as warm (it was just created)
  return _num(now) < until ? 'warm' : 'cold';
}

/** Re-warm: any OBSERVED change restarts the window (§12.2). A `gone` row never re-warms — terminal. PURE. */
export function reWarm(row, { at = 0, windowMs = DEFAULT_WARM_MS } = {}) {
  const r = _isObj(row) ? row : {};
  if (_str(r.watch) === 'gone') return r;
  const t = _num(at);
  return { ...r, watch: 'warm', warmUntil: t + Math.max(0, _num(windowMs) || DEFAULT_WARM_MS), lastSeenAt: t };
}

/**
 * THE HAND-OFF (§12.0/§12.2). draft #D1099 → order #1234, on the SAME row.
 *
 * `id` and `kind` are untouched — that is the whole point, and `describeCreate` keeps reporting what was
 * actually created. `currentKind`/`currentId` advance, the timeline gets a `transition`, and the warm window
 * RESTARTS because something just changed.
 *
 * Returns the row UNCHANGED when the transition is a no-op or malformed: a hand-off must be OBSERVED (§12.5 — an
 * order link populated), never inferred, so a call with nothing new in it must not grow the timeline.
 */
export function applyTransition(row, { toKind = '', toId = '', at = 0, windowMs = DEFAULT_WARM_MS } = {}) {
  const r = _isObj(row) ? row : {};
  if (_str(r.watch) === 'gone') return r;                                   // gone is absorbing
  const k = _str(toKind).trim();
  const i = _str(toId).trim();
  if (!k || !i) return r;                                                   // nothing observed → nothing recorded
  const fromKind = _str(r.currentKind) || _str(r.kind);
  const fromId = _str(r.currentId) || _str(r.id);
  if (fromKind === k && fromId === i) return r;                             // already there — a re-read confirming the same state is not an event
  const t = _num(at);
  return {
    ...r,
    currentKind: k,
    currentId: i,
    events: appendEvent(r.events, { at: t, type: 'transition', fromKind, fromId, toKind: k, toId: i }),
    watch: 'warm',
    warmUntil: t + Math.max(0, _num(windowMs) || DEFAULT_WARM_MS),
    lastSeenAt: t,
  };
}

/**
 * OBSERVED VALUES CHANGED (§12.9's event, without §12.9's extractor). Appends an `update` ONLY when a watched
 * value actually moved — a re-read that confirms the same tracking number must not grow the timeline (§12.7).
 * That rule is why this compares before it appends instead of trusting the caller to.
 */
export function applyUpdate(row, { fields = null, at = 0, windowMs = DEFAULT_WARM_MS } = {}) {
  const r = _isObj(row) ? row : {};
  if (_str(r.watch) === 'gone') return r;
  const f = _isObj(fields) ? fields : null;
  if (!f) return r;
  const prev = _isObj(r.observed) ? r.observed : {};
  const changed = {};
  for (const [k, v] of Object.entries(f)) {
    if (v == null || v === '') continue;                                    // an absent path yields no key, never `undefined` (§12.7)
    if (String(prev[k]) === String(v)) continue;
    changed[k] = typeof v === 'number' || typeof v === 'boolean' ? v : _str(v).slice(0, 200);
  }
  if (!Object.keys(changed).length) return r;                               // confirmed, not changed → no event, no re-warm
  const t = _num(at);
  return {
    ...r,
    observed: { ...prev, ...changed },
    events: appendEvent(r.events, { at: t, type: 'update', fields: changed }),
    watch: 'warm',
    warmUntil: t + Math.max(0, _num(windowMs) || DEFAULT_WARM_MS),
    lastSeenAt: t,
  };
}

/**
 * GONE — terminal, and ONLY from an observation (§12.2): the object returned 404, or a delete we performed
 * succeeded. Never a forecast, never inferred from a status string. Idempotent: a second observation of the same
 * non-existence is not a second event.
 */
export function applyGone(row, { why = 'deleted', at = 0 } = {}) {
  const r = _isObj(row) ? row : {};
  if (_str(r.watch) === 'gone') return r;
  const t = _num(at);
  const w = why === '404' ? '404' : 'deleted';
  const out = { ...r, watch: 'gone', lastSeenAt: t, events: appendEvent(r.events, { at: t, type: 'gone', why: w }) };
  delete out.warmUntil;                                                     // §12.1 — absent when cold/gone
  return out;
}

/**
 * The row's live pointer: where the artifact IS, versus what was created. PURE.
 * The §12.1a defect this exists to close: `_recordOpenUrl` resolves `itemUrl` from the CREATE's recipe, so after
 * a hand-off it builds a DRAFT url carrying an ORDER id — not a visible 404, potentially a different record.
 * Every link resolver must follow the artifact, not the act.
 */
export function currentRef(row) {
  const r = _isObj(row) ? row : {};
  return { kind: _str(r.currentKind) || _str(r.kind), id: _str(r.currentId) || _str(r.id) };
}

/** Did this row hand off? PURE — for the card's "draft → order #1234" line, the warranty question answered at a
 *  glance (did the replacement actually go out). */
export function handOff(row) {
  const r = _isObj(row) ? row : {};
  const k = _str(r.currentKind); const i = _str(r.currentId);
  if (!k || !i) return null;
  if (k === _str(r.kind) && i === _str(r.id)) return null;
  return { fromKind: _str(r.kind), fromId: _str(r.id), toKind: k, toId: i };
}

/**
 * §12.6 — STALENESS IS RENDERED, NEVER IMPLIED. Under session-ride the poll runs only while the user has a live
 * session, so a cadence is a CEILING, never a guarantee: "at most every N", not "every N". A surface that omits
 * this implies a completeness it does not have — the same visible-total honesty §4 forces on `truncationNotice`.
 * PURE; `clock` is the caller's formatted time so this stays clock-free.
 * @returns {string} '' when nothing has ever been confirmed — say nothing rather than invent a freshness
 */
export function asOfLine(row, clock = '', now = 0) {
  const r = _isObj(row) ? row : {};
  const seen = _num(r.lastSeenAt);
  const state = nextWatch(r, now);
  if (state === 'gone') {
    const g = (Array.isArray(r.events) ? r.events : []).filter((e) => _isObj(e) && e.type === 'gone').pop();
    return `gone${g && g.why === '404' ? ' (not found on the site)' : ''}${clock ? ` — as of ${clock}` : ''}`;
  }
  if (!seen) return '';
  return `${state} — as of ${clock || 'the last check'}`;
}

/**
 * v2.74.2206 (§13.3) — SOMETHING LEFT THE BOUNDARY. Stamped once, by the FIRST outward act to touch this record;
 * later ones do not move it, because the question it answers is "has anything been sent?", not "how many".
 *
 * Its own §12.1 field, rather than a flag derived from the create leg, because of the finding in §13.3 and it is
 * worth restating: THE DECLARED AXES DESCRIBE THE ACT, NOT THE RECORD'S HISTORY. `delete_ticket` is
 * `destructive:true, outward:false` — correctly, deleting is an internal act — but the ticket may have emailed
 * the homeowner since it was created. Deleting it does not unsend that email; it destroys the record of a
 * message the customer already holds. So propriety cannot be read off the delete leg, and the RECORD has to
 * carry the history the leg cannot know.
 */
export function markOutward(row, at = 0) {
  const r = _isObj(row) ? row : {};
  if (_num(r.outwardAt)) return r;                                          // first one wins — this is a fact, not a counter
  return { ...r, outwardAt: _num(at) };
}

/**
 * v2.74.2206 (§13.2) — MAY THIS RECORD BE UN-MADE, and if not, WHY. PURE.
 *
 * The spec's derivation, kept whole so the rule lives in one place instead of being re-decided per surface:
 *     offer ⟺ a reversal leg exists ∧ outwardAt unset ∧ state is fresh ∧ watch !== 'gone'
 *
 * THREE OUTCOMES, not two, and the third is the honest one. `stale` means every condition holds EXCEPT freshness:
 * the row is cold, so what we believe about it was last confirmed a while ago. §13.2 writes freshness as a
 * conjunct of the offer, which would hide the control on every cold row — and with §12.3's verify-at-view read
 * still unbuilt there is nothing a user could do to refresh it, so a hard block would be a dead end rather than a
 * safeguard. `stale` therefore still offers, and says what it does not know. When verify-at-view lands, `stale`
 * becomes a re-read instead of a caveat, and this function is the only thing that changes.
 *
 * `why` is the SENTENCE a surface renders (§13.5: "no dead control on the card; the drill overlay states the
 * reversal status in words"). It is written here, not at the surface, because a suppression that explains itself
 * differently on two surfaces is two explanations that can disagree.
 *
 * @param o.hasLeg     does the catalog name a reversal for `currentKind || kind`? (the caller looks it up)
 * @param o.kindLabel  the noun for the sentence when there is no leg ("Orders can't be deleted…")
 * @returns {{offer:'yes'|'stale'|'no', why:string}}
 */
export function reversalOffer(row, { hasLeg = false, now = 0, kindLabel = '' } = {}) {
  const r = _isObj(row) ? row : {};
  const state = nextWatch(r, now);
  if (state === 'gone') return { offer: 'no', why: 'Already gone — there is nothing left to undo.' };
  const outAt = _num(r.outwardAt);
  if (outAt) {
    // The §13.4 row that proves the rule generalizes: a draft whose invoice was sent, a ticket whose reply was
    // emailed. Both are internally deletable and neither is undoable, for the same reason.
    return { offer: 'no', why: 'Can’t be undone — something already left for the customer. Deleting this would only destroy our record of it.' };
  }
  if (!hasLeg) {
    const k = _str(kindLabel) || _str(r.currentKind) || _str(r.kind) || 'record';
    return { offer: 'no', why: `${k.charAt(0).toUpperCase()}${k.slice(1)}s can’t be un-made from here — that would be a different act with different consequences, not an undo.` };
  }
  if (state === 'cold') return { offer: 'stale', why: 'Reversible — but its state was last confirmed a while ago, so it may have changed since.' };
  return { offer: 'yes', why: 'Reversible — nothing has left the boundary yet.' };
}

/**
 * v2.74.2206 (§12.1a) — ONE TIMELINE ENTRY AS A SENTENCE. PURE; `clock` is the caller's formatted time, so this
 * stays clock-free like every other renderer here.
 *
 * Built because the drill overlay has been promising this in words since AU-8 — "Updates and deletions to this
 * record will appear here as they're captured" — while rendering nothing. Once `events[]` started carrying real
 * entries that note became a promise with data behind it and no renderer, which is the `captured ≠ visible` gap
 * this repo has now hit twice.
 */
export function describeEvent(evt, clock = '') {
  const e = _isObj(evt) ? evt : {};
  const when = _str(clock);
  const t = _str(e.type);
  let text = '';
  if (t === 'create') text = `Created${_str(e.kind) ? ` as a ${_str(e.kind)}` : ''}${_str(e.label) ? ` — ${_str(e.label)}` : ''}`;
  else if (t === 'transition') text = `Became a ${_str(e.toKind) || 'record'}${_str(e.toId) ? ` (#${_str(e.toId)})` : ''}${_str(e.fromKind) ? `, from ${_str(e.fromKind)}` : ''}`;
  else if (t === 'gone') text = e.why === '404' ? 'No longer on the site' : 'Deleted';
  else if (t === 'update') {
    const f = _isObj(e.fields) ? e.fields : {};
    const bits = Object.entries(f).slice(0, 4).map(([k, v]) => `${k} ${_str(v).slice(0, 40)}`);
    text = bits.length ? `Changed — ${bits.join(' · ')}` : 'Changed';
  } else return '';                                                          // an unknown type renders nothing rather than a shrug
  return when ? `${when} — ${text}` : text;
}

/**
 * §12.3's cheap tier, as a pure predicate: may we spend a PER-RECORD read on this row right now?
 *
 * `cold` suppresses per-record reads and NOTHING ELSE — corrected 2026-08-10 by the tracking-number case, which
 * falsified the first version of this rule. A collection read (`orders updated since X`) is O(1) in records, so
 * covering a cold row costs nothing extra and excluding it buys a blind spot exactly where it hurts: a draft
 * that sat long enough to go cold and was then completed on someone else's machine. Hence `scope`.
 *
 * And nothing suppresses OBSERVATION at any tier: a change seen in this browser lands on a record cold for
 * months. That is what makes view-only decay safe.
 */
export function mayRead(row, { scope = 'record', now = 0, force = false } = {}) {
  const state = nextWatch(row, now);
  if (state === 'gone') return false;                                       // terminal — nothing left to confirm
  if (scope === 'collection') return true;                                  // O(1) in records: cold rows ride free
  if (force) return true;                                                   // verify-at-view is a human asking; honour it
  return state === 'warm';
}
