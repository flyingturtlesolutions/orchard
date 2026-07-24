// Core/runDriver.js — CD-1a (DESIGN_cadence.md §2.2 / §11.2): the extracted CHAIN LOOP. PURE control flow over an
// injected REPORTER and an injected per-step executor. The centrepiece — the last piece of the run path that still
// held its own DOM IO.
//
// The move (§2.2): the panel is the CONTROL + REPORTING surface, not the execution engine. So the loop that walks
// a workflow's clauses becomes host-agnostic — it calls `reporter.*` instead of writing into a `msg` element, and
// delegates each clause to an injected `runStep`. Two reporters, one loop:
//
//   | host          | reporter   | gate()        | done()                 |
//   | panel         | DOM        | confirm bar   | finalizes the bubble   |
//   | service worker| history    | returns 'park'| writes the wfruns entry|
//
// `gate` is the load-bearing row (§11.2): park-versus-prompt is a property of WHETHER ANYONE IS WATCHING, which is
// exactly what the reporter encodes — a write step calls `reporter.gate(preview)` and the reporter decides. A
// missing/partial reporter defaults gate() to 'park' (fail safe: no surface ⇒ nobody watching ⇒ never auto-write).
//
// The template is Core/upsert.js `runUpsert`: injected async IO plus a callback that CANNOT change the verdict.
// This is that, scaled to a chain. `startIndex` + `state` are the park/resume seam (§8) — both already exist on
// chat.js's _orchRunChain, so resuming a parked run needs no new parameters.

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** A run's terminal verdict. `parked` is §8 — a write stopped it for a human; distinct from a failure. */
export const DRIVER_VERDICTS = Object.freeze(['complete', 'partial', 'failed', 'empty', 'parked']);

/**
 * Normalize a possibly-partial reporter into the full five-method contract, each guaranteed callable. A logging
 * method that throws must never change a verdict (the upsert `say` discipline), so every call is swallowed —
 * EXCEPT gate, whose return value IS a decision and so is preserved. PURE.
 */
export function normalizeReporter(reporter) {
  const o = (reporter && typeof reporter === 'object') ? reporter : {};
  const safe = (name) => (typeof o[name] === 'function'
    ? (...a) => { try { return o[name](...a); } catch { /* a reporter never changes the run */ return undefined; } }
    : () => undefined);
  return {
    step: safe('step'),         // (i, total, text) — "step 2 of 5"
    progress: safe('progress'), // (text)           — live status weaving
    result: safe('result'),     // (payload)        — a readout to render / accumulate
    // gate(preview) → true (proceed) | false (cancel) | 'park' (stop, surface as a case). No reporter ⇒ 'park'.
    gate: typeof o.gate === 'function' ? async (preview) => { try { return await o.gate(preview); } catch { return 'park'; } } : async () => 'park',
    done: safe('done'),         // (verdict)         — finalize / write the history entry
  };
}

/**
 * Run a workflow's clause chain. PURE control flow; every effect is injected.
 *
 * @param {object}   opts
 * @param {Array}    opts.clauses     the replay plan's clauses ({text, pinned?}) — from Core/workflowWizard.replayPlan
 * @param {object}   opts.reporter    the host reporter (panel DOM / SW history) — see normalizeReporter
 * @param {(clause:object, ctx:{index:number,total:number,state:object,reporter:object}) => Promise<object>} opts.runStep
 *        executes ONE clause. Returns { ok, value?, state?, stop?, park?, parkedRunId?, preview?, error? }.
 *        A write-bearing step calls `ctx.reporter.gate(preview)` itself and returns { park:true } when it decides so.
 * @param {number}   [opts.startIndex=0]  resume point (§8 park/resume)
 * @param {object}   [opts.state=null]    carried chain state (readouts, lastValue, …)
 * @returns {Promise<{verdict:string, ranSteps:number, failedSteps:number, parkedAt:number, parkedRunId:string, state:object}>}
 */
