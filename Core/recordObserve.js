// Core/recordObserve.js — AU-6 §12.9 (observed fields) + §12.3/§12.4 (the collection poll's pure half).
// PURE — no chrome, no DOM, no LLM, no clock. The SW supplies `now` and performs the reads.
//
// TWO JOBS, one file, because they are two halves of one sentence: §12.9 says WHAT to watch on a record, and
// §12.3/§12.4 say WHEN to go look and what an answer means. Splitting them would put the "absence is not
// deletion" rule a file away from the extractor whose output it judges.

import { extractValue } from './peritemMap.js';
import { warmWindowMs } from './recordLife.js';

const _str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
const _isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const _num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * v2.74.2217 — THE WARM WINDOW A HAND-OFF SHOULD GRANT belongs to the DESTINATION kind, not to whichever leg
 * happened to observe the transition. PURE.
 *
 * The defect this closes: `applyTransition` took `windowMs` from the observing leg — the draft DETAIL read (no
 * `warm:` declared → 14d default) — so a record handed off to an order got 14 days, not the 60 the order leg
 * declares. `shopify_order`'s `warm: '60d'` ("tracks the merchant's return policy") only took effect after the
 * first observed change, which for a slow shipment may never come: an order quiet for 14 days went cold, cold
 * suppresses the per-record read, and the tracking number — the thing AU-6 exists to reach — was structurally
 * unobservable for exactly the slow shipments where it matters.
 *
 * Resolution mirrors probePlan's own leg lookup: the per-record read (`reads`) for the NEW kind on the same
 * host. No such leg → the default window, which is at least honest about not knowing.
 */
export function destinationWarmMs(catalog, { toKind = '', host = '' } = {}) {
  const dest = (Array.isArray(catalog) ? catalog : []).find((r) =>
    _isObj(r) && _str(r.reads) === _str(toKind) && _str(r.appHost) === _str(host));
  return warmWindowMs(dest || null);
}

/**
 * Walk a rows path to EVERY match — `data.draftOrders.edges[].node`, `fulfillments`, `returns.edges[].node`. PURE.
 *
 * v2.74.2208 — MAPS OVER ARRAYS rather than taking the first element, which the first version did (borrowing
 * `extractValue`'s array hop, where taking [0] is right because it is resolving ONE scalar). Here it was a bug
 * with no symptom in the tests: `data.draftOrders.edges[].node` walked to the edges array, took edges[0], and
 * returned exactly ONE row — so a poll over fifty drafts would have reconciled the newest and silently ignored
 * the other forty-nine. Every test passed because they all declared flat paths.
 *
 * A GraphQL `edges[].node` list unwraps to its nodes at the end, so a caller may declare either form.
 */
export function rowsAt(value, path) {
  if (!path) return [];
  let cur = [value];
  for (const seg of _str(path).split('.').filter(Boolean)) {
    const bare = seg.replace(/\[\]$/, '');
    const next = [];
    for (const c of cur) {
      if (!_isObj(c) && !Array.isArray(c)) continue;
      const v = Array.isArray(c) ? undefined : c[bare];
      if (Array.isArray(v)) next.push(...v);
      else if (v != null) next.push(v);
    }
    cur = next;
  }
  return cur.filter((r) => r != null).map((r) => (_isObj(r) && _isObj(r.node) ? r.node : r));
}
const _rowsAt = rowsAt;

/**
 * §12.9 — READ THE DECLARED OBSERVERS off one vendor object. PURE.
 *
 * Three kinds, and they compose rather than multiply (§12.9.2):
 *   A `field`  — a scalar on the record            → {fields:{name:value}}
 *   B `set`    — a collection whose MEMBERS are the news (a Zendesk reply)  → {added:[…]}
 *   C `member` — a collection whose members have their own state           → {changed:[…]}
 * C is B composed with A, which is why there is no third mechanism: a new member arrives by the `set` rule and
 * its later state moves by this one.
 *
 * DECLARED PATHS ONLY, and an absent path yields NO KEY — never `undefined`, never a guess (§12.7). The whole
 * point of a declaration here is that a poll cannot invent news: if nobody said to watch it, a change in it is
 * not an event.
 *
 * ADDITIONS ONLY for `set`, by default and deliberately (§12.9.2): "a member that vanishes is far more often
 * pagination (`first: 10`) or a filter change than a deletion. Concluding 'removed' from a truncated read
 * manufactures false events" — the same silent-truncation failure §5.6 exists to prevent.
 *
 * @param obj    the vendor object for ONE record (a row from a collection read, or a detail read's body)
 * @param decl   the leg's `observe` declaration: {name: {of:'field'|'set'|'member', …}}
 * @param seen   what we already know: {fields:{}, sets:{name:[ids]}, members:{name:{id:{k:v}}}}
 * @returns {{fields:object, added:object, changed:object, seenNext:object}}  empty objects when nothing is news
 */
