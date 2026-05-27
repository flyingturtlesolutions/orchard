// Core/outcomes.js — OutcomeEvent stream: schema, factory, adapters, rollups.
//
// See OUTCOMES_SPEC.md + GROUND_SPEC.md § 0.13–0.17. ONE unified append-only
// stream is both the training corpus and the usage-metrics source; artifacts
// carry only small ROLLUPS derived from it (§ 0.13). This module is PURE (no
// chrome / DOM deps) so it runs in the background, the sidepanel, and node unit
// tests alike — mirroring Core/locale.js.
//
// v1 (OUTCOMES_SPEC § 8) lands: the OutcomeEvent schema + factory; adapters from
// the existing telemetry seeds (`_logResolveRun`, `#audit`, § 9); the derived
// rollups (Feature.health / Perspective.usage / Ground.conventions histogram,
// § 4); corpusRef minting (stubbed body, § 0.17); and ACTIVE confidence decay
// from resolve-misses (§ 7, § 0.16). The emit hooks at the live call sites are a
// later wiring slice; these pure functions are additive and forward-compatible.
//
// v2.74.412 — Build slice 1 of the OUTCOMES arc: pure module only.

export const OUTCOMES_SCHEMA = 1;

export const PHASES = Object.freeze(['author', 'runtime']);
export const OPS = Object.freeze(['locate', 'resolve', 'poke', 'profile', 'activate', 'action']);
export const VERDICTS = Object.freeze(['verified', 'failed', 'abstained', 'corrected']);
export const OUTCOMES = Object.freeze(['success', 'failure']);
export const PROVENANCE_SOURCES = Object.freeze(['enumeration', 'llm-resolve', 'llm-locate', 'human-pick']);
export const LIFECYCLE = Object.freeze(['fresh', 'verified', 'stale-suspected', 'stale', 'retired']);

// ─── id minting ─────────────────────────────────────────────────────────────────

