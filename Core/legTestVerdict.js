// Core/legTestVerdict.js — OV-4 (v2.74.1413, DESIGN_overview.md §3): the STRUCTURAL pass/fail verdict for a leg test.
// PURE. Given the reply from invoking a leg live (the INVOKE_SESSION / SESSION_REPLAY envelope
// {success, value, error, detail, hint}), decide whether the leg WORKS — deterministically, the way the trial gate
// does, NOT by LLM judgement (a read that returns the wrong shape is a structural miss). The workbench shows this
// verdict + the raw result; on a fail the developer edits the leg's fields and re-tests (the no-code SH-T loop).
//
// @module Core/legTestVerdict

// Does the result tree contain a NON-EMPTY value reachable by the (last segment of the) field path? Bounded recursion,
// GraphQL-friendly (unwraps `data`/`edges`/`node`/wrapper objects). Used only when the author declared expected fields.
function _hasField(value, field, depth = 0) {
  const key = String(field || '').split('.').pop();
  if (!key || value == null || depth > 6) return false;
  if (Array.isArray(value)) return value.some((v) => _hasField(v, key, depth + 1));
  if (typeof value !== 'object') return false;
  for (const [k, v] of Object.entries(value)) {
    if (k === key && v != null && v !== '' && !(Array.isArray(v) && v.length === 0)) return true;
    if (v && typeof v === 'object' && _hasField(v, key, depth + 1)) return true;
  }
  return false;
}

// The length of the FIRST result collection (a plain array or a GraphQL {edges:[…]}), INCLUDING an empty one; null if
// none is found. Skips userErrors/errors (not result records). Bounded recursion. Distinguishing "found an empty list"
// (→ 0) from "found no list" (→ null) is what let an empty-but-valid read read as 0, not 1.
function _firstListLen(value, depth = 0) {
  if (value == null || depth > 6 || typeof value !== 'object') return null;
  if (Array.isArray(value)) return value.length;
  if (Array.isArray(value.edges)) return value.edges.length;
  for (const [k, v] of Object.entries(value)) {
    if (k === 'userErrors' || k === 'errors') continue;
    const n = _firstListLen(v, depth + 1);
    if (n != null) return n;
  }
  return null;
}
// A coarse "how much came back" — a list's length (incl. 0), else 1 for a single record, else 0. For the glance only.
function _resultCount(value) {
  if (value == null) return 0;
  if (typeof value !== 'object') return 1;
  const n = _firstListLen(value);
  return (n != null) ? n : 1;
}

/**
 * Assess a leg-test reply. PURE.
 * @param {object|null} reply  the invoke envelope: { success, value|result, error, detail, hint }
 * @param {{ expectFields?: string[] }} [opts]  field names the author expects in a successful result (structural check)
 * @returns {{ pass:boolean, verdict:string, summary:string, detail:(string|null), count:number, missing?:string[] }}
 *   verdict — 'ok' (pass) | 'no-reply' | 'missing-fields' | the reply's error code (e.g. 'graphql-error', 'no-csrf',
 *   'not-logged-in', 'op-hash-stale'). The workbench maps a few of these to a next-step hint.
 */
export function assessLegTest(reply, { expectFields = [] } = {}) {
  if (!reply || typeof reply !== 'object') {
    return { pass: false, verdict: 'no-reply', summary: 'No reply — the invoke didn’t return.', detail: null, count: 0 };
  }
  if (reply.success === false || (reply.error && reply.success !== true)) {
    const v = String(reply.error || 'error');
    return { pass: false, verdict: v, summary: `Failed — ${v}.`, detail: (reply.detail || reply.hint) ? String(reply.detail || reply.hint) : null, count: 0 };
  }
  const value = (reply.value !== undefined) ? reply.value : (reply.result !== undefined ? reply.result : null);
  const want = Array.isArray(expectFields) ? expectFields.map((f) => String(f || '').trim()).filter(Boolean) : [];
  const missing = want.filter((f) => !_hasField(value, f));
  const count = _resultCount(value);
  if (missing.length) {
    return { pass: false, verdict: 'missing-fields', summary: `Returned, but missing expected field(s): ${missing.join(', ')}.`, detail: null, count, missing };
  }
  return { pass: true, verdict: 'ok', summary: count ? `Returned ${count} record${count === 1 ? '' : 's'}.` : 'Returned successfully.', detail: null, count };
}
