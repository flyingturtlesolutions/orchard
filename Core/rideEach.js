// Core/rideEach.js — v2.74.2047: the SW-side EACH SWEEP (DESIGN_cadence.md §11.3 widened; DK-7's fan-out, headless).
//
// The capability the v2046 tier demotion honestly declared missing: a workflow whose ride step banked an
// 'each'-swept binding (divisionId:'each' over the ~121 accessible divisions) could only run panel-tier, because
// the SW had no resolve layer and no RIDE_EACH fan-out — invokeRideRecipe's v1730 literal-safe filter DROPPED the
// sentinel, and a path-templated endpoint then refused `needs-divisionId` on every scheduled fire (live 14:24Z).
// This module is the panel chain fan's headless twin (chat.js `_runConnectorLeg`'s rp.each branch, v1880):
//   · enumerate the sweep values from the leg's OWN declared resolve source (spec.via → resolveRideParam each-mode);
//   · bounded-concurrent per-value invokes with the non-each bindings riding along — order-preserving SLOTS, never
//     pushes (a faster division must not reorder the aggregate — the v1880/v1885 rule);
//   · per-value failures count-and-continue (partial coverage stays honest, never fatal; total failure exits);
//   · group-tagged rows aggregate into the EXACT prior-rows shape Core/headlessClause.rowsOf consumes
//     ({ rows, truncated, seen }) — so a following headless map step reads the sweep as its collection.
//
// PURE + injected IO, Logger-free (the Core discipline): the runner takes { invoke } and returns data plus an
// `each` stats block; the HOST (background/handlers/cadence.js) speaks the RIDE_EACH ▸ lines in the panel fan's
// exact vocabulary — `(sw…)`/`[sw]` where the chain says `(chain…)`/`[chain]` — so a gc/gl reader sees one
// language, and trace-lint's ride-each-receipt pairing holds (tally opener → returned/exit terminal, adjacent).
//
// READS ONLY. A write with an 'each' binding never sweeps: runRideStep's write gate parks it before bindings are
// read, and this module refuses non-'ask' legs anyway (the belt-and-suspenders twin of the panel's
// '"each" only works for reads' guard).

import { planExec } from './execPlan.js';
import { resolveRideParam } from './rideParamResolve.js';
import { primaryList, primaryObject } from './connectorRender.js';

/** Mirror of the panel fan's lane budget (chat.js _RIDE_CONC = 8): the INVOKE_SESSION handler already serves 8
 * concurrent per-item calls from the panel's fan-out today, so the SW fan rides the same proven width. */
export const EACH_CONCURRENCY = 8;

/** Mirror of the panel chain fan's aggregate cap (_EACH_ROW_CAP, v1874): any truncation a conclusion rests on
 * must TRAVEL with the data — `truncated`/`seen` ride the value and the receipt line. */
export const EACH_ROW_CAP = 200;

/**
 * The each-sentinel word-set the model binds ("for each division…") — the SAME set resolveRideParam's each-mode
 * accepts (each|every|all, whole-value). Meaningful ONLY on a param whose resolve spec opted in with `each:true`;
 * on any other param 'all'/'every' are legitimate literal values (a status named "all") and must ride untouched —
 * only the exact v1730 token 'each' is ever treated specially there. PURE.
 */
export function isEachSentinel(v) {
  return typeof v === 'string' && /^(each|every|all)$/i.test(v.trim());
}

/** Might these bindings carry an each-axis? — the cheap pre-check before projecting a leg. Deliberately a
 * SUPERSET (any sentinel word): eachSweptParam then decides against the leg's actual resolve specs, and a plain
 * literal ('status: "all"' with no swept axis) falls through to the normal invoke untouched. PURE. */
export function hasEachSentinel(params) {
  return !!(params && typeof params === 'object' && Object.values(params).some(isEachSentinel));
}

/**
 * The FIRST sweepable each-axis (mirrors _resolveRideParamsCore: ONE each-axis per run, first wins). PURE.
 * @param {object} leg     the projected leg (leg.tool.resolve holds the per-param specs)
 * @param {object} params  the banked bindings
 * @returns {{name:string, spec:object|null, sweepable:boolean}|null}
 *   · sweepable:true  — a sentinel rides a param whose spec declares `each:true` + `via` (enumerable);
 *   · sweepable:false — the exact token 'each' rides a param with NO such spec (a forged/drifted pin — the
 *     caller must fail HONESTLY, never drop the sentinel into a wrong-scope read);
 *   · null            — no each-axis at all ('every'/'all' on unmarked params are literals, not axes).
 */