export function observeFields(obj, decl, seen = null) {
  const o = _isObj(obj) ? obj : null;
  const d = _isObj(decl) ? decl : null;
  const prev = _isObj(seen) ? seen : {};
  const prevFields = _isObj(prev.fields) ? prev.fields : {};
  const prevSets = _isObj(prev.sets) ? prev.sets : {};
  const prevMembers = _isObj(prev.members) ? prev.members : {};
  const out = { fields: {}, added: {}, changed: {}, seenNext: { fields: { ...prevFields }, sets: { ...prevSets }, members: { ...prevMembers } } };
  if (!o || !d) return out;

  for (const [name, spec] of Object.entries(d)) {
    if (!_isObj(spec)) continue;
    const of = _str(spec.of) || 'field';

    if (of === 'field') {
      const v = extractValue(o, _str(spec.at));
      if (v == null || v === '') continue;                       // absent path → no key at all
      if (String(prevFields[name]) === String(v)) continue;      // unchanged → not news (absent→present IS news)
      out.fields[name] = v;
      out.seenNext.fields[name] = v;
      continue;
    }

    const rows = _rowsAt(o, _str(spec.rows));
    const idKey = _str(spec.id);
    if (!rows.length || !idKey) continue;                        // `id` is REQUIRED — without member identity every poll looks like change

    if (of === 'set') {
      const known = new Set((Array.isArray(prevSets[name]) ? prevSets[name] : []).map(String));
      const keep = _isObj(spec.keep) ? spec.keep : {};
      const added = [];
      const nextIds = new Set(known);
      for (const r of rows) {
        const id = _str(extractValue(r, idKey) ?? r[idKey]);
        if (!id || known.has(id)) continue;
        const rec = { id };
        for (const [k, path] of Object.entries(keep)) {
          const v = extractValue(r, _str(path));
          if (v != null && v !== '') rec[k] = v;
        }
        added.push(rec);
        nextIds.add(id);
      }
      // The seen-set grows even when nothing was added, so a first sighting does not replay as news next poll.
      out.seenNext.sets[name] = [...nextIds].slice(-200);
      if (added.length) out.added[name] = added;
      continue;
    }

    if (of === 'member') {
      const track = _isObj(spec.track) ? spec.track : {};
      const known = _isObj(prevMembers[name]) ? prevMembers[name] : {};
      const next = { ...known };
      const changed = [];
      for (const r of rows) {
        const id = _str(extractValue(r, idKey) ?? r[idKey]);
        if (!id) continue;
        const cur = {};
        for (const [k, path] of Object.entries(track)) {
          const v = extractValue(r, _str(path));
          if (v != null && v !== '') cur[k] = v;
        }
        if (!Object.keys(cur).length) continue;
        const was = _isObj(known[id]) ? known[id] : null;
        next[id] = { ...(was || {}), ...cur };
        if (!was) continue;                                      // a NEW member is the `set` rule's news, not this one's
        const moved = {};
        for (const [k, v] of Object.entries(cur)) if (String(was[k]) !== String(v)) moved[k] = v;
        if (Object.keys(moved).length) changed.push({ id, ...moved });
      }
      out.seenNext.members[name] = next;
      if (changed.length) out.changed[name] = changed;
    }
  }
  return out;
}

