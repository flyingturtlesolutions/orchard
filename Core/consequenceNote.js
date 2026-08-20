// Core/consequenceNote.js — v2.74.2229: the §14 CONSEQUENCE WRITE-BACK, pure half (the CW-VS slice).
// USER RULING 2026-08-14: when the replacement order's lifecycle moves, write it onto the warranty task that
// incited it — (1) order confirmed (the draft→order hand-off), (2) tracking number observed, (3) delivered.
// Each line: date — description — reference — creator (default "Divine @ Deako").
//
// PURE — no chrome, no clock (the seam passes the formatted date), no Logger. The sweep (background/handlers/
// vitals.js) is the impure half: it reads the task's current note, APPENDS (the write REPLACES VendorExplanation
// wholesale — v2227's capture proved it — so append-preserving the prior text is what makes the unattended write
// honest), fires the gated leg, and marks the row.
//
// STATE-DERIVED, NOT EDGE-TRIGGERED (the §12.5 probe lesson): `dueWriteBacks` reads what the ROW knows now —
// hand-off pointer, the observed bag, the `writeBack` marker — so a write lost to a blip retries on the next
// sweep instead of stranding, and marking is the only thing that makes it stop.
//
// v1 honesty: the tracking number is parsed back OUT of the flattened observed strings (`parcels: "+1 new
// (1Z…)"`) — a raw-news channel from observeFields would be cleaner and is the named refinement, not a blocker.

const _str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
const _isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export const NOTE_CREATOR_DEFAULT = 'Divine @ Deako';
/** UPS 1Z… plus the long-digit carriers (FedEx/USPS). Deliberately conservative — a miss costs a late line. */
export const TRACKING_RE = /\b(1Z[0-9A-Z]{10,18}|\d{12,26})\b/;

/** One note line. PURE — `date` arrives formatted (the seam owns the clock). Unknown kind → ''. */
export function composeNoteLine(kind, { date = '', ref = '', tracking = '', carrier = '', creator = NOTE_CREATOR_DEFAULT } = {}) {
  const d = _str(date); const c = _str(creator) || NOTE_CREATOR_DEFAULT;
  if (kind === 'confirmed') return `${d} — Replacement order confirmed — ${_str(ref) || 'order'} — ${c}`;
  if (kind === 'tracking') return `${d} — Replacement shipped — tracking ${_str(tracking)}${_str(carrier) ? ` (${_str(carrier)})` : ''} — ${c}`;
  if (kind === 'delivered') return `${d} — Replacement delivered${_str(tracking) ? ` — ${_str(tracking)}` : ''} — ${c}`;
  return '';
}

/**
 * Append a line to the task's existing note text. The prior text ALWAYS survives (that is the ruling's safety
 * property — the leg's transport replaces the whole field, so this function is where "append" becomes true).
 * Idempotent: a line already present is not added twice — the belt that makes a re-fired write harmless.
 */
export function appendNote(prior, line) {
  const p = _str(prior).trim();
  const l = _str(line).trim();
  if (!l) return p;
  if (p.includes(l)) return p;
  return p ? `${p}\n${l}` : l;
}

/**
 * Which write-backs does this row OWE right now? PURE over the row's own state:
 *   confirmed — the hand-off pointer moved and no 'confirmed' marker yet
 *   tracking  — a tracking-shaped token sits in the observed bag and no 'tracking' marker yet
 *   delivered — the observed progress/status says DELIVERED and no 'delivered' marker yet
 * Rows with no provenance owe nothing — a write-back with no inciting task has no destination (§12.8's
 * never-inferred rule). Returns [] rather than throwing on any junk.
 */