export function eachSweptParam(leg, params) {
  const specs = (leg && leg.tool && leg.tool.resolve && typeof leg.tool.resolve === 'object') ? leg.tool.resolve : {};
  let unsweepable = null;
  for (const [name, v] of Object.entries((params && typeof params === 'object') ? params : {})) {
    const spec = (specs[name] && typeof specs[name] === 'object') ? specs[name] : null;
    if (spec && spec.each === true && spec.via) {
      if (isEachSentinel(v)) return { name, spec, sweepable: true };
      continue;
    }
    if (v === 'each' && !unsweepable) unsweepable = { name, spec, sweepable: false };
  }
  return unsweepable;
}

/**
 * Fetch the enumeration state (the resolve spec's `via` read) through the SAME injected invoke the per-item calls
 * use: a param-free same-app GET, planned by planExec (INVOKE_SESSION only — the SW's one channel; mirrors
 * chat.js `_rideResolveVia`'s cookie-ride branch). No cache here — Core stays stateless, ONE sweep makes ONE via
 * read, and the panel's 120s cache exists for interactive re-asks the clock doesn't have.
 * @returns {Promise<{ok:boolean, value?:*, error?:string}>}
 */
export async function fetchEachState(leg, via, { invoke } = {}) {
  if (!leg || !leg.tool || !via) return { ok: false, error: 'no-leg' };
  if (typeof invoke !== 'function') return { ok: false, error: 'no-invoke' };
  const viaLeg = {
    ...leg, mode: 'ask', params: [],
    paramSchema: { type: 'object', properties: {}, required: [] },
    tool: { ...leg.tool, endpoint: String(via), method: 'GET', body: null },
  };
  const plan = planExec(viaLeg, {}, {});
  if (!plan || plan.ok === false || plan.channel !== 'INVOKE_SESSION') return { ok: false, error: 'no-plan' };
  let r = null;
  try { r = await invoke(plan.payload); } catch (e) { return { ok: false, error: (e && e.message) || 'invoke-threw' }; }
  if (!r || r.success === false || r.value == null) return { ok: false, error: (r && r.error) || 'each-state-unavailable' };
  return { ok: true, value: r.value };
}

// Rows from one per-item reply, list-or-single normalized — the panel's `_rideEachRows`, verbatim semantics.
// This also NORMALIZES envelope shapes ({tasks:[…]}) that the strict ride→map rowsOf seam would otherwise reject.
function _replyRows(value) {
  const rows = primaryList(value);
  if (Array.isArray(rows)) return rows;
  const one = primaryObject(value);
  return one ? [one] : [];
}

/**
 * Run one each-swept READ headless: enumerate → fan → aggregate. PURE decision + injected `invoke`.
 *
 * @param {object} leg     the projected connector leg (mode 'ask'; tool.resolve carries the swept spec)
 * @param {object} params  the banked bindings (the swept param holds the sentinel; the rest ride along)
 * @param {{ invoke:Function, onEach?:Function, concurrency?:number, rowCap?:number }} io
 *        `onEach(done, total, label)` fires per completion — the cadence host uses it to keep the in-flight
 *        run marker alive across a long sweep (progress is cosmetic; a throwing callback never changes the run).
 * @returns {Promise<{ok:boolean, value?:{rows:Array, truncated:boolean, seen:number}, error?:string, each?:object}>}
 *   `each` (present once the fan ran, and on enumeration failures the host shouldn't narrate as a span) =
 *   { recipeId, noun, total, ok, failed, seen, returned, truncated, capped, fixed, rowCap } — the host's line data.
 */
