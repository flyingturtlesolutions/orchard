// Core/headlessClause.js — CD-1a PHASE 2, extraction 1 of 5 (DESIGN_cadence.md §11.3: fieldread → branch → map →
// case → write). The HEADLESS per-item FIELD READ: the own-record subset of chat.js `_runFieldReadClause`, over
// the chain state's prior rows, with NO DOM, NO LLM, NO IO — which is what makes a fieldRead step tier-'sw'.
//
// What this deliberately does NOT do (the panel keeps it): the per-item DRILL fan-out for fields absent from the
// already-fetched rows (that is IO + politeness pacing + teach offers), and the LLM interpretation of a bare
// phrase into a verdict. Headless runs only what was BANKED: the pin carries the field phrase (+ optional term)
// resolved at qualify time; run time re-resolves it against the actual rows and FAILS HONESTLY on drift or
// ambiguity — never guesses (the §1626 rule; a confidently-wrong field read is this area's recurring failure).

import { readFieldSection, fieldReadTally, resolveFieldKey } from './fieldRead.js';

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** The prior step's rows, from the chain state's lastValue. Array, or {rows:[…]} — anything else is "no prior". */
export function rowsOf(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.rows)) return value.rows;
  return null;
}

/**
 * Run ONE banked field-read step headless. Returns the runDriver runStep contract.
 *
 * Resolution discipline: the field KEY is resolved ONCE, on the first row that is an object, then applied to all
 * (records in one list share a schema; per-row re-resolution could silently read different fields from different
 * rows). `ambiguous` and `not-found` fail the STEP — the §2.1 drift rule one level down: a banked field that no
 * longer resolves stops the run, never re-interprets.
 *
 * @param {object} clause   a replayPlan clause whose pin carries { kind:'fieldRead', field, term? }
 * @param {{ state?: object }} io
 * @returns {{ok?:boolean, value?:object, state?:object, error?:string}}
 */
export function runFieldReadStep(clause, { state = null } = {}) {
  const pin = (clause && (clause.pinned || clause.clause)) || {};
  const fieldPhrase = _str(pin.field);
  if (!fieldPhrase) return { ok: false, error: 'field-not-banked' };   // a legacy pin (pre-v1717) — needs the panel's interpreter
  const term = _str(pin.term);

  const rows = rowsOf(state && state.lastValue);
  if (!rows || !rows.length) return { ok: false, error: 'no-prior-rows' };

  const firstObj = rows.find((r) => r && typeof r === 'object');
  if (!firstObj) return { ok: false, error: 'rows-not-records' };
  const res = resolveFieldKey(firstObj, fieldPhrase);
  if (res.ambiguous) return { ok: false, error: `field-ambiguous: ${res.candidates.join(', ')}` };
  if (!res.key) return { ok: false, error: `field-gone: no field matches "${fieldPhrase}"` };
  const key = res.key;

  let found = 0, whole = 0, missing = 0;
  const items = [];
  const enriched = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const raw = (row && typeof row === 'object') ? row[key] : undefined;
    if (raw == null || _str(raw) === '') {
      missing++;
      items.push({ i, mode: 'missing', text: '' });
      enriched.push(row);
      continue;
    }
    const sec = readFieldSection(String(raw), term);
    if (sec.found && sec.mode !== 'whole') found++; else whole++;
    items.push({ i, mode: sec.mode, text: sec.text });
    // the enriched row (the PP-1 composition rule): a following step sees the read's extract alongside the record
    enriched.push((row && typeof row === 'object') ? { ...row, [`${key}__read`]: sec.text } : row);
  }

  const tally = fieldReadTally({ rows: rows.length, found, whole, missing, field: key, term });
  return {
    ok: true,
    value: { kind: 'fieldRead', field: key, term: term || null, tally, items },
    state: { ...(state || {}), lastValue: enriched, lastFieldRead: { field: key, term: term || null, tally } },
  };
}
