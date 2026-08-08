// Core/warrantyContact.js — v2.74.2110: the CONTACT arm's artifact.
//
// The warranty reader (Core/warrantySwitch.js) produces two outcomes. REPLACE has always had a concrete artifact —
// a Shopify draft order (count × product). CONTACT had none: it was a verdict with nowhere to go, so a task that
// needed a person just sat in a list. The user's framing: "this path requires human action and the contact surface
// is zendesk, so the equivalent to draft order would be creating a ticket with the necessary context for human
// action" — and, clarified: **a support request TO THE SUPPORT TEAM asking them to contact the customer**, not a
// customer-facing ticket. EVERY TICKET HAS A REQUESTER, and here it is ORCHARD (user ruling) — the desk raises
// the request, not the homeowner. `requesterId` rides through when Orchard's Zendesk user id is known; with none
// supplied Zendesk attributes the ticket to the authenticated session, which is still a real requester and still
// never the homeowner — they are named in the body as the person to CALL.
//
// The body is CAUSE-SPECIFIC, because the four contact causes need genuinely different human actions (asking a
// homeowner "how many?" is not the same job as routing an outlets task to another trade). One template with a
// swapped noun would produce a ticket that reads right and asks the wrong question.
//
// PURE — no DOM, no chrome, no network. Renders text only; the caller ships it through the ordinary write gate.
//
// PII NOTE: the ticket body deliberately carries the homeowner's name/phone/email/address. That is not an LLM
// egress — it is a WRITE into the team's own Zendesk over the user's own session, and a support agent cannot make
// the call without it. The classifier's redaction (which strips exactly these values before any model sees them)
// is a different boundary and is unaffected.

import { resolveWriteValue } from './writeMap.js';

