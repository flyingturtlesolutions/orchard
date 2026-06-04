// Core/orchRun.js — ORCH-L: the PURE plan interpreter (control-flow walker).
//
// validatePlan (orchPlan.js) guarantees a plan is well-formed; THIS module RUNS it. The control flow —
// sequence, foreach, loop, gate, and per-iteration collect — lives here as pure logic; ALL I/O (running a
// fragment, reading an observation, evaluating an analysis) is delegated to an `exec` interface the runtime
// supplies. That separation is the point: the loop/branch semantics are unit-testable with a mock exec (no DOM,
// no chrome), and the SAME walker drives the chat runner, the tier-2 runner, and a headless replay.
//
//   walkPlan(plan, exec, opts?) → { ok, error, outputs, produced, trace }
//
// The `exec` interface (all async, all return { ok, value?, items?, error? }):
//   exec.fragment(step, scope)            run an action capability      → { ok, error? }
//   exec.observe(step, scope)             run a read                    → { ok, value, items? }   // items[] for a list driver
//   exec.analyze(step, overResult, scope) reason over an observation    → { ok, value, items? }   // optional; default = passthrough of `over`
//
//   `scope` = { vars, item, index } — the current foreach element + bound vars; the runtime uses it to target the
//   Nth item (e.g. a per-item selector) when running a body step.
//
// Control-flow semantics:
//   • sequence  — run steps in order; a fragment/observe/gate/loop FAILURE aborts the (sub)plan.
//   • foreach   — `over` produced a list; run `body` once per item (LENIENT: one item's failure is recorded and
//                 skipped, the rest continue — "the salaries of EACH" shouldn't abort because one row lacks one).
//   • loop      — `over` produced a count; run `body` that many times.
//   • gate      — `over` produced a predicate; run `body` iff truthy (a closed gate is a SKIP, not a failure).
//   • collect   — a foreach/loop with `collect:'NAME'` accumulates each iteration's result (the body's
//                 `collectFrom` step, else its LAST observe/analyze) into outputs[NAME].
//
// PURE: no DOM / chrome / LLM. Deterministic given a deterministic exec.
//
// @module Core/orchRun
// @version 2.74.720

const _AFFIRMATIVE = /^\s*(yes|true|y|present|available|in ?stock|enabled|on|1)\s*$/i;

/** Truthiness for a gate's predicate value. PURE. Booleans pass through; strings match an affirmative vocabulary;
 *  a non-empty number/array is truthy; null/undefined/'' are false. */
export function gatePasses(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  if (typeof value === 'number') return value > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return _AFFIRMATIVE.test(value);
  return !!value;
}

/** Coerce a loop/foreach driver result into an iterable list of items + a count. PURE. */
function _itemsOf(driver) {
  if (!driver) return [];
  if (Array.isArray(driver.items)) return driver.items;
  if (Array.isArray(driver.value)) return driver.value;
  return [];
}
function _countOf(driver) {
  if (!driver) return 0;
  const n = parseInt(driver.value, 10);
  if (Number.isFinite(n)) return Math.max(0, n);
  return _itemsOf(driver).length;
}

/** What a foreach/loop iteration contributes to its `collect` list: the value of the body's `collectFrom` step
 *  (a body step id) or, by default, the body's LAST observe/analyze. PURE — reads `produced` (set during the
 *  iteration's body walk). Returns undefined when there's nothing to collect (so the item is skipped). */
function _collectValue(node, produced) {
  const body = Array.isArray(node.body) ? node.body : [];
  let targetId = node.collectFrom;
  if (!targetId) {
    for (let i = body.length - 1; i >= 0; i--) {
      const b = body[i];
      if (b && (b.kind === 'observe' || b.kind === 'analyze')) { targetId = b.id; break; }
    }
  }
  if (!targetId || !produced.has(targetId)) return undefined;
  const r = produced.get(targetId);
  return r ? r.value : undefined;
}

/**
 * Run a validated plan IR. PURE control logic; I/O via `exec`. Returns the run env:
 *   { ok, error, outputs, produced (Map id→result), trace }
 * `ok:false` means a sequence step (fragment/observe/gate-body/loop-body) failed — `error` says which.
 * @param {{goal?:string, steps:object[]}} plan
 * @param {{fragment:Function, observe:Function, analyze?:Function}} exec
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, error:(string|null), outputs:object, produced:Map, trace:object[]}>}
 */