export async function runWorkflow({ clauses, reporter, runStep, startIndex = 0, state = null } = {}) {
  const rep = normalizeReporter(reporter);
  const list = Array.isArray(clauses) ? clauses : [];
  const total = list.length;

  if (typeof runStep !== 'function') { rep.done('failed'); return _result('failed', 0, 0, -1, '', state || {}); }
  if (!total) { rep.done('empty'); return _result('empty', 0, 0, -1, '', state || {}); }

  let st = (state && typeof state === 'object') ? state : {};
  let ran = 0, failed = 0;
  let firstFailure = null;   // §6.5 — the FIRST failing step is the audit story (the chain may continue past soft fails)

  for (let i = Math.max(0, Number(startIndex) || 0); i < total; i++) {
    const clause = list[i] || {};
    rep.step(i, total, _str(clause.text));

    let r;
    try { r = await runStep(clause, { index: i, total, state: st, reporter: rep }); }
    catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
    r = (r && typeof r === 'object') ? r : {};

    if (r.state && typeof r.state === 'object') st = r.state;

    // ── park: a write reached with nobody watching (§8). Stop HERE, resumable from this index. ──────────────
    if (r.park) {
      rep.done('parked');
      return _result('parked', ran, failed, i, _str(r.parkedRunId), st);
    }

    if (r.ok) {
      ran++;
      if (r.value !== undefined) rep.result(r.value);
      continue;
    }

    // a failed step: record it. `stop` (a hard fail / auth stop) ends the run; otherwise the chain continues so
    // one flaky step doesn't sink the rest (the loose-chain behaviour _orchRunChain already has).
    failed++;
    if (!firstFailure) firstFailure = { i, text: _str(clause.text), error: _str(r.error) };
    if (r.stop) {
      const v = ran > 0 ? 'partial' : 'failed';
      rep.done(v);
      return _result(v, ran, failed, -1, '', st, firstFailure);
    }
  }

  const verdict = failed === 0 ? 'complete' : (ran > 0 ? 'partial' : 'failed');
  rep.done(verdict);
  return _result(verdict, ran, failed, -1, '', st, firstFailure);
}

function _result(verdict, ranSteps, failedSteps, parkedAt, parkedRunId, state, failedStep = null) {
  return { verdict, ranSteps, failedSteps, parkedAt, parkedRunId: parkedRunId || '', state: state || {}, failedStep };
}

/**
 * A pure ACCUMULATING reporter for the service-worker side: it renders nothing and gate()→'park' (nobody is
 * watching), but records everything the history entry needs. The handler wraps `.snapshot()` into the wfruns
 * entry. Kept here (not the handler) so the accumulation is tested. PURE.
 */
export function makeAccumulatorReporter() {
  const acc = { steps: 0, total: 0, results: [], verdict: '', lastText: '', gates: 0, preview: null };
  return {
    step(i, total, text) { acc.steps = Math.max(acc.steps, i + 1); acc.total = total; acc.lastText = String(text || ''); },
    progress() { /* no surface */ },
    result(payload) { acc.results.push(payload); },
    gate(preview) { acc.gates++; acc.preview = preview || null; return 'park'; },   // §8 — a scheduled run reaching a write always parks; keep the preview for the case
    done(verdict) { acc.verdict = String(verdict || ''); },
    snapshot() {
      return {
        steps: acc.steps, total: acc.total, results: acc.results.slice(),
        verdict: acc.verdict, parked: acc.gates > 0 || acc.verdict === 'parked', preview: acc.preview,
      };
    },
  };
}

/**
 * The RESUME reporter (§8, CD-7): after a human approved a parked run, re-fire it with THIS reporter. The FIRST
 * write it reaches — the one the person saw the preview for and approved — gets `gate()→true` (proceed); every
 * SUBSEQUENT write re-parks (`'park'`), because §8's rule is one approval per write, never a blanket "approve the
 * rest". Same accumulation as the SW reporter otherwise. PURE.
 */
export function makeResumeReporter() {
  const acc = { steps: 0, total: 0, results: [], verdict: '', gates: 0, approved: false, preview: null };
  return {
    step(i, total) { acc.steps = Math.max(acc.steps, i + 1); acc.total = total; },
    progress() { /* no surface */ },
    result(payload) { acc.results.push(payload); },
    gate(preview) {
      acc.gates++;
      if (!acc.approved) { acc.approved = true; return true; }   // the approved write proceeds
      acc.preview = preview || null; return 'park';              // a later write re-parks (a fresh approval)
    },
    done(verdict) { acc.verdict = String(verdict || ''); },
    snapshot() {
      return {
        steps: acc.steps, total: acc.total, results: acc.results.slice(),
        verdict: acc.verdict, parked: acc.verdict === 'parked', preview: acc.preview, approvedWrite: acc.approved,
      };
    },
  };
}
