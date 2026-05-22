/**
 * v2.62.0 — Built-in Analyses.
 *
 * These ship as code with the extension and appear in the Analyses library
 * alongside user-authored Analyses. They cannot be edited or deleted by
 * users; they're always available regardless of Ground.
 *
 * Each built-in is shaped like a stored Analysis (same fields), but with
 * `builtin: true` and a stable id (prefixed `builtin:`) so references from
 * strategies survive across users / Grounds / installations.
 *
 * Operations may contain `{{PARAM_NAME}}` placeholders in their values;
 * these are surfaced as the Analysis's params. At strategy-invocation
 * time, the strategy provides bindings for each param.
 *
 * Conservative starting set — two built-ins. More to come as evidence
 * permits. Renaming or removing a built-in is a breaking change for any
 * strategy that references it, so the set is intentionally small and
 * its names are intended to be stable.
 *
 * v2.66.0 (Pass 3a) — Storage shape moves to layered implementations.
 * Each Analysis carries `implementations: [{tier, operations}]` instead
 * of a single top-level `operations` field. The contract (preconditions,
 * postconditions, params) stays at the Analysis level, shared across
 * implementations. Built-ins ship with a single 'cache'-tier implementation
 * for now; future built-ins may carry multiple implementations (cache + a
 * frontier-tier fallback).
 *
 * Tier vocabulary:
 *   'cache'    — deterministic rule-based execution (T1). Free, instant,
 *                effectively cached at authoring time.
 *   'frontier' — frontier-class model invocation (T3). Real per-call cost,
 *                seconds of latency, judgment-capable.
 *   (T2 / T4 not implemented yet; names assigned when they land.)
 */

export const BUILTIN_ANALYSES = Object.freeze([
  // ── Filter records by field ─────────────────────────────────────────
  // Single-op Analysis: filter a list of records by a field assertion.
  // The most basic data-narrowing operation; covers cases where the user
  // wants "all records matching X" without sorting or limiting.
  //
  // Pre/post (v2.64.0): loose discipline. INPUT is the conventional name
  // for the source list (mapped from the SIEVE node's `source` binding by
  // the engine at evaluation time). OUTPUT is the conventional name for
  // the output. Pre asserts the input is a list; post asserts the output
  // is a list. We don't make field-level claims at the built-in level
  // because the user's chosen assertion type determines what's matched.
  {
    id: 'builtin:filter-records-by-field',
    builtin: true,
    name: 'Filter records by field',
    description: 'Keep records whose chosen field matches a assertion (equals / starts-with / contains / present).',
    params: ['FIELD', 'ASSERTION_TYPE', 'VALUE'],
    preconditions: { match: 'all', conditions: [
      { type: 'binding_is_list', binding: 'INPUT' },
    ] },
    postconditions: { match: 'all', conditions: [
      { type: 'binding_is_list', binding: 'OUTPUT' },
    ] },
    implementations: [
      {
        tier: 'cache',
        body: {
          kind: 'operations',
          operations: [
            {
              op: 'filter',
              assertion: {
                type: '{{ASSERTION_TYPE}}',
                field: '{{FIELD}}',
                value: '{{VALUE}}',
              },
            },
          ],
        },
      },
    ],
  },

  // ── Take top N matching ─────────────────────────────────────────────
  // The composite filter+sort+take Analysis: narrow, rank, take. Solves
  // the canonical selection-and-ranking pattern (e.g. "the most-recent
  // device matching prefix X"). Five params; user picks all at strategy
  // edit time.
  //
  // Pre/post (v2.64.0): same loose discipline as the filter built-in.
  // Pre asserts INPUT is a list. Post asserts OUTPUT is a list with
  // length <= COUNT (since the take operation guarantees this).
  {
    id: 'builtin:take-top-n-matching',
    builtin: true,
    name: 'Take top N matching',
    description: 'Filter records by a field assertion, sort by another field, then take the top N.',
    params: ['FIELD', 'ASSERTION_TYPE', 'VALUE', 'SORT_KEY', 'SORT_DIRECTION', 'SORT_TYPE', 'COUNT'],
    preconditions: { match: 'all', conditions: [
      { type: 'binding_is_list', binding: 'INPUT' },
    ] },
    postconditions: { match: 'all', conditions: [
      { type: 'binding_is_list', binding: 'OUTPUT' },
      { type: 'binding_length_max', binding: 'OUTPUT', max: '{{COUNT}}' },
    ] },
    implementations: [
      {
        tier: 'cache',
        body: {
          kind: 'operations',
          operations: [
            {
              op: 'filter',
              assertion: {
                type: '{{ASSERTION_TYPE}}',
                field: '{{FIELD}}',
                value: '{{VALUE}}',
              },
            },
            {
              op: 'sort',
              key: '{{SORT_KEY}}',
              direction: '{{SORT_DIRECTION}}',
              coerceAs: '{{SORT_TYPE}}',
            },
            {
              op: 'take',
              count: '{{COUNT}}',
            },
          ],
        },
      },
    ],
  },
]);

/**
 * Returns true if the given id refers to a built-in Analysis.
 */
export function isBuiltinAnalysisId(id) {
  return typeof id === 'string' && id.startsWith('builtin:');
}

/**
 * Find a built-in Analysis by id. Returns null if not found.
 */
export function getBuiltinAnalysis(id) {
  return BUILTIN_ANALYSES.find(a => a.id === id) ?? null;
}

/**
 * v2.66.0 (Pass 3a) — Tier vocabulary used in implementations[].tier.
 * Adding new tiers requires updating SchemaValidator + studio editor.
 * Removing or renaming a tier is breaking for any stored Analysis.
 */
export const ANALYSIS_TIERS = Object.freeze(['cache', 'frontier']);