export async function runEachSweep(leg, params, { invoke, onEach = null, concurrency = EACH_CONCURRENCY, rowCap = EACH_ROW_CAP } = {}) {
  if (!leg || !leg.tool) return { ok: false, error: 'no-leg' };
  if (leg.mode !== 'ask') return { ok: false, error: 'each-write-refused' };   // reads only — a write stays one item per confirm
  if (typeof invoke !== 'function') return { ok: false, error: 'no-invoke' };

  const swept = eachSweptParam(leg, params);
  if (!swept || !swept.sweepable) return { ok: false, error: 'each-not-sweepable' };
  const spec = swept.spec;

  const st = await fetchEachState(leg, spec.via, { invoke });
  if (!st.ok) return { ok: false, error: st.error || 'each-state-unavailable' };   // e.g. not-logged-in — transient upstream

  const r = resolveRideParam(spec, params[swept.name], st.value);
  if (!r || r.each !== true || !Array.isArray(r.values) || !r.values.length) {
    return { ok: false, error: 'each-enumeration-empty' };   // enumerable but empty state — honest, never a silent no-op
  }
  const all = r.values;
  const noun = String(swept.name).replace(/Id$/i, '') || 'item';

  // The ride-along params, v1730 literal-safe: the swept key is OURS to fill per item (the map-valueParam hazard —
  // never let the marked-key drop delete the value the fan supplies); the exact token 'each' on any other param
  // drops (a second axis never fans); other resolve-marked params drop (no SW name→id resolution — default scope,
  // the pre-1730 behavior, never worse). Plain literals — including 'all'/'every' as VALUES — ride untouched.
  const marked = (leg.tool.resolve && typeof leg.tool.resolve === 'object') ? new Set(Object.keys(leg.tool.resolve)) : new Set();
  const fixed = {};
  for (const [k, v] of Object.entries((params && typeof params === 'object') ? params : {})) {
    if (k === swept.name) continue;
    if (v === 'each') continue;
    if (marked.has(k)) continue;
    fixed[k] = v;
  }

  // ORDER IS PRESERVED by writing into indexed SLOTS rather than pushing (the panel fan's rule verbatim): the
  // aggregate groups rows by axis label, and a concurrent push would interleave a faster division's rows.
  const slots = new Array(all.length).fill(null);
  let failed = 0; let done = 0; let next = 0;
  let firstError = '';
  const worker = async () => {
    while (next < all.length) {
      const i = next++;
      let res = null;
      try {
        const plan = planExec(leg, { ...fixed, [swept.name]: all[i].value }, {});
        // quiet:true — the v1670 rule: the roll-up speaks for successes; 121 per-item SUCCESS lines would evict
        // the run's own lines from the ring. Failures still log individually in the executor (by design).
        if (plan && plan.ok !== false && plan.channel === 'INVOKE_SESSION') res = await invoke({ ...plan.payload, quiet: true });
      } catch { res = null; }   // a throwing read counts as ONE failure and never aborts the fan
      done++;
      if (res && res.success !== false) slots[i] = { label: all[i].label, rows: _replyRows(res.value) };
      else { failed++; if (!firstError) firstError = (res && res.error) || 'invoke-failed'; }
      try { if (typeof onEach === 'function') onEach(done, all.length, all[i].label); } catch { /* progress is cosmetic */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(concurrency) || 1, all.length)) }, worker));

  const items = slots.filter(Boolean);
  // the tally line's row count is PRE-cap (`seen`); the receipt's is POST-cap (`returned`) — two counts, on purpose
  const cap = Math.max(1, Number(rowCap) || EACH_ROW_CAP);
  const tagged = []; let seen = 0;
  for (const it of items) {
    for (const row of it.rows) {
      seen++;
      // group tag first — NOTE the row spreads AFTER, so a source field literally named the noun wins (the
      // panel's documented trade-off, mirrored rather than diverged from).
      if (tagged.length < cap) tagged.push((row && typeof row === 'object') ? { [noun]: it.label, ...row } : { [noun]: it.label, value: row });
    }
  }
  const truncated = seen > tagged.length;
  const fixedStr = Object.entries(fixed).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${String(v).slice(0, 20)}`).join(', ');
  const each = {
    recipeId: (leg.tool && leg.tool.recipeId) || leg.key || '', noun,
    total: all.length, ok: items.length, failed, seen, returned: tagged.length,
    truncated, capped: r.capped === true, fixed: fixedStr, rowCap: cap,
  };
  if (!items.length) {
    // total failure exits; the first per-item error rides out so Core/trigger.isTransientFailure can keep an
    // auth blip ('not-logged-in') out of the disarm count — the panel's "session may have expired" case.
    return { ok: false, error: firstError || 'each-total-failure', each };
  }
  // { rows, truncated, seen } — EXACTLY the shape headlessClause.rowsOf accepts as prior rows for a map step.
  return { ok: true, value: { rows: tagged, truncated, seen }, each };
}
