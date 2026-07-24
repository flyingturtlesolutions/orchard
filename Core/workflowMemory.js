// Core/workflowMemory.js — WF-1: structured, recallable IL WORKFLOWS (a phrase → a saved multi-step decomposition).
// PURE: no chrome / DOM / LLM / storage / clock.
//
// The STRUCTURED form of `remember: when I say X, run [steps]` — the flywheel for AUTONOMOUS compounds (a connector
// read → fan-out → the map run), which the Ground-composite saver (T2) cannot hold because they have no Ground. A
// workflow record = { id, ask, subAsks[], appId, createdAt, runs }. Recall is a CASCADE: LEXICAL (token overlap —
// free + deterministic, no LLM) FIRST; on a miss the caller may escalate to an LLM matcher over `workflowCandidates`
// (a compact {id,name,ask} set), validated back through `resolveWorkflowMatch` (the trust gate on the model's id).
// Either way the suggestion is a CONFIRM, so an LLM mismatch is caught by the user, never silently replayed.
//
// SAFETY: a workflow stores the user's OWN decomposition (the ask + its sub-asks) — trusted config, no page content.
// Replaying it re-runs the same chain, so the inner per-step gates (the chain's "Run all", the map's batch confirm,
// the write gate) still apply; the suggestion itself is a confirm. Nothing here bypasses an effect gate.

import { normalizeTrigger } from './trigger.js';
import { sanitizeBindings } from './workflowWizard.js';   // v1730 — ONE definition of a bankable binding set (the closed-literal discipline needs the same sanitizer at both hops)

const _str = (x) => String(x == null ? '' : x).trim();

// WF-2 suppression, single-sourced: a never-run, twice-dismissed workflow stops suggesting ("no" ≥2× + never ran).
const _live = (w) => !(w.dismissed >= 2 && w.runs === 0);

// Tiny stoplist so a short re-ask ("get tickets") matches a long saved workflow without function words dominating.
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'my', 'me', 'i', 'it', 'then', 'each', 'all', 'with', 'at', 'is', 'new']);
function _tokens(s) {
  return Array.from(new Set(_str(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t))));
}
// djb2 → base36 (same id style as goalStore / outcomes). PURE + deterministic.
function _hash(s) { let h = 5381; const str = String(s); for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

/** A stable CONTENT id for a workflow (ask + its ordered steps), so re-banking the same thing dedups. PURE. */
export function workflowId(ask, subAsks) {
  const steps = (Array.isArray(subAsks) ? subAsks : []).map(_str).filter(Boolean).join('|').toLowerCase();
  return `wf-${_hash(`${_str(ask).toLowerCase()}::${steps}`)}`;
}

// WW-1 (v2.74.1610, §10.A) — per-step PROVENANCE, body-blind. The method a step USED at qualify time — for
// DISPLAY/AUDIT only, NEVER a binding (§11: replay re-resolves through the router). A syncable record must carry
// no page content, so this whitelists {text, via:{kind,host,name}, bankedAt} — a captured VALUE never enters.
function _normSteps(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => {
    if (!s || typeof s !== 'object') return null;
    const text = _str(s.text); if (!text) return null;
    const v = (s.via && typeof s.via === 'object') ? s.via : {};
    const via = { kind: _str(v.kind) || null, host: _str(v.host) || null, name: _str(v.name).slice(0, 80) || null };
    const out = { text, via, bankedAt: Number.isFinite(s.bankedAt) ? s.bankedAt : 0 };
    // PP-0c (§8.3 / DESIGN_cadence.md §2.1) — carry the pinned RESOLUTION ({kind, capabilityId, groundId?}) that
    // buildWorkflowSave/pinnedClause emit. Additive + whitelisted for the SAME reason as orphanedFrom below: this
    // literal is closed by construction, and BOTH saveWorkflow and updateWorkflow route through normalize — so
    // without this line no pinned clause ever reaches storage, replayPlan always takes the loose branch, and the
    // drift check can never fire (a drift check bypassed by a fallback is not a drift check, workflowWizard §180).
    if (s.clause && typeof s.clause === 'object') {
      const kind = _str(s.clause.kind) || null;
      const capabilityId = _str(s.clause.capabilityId) || null;
      if (kind || capabilityId) {
        out.clause = { kind, capabilityId, ...(s.clause.groundId ? { groundId: _str(s.clause.groundId) } : {}) };
        // CD-1a phase 2 (v1717) — a fieldRead pin's banked field/term survive normalize (same closed-literal
        // discipline: an unlisted field is dropped on every edit). Schema names only — §11 body-blind holds.
        if (kind === 'fieldRead' && _str(s.clause.field)) {
          out.clause.field = _str(s.clause.field).slice(0, 80);
          if (_str(s.clause.term)) out.clause.term = _str(s.clause.term).slice(0, 80);
        }
        // v2.74.1730 — a connector pin's banked BINDINGS survive normalize too (same sanitizer as the bank side —
        // one definition, or the two hops drift apart the way the branch/fieldRead field-name pair did pre-v1690).
        if (kind === 'connector' || kind === 'ride') {
          const b = sanitizeBindings(s.clause.bindings);
          if (b) out.clause.bindings = b;
        }
      }
    }
    return out;
  }).filter(Boolean);
}