/**
 * §12.5 (v2.74.2208) — THE TRANSITION ADAPTER, as a DECLARATION rather than a per-platform function.
 *
 * The spec asked for `readTransition(replyOrRecord, {kind,id}) -> null | {toKind,toId,at}`, isolating one
 * unknown behind one function per platform. A declaration is strictly better and does the same job: it is
 * catalog DATA, so a second platform costs a line rather than a function, and it cannot drift from the read it
 * belongs to because it sits on that read.
 *
 *     handOff: { at: 'order.id', toKind: 'order' }     // on shopify_draft_orders
 *
 * AND IT DOES NOT VIOLATE §10.3'S "never code a reply shape blind". Nothing here guesses: it names a path and
 * acts ONLY if a value is actually there. If Shopify's DraftOrderList does not return `order`, this resolves to
 * null and the record simply stays a draft — no event, no false hand-off. The unknown fails toward NOTHING,
 * which is the same posture §12.5 wanted from its re-read, one step cheaper.
 *
 * A hand-off must be OBSERVED, never inferred from a status string — which is exactly why this reads an ID and
 * not `status === 'COMPLETED'`. A completed status says something happened; an id says what it became.
 */
export function readTransition(obj, decl) {
  const o = _isObj(obj) ? obj : null;
  const d = _isObj(decl) ? decl : null;
  if (!o || !d) return null;
  const raw = extractValue(o, _str(d.at));
  if (raw == null || raw === '') return null;
  const toId = _str(raw).split('/').pop();                     // gid://shopify/Order/1234 → 1234, matching what a create banks
  const toKind = _str(d.toKind);
  if (!toId || !toKind) return null;
  // v2.74.2209 — the NAME at the new address, when the declaration names a path to it. Optional by design: a
  // source that does not carry one yields a hand-off without a label rather than no hand-off at all.
  const lab = d.label ? extractValue(o, _str(d.label)) : null;
  return { toKind, toId, ...(lab ? { toLabel: _str(lab).slice(0, 80) } : {}) };
}

/**
 * v2.74.2209 (§12.3's targeted per-record re-read) — DOES THIS ROW OWE A PROBE? PURE.
 *
 * The HAR of 2026-08-11 settled why this exists: Shopify's draft LIST carries `status` but NOT `order`, so the
 * collection poll can see THAT a draft completed and never WHAT it became. §12.5 anticipated exactly this — "if
 * it does not [carry the id] … we do ONE targeted re-read" — and this is the trigger for that read.
 *
 * TRIGGERED BY STATE, NOT BY THE CHANGE, and that is the load-bearing choice. Firing on "status just became
 * COMPLETED" would fire once and never again, so a probe lost to a transport blip would strand the record as a
 * draft forever. Firing on "status IS COMPLETED and this record has not handed off yet" is idempotent: it retries
 * until it succeeds and stops the moment it does, because the hand-off itself is what makes the condition false.
 *
 * @param decl  the collection's `handOffProbe`: { when: {field, is}, via: '<recipeId>' }
 * @returns {{via:string}|null}
 */
export function probeDue(row, vendorRow, decl) {
  const d = _isObj(decl) ? decl : null;
  const r = _isObj(row) ? row : null;
  const v = _isObj(vendorRow) ? vendorRow : null;
  if (!d || !r || !v || !_str(d.via)) return null;
  if (_str(r.currentKind) && _str(r.currentKind) !== _str(r.kind)) return null;   // already handed off — nothing pending
  const w = _isObj(d.when) ? d.when : null;
  if (w) {
    const got = extractValue(v, _str(w.field));
    if (got == null || String(got) !== String(w.is)) return null;
  }
  return { via: _str(d.via) };
}

/**
 * v2.74.2209 (§12.3) — THE PER-RECORD TIER: which rows are worth one read of their own right now. PURE.
 *
 * This is the tier §12.3 prices at "1 read PER record", and it is `warm`-gated for exactly that reason — unlike a
 * collection read, its cost scales with the book. A cold row is not probed; an observed change re-warms it, so a
 * record stays watched precisely while it is doing something.
 *
 * It exists because a collection cannot always answer. A Shopify ORDER's tracking lives on the order, and the
 * only orders collection we have that returns tracking is the UNFULFILLED queue — which an order LEAVES at the
 * moment it ships, i.e. at the moment the tracking number appears. So the shipping watch has to be per-record.
 *
 * @returns {Array<{key, recipeId, kind, id, label, why}>}
 */
