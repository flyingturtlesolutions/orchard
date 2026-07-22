/**
 * Core/upsert.js — PP-2 (v2.74.1661): find-or-create-then-act, with the three-outcome contract.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §3 (UPSERT) · §3.1 (multi-arm + idempotency) · §10.1 (trial tagging).
 *
 * ── WHY THIS IS NOT BUILT ON THE `try` NODE ─────────────────────────────────────────────────────────────────
 * §3 flagged the hazard and made it a precondition: *"`try`'s `recover` arm reached on ANY failure would be
 * exactly this bug; confirm what triggers `recover` before using it."* It was confirmed, and the answer is that
 * `try` is the WRONG HOST:
 *
 *   Services/ExecutionEngine.js:1515-1531 — recover is chosen by elimination on a three-valued STATUS:
 *     status === 'ok'      → return ok
 *     status === 'aborted' → propagate
 *     otherwise            → run recover        ← any 'failed', for any reason
 *
 * The engine's result shape is `{status, error?}` where `error` is a bare STRING (`:560-567`). There is no code,
 * category or cause. Worse, `TemplateWalker.#msg` retries a never-delivered channel 6× and then throws, and every
 * `#executeStep` call site converts that throw into a success-false string — so a dead tab, an uninjected content
 * script, and a selector that legitimately matched nothing all arrive at `try` as the SAME `status:'failed'`.
 *
 * Building find-or-create on `try` would therefore create a duplicate record every time the lookup merely failed
 * to reach the service. That is the v1637 bug (unreachable read scored as a miss) with a write on the end of it.
 *
 * So UPSERT owns its own control flow, over a find that MUST report three outcomes.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────────────────────────────────────
 *   hit         → act on what was found
 *   miss        → re-check, then create, then act
 *   unreachable → STOP. Report. **DO NOT CREATE.**
 * The third outcome is the entire point. A two-outcome find turns every transport blip into a duplicate record.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** The three outcomes a `find` must be able to report. A find that cannot say `unreachable` is unsafe here. */
export const FIND_OUTCOMES = Object.freeze(['hit', 'miss', 'unreachable']);

/** What an upsert reports. `blocked` = we refused to act (unreachable find, or a re-check that went ambiguous). */
export const UPSERT_OUTCOMES = Object.freeze(['hit', 'created', 'blocked', 'failed']);

/**
 * Normalize whatever a caller's find returned into the three-outcome contract. PURE.
 *
 * Deliberately STRICT: an unrecognized shape is `unreachable`, never `miss`. The failure modes are asymmetric —
 * reading an unreachable result as a miss creates a duplicate record, while reading a miss as unreachable merely
 * stops and asks a human. §3's rule: when the two errors differ in cost this much, default to the cheap one.
 */
export function normalizeFindResult(r) {
  if (r && typeof r === 'object' && FIND_OUTCOMES.includes(r.outcome)) {
    return { outcome: r.outcome, record: r.record ?? null, why: _str(r.why) };
  }
  if (r === null || r === undefined) {
    return { outcome: 'unreachable', record: null, why: 'find returned nothing — cannot distinguish miss from failure' };
  }
  return { outcome: 'unreachable', record: null, why: `find returned an unrecognized shape (${typeof r})` };
}

/**
 * Run one item's upsert. The caller injects every effect; this function owns only the DECISION.
 *
 * @param {Object}   item
 * @param {Object}   io
 * @param {(item:Object) => Promise<Object>} io.find     MUST return {outcome:'hit'|'miss'|'unreachable', record?, why?}
 * @param {(item:Object) => Promise<Object>} io.create   returns the created record; throwing is a `failed` upsert
 * @param {(item:Object, record:Object, ctx:Object) => Promise<*>} [io.act]   optional follow-on action
 * @param {(item:Object) => Promise<Object>} [io.recheck]  re-run of `find` immediately before create (§3.1)
 * @param {string}   [io.trialTag]   stamped onto create as `orchard-trial-<runId>` (§10.1) — findable residue
 * @param {(line:string) => void} [io.onDisposition]      §5.5 — every branch reports, including the refusals
 * @returns {Promise<{outcome:string, record:Object|null, acted:boolean, why:string}>}
 */