/** Normalize a workflow record. PURE. Requires an ask + ≥2 sub-asks (a single step isn't a workflow). Null otherwise. */
export function normalizeWorkflow(raw) {
  const r = (raw && typeof raw === 'object') ? raw : null;
  if (!r) return null;
  const ask = _str(r.ask);
  const subAsks = (Array.isArray(r.subAsks) ? r.subAsks : []).map(_str).filter(Boolean);
  if (!ask || subAsks.length < 2) return null;
  const contentId = workflowId(ask, subAsks);   // WW-1 (§10.A) — the CONTENT hash: dedup key + edit-detector (changes on edit)
  const createdAt = Number.isFinite(r.createdAt) ? r.createdAt : 0;
  return {
    // WW-1 (§10.A) — `id` is a STABLE SURROGATE: honored if the store minted one (routines bind it, so it must
    // survive an edit); falls back to contentId only for legacy records that never had a surrogate. NEVER
    // recompute a present id from content.
    id: _str(r.id) || contentId,
    contentId,
    ask,
    subAsks,
    name: _str(r.name) || null,                                       // WF-2 — an optional short alias ("standup")
    appId: _str(r.appId) || null,
    createdAt,
    updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : createdAt,
    runs: Number.isFinite(r.runs) ? r.runs : 0,
    dismissed: Number.isFinite(r.dismissed) ? r.dismissed : 0,        // WF-2 — "No, interpret it" count (suppression)
    status: r.status === 'draft' ? 'draft' : 'ready',                // WW-1 (§10.A) — draft never reaches the launch page / a cadence
    // WF-3 (v1640) — provenance of a desk that no longer exists; whitelisted so an edit can't strip it.
    orphanedFrom: (r.orphanedFrom && typeof r.orphanedFrom === 'object') ? r.orphanedFrom : undefined,
    qualifiedAt: Number.isFinite(r.qualifiedAt) ? r.qualifiedAt : 0,  // WW-1 — when every step was approved (empirical proof stamp)
    steps: _normSteps(r.steps),                                       // WW-1 — body-blind per-step provenance (display/audit)
    // PP-0c (§8.4 / DESIGN_cadence.md §2.1) — the record SCHEMA version (1 = phrasing only, 2 = steps may carry a
    // pinned clause). buildWorkflowSave emits it; whitelisted here so an edit can't strip it and turn every record
    // back into isPrePinned()===true, which silently bypasses the drift check. undefined for legacy records.
    schema: Number.isFinite(r.schema) ? r.schema : undefined,
    // CD-0 (DESIGN_cadence.md §7) — the cadence TRIGGER: when the workflow runs by itself. A FIELD on the workflow,
    // not an entity (§1). Whitelisted on orphanedFrom's precedent so an edit can't strip it; normalizeTrigger
    // (Core/trigger.js, pure) returns undefined when there is no valid cadence.
    trigger: normalizeTrigger(r.trigger),
  };
}

/**
 * The best workflow whose saved ask the NEW ask matches, or null. PURE. Uses the OVERLAP-COEFFICIENT
 * (|A∩B| / min(|A|,|B|)) — so a SHORT re-ask ("get tickets") fully matches a LONG saved workflow ("get my open
 * tickets and research each…"). Requires ≥ `minShared` meaningful tokens in common AND score ≥ `minScore` (precision
 * over recall — a wrong suggestion is more annoying than a missed one). Ties broken by run-count (the more-used wins).
 * `workflows` must already be scoped to the current app (the store loads per-instance).
 */
