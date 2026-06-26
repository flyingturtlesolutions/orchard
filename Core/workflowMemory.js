// Core/workflowMemory.js — WF-1: structured, recallable IL WORKFLOWS (a phrase → a saved multi-step decomposition).
// PURE: no chrome / DOM / LLM / storage / clock.
//
// The STRUCTURED form of `remember: when I say X, run [steps]` — the flywheel for AUTONOMOUS compounds (a connector
// read → fan-out → the map run), which the Ground-composite saver (T2) cannot hold because they have no Ground. A
// workflow record = { id, ask, subAsks[], appId, createdAt, runs }. Recall is LEXICAL (token overlap) — deterministic,
// no LLM round-trip on every ask; an LLM matcher is a later refinement.
//
// SAFETY: a workflow stores the user's OWN decomposition (the ask + its sub-asks) — trusted config, no page content.
// Replaying it re-runs the same chain, so the inner per-step gates (the chain's "Run all", the map's batch confirm,
// the write gate) still apply; the suggestion itself is a confirm. Nothing here bypasses an effect gate.

const _str = (x) => String(x == null ? '' : x).trim();

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
    appId: _str(r.appId) || null,
    createdAt: Number.isFinite(r.createdAt) ? r.createdAt : 0,
    runs: Number.isFinite(r.runs) ? r.runs : 0,
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
  const qa = _tokens(ask);
  if (qa.length < minShared) return null;
  const qs = new Set(qa);
  let best = null; let bestScore = 0;
  for (const raw of (Array.isArray(workflows) ? workflows : [])) {
    const w = normalizeWorkflow(raw);
    if (!w) continue;
    const wt = _tokens(w.ask);
    const shared = wt.filter((t) => qs.has(t)).length;
    if (shared < minShared) continue;
    const score = shared / Math.min(qa.length, wt.length);
    if (score > bestScore || (score === bestScore && best && w.runs > best.runs)) { best = w; bestScore = score; }
  }
  return bestScore >= minScore ? best : null;
}