export function probePlan(rows, { catalog = [], now = 0, lastProbeAt = {}, gapMs = POLL_GAP_MS, watchOf = null } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(_isObj);
  const legs = (Array.isArray(catalog) ? catalog : []).filter((r) => _isObj(r) && _str(r.reads) && _isObj(r.observe));
  const seenAt = _isObj(lastProbeAt) ? lastProbeAt : {};
  const state = typeof watchOf === 'function' ? watchOf : () => 'warm';
  const out = [];
  for (const row of list) {
    if (_str(row.watch) === 'gone') continue;
    const kind = _str(row.currentKind) || _str(row.kind);
    const leg = legs.find((l) => _str(l.reads) === kind && _str(l.appHost) === _str(row.system));
    if (!leg) continue;
    if (state(row) !== 'warm') continue;                        // COLD suppresses per-record reads — the one thing it does suppress
    const key = `${_num(row.at)}|${_str(row.id)}`;
    const gap = _num(leg.pollGapMs) || _num(gapMs) || POLL_GAP_MS;
    const last = _num(seenAt[key]);
    if (last && (_num(now) - last) < gap) continue;
    out.push({ key, recipeId: _str(leg.id), kind, id: _str(row.currentId) || _str(row.id), label: _str(row.currentLabel) || _str(row.label), why: last ? 'window elapsed' : 'never probed' });
  }
  return out;
}

/**
 * v2.74.2209 — the ONE value a probe leg needs, from the record. PURE.
 * Declared per leg because the same record id is spelled differently per read: Shopify's draft detail takes a
 * full `gid://shopify/DraftOrder/<id>`, while its order read searches `name:<digits>` — so what to send is a
 * property of the LEG, not something a caller can infer from the record.
 */
