// Core/decisionMarkers.js — CW-3a (DESIGN_cloud_logs.md ruling 8): THE decision-marker manifest.
// ONE source of truth, two derivations: studio.js builds _DECISION_RE from it (the decisions-view filter),
// and tools/observability/gen-filters.cjs generates the CloudWatch metric-filter artifact from it — so a new
// marker can never be visible in one world and invisible in the other (invariant #1, restructured: add the
// marker HERE; both worlds follow). `src` is a regex-source fragment (the old _DECISION_RE alternation,
// split top-level); `metric: true` entries become fleet metric filters (metricPattern = the CloudWatch
// filter sub-pattern when narrower than the marker itself). PURE — no DOM, no chrome.
//
// Generated 2026-07-31 from studio.js's literal _DECISION_RE (v2.74.1715 lineage), then hand-owned: edit
// THIS file, never the studio literal (which no longer exists).

export const DECISION_MARKERS = [
  { key: 'run', src: "▶ RUN " },
  { key: 'run-2', src: "[✓✗] RUN " },
  { key: 'comprehend-cross-ground', src: "COMPREHEND_CROSS_GROUND ▸" },
  { key: 't3x-resolve', src: "T3X resolve ▸" },
  { key: 't3x-bind', src: "T3X bind ▸" },
  { key: 'bind', src: "_bind ▸" },
  { key: 'grounds', src: "GROUNDS ▸" },
  { key: 'route', src: "ROUTE ▸" },
  { key: 'handoff', src: "HANDOFF ▸" },
  { key: 'postcond', src: "postcond ▸" },
  { key: 'orch-match', src: "ORCH_MATCH ▸" },
  { key: 'orch-match-global', src: "ORCH_MATCH_GLOBAL ▸" },
  { key: 'detect-duplicate-grounds', src: "DETECT_DUPLICATE_GROUNDS ▸" },
  { key: 'merge-grounds', src: "MERGE_GROUNDS ▸" },
  { key: 'mergeground', src: "mergeGround " },
  { key: 'ground-saved', src: "Ground saved:" },
  { key: 'ground-deleted', src: "Ground deleted:" },
  { key: 'x', src: "→ (?:auto|propose|miss)\\/" },
  { key: 'run-observation', src: "RUN_OBSERVATION" },
  { key: 'run-best-observation', src: "RUN_BEST_OBSERVATION" },
  { key: 'orch-record-alias', src: "ORCH_RECORD_ALIAS" },
  { key: 'orch-admin', src: "ORCH_ADMIN ▸" },
  { key: 'replay-sg-capability', src: "REPLAY_SG_CAPABILITY —" },
  { key: 'bindings', src: "— bindings:" },
  { key: 'click-caused-navigation', src: "CLICK caused navigation" },
  { key: 'walk', src: "WALK ▸" },
  { key: 'loop', src: "LOOP ▸" },
  { key: 'orch-plan', src: "ORCH_PLAN ▸" },
  { key: 'open-url-new-tab', src: "OPEN_URL_NEW_TAB —" },
  { key: 'reverify-sg-capability', src: "REVERIFY_SG_CAPABILITY —" },
  { key: 'route-ask', src: "ROUTE_ASK \"" },
  { key: 'bindclauseparams', src: "bindClauseParams →" },
  { key: 'locale-fresh-skip', src: "locale-fresh-skip" },
  { key: 'locale-trust', src: "locale-trust:" },
  { key: 'explore-page-structure-done', src: "EXPLORE_PAGE_STRUCTURE done" },
  { key: 'run-sg-trial', src: "RUN_SG_TRIAL" },
  { key: 'interaction-monitor-start', src: "INTERACTION_MONITOR_START" },
  { key: 'intent-menu', src: "INTENT_MENU ▸" },
  { key: 'rich-intents', src: "RICH_INTENTS ▸" },
  { key: 'accept-sg-trial', src: "ACCEPT_SG_TRIAL" },
  { key: 'interaction-outcomes', src: "INTERACTION_OUTCOMES ▸" },
  { key: 'proposerichintents', src: "proposeRichIntents —" },
  { key: 'ensuregroundforurl', src: "ensureGroundForUrl" },
  { key: 'explore', src: "EXPLORE ▸" },
  { key: 'stop', src: "STOP ▸" },
  { key: 'focus', src: "FOCUS ▸" },
  { key: 'clarify', src: "CLARIFY ▸" },
  { key: 'close-tabs', src: "CLOSE_TABS ▸" },
  { key: 'devbr', src: "DEVBR ▸" },
  { key: 'lt', src: "LT ▸" },
  { key: 'concern', src: "CONCERN ▸" },
  { key: 'sync', src: "SYNC ▸" },
  { key: 'merge', src: "MERGE ▸" },
  { key: 'abandon', src: "ABANDON ▸" },
  { key: 'drift', src: "DRIFT ▸" },
  { key: 'split', src: "SPLIT ▸" },
  { key: 'fork', src: "FORK ▸" },
  { key: 'scope', src: "SCOPE ▸" },
  { key: 'worktree', src: "WORKTREE ▸" },
  { key: 'merge-lock', src: "MERGE_LOCK ▸" },
  { key: 'version', src: "VERSION ▸" },
  { key: 'review', src: "REVIEW ▸" },
  { key: 'deploy', src: "DEPLOY ▸" },
  { key: 'surface', src: "SURFACE ▸" },
  { key: 'il', src: "IL ▸" },
  { key: 'gaps', src: "GAPS ▸" },
  { key: 'harvest', src: "HARVEST ▸" },
  { key: 'synth', src: "SYNTH ▸" },
  { key: 'write-gate', src: "WRITE_GATE ▸" },
  { key: 'interpret', src: "INTERPRET ▸" },
  { key: 'canvas', src: "CANVAS ▸" },
  { key: 'forage', src: "FORAGE ▸" },
  { key: 'session-replay', src: "SESSION_REPLAY ▸" },
  { key: 'answer-guard', src: "ANSWER_GUARD ▸" },
  { key: 'shape', src: "SHAPE ▸" },   // v2.74.1964 — the additive-reply outcome (answer+records / answer-only / …): makes "is Fix A running" a gl grep
  { key: 'layout', src: "LAYOUT ▸" },   // v2.74.1971 — the deterministic APPEARANCE report (overflow / rows / chat.css styled the chips): "does it look right" as a gl grep, not an eyeball
  { key: 'sheet', src: "SHEET ▸" },   // v2.74.1977 — the 2nd input type: an uploaded .xlsx/.csv opened a case grounded on its rows
  { key: 'demo-write', src: "DEMO_WRITE ▸" },
  { key: 'connector-invoke', src: "CONNECTOR_INVOKE ▸" },
  { key: 'connector-link', src: "CONNECTOR_LINK ▸" },
  { key: 'connector-tools', src: "CONNECTOR_TOOLS ▸" },
  { key: 'source', src: "SOURCE ▸" },
  { key: 'workflow', src: "WORKFLOW ▸" },
  { key: 'cadence', src: "CADENCE ▸", metric: true, metricPattern: ['CADENCE ▸ fired', 'CADENCE ▸ auto-disarmed'] },
  { key: 'trigger', src: "TRIGGER ▸" },
  { key: 'ride-write', src: "RIDE_WRITE ▸" },
  { key: 'ride-resolve', src: "RIDE_RESOLVE ▸" },
  { key: 'ride-drill', src: "RIDE_DRILL ▸" },
  { key: 'ride-each', src: "RIDE_EACH ▸" },
  { key: 'routine', src: "ROUTINE ▸" },
  { key: 'case-brief', src: "CASE_BRIEF ▸" },
  { key: 'conn', src: "CONN ▸" },
  { key: 'section-nav', src: "SECTION_NAV ▸" },
  { key: 'drive', src: "DRIVE ▸" },
  { key: 'drive-hydrate', src: "DRIVE_HYDRATE ▸" },
  { key: 'drive-invoke', src: "DRIVE_INVOKE ▸" },
  { key: 'interpret-ask', src: "INTERPRET_ASK \"" },
  { key: 'interpret-ask-2', src: "INTERPRET_ASK ▸" },
  { key: 'palette', src: "PALETTE ▸" },
  { key: 'identity-probe', src: "IDENTITY_PROBE ▸" },
  { key: 'sweep', src: "SWEEP ▸" },
  { key: 'show', src: "SHOW ▸" },
  { key: 'leg-test', src: "LEG_TEST ▸" },
  { key: 'leg-verify', src: "LEG_VERIFY ▸" },
  { key: 'learned', src: "LEARNED ▸" },
  { key: 'field-followup', src: "FIELD_FOLLOWUP ▸" },
  // v2.74.1911 — the identifier-provenance gate: a blocked invented param IS a routing decision.
  { key: 'param', src: "PARAM ▸" },
  { key: 'obs-param', src: "OBS_PARAM ▸" },
  { key: 'target', src: "TARGET ▸" },
  { key: 'invoke', src: "INVOKE ▸" },
  // EX-1 (v2.74.1946) — a self-reload or a programmatic ask is the loop ACTING on its own build; if it were absent
  // here, a `-decisions-` download could not say whether the run it is grading was even exercised (invariant #1).
  { key: 'exercise', src: "EXERCISE ▸" },
  { key: 'heal', src: "HEAL ▸", metric: true, metricPattern: 'HEAL ▸ suspect' },
  { key: 'vitals', src: "VITALS ▸", metric: true, metricPattern: 'VITALS ▸ case opened' },
  { key: 'dash', src: "DASH ▸" },
  { key: 'map', src: "MAP ▸" },
  { key: 'field-read', src: "FIELD_READ ▸" },
  { key: 'context', src: "CONTEXT ▸" },
  { key: 'payload', src: "PAYLOAD ▸" },
  { key: 'find', src: "FIND ▸" },
  { key: 'dispatch', src: "DISPATCH ▸" },
  { key: 'clause-error', src: "CLAUSE_ERROR ▸" },
  { key: 'branch', src: "BRANCH ▸" },
  { key: 'redact', src: "REDACT ▸" },
  { key: 'pipeline', src: "PIPELINE ▸" },
  { key: 'gate', src: "GATE   ▸" },
  { key: 'steps', src: "STEPS ▸" },
  { key: 'step', src: "STEP ▸" },
  { key: 'span', src: "SPAN ▸" },
  { key: 'run-3', src: "RUN ▸" },
  { key: 'read', src: "READ   ▸" },
  { key: 'task', src: "TASK   ▸" },
  { key: 'presence', src: "PRESENCE ▸" },
  { key: 'panel', src: "PANEL ▸" },
  { key: 'children', src: "CHILDREN ▸" },
  { key: 'ride-tab', src: "RIDE_TAB ▸" },
  { key: 'write', src: "WRITE ▸" },
  { key: 'upsert', src: "UPSERT ▸" },
  { key: 'case', src: "CASE   ▸" },
  // CW-4 (gl 2026-07-31 observation) — a consent flip that changes what leaves the machine is a DECISION:
  // the decisions view and the fleet must both record it.
  { key: 'cloudlogs', src: 'CLOUDLOGS ▸' },
  // CW (DESIGN_cloud_logs.md ruling 9) — the shipper's own honesty marker: a fleet trace must record its
  // own incompleteness, and the dashboard must see the pipeline's loss rate.
  { key: 'shipper', src: 'SHIPPER ▸', metric: true, metricPattern: 'SHIPPER ▸ gap' },
];

/** The decisions-view filter, derived (studio.js consumes this). */
export function buildDecisionRegExp() {
  return new RegExp('(' + DECISION_MARKERS.map((m) => m.src).join('|') + ')');
}

/** The metric-filter subset (gen-filters.cjs consumes this). patterns = literal substrings (CloudWatch JSON
 * filter patterns support only *-wildcards and ||-composition — never regex, the v1906 lesson). */
export function metricMarkers() {
  return DECISION_MARKERS.filter((m) => m.metric).map((m) => {
    const raw = m.metricPattern || m.src;
    return { key: m.key, patterns: Array.isArray(raw) ? raw : [raw] };
  });
}