export async function runUpsert(item, {
  find, create, act = null, recheck = null, trialTag = '', onDisposition = null,
} = {}) {
  const say = (line) => { if (onDisposition) { try { onDisposition(line); } catch { /* logging never changes a verdict */ } } };
  const done = (outcome, record, acted, why) => ({ outcome, record: record ?? null, acted: !!acted, why: _str(why) });

  if (typeof find !== 'function') return done('blocked', null, false, 'no find supplied');

  let found;
  try { found = normalizeFindResult(await find(item)); }
  catch (e) { const why = `find threw: ${(e && e.message) || e}`; say(`unreachable(${why})`); return done('blocked', null, false, why); }

  // ── unreachable: the whole reason this file exists ────────────────────────────────────────────────────────
  if (found.outcome === 'unreachable') {
    say(`unreachable(${found.why || 'lookup could not complete'})`);
    return done('blocked', null, false, found.why || 'lookup could not complete');
  }

  // ── hit ───────────────────────────────────────────────────────────────────────────────────────────────────
  if (found.outcome === 'hit') {
    say('hit');
    if (!act) return done('hit', found.record, false, '');
    try { await act(item, found.record, { via: 'hit' }); return done('hit', found.record, true, ''); }
    catch (e) { const why = `act threw: ${(e && e.message) || e}`; say(`failed(${why})`); return done('failed', found.record, false, why); }
  }

  // ── miss → re-check, then create ──────────────────────────────────────────────────────────────────────────
  //
  // The re-check is NOT belt-and-braces. For a CREATE, absence is the normal case and presence is the stale
  // case — the inverse of the UPDATE case the proposal queue's staleness CAS was built for (recorded at v1639,
  // where a `basedOn.path` that was never verified against a real response failed OPEN). An unattended upsert
  // has no queue in front of it, so it re-checks inline or it races.
  if (recheck) {
    let again;
    try { again = normalizeFindResult(await recheck(item)); }
    catch (e) { const why = `recheck threw: ${(e && e.message) || e}`; say(`blocked(${why})`); return done('blocked', null, false, why); }

    if (again.outcome === 'hit') {
      // Someone else created it between find and create. That is a HIT, not a second create.
      say('hit(on recheck — created concurrently)');
      if (!act) return done('hit', again.record, false, 'found on recheck');
      try { await act(item, again.record, { via: 'recheck' }); return done('hit', again.record, true, 'found on recheck'); }
      catch (e) { const why = `act threw: ${(e && e.message) || e}`; say(`failed(${why})`); return done('failed', again.record, false, why); }
    }
    if (again.outcome === 'unreachable') {
      // The first look said miss, the second could not tell. Creating now risks a duplicate — refuse.
      say(`blocked(recheck unreachable: ${again.why})`);
      return done('blocked', null, false, `recheck could not confirm absence: ${again.why}`);
    }
  }

  if (typeof create !== 'function') return done('blocked', null, false, 'no create supplied');

  let made;
  try { made = await create(item, { trialTag: _str(trialTag) }); }
  catch (e) { const why = `create threw: ${(e && e.message) || e}`; say(`failed(${why})`); return done('failed', null, false, why); }

  if (made == null) {
    // A create that returns nothing may or may not have written. Treat it as failed and SAY so — the residue is
    // findable by trial tag (§10.1), which is exactly why the tag matters more than the returned id.
    const why = 'create returned nothing — a record may exist without a captured id';
    say(`failed(${why})`);
    return done('failed', null, false, why);
  }

  say('created');
  if (!act) return done('created', made, false, '');
  try { await act(item, made, { via: 'created' }); return done('created', made, true, ''); }
  catch (e) { const why = `act threw: ${(e && e.message) || e}`; say(`failed(${why})`); return done('created', made, false, why); }
}

/**
 * Resolve an upsert target ONCE per item, memoized by key. §3.1's second-order hazard: under `mode:'all'`, two
 * arms that both upsert the same entity would otherwise create it twice.
 *
 * @param {(item:Object) => string} keyOf  stable identity for the target within one item's run
 */
export function upsertOnce(keyOf) {
  const seen = new Map();
  return function once(item, run) {
    const k = _str(typeof keyOf === 'function' ? keyOf(item) : '') || '_';
    if (!seen.has(k)) seen.set(k, Promise.resolve().then(() => run(item)));
    return seen.get(k);
  };
}

/**
 * Honest tally across a run. Every class named INCLUDING the zeroes (§5.5) — a silently absent class reads as
 * "did not happen" when it may mean "not counted".
 */
export function upsertTally(results) {
  const list = Array.isArray(results) ? results : [];
  const n = { hit: 0, created: 0, blocked: 0, failed: 0 };
  for (const r of list) if (r && n[r.outcome] !== undefined) n[r.outcome]++;
  const parts = [`${n.hit} found`, `${n.created} created`, `${n.blocked} blocked`, `${n.failed} failed`];
  return `${list.length} item${list.length === 1 ? '' : 's'} — ${parts.join(' · ')}`;
}