export function probeParams(leg, { id = '', label = '' } = {}) {
  const l = _isObj(leg) ? leg : {};
  const p = _isObj(l.probe) ? l.probe : null;
  if (!p || !_str(p.param)) return null;
  let v = _str(p.from) === 'label' ? _str(label) : _str(id);
  if (!v) return null;
  if (p.digits) v = v.replace(/\D+/g, '');                      // "DEAKO#72044" → "72044" (the leg's own does-line: digits, not the store prefix)
  if (p.gid && !/^gid:\/\//.test(v)) v = `gid://shopify/${_str(p.gid)}/${v}`;
  if (!v) return null;
  return { [_str(p.param)]: v };
}

/** Is there anything to report? PURE — so a caller can skip a write rather than append an empty event. */
export function hasNews(obs) {
  const o = _isObj(obs) ? obs : {};
  return !!(Object.keys(o.fields || {}).length || Object.keys(o.added || {}).length || Object.keys(o.changed || {}).length);
}

/**
 * Flatten an observation into the `{name: scalar}` shape `applyUpdate` compares and stores. PURE.
 * A `set`/`member` result becomes a COUNT-and-latest summary rather than a nested blob, because the timeline
 * entry is a sentence a person reads — the members themselves are on the vendor's page, one eye-click away.
 */
export function newsToFields(obs) {
  const o = _isObj(obs) ? obs : {};
  const out = { ...(o.fields || {}) };
  for (const [name, list] of Object.entries(o.added || {})) {
    if (Array.isArray(list) && list.length) out[name] = `+${list.length} new (${list.map((x) => _str(x.id)).slice(0, 3).join(', ')})`;
  }
  for (const [name, list] of Object.entries(o.changed || {})) {
    if (Array.isArray(list) && list.length) out[name] = list.map((x) => `${_str(x.id)}→${Object.entries(x).filter(([k]) => k !== 'id').map(([, v]) => _str(v)).join('/')}`).slice(0, 3).join(' · ');
  }
  return out;
}

// ── §12.3/§12.4 — the COLLECTION poll ──────────────────────────────────────────────────────────────────────

/** Default gap between polls of one collection when its recipe declares no `pulse` cadence. */
export const POLL_GAP_MS = 6 * 60 * 60 * 1000;   // 4× a day at most — a ceiling, never a guarantee (§12.6)

/**
 * §12.4 — WHICH COLLECTIONS ARE WORTH READING RIGHT NOW. PURE.
 *
 * THE UNIT OF POLLING IS THE COLLECTION, never the record: `shopify_draft_orders` answers for N drafts in ONE
 * request, and per-record polling is O(N) requests on a live user session, untenable near the 500 cap.
 *
 * A collection is a candidate when it declares BOTH `observe` (something to watch) and `watches` (which record
 * kinds its rows answer for). Cold rows are INCLUDED in the coverage count — §12.3's corrected rule: a
 * collection read is O(1) in records, so excluding cold rows saves zero and buys a blind spot exactly where it
 * hurts (a draft that sat long enough to go cold and was then completed on someone else's machine).
 *
 * @returns {Array<{recipeId, host, rowIds:string[], why}>}  one entry per collection worth reading
 */
export function pollPlan(rows, { catalog = [], now = 0, lastPollAt = {}, gapMs = POLL_GAP_MS } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(_isObj);
  const legs = (Array.isArray(catalog) ? catalog : []).filter((r) => _isObj(r) && _isObj(r.observe) && Array.isArray(r.watches) && r.watches.length);
  const seenAt = _isObj(lastPollAt) ? lastPollAt : {};
  const out = [];
  for (const leg of legs) {
    // v2.74.2212 — SEND THE LEG'S DECLARED PARAMS, BLANK. A poll wants the collection's DEFAULT scope, and these
    // legs say so themselves: `shopify_draft_orders`' own hint is "blank for the most recent drafts". But its
    // `{query}` sits IN THE URL, and an unfilled `{…}` is refused before the network (`needs query`,
    // connector.js:1156) — so passing nothing meant every poll was blocked, counted as one unreadable
    // collection, and moved past in silence. Live: a draft completed in Shopify at 17:13 and the record still
    // read `draft` after a forced re-check.
    //
    // A REQUIRED param makes a leg unpollable, and that is the honest verdict rather than a blank guess: nothing
    // in a collection sweep can supply one, and sending '' would query for the empty string.
    const _params = {};
    let _blocked = false;
    for (const p of (Array.isArray(leg.params) ? leg.params : [])) {
      const n = _str(p && p.name); if (!n) continue;
      if (p && p.required === true) { _blocked = true; break; }
      _params[n] = '';
    }
    if (_blocked) continue;
    const host = _str(leg.appHost);
    const kinds = new Set(leg.watches.map((k) => _str(k)));
    const live = list.filter((r) => _str(r.system) === host && _str(r.watch) !== 'gone'
      && (kinds.has(_str(r.currentKind) || _str(r.kind))));
    if (!live.length) continue;                                             // nothing to reconcile → no request
    const gap = _num(leg.pollGapMs) || _num(gapMs) || POLL_GAP_MS;
    const last = _num(seenAt[_str(leg.id)]);
    if (last && (_num(now) - last) < gap) continue;                         // inside its window — the tick is the scanner, the window is the cadence
    out.push({ recipeId: _str(leg.id), host, params: _params, rowIds: live.map((r) => _str(r.currentId) || _str(r.id)), why: last ? 'window elapsed' : 'never polled' });
  }
  return out;
}

/**
 * §12.3 — WHAT A COLLECTION'S ANSWER MEANS FOR EACH ROW. PURE; returns INSTRUCTIONS, not mutations, so the
 * caller applies them through Core/recordLife's own functions and this file never owns the state machine.
 *
 * THE RULE THAT MATTERS MOST — **ABSENCE IS NOT DELETION, unless the collection is a PARTITION.**
 * `shopify_draft_orders` declares `coverage: 'selection'` (connectorRecipes.js), and a draft missing from it has
 * at least three innocent explanations: it was COMPLETED into an order, it fell past `first: 50`, or a filter
 * moved. Concluding `gone` from any of those would mark a live record dead and remove its eye — a confidently
 * wrong terminal state, from silence. Only a declared PARTITION ("these rows are ALL of them") makes absence an
 * observation, and even then only for rows the read's own scope covers.
 *
 * @param rows          the banked rows this collection answers for
 * @param observedRows  the vendor rows it returned
 * @param o.leg         the collection recipe ({observe, coverage, id})
 * @param o.seenBy      {rowKey: seen-state} for observeFields
 * @returns {Array<{key, at, kind:'update'|'gone', fields?, seenNext?, why?}>}
 */
export function reconcileCollection(rows, observedRows, { leg = null, now = 0, seenBy = {}, stats = null } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter(_isObj);
  const got = (Array.isArray(observedRows) ? observedRows : []).filter(_isObj);
  const l = _isObj(leg) ? leg : {};
  // v2.74.2214 — COUNTS FOR THE CALLER'S AUDIT LINE, because "0 handed off" alone cannot distinguish the two
  // ways this loop does nothing: a banked row ABSENT from the vendor reply (a silent `continue` — correct for a
  // `selection` collection, but invisible) vs. PRESENT with a probe condition that did not hold. Live 2026-08-11:
  // #D29741 sat COMPLETED in Shopify through two green polls and the tally could not say which of those it was.
  // Counts only — never an observed value — per the body-blind audit rule.
  const st = _isObj(stats) ? stats : null;
  if (st) { st.matched = 0; st.whenMet = 0; }
  const decl = _isObj(l.observe) ? l.observe : null;
  const idKey = _str(l.rowId) || 'id';
  const seen = _isObj(seenBy) ? seenBy : {};
  const byId = new Map();
  for (const r of got) {
    const raw = _str(extractValue(r, idKey) ?? r[idKey]);
    if (!raw) continue;
    byId.set(raw, r);
    const tail = raw.split('/').pop();                                      // gid://shopify/DraftOrder/29685 → 29685
    if (tail && tail !== raw) byId.set(tail, r);
  }
  const out = [];
  for (const row of list) {
    const key = `${_num(row.at)}|${_str(row.id)}`;
    const want = _str(row.currentId) || _str(row.id);
    const hit = byId.get(want) || null;
    if (!hit) {
      // Absence. ONLY a partition may read it as non-existence — see the rule above.
      if (_str(l.coverage) === 'partition') out.push({ key, at: _num(now), kind: 'gone', why: '404' });
      continue;
    }
    if (st) {
      st.matched++;
      const _w = _isObj(l.handOffProbe) && _isObj(l.handOffProbe.when) ? l.handOffProbe.when : null;
      if (_w && String(extractValue(hit, _str(_w.field))) === String(_w.is)) st.whenMet++;
    }
    // THE HAND-OFF IS CHECKED FIRST, and it is checked BEFORE the field observers because it changes which
    // collection answers for this record from now on. A draft that became an order stops being the draft list's
    // business; reporting a status change on it first would be describing a record at its old address.
    const ho = readTransition(hit, l.handOff);
    if (ho && (ho.toKind !== (_str(row.currentKind) || _str(row.kind)) || ho.toId !== want)) {
      out.push({ key, at: _num(now), kind: 'transition', toKind: ho.toKind, toId: ho.toId, ...(ho.toLabel ? { toLabel: ho.toLabel } : {}) });
      continue;                                                 // the pointer moves; the new collection reads it next tick
    }
    // The collection may only be able to say SOMETHING happened (Shopify's draft list carries `status` and not
    // `order`). Then it asks for one targeted read rather than guessing — §12.5's second branch.
    const pr = probeDue(row, hit, l.handOffProbe);
    if (pr) {
      // The status change IS the probe's trigger, so it is not ALSO separate news — reporting both would put
      // 'Became an order' and 'Changed — status COMPLETED' in one timeline saying the same thing twice. A failed
      // probe loses nothing: the condition is state-triggered, so the next sweep raises it again.
      out.push({ key, at: _num(now), kind: 'probe', via: pr.via, id: want });
      continue;
    }
    if (!decl) continue;
    const obs = observeFields(hit, decl, seen[key] || null);
    if (!hasNews(obs)) continue;
    out.push({ key, at: _num(now), kind: 'update', fields: newsToFields(obs), seenNext: obs.seenNext });
  }
  return out;
}