/** djb2 — same deriver style as Core/locale.js (base36). */
export function hashId(s) {
  const str = String(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Stable-ish unique event id. Seeds with ts + a payload digest + entropy. */
export function mintEventId(seed = '') {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return 'evt_' + hashId(`${ts}|${seed}|${rand}`);
}

/**
 * corpusRef for the full proposal→outcome→correction pair (§ 0.14, § 0.17). The
 * id is minted NOW even though the labeled-corpus store is stubbed in v1, so the
 * later fill is non-breaking: the artifact already points at the (future) body.
 */
export function mintCorpusRef(eventId) {
  return 'corpus_' + hashId(String(eventId || mintEventId()));
}

// ─── Event factory (OUTCOMES_SPEC § 5) ──────────────────────────────────────────

/**
 * Normalize a partial into a complete OutcomeEvent. Mints `id` + `ts` if absent;
 * mints a `corpusRef` for authoring events (training pairs). Unknown
 * phase/op/verdict are coerced to safe defaults rather than thrown — the stream
 * is append-only and must never reject a real signal.
 * @returns {object} OutcomeEvent
 */
export function makeEvent(partial = {}) {
  const p = partial || {};
  const phase = PHASES.includes(p.phase) ? p.phase : 'author';
  const op = OPS.includes(p.op) ? p.op : 'resolve';
  const ts = typeof p.ts === 'number' ? p.ts : Date.now();
  const id = p.id || mintEventId(`${p.groundId || ''}|${op}|${p.featureId || p.role || ''}`);
  const verdict = VERDICTS.includes(p.verdict) ? p.verdict : undefined;
  const ev = {
    id, ts, schema: OUTCOMES_SCHEMA,
    phase, op,
    groundId: p.groundId ?? null,
    localeId: p.localeId ?? null,
    perspectiveId: p.perspectiveId ?? null,
    featureId: p.featureId ?? null,
    role: p.role ?? null,
  };
  if (p.input) ev.input = p.input;                       // { roleOrIntent, screenshotRef?, domHash?, contextRefs? }
  if (p.llmOutput) ev.llmOutput = p.llmOutput;           // { box?|selector?|goals?, confidence, model, operation }
  if (verdict) ev.verdict = verdict;
  if (p.humanFinal) ev.humanFinal = p.humanFinal;        // the correction, if any
  if (OUTCOMES.includes(p.outcome)) ev.outcome = p.outcome;
  if (p.detail) ev.detail = p.detail;                    // { matchedCount?, iou?, reason? }
  // Authoring events are training pairs → always carry a corpusRef (body stubbed).
  if (phase === 'author') ev.corpusRef = p.corpusRef || mintCorpusRef(id);
  return ev;
}

// ─── Adapters from existing telemetry seeds (OUTCOMES_SPEC § 9) ──────────────────

/**
 * Resolve-run → authoring `resolve` events. `_logResolveRun` (perspective-capture)
 * already records per-role outcomes; each `details[]` row becomes one event.
 * A row carrying `humanFinal` (a human re-pick after the LLM's selector failed)
 * is the GOLD label → verdict 'corrected'. `ctx` supplies the ids the run entry
 * lacks (groundId / localeId / perspectiveId, and an optional role→featureId map).
 * @param {object} run   a _logResolveRun entry: { ts, url, mode, details:[{role,status,selector,reason,matchedCount,confidence,humanFinal?}] }
 * @param {object} ctx   { groundId?, localeId?, perspectiveId?, model?, featureIdForRole?(role, selector)->id|null }
 * @returns {object[]} OutcomeEvent[]
 */
export function eventsFromResolveRun(run, ctx = {}) {
  const details = Array.isArray(run?.details) ? run.details : [];
  const out = [];
  for (const d of details) {
    if (!d || typeof d.role !== 'string') continue;
    if (d.status === 'skipped') continue;               // role already filled — not a signal
    const verdict =
      d.humanFinal ? 'corrected' :
      d.status === 'resolved' ? 'verified' :
      d.status === 'abstained' ? 'abstained' : 'failed';
    // featureId tracks the element resolve PROPOSED/attempted (`d.selector`) — so
    // a 'verified' row credits the feature that worked, a 'failed' row debits the
    // one that didn't, and a 'corrected' row debits the WRONG element the LLM
    // proposed (active decay flags it). The human's truth selector rides in
    // `humanFinal` for the corpus + the conventions histogram, NOT for decay —
    // we must never penalize the feature the human confirmed is correct.
    const fidSelector = d.selector ?? null;
    out.push(makeEvent({
      ts: run.ts,
      phase: 'author',
      op: 'resolve',
      groundId: ctx.groundId ?? null,
      localeId: ctx.localeId ?? null,
      perspectiveId: ctx.perspectiveId ?? null,
      featureId: (typeof ctx.featureIdForRole === 'function' ? ctx.featureIdForRole(d.role, fidSelector) : null) ?? null,
      role: d.role,
      input: { roleOrIntent: d.role, domHash: run.domHash ?? undefined },
      llmOutput: d.selector ? { selector: d.selector, confidence: d.confidence, model: ctx.model, operation: 'resolve' } : undefined,
      verdict,
      humanFinal: d.humanFinal,
      detail: { matchedCount: d.matchedCount, reason: d.reason },
    }));
  }
  return out;
}

/**
 * `#audit` telemetry → a minimal event (operational seed, § 9). The audit entry
 * is cost/latency only today; this widens it into the stream so authoring ops
 * are counted even before per-feature content fields are wired.
 * @param {object} entry  { ts, role, operation, ok, error?, model }
 */
export function eventFromAudit(entry = {}) {
  const opMap = { resolve: 'resolve', describe: 'profile', locate: 'locate', ground: 'resolve' };
  return makeEvent({
    ts: entry.ts,
    phase: 'author',
    op: opMap[entry.role] || 'profile',
    llmOutput: { model: entry.model, operation: entry.operation },
    verdict: entry.ok ? 'verified' : 'failed',
    detail: entry.error ? { reason: entry.error } : undefined,
  });
}

// ─── Selector-tier classifier (mirrors Core/locale.js for one histogram vocab) ─

export function selectorTier(sel) {
  if (!sel) return 'positional';
  if (/(^|\s|>)#[A-Za-z]/.test(sel)) return 'id';
  if (/\[data-/.test(sel)) return 'data';
  if (/\[aria-|\[role=/.test(sel)) return 'aria';
  if (/:nth-|:first-|:last-|>\s|\+\s|~\s/.test(sel)) return 'positional';
  if (/\./.test(sel)) return 'class';
  return 'semantic';
}

// ─── Rollups (OUTCOMES_SPEC § 4) — all DERIVED, never authored ───────────────────

/**
 * Fold authoring/runtime events into per-Feature health. Events without a
 * `featureId` are skipped (the rollup is feature-keyed). Pure: pass a `prior`
 * map to fold incrementally onto existing rollups.
 * @returns {Object<string, {lifecycle,lastVerifiedAt,resolveHits,resolveMisses,lastResolvedAt}>}
 */
export function foldFeatureHealth(events, prior = {}) {
  const out = {};
  for (const k of Object.keys(prior)) out[k] = { ...prior[k] };
  for (const ev of Array.isArray(events) ? events : []) {
    const fid = ev?.featureId;
    if (!fid) continue;
    const h = out[fid] || (out[fid] = { lifecycle: 'fresh', lastVerifiedAt: null, resolveHits: 0, resolveMisses: 0, lastResolvedAt: null });
    const isResolveLike = ev.op === 'resolve' || ev.op === 'locate' || ev.op === 'poke' || ev.op === 'action';
    const failed = ev.verdict === 'failed' || ev.verdict === 'corrected' || ev.outcome === 'failure';
    const verified = ev.verdict === 'verified' || ev.outcome === 'success';
    if (isResolveLike && verified) {
      h.resolveHits++;
      h.lastVerifiedAt = ev.ts;
      h.lastResolvedAt = ev.ts;
      if (h.lifecycle === 'fresh' || h.lifecycle === 'stale-suspected') h.lifecycle = 'verified';
    } else if (isResolveLike && failed) {
      h.resolveMisses++;
      h.lastResolvedAt = ev.ts;
    }
    // 'abstained' is not a hit or a miss — it does not move health.
  }
  return out;
}

/**
 * Fold runtime events into per-Perspective usage (§ 4). Counts `activate`/`action`
 * ops with a success/failure outcome.
 * @returns {Object<string, {activations,lastUsedAt,successRate,lastOutcome}>}
 */
export function foldPerspectiveUsage(events, prior = {}) {
  const acc = {};
  // Seed running success/total from prior (reconstruct from successRate*activations).
  for (const k of Object.keys(prior)) {
    const p = prior[k];
    const total = p.activations || 0;
    const succ = Math.round((p.successRate ?? 0) * total);
    acc[k] = { activations: total, succ, lastUsedAt: p.lastUsedAt ?? null, lastOutcome: p.lastOutcome ?? null };
  }
  for (const ev of Array.isArray(events) ? events : []) {
    const pid = ev?.perspectiveId;
    if (!pid) continue;
    if (ev.op !== 'activate' && ev.op !== 'action') continue;
    if (!OUTCOMES.includes(ev.outcome)) continue;
    const a = acc[pid] || (acc[pid] = { activations: 0, succ: 0, lastUsedAt: null, lastOutcome: null });
    a.activations++;
    if (ev.outcome === 'success') a.succ++;
    a.lastUsedAt = ev.ts;
    a.lastOutcome = ev.outcome;
  }
  const out = {};
  for (const [pid, a] of Object.entries(acc)) {
    out[pid] = {
      activations: a.activations,
      lastUsedAt: a.lastUsedAt,
      successRate: a.activations ? a.succ / a.activations : 0,
      lastOutcome: a.lastOutcome,
    };
  }
  return out;
}

/**
 * Fold verified/corrected selectors into a Ground conventions histogram (§ 6,
 * § 0.15). A 'corrected' event uses the HUMAN-final selector (the truth); a
 * 'verified' event uses the LLM's accepted selector. Returns fractions + raw
 * counts so a downstream bias can read either. Recomputed lazily, not per event.
 * @returns {{selectorTierHistogram:Object<string,number>, counts:Object<string,number>, total:number, recomputedAt:number}}
 */
export function foldConventions(events, prior = null) {
  const counts = {};
  for (const ev of Array.isArray(events) ? events : []) {
    let sel = null;
    if (ev?.verdict === 'corrected') sel = ev.humanFinal?.selector ?? null;
    else if (ev?.verdict === 'verified') sel = ev.llmOutput?.selector ?? ev.humanFinal?.selector ?? null;
    if (!sel) continue;
    const tier = selectorTier(sel);
    counts[tier] = (counts[tier] || 0) + 1;
  }
  if (prior?.counts) for (const [k, v] of Object.entries(prior.counts)) counts[k] = (counts[k] || 0) + v;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const histogram = {};
  for (const [k, v] of Object.entries(counts)) histogram[k] = total ? v / total : 0;
  return { selectorTierHistogram: histogram, counts, total, recomputedAt: Date.now() };
}

// ─── Active confidence decay (OUTCOMES_SPEC § 7, GROUND_SPEC § 0.16) ──────────────

/**
 * Confidence decay, returning the proposed next {confidence, lifecycle, lastDecayedAt} + whether
 * anything changed (caller persists). PURE. WITHOUT touching siblings (§ 8 feature-drift). Two halves:
 *
 *  - ACTIVE (miss-driven): observed resolve-misses beyond what successes offset lower confidence
 *    and flip lifecycle toward `stale-suspected`.
 *  - PASSIVE (age-based, GROUND §0.16's previously-deferred half): a Feature unproven for a long
 *    time loses confidence even with no misses. Reference = its last proof (verify, else resolve),
 *    else first observation; exponential half-life past a grace window, applied onto the active
 *    result. INCREMENTAL — it decays only the time since `lastDecayedAt` (persist the returned
 *    value back onto the feature), so repeated calls don't re-decay the already-decayed value; a
 *    re-proof advances the reference and restarts the clock. Past `staleAfterMs` the lifecycle
 *    drifts to `stale-suspected`. No timestamp ⇒ age decay is a no-op. Disable with `opts.ageDecay:false`.
 *
 * @param {object} feature  { confidence?, lastDecayedAt?, evidence?{observedAt}, createdAt? }
 * @param {object} health   from foldFeatureHealth: { resolveHits, resolveMisses, lifecycle, lastVerifiedAt, lastResolvedAt }
 * @param {object} opts      { missThreshold=2, decayPerMiss=0.15, floor=0.1,
 *                             ageDecay=true, now=Date.now(), halfLifeMs=30d, graceMs=14d, staleAfterMs=60d }
 * @returns {{ confidence:number, lifecycle:string, lastDecayedAt:(number|null), changed:boolean }}
 */
export function decayFeature(feature = {}, health = {}, opts = {}) {
  const missThreshold = opts.missThreshold ?? 2;
  const decayPerMiss = opts.decayPerMiss ?? 0.15;
  const floor = opts.floor ?? 0.1;
  const misses = health.resolveMisses ?? 0;
  const successes = health.resolveHits ?? 0;
  const prevConf = typeof feature.confidence === 'number' ? feature.confidence : 0.6;
  let confidence = prevConf;
  let lifecycle = health.lifecycle || 'fresh';
  let lastDecayedAt = feature.lastDecayedAt ?? null;   // carried through unchanged unless age decay fires

  // Active (miss-driven) decay. Net misses beyond what successes offset.
  const netMiss = misses - successes;
  if (netMiss >= missThreshold) {
    confidence = Math.max(floor, prevConf - decayPerMiss * (netMiss - missThreshold + 1));
    if (lifecycle === 'fresh' || lifecycle === 'verified') lifecycle = 'stale-suspected';
  } else if (successes > 0 && misses === 0 && lifecycle === 'fresh') {
    lifecycle = 'verified';
  }

  // Passive (age-based) decay — INCREMENTAL. Decay only the time elapsed SINCE the last
  // application (`lastDecayedAt`), not since the reference, so repeated writebacks don't
  // re-decay the already-decayed value (the prior compounding bug). Exponential half-life is
  // self-consistent under stepwise application: 0.5^(Δt1/H)·0.5^(Δt2/H) = 0.5^((Δt1+Δt2)/H).
  // A re-proof advances `ref` (and thus the grace window), naturally restarting the clock.
  // `lastDecayedAt` advances ONLY when the step actually moves confidence at 3dp — so many
  // tiny increments accumulate instead of being lost to rounding.
  if (opts.ageDecay !== false) {
    const now = opts.now ?? Date.now();
    const DAY = 24 * 3600 * 1000;
    const halfLifeMs = opts.halfLifeMs ?? 30 * DAY;
    const graceMs = opts.graceMs ?? 14 * DAY;
    const staleAfterMs = opts.staleAfterMs ?? 60 * DAY;
    const r3 = (n) => Math.round(n * 1000) / 1000;
    const ref = health.lastVerifiedAt ?? health.lastResolvedAt
      ?? (feature.evidence && feature.evidence.observedAt) ?? feature.createdAt ?? null;
    if (ref != null && now > ref) {
      const decayStart = ref + graceMs;                 // age decay begins when grace ends
      if (now > decayStart) {
        const from = Math.max(decayStart, lastDecayedAt ?? decayStart);
        const dt = now - from;                           // elapsed since last applied (or grace end)
        if (dt > 0) {
          const aged = Math.max(floor, confidence * Math.pow(0.5, dt / halfLifeMs));
          if (r3(aged) !== r3(confidence)) { confidence = aged; lastDecayedAt = now; }
        }
      }
      if ((now - ref) > staleAfterMs && (lifecycle === 'fresh' || lifecycle === 'verified')) lifecycle = 'stale-suspected';
    }
  }

  confidence = Math.round(confidence * 1000) / 1000;
  const changed = confidence !== prevConf
    || lifecycle !== (health.lifecycle || 'fresh')
    || lastDecayedAt !== (feature.lastDecayedAt ?? null);
  return { confidence, lifecycle, lastDecayedAt, changed };
}

// ─── Stream store helpers (caller wires chrome.storage in the wiring slice) ──────

/** Append events to a bounded in-memory stream (newest kept). Pure on arrays. */
export function appendEvents(stream, events, cap = 1000) {
  const next = Array.isArray(stream) ? stream.slice() : [];
  for (const ev of Array.isArray(events) ? events : []) if (ev && ev.id) next.push(ev);
  while (next.length > cap) next.shift();
  return next;
}