const _s = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));
const _clip = (v, n) => { const s = _s(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** The ask, per cause. Each names WHAT a person must find out and WHY the machine could not. */
export const CONTACT_ASKS = Object.freeze({
  'no-count': {
    ask: 'How many switches does the homeowner need?',
    why: 'The note asks for switches but gives no quantity anywhere, so we will not guess one.',
    verb: 'confirm the quantity',
  },
  'named-product-unresolved': {
    ask: 'Which Deako product is this? Confirm the exact model with the homeowner.',
    why: 'The note names a specific product we could not match to the catalog, and substituting the standard switch could ship the wrong device.',
    verb: 'confirm the product',
  },
  'other-trade': {
    ask: 'Who owns this? It reads as another trade, not a Deako switch — please route it.',
    why: 'The work described is not a Deako switch replacement, so no order should be drafted against it.',
    verb: 'route to the right trade',
  },
  'already-handled': {
    ask: 'Has this already been handled? Confirm before anything else is sent.',
    why: 'The note says the work was already done, declined, or is being repaired instead.',
    verb: 'verify before acting',
  },
});

/** Priority per cause. Nothing here is urgent; an unrouted task is the one that rots, so it edges up. */
const _PRIORITY = Object.freeze({ 'no-count': 'normal', 'named-product-unresolved': 'normal', 'other-trade': 'normal', 'already-handled': 'low' });

/**
 * EVERY contact on the task, each classified by THE RECORD'S OWN FLAGS — never by guessing at a role string.
 *
 * The user's warning (2026-08-08): "careful, other might be support or drh sales rep." Phoning a builder's staffer
 * believing they are the customer is the failure this guards. `TaskContacts` answers it outright — HAR-verified
 * payload of `GET /api/Vendor/Warranty/TaskContacts/{taskId}` (Core/connectorRecipes.js:915), which the drill merges
 * onto the row under `__contacts` verbatim, PascalCase intact:
 *
 *   Email · HomePhone · WorkPhone · CellPhone · ContactMethod · IsPrimary · IsDrHorton · IsBuyer ·
 *   AssignmentType · Id · FirstName · LastName · FullName
 *
 * Both sampled tasks carried the same four-row shape, and it is the FLAGS that separate the sides:
 *   IsDrHorton:true + AssignmentType "CSR" / "COORDINATOR"  -> builder staff — NOT the customer, never called
 *   IsBuyer:true + IsPrimary:true                            -> the primary homeowner
 *   IsDrHorton:false with no AssignmentType                  -> the co-buyer (the secondary homeowner)
 *
 * That last line is the one inference here, and it is made deliberately: the serializer OMITS false booleans, so the
 * co-buyer arrives carrying no `IsBuyer` at all. Reading "no flags" as "not a homeowner" would silently drop the
 * second person the user asked to always list; reading it as builder staff would be worse. Absence of a DRH marker is
 * therefore treated as homeowner-side — the safe direction, since a homeowner mislabelled secondary still gets
 * called whereas a dropped one does not. `roleStated` marks which labels came from the record verbatim.
 *
 * Reading the row's own flat fields (the pickFieldPath fallback) is deliberately AVOIDED — it returns whichever
 * contact sits first in the array regardless of side, which is how a probe of this module returned the same person
 * as both primary and "other". PURE.
 * @returns {Array<{name,email,phone,phoneLabel,prefers,role,roleStated,isPrimary,isHomeowner,isStaff}>}
 */
export function contactsFrom(row) {
  const r = (row && typeof row === 'object') ? row : {};
  const raw = [r.__contacts, r.contacts].find((x) => Array.isArray(x) && x.length) || [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    // Case-insensitive reads: the sidecar carries PascalCase, hand-built rows use camelCase.
    const g = (re) => { const hit = Object.entries(c).find(([k, v]) => re.test(k) && v != null && typeof v !== 'object' && _s(v)); return hit ? _s(hit[1]) : ''; };
    const flag = (name) => { const hit = Object.entries(c).find(([k]) => k.toLowerCase() === name); return hit ? (hit[1] === true || hit[1] === 'true') : false; };

    const assignment = g(/^assignmenttype$|role|contacttype|relation/i);   // "CSR" · "COORDINATOR" · a stated title
    const isDrh = flag('isdrhorton');
    const isStaff = isDrh || (!!assignment && !/home\s*owner|buyer|primary|secondary/i.test(assignment));
    const isPrimary = flag('isprimary');
    const isHomeowner = !isStaff;                            // see the note above: no DRH marker => homeowner side
    const role = assignment
      ? (isDrh ? assignment + ' (D.R. Horton)' : assignment)
      : (isPrimary ? 'Primary homeowner' : 'Secondary homeowner');

    // Phone: keep the LABEL, so the agent knows whether they are dialling a cell or a work line.
    const phones = [['cell', g(/^cellphone$|mobile|cell/i)], ['home', g(/^homephone$/i)], ['work', g(/^workphone$/i)], ['', g(/phone/i)]];
    const hit = phones.find(([, v]) => v) || ['', ''];
    const prefersRaw = g(/^contactmethod$/i);                // "Any" · "-1" (the unset sentinel) · a named method
    const first = g(/first/i); const last = g(/last/i); const full = g(/^fullname$|^name$|displayname/i);

    const person = {
      name: _s(full || [first, last].filter(Boolean).join(' ')),
      email: g(/email/i), phone: hit[1], phoneLabel: hit[0],
      prefers: /^-?1$/.test(prefersRaw) ? '' : prefersRaw,   // "-1" means no preference recorded, not a method
      role, roleStated: !!assignment, isPrimary, isHomeowner, isStaff,
    };
    if (person.name || person.email || person.phone) out.push(person);
  }
  // Homeowners first (primary ahead of co-buyer), staff after — the agent reads top-down and calls from the top.
  const rank = (p) => (p.isHomeowner ? (p.isPrimary ? 0 : 1) : 2);
  return out.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
}

/** The homeowner to name on the ticket — primary first, and NEVER a builder staffer. PURE. */
export function homeownerFrom(row) {
  const all = contactsFrom(row);
  const p = all.find((x) => x.isHomeowner && x.isPrimary) || all.find((x) => x.isHomeowner) || null;
  return p
    ? { name: p.name, email: p.email, phone: p.phone, role: p.role }
    : { name: '', email: '', phone: '', role: '' };
}

/** The task's own identifiers/location, as the support agent needs to see them. PURE. */
export function taskIdentityFrom(row) {
  const r = (row && typeof row === 'object') ? row : {};
  const g = (k) => _s(r[k]);
  return {
    ticketId: g('TicketId'), taskNumber: g('TaskNumber'),
    address: _s([g('AddressLine1'), g('CityStateZip')].filter(Boolean).join(', ')),
    project: g('ProjectDisplayName') || g('ProjectName'),
    status: g('TaskStatus'), priority: g('Priority'),
  };
}

/**
 * Build the support request for one CONTACT task. PURE.
 *
 * @param {{row:object, outcome:{cause:string, fields?:object}, instructions?:string, requesterId?:number|string}} spec
 * @returns {{subject:string, comment:string, priority:string, cause:string, requester_id?:number}|null}
 */
export function buildContactTicket({ row = {}, outcome = {}, instructions = '', requesterId = null } = {}) {
  const cause = _s(outcome && outcome.cause);
  const spec = CONTACT_ASKS[cause];
  if (!spec) return null;                                   // an unknown cause writes NOTHING — never a vague ticket
  const id = taskIdentityFrom(row);
  const who = homeownerFrom(row);
  const note = _s(instructions) || _s(row.Instructions);
  const named = _s(outcome.fields && outcome.fields.product_name);

  const where = id.address || id.project || 'address not on the task';
  const subject = _clip(`Warranty ${id.ticketId ? `#${id.ticketId}` : id.taskNumber ? `task ${id.taskNumber}` : ''} — ${spec.verb}${who.name ? ` with ${who.name}` : ''} (${where})`.replace(/\s+/g, ' ').replace(' — ', ' — '), 150);

  // The body is ordered for the person doing the work: the ask first, then who to reach, then the evidence.
  const lines = [];
  lines.push(`Please ${spec.verb} on a Deako warranty task before we can ship anything.`);
  lines.push('');
  lines.push(`WHAT WE NEED: ${spec.ask}`);
  if (cause === 'named-product-unresolved' && named) lines.push(`The note names: "${_clip(named, 80)}"`);
  lines.push('');
  // WHO TO CALL vs WHO ELSE IS ON THE TASK. A warranty task's contacts include people who are NOT the customer —
  // the builder's own CSR and coordinator ride on every one of them. Phoning a CSR believing they are the homeowner
  // is the failure this split prevents, so the two sides are separated by the record's `IsDrHorton`/`AssignmentType`
  // flags (see contactsFrom) and everyone is listed with the title the record gives them.
  const people = contactsFrom(row);
  const owners = people.filter((p) => p.isHomeowner);
  const others = people.filter((p) => !p.isHomeowner);
  const say = (p) => {
    lines.push(`  ${p.name || '(name not stated)'}  — ${p.role}`);
    const ph = p.phone ? `${p.phone}${p.phoneLabel ? ` (${p.phoneLabel})` : ''}` : '(none)';
    lines.push(`    Phone: ${ph}    Email: ${p.email || '(none)'}${p.prefers ? `    Prefers: ${p.prefers}` : ''}`);
  };
  lines.push(owners.length > 1 ? 'HOMEOWNERS — call these' : 'HOMEOWNER — call this person');
  if (!owners.length) {
    lines.push(people.length
      ? '  (every contact on this task is builder staff — no homeowner is listed; check VendorSuite before calling anyone below)'
      : '  (no contacts on the task — look them up in VendorSuite before calling)');
  }
  for (const p of owners) say(p);
  if (others.length) {
    lines.push('');
    lines.push('ALSO ON THE TASK (not the customer)');
    for (const p of others) say(p);
  }
  lines.push('');
  lines.push(`  Address:   ${id.address || '(not on the task)'}`);
  if (id.project) lines.push(`  Community: ${id.project}`);
  lines.push('');
  lines.push('WARRANTY TASK');
  if (id.ticketId) lines.push(`  Ticket:  #${id.ticketId}`);
  if (id.taskNumber) lines.push(`  Task:    ${id.taskNumber}`);
  if (id.status) lines.push(`  Status:  ${id.status}`);
  lines.push('');
  lines.push('THE NOTE SAYS');
  lines.push(note ? note.split('\n').map((l) => `  ${l}`).join('\n') : '  (no instructions text on the task)');
  lines.push('');
  lines.push('RAISED BY: Orchard (warranty desk) — opened automatically from the warranty queue.');
  lines.push(`WHY THIS NEEDS A PERSON: ${spec.why}`);
  lines.push('');
  lines.push('Reply here with the answer and the replacement can be drafted.');

  const rid = Number(requesterId);
  return {
    subject, comment: lines.join('\n'), priority: _PRIORITY[cause] || 'normal', cause,
    // ORCHARD is the requester (user ruling: "every ticket has a requestor — orchard can be the requestor here").
    // Omitted when the id is unknown, in which case Zendesk attributes the ticket to the authenticated session —
    // still a real requester, and never the homeowner, who is named in the body as the person to CALL.
    ...(Number.isFinite(rid) && rid > 0 ? { requester_id: rid } : {}),
  };
}

/**
 * Build one support request per CONTACT task (1:1 with the draft-order model — each ticket stays independently
 * actionable, and a batched ticket cannot be worked by two agents). Rows whose cause has no ask are SKIPPED and
 * reported, never turned into a vague ticket. PURE.
 * @returns {{tickets:Array, skipped:Array<{id:string, cause:string}>}}
 */
export function buildContactTickets(items = []) {
  const tickets = []; const skipped = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it) continue;
    const t = buildContactTicket({ row: it.row || {}, outcome: it.outcome || {}, instructions: it.instructions, requesterId: it.requesterId });
    if (t) tickets.push({ id: _s(it.id), ...t });
    else skipped.push({ id: _s(it.id), cause: _s(it.outcome && it.outcome.cause) || '(none)' });
  }
  return { tickets, skipped };
}

/** One-line preview per ticket, for the panel's plan (mirrors the draft-order preview). PURE. */
export function describeContactTicket(t) {
  const x = (t && typeof t === 'object') ? t : {};
  return `${_s(x.cause) || 'contact'} — ${_clip(x.subject, 90)}`;
}