export function workflowMatch(ask, workflows, { minScore = 0.6, minShared = 2 } = {}) {
  // WF-2 — drop a never-run, twice-dismissed match: the user said "no" to it ≥2× and never ran it → stop nagging.
  const list = (Array.isArray(workflows) ? workflows : []).map(normalizeWorkflow).filter(Boolean).filter(_live);
  // WF-2 — a NAME match (the user typed the alias directly) is the strongest signal; takes priority over ask overlap.
  const aNorm = _str(ask).toLowerCase().replace(/\s+/g, ' ');
  const named = aNorm && list.find((w) => w.name && w.name.toLowerCase().replace(/\s+/g, ' ') === aNorm);
  if (named) return named;
  const qa = _tokens(ask);
  if (qa.length < minShared) return null;
  const qs = new Set(qa);
  let best = null; let bestScore = 0;
  for (const w of list) {
    const wt = _tokens(w.ask);
    const shared = wt.filter((t) => qs.has(t)).length;
    if (shared < minShared) continue;
    const score = shared / Math.min(qa.length, wt.length);
    if (score > bestScore || (score === bestScore && best && w.runs > best.runs)) { best = w; bestScore = score; }
  }
  return bestScore >= minScore ? best : null;
}

/**
 * The candidate set to hand an LLM matcher when LEXICAL recall misses, or []. PURE. Applies the SAME suppression
 * filter as workflowMatch (_live), sorts most-used first, and returns a COMPACT shape — { id, name, ask } only,
 * never subAsks/appId — so the prompt stays lean and the model matches on the user-authored ask/alias, not the
 * steps. Capped (default 24) to bound the prompt. The caller sends these; the model returns one id (or null).
 */
export function workflowCandidates(workflows, { cap = 24 } = {}) {
  return (Array.isArray(workflows) ? workflows : []).map(normalizeWorkflow).filter(Boolean).filter(_live)
    .sort((w1, w2) => (w2.runs - w1.runs) || (w2.createdAt - w1.createdAt))
    .slice(0, Math.max(0, cap))
    .map((w) => ({ id: w.id, name: w.name, ask: w.ask }));
}

/**
 * Resolve an LLM-returned workflow id back to the FULL normalized record, or null. PURE — the TRUST GATE on the
 * model's answer: accept the id ONLY if it names a real, non-suppressed candidate (guards a hallucinated / stale /
 * suppressed id). Defence-in-depth: the caller still shows a suggest-and-confirm, so this isn't the only check.
 */
export function resolveWorkflowMatch(workflows, id) {
  const want = _str(id);
  if (!want) return null;
  return (Array.isArray(workflows) ? workflows : []).map(normalizeWorkflow).filter(Boolean).filter(_live)
    .find((w) => w.id === want) || null;
}

/**
 * Cheap PRE-GATE for the LLM semantic fallback: does `ask` share ≥1 meaningful token with any candidate's ask/name?
 * PURE. The LLM matcher only earns its cost on a NEAR-miss (some shared vocabulary, below the lexical threshold);
 * an ask with zero vocabulary in common is almost never a re-invocation, so skip the round-trip. Candidates are the
 * compact {id,name,ask} from `workflowCandidates`.
 */
export function workflowSharesVocab(ask, candidates) {
  const q = new Set(_tokens(ask));
  if (!q.size) return false;
  return (Array.isArray(candidates) ? candidates : []).some(
    (c) => c && _tokens(`${_str(c.ask)} ${_str(c.name)}`).some((t) => q.has(t)),
  );
}

/**
 * WF-3 (v2.74.1641) — is this record a WORKFLOW, in the sense the product means?
 *
 * The store holds two populations. A `draft` is auto-banked whenever an ask happened to decompose into 2+
 * sub-asks — it is a record of a decomposition, not something the user built. A banked workflow is one the user
 * finished and saved (the wizard sets status 'ready' once every step is approved). The launch page has enforced
 * exactly this since WW-1b — "unfinished != proven quick action" — and any other surface that lists workflows
 * must agree, or the same store reads as six workflows in one place and none in another. PURE.
 */
export function isBankedWorkflow(w) {
  return !!w && !!(w.ask || w.name) && w.status !== 'draft';
}
