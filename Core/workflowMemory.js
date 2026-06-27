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

/** Normalize a workflow record. PURE. Requires an ask + ≥2 sub-asks (a single step isn't a workflow). Null otherwise. */
export function normalizeWorkflow(raw) {
  const r = (raw && typeof raw === 'object') ? raw : null;
  if (!r) return null;
  const ask = _str(r.ask);
  const subAsks = (Array.isArray(r.subAsks) ? r.subAsks : []).map(_str).filter(Boolean);
  if (!ask || subAsks.length < 2) return null;
  return {
    id: _str(r.id) || workflowId(ask, subAsks),
    ask,
    subAsks,
    name: _str(r.name) || null,                                       // WF-2 — an optional short alias ("standup")
    appId: _str(r.appId) || null,
    createdAt: Number.isFinite(r.createdAt) ? r.createdAt : 0,
    runs: Number.isFinite(r.runs) ? r.runs : 0,
    dismissed: Number.isFinite(r.dismissed) ? r.dismissed : 0,        // WF-2 — "No, interpret it" count (suppression)
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