export async function walkPlan(plan, exec, opts = {}) {
  const env = { produced: new Map(), outputs: {}, trace: [] };
  const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
  const r = await _walk(steps, exec, env, { vars: {}, item: null, index: null });
  return { ok: r.ok, error: r.ok ? null : (r.error || 'plan failed'), outputs: env.outputs, produced: env.produced, trace: env.trace };
}

async function _walk(steps, exec, env, scope) {
  for (const s of (Array.isArray(steps) ? steps : [])) {
    const r = await _walkStep(s, exec, env, scope);
    if (!r.ok) return r;   // a sequence aborts on the first failure
  }
  return { ok: true };
}

async function _walkStep(s, exec, env, scope) {
  if (!s || !s.kind) return { ok: true };
  switch (s.kind) {
    case 'fragment': {
      const r = await exec.fragment(s, scope);
      env.trace.push({ id: s.id, kind: 'fragment', ok: !!(r && r.ok) });
      return (r && r.ok) ? { ok: true } : { ok: false, error: (r && r.error) || `fragment "${s.id}" failed` };
    }
    case 'observe': {
      const r = await exec.observe(s, scope);
      env.trace.push({ id: s.id, kind: 'observe', ok: !!(r && r.ok), value: r && r.value });
      if (!r || r.ok === false) return { ok: false, error: (r && r.error) || `observe "${s.id}" failed` };
      env.produced.set(s.id, r);
      return { ok: true };
    }
    case 'analyze': {
      const over = env.produced.get(s.over) || null;
      const r = (typeof exec.analyze === 'function') ? await exec.analyze(s, over, scope) : { ok: true, value: over ? over.value : undefined, items: over ? over.items : undefined };
      env.trace.push({ id: s.id, kind: 'analyze', ok: !!(r && r.ok) });
      if (!r || r.ok === false) return { ok: false, error: (r && r.error) || `analyze "${s.id}" failed` };
      env.produced.set(s.id, r);
      return { ok: true };
    }
    case 'foreach': {
      const items = _itemsOf(env.produced.get(s.over));
      const collected = [];
      let done = 0, skipped = 0;
      for (let i = 0; i < items.length; i++) {
        const childScope = { vars: { ...(scope.vars || {}), [s.itemVar || 'item']: items[i] }, item: items[i], index: i };
        const r = await _walk(s.body, exec, env, childScope);
        if (!r.ok) { skipped++; continue; }   // LENIENT: one item's failure doesn't abort the loop
        done++;
        if (s.collect) { const cv = _collectValue(s, env.produced); if (cv !== undefined) collected.push(cv); }
      }
      if (s.collect) env.outputs[s.collect] = collected;
      env.trace.push({ id: s.id, kind: 'foreach', items: items.length, done, skipped, collect: s.collect || null });
      return { ok: true };
    }
    case 'loop': {
      const n = _countOf(env.produced.get(s.over));
      const collected = [];
      for (let i = 0; i < n; i++) {
        const childScope = { vars: { ...(scope.vars || {}), [s.itemVar || 'i']: i }, item: null, index: i };
        const r = await _walk(s.body, exec, env, childScope);
        if (!r.ok) return r;   // a loop is deterministic — abort on body failure
        if (s.collect) { const cv = _collectValue(s, env.produced); if (cv !== undefined) collected.push(cv); }
      }
      if (s.collect) env.outputs[s.collect] = collected;
      env.trace.push({ id: s.id, kind: 'loop', count: n, collect: s.collect || null });
      return { ok: true };
    }
    case 'gate': {
      const driver = env.produced.get(s.over) || null;
      const pass = gatePasses(driver ? driver.value : undefined);
      env.trace.push({ id: s.id, kind: 'gate', pass });
      if (!pass) return { ok: true };   // closed gate → SKIP body, not a failure
      return _walk(s.body, exec, env, scope);
    }
    default:
      return { ok: true };   // unknown kind — validatePlan already flags it; the walker no-ops
  }
}