export function dueWriteBacks(row) {
  const r = _isObj(row) ? row : {};
  const inc = _isObj(r.incitedBy) ? r.incitedBy : null;
  if (!inc || !_str(inc.id)) return [];
  const wb = _isObj(r.writeBack) ? r.writeBack : {};
  const out = [];
  const handedOff = !!(_str(r.currentKind) && _str(r.currentId)
    && (_str(r.currentKind) !== _str(r.kind) || _str(r.currentId) !== _str(r.id)));
  if (handedOff && !wb.confirmed) out.push({ key: 'confirmed', ref: _str(r.currentLabel) || `#${_str(r.currentId)}` });
  const obs = _isObj(r.observed) ? r.observed : {};
  const hay = ['parcels', 'progress', 'tracking'].map((k) => _str(obs[k])).join(' · ');
  const m = hay.match(TRACKING_RE);
  if (m && !wb.tracking) out.push({ key: 'tracking', tracking: m[1] });
  if (/DELIVERED/i.test(`${_str(obs.progress)} ${_str(obs.shipStatus)}`) && !wb.delivered) {
    out.push({ key: 'delivered', tracking: m ? m[1] : '' });
  }
  return out;
}

// ── v2.74.2230 — the CUSTOMER NOTIFY (the outward half; USER: "the customer is also notified by email") ──────
// The sweep may only STAGE: composing and parking the draft on the row is internal; SENDING is outward and
// belongs to a human click on the Records drill (pipelineGate queues outward acts — the leg cannot run
// unattended even if a caller tried). `pendingNotify` on the row is the parked draft (or a withheld verdict,
// which is equally visible — a silently-skipped email would be the §13.5 dead-control class).

/** The customer-facing email for the order-confirmed event. PURE; date arrives formatted. */
export function composeCustomerEmail({ name = '', ref = '', date = '', creator = NOTE_CREATOR_DEFAULT } = {}) {
  const first = _str(name).trim().split(/\s+/)[0] || 'there';
  return {
    subject: 'Your warranty replacement has been ordered',
    body: `Hi ${first},\n\nGood news — your warranty replacement was ordered on ${_str(date)}${_str(ref) ? ` (order ${_str(ref)})` : ''}. We'll follow up with tracking as soon as it ships.\n\n— ${_str(creator) || NOTE_CREATOR_DEFAULT}`,
  };
}

/**
 * Does this row owe the customer a confirmed-notification? PURE, state-derived like dueWriteBacks: handed-off +
 * provenance + neither sent (wb.notify) nor already staged/withheld (pendingNotify — the drill owns it then).
 * @returns {{ref:string}|null}
 */
export function dueNotify(row) {
  const r = _isObj(row) ? row : {};
  const inc = _isObj(r.incitedBy) ? r.incitedBy : null;
  if (!inc || !_str(inc.id)) return null;
  const wb = _isObj(r.writeBack) ? r.writeBack : {};
  if (wb.notify) return null;
  if (_isObj(r.pendingNotify)) return null;
  const handedOff = !!(_str(r.currentKind) && _str(r.currentId)
    && (_str(r.currentKind) !== _str(r.kind) || _str(r.currentId) !== _str(r.id)));
  if (!handedOff) return null;
  return { ref: _str(r.currentLabel) || `#${_str(r.currentId)}` };
}

/** Park a drafted email (or a withheld verdict) on the row. PURE; never overwrites an existing stage. */
export function stagePendingNotify(row, pending) {
  const r = _isObj(row) ? row : {};
  if (_isObj(r.pendingNotify)) return r;
  const p = _isObj(pending) ? pending : null;
  if (!p) return r;
  return { ...r, pendingNotify: p };
}

/** Remove the parked draft (after a successful send, or a human dismissal). PURE. */
export function clearPendingNotify(row) {
  const r = _isObj(row) ? row : {};
  if (!('pendingNotify' in r)) return r;
  const { pendingNotify: _drop, ...rest } = r;
  return rest;
}

/** Mark one write-back sent. PURE; same-object return when already marked (the changed:false contract). */
export function markWriteBack(row, key, at = 0) {
  const r = _isObj(row) ? row : {};
  const k = _str(key);
  if (!k) return r;
  const wb = _isObj(r.writeBack) ? r.writeBack : {};
  if (wb[k]) return r;
  return { ...r, writeBack: { ...wb, [k]: Number(at) || 0 } };
}
