// Core/zendeskAssignee.js — v2.74.2121. WHO a support request lands on.
//
// This replaces the requester work (v2119/2120), on the user's correction: "the requestor isn't a required field
// when creating a ticket, only the assignee. So no need to create an orchard account." That is right, and it makes
// the whole find-or-create arc unnecessary — Zendesk attributes an unspecified requester to the authenticated
// session, which is a real requester and costs nothing to leave alone. The account module and its 17 tests were
// deleted rather than left as dead code.
//
// The distinction the code must keep straight: the Zendesk API does NOT require an assignee — a ticket may sit
// unassigned in a queue. The WORKFLOW does. A support request that asks a person to phone a homeowner is useless
// sitting unassigned, so these tickets fail CLOSED without one, matching the write-gate posture everywhere else.
// Never phrase that as "Zendesk requires it": it does not, and a reader who acts on that will be wrong elsewhere.
//
// HAR-VERIFIED (deako.zendesk.com, 2026-08-08) — the real create carried, alongside subject/comment:
//   assigneeId <14-digit>  ·  groupId <8-digit>  ·  brandId  ·  ticketFormId  ·  priority "NORMAL"
//   comment { body { value, format:"HTML" }, isPublic:true }  ·  via { viaChannel:"WEB_FORM" }
//   tags ["ci-warranty-replacements"]
// and answered CreateIssueTicketSuccess { ticket { id } }. So assignment by ID is what the UI does; the REST leg
// accepts an id or an email, and an email is the only form a person can state from memory.
//
// PURE — no chrome.*, no network, no DOM.

const _s = (v) => (v == null ? '' : String(v).trim());
const _isEmail = (v) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(_s(v));
const _posInt = (v) => { const n = Number(v); return (Number.isFinite(n) && n > 0 && Number.isInteger(n)) ? n : null; };

/**
 * The tag every warranty support request carries, so the team can filter them as a class.
 *
 * The live replacement ticket used `ci-warranty-replacements`, so this is the sibling for the other arm rather
 * than an invented convention — but it IS our choice of name, and it is stated here rather than buried at a call
 * site so it can be corrected in one place.
 */
export const CONTACT_TAG = 'ci-warranty-contact';

/**
 * Normalize whatever the user said into assignment fields for the create. PURE.
 *
 * Accepts an email ("assign them to jane@deako.com"), a numeric agent id, or a group id — an email is the only
 * form a person states from memory, and the leg accepts it. Returns {} when nothing usable was given, so the
 * caller can fail closed rather than silently creating an unassigned ticket.
 * @returns {{assignee_email?:string, assignee_id?:number, group_id?:number}}
 */
export function assignmentFields({ email = '', assigneeId = null, groupId = null } = {}) {
  const out = {};
  if (_isEmail(email)) out.assignee_email = _s(email).toLowerCase();
  const a = _posInt(assigneeId); if (a) out.assignee_id = a;
  const g = _posInt(groupId); if (g) out.group_id = g;
  return out;
}

/** Is this enough to land the ticket on someone? PURE. A group alone counts — a queue has owners. */
export function hasAssignment(fields) {
  const f = (fields && typeof fields === 'object') ? fields : {};
  return !!(f.assignee_email || f.assignee_id || f.group_id);
}

/**
 * The line the reviewer reads before anything is created. PURE.
 *
 * Two honest states, and neither is silent: assigned (say to whom, in the form given) or not (say that the ticket
 * would sit unassigned, and that we will not create it that way). The requester is mentioned only to close the
 * question a reader would otherwise ask — it is the signed-in session, by design, and needs no account.
 */
export function describeAssignment(fields, { requesterNote = true } = {}) {
  const f = (fields && typeof fields === 'object') ? fields : {};
  const who = f.assignee_email
    || (f.assignee_id ? `agent ${f.assignee_id}` : '')
    || (f.group_id ? `group ${f.group_id}` : '');
  const req = requesterNote ? ' Raised by your signed-in Zendesk account.' : '';
  return who
    ? `Assigned to ${who}.${req}`
    : `No assignee set — these ask a person to make a call, so I won't open them unassigned. Say who, e.g. \`assign the support requests to jane@example.com\`.${req}`;
}

/** Parse "assign the support requests to <who>". PURE. Returns null when the ask is not that. */
export function parseAssignAsk(ask) {
  const a = _s(ask);
  if (!a) return null;
  const m = a.match(/^\s*assign\s+(?:the\s+)?(?:support\s+requests?|zendesk\s+(?:tickets?|requests?)|contact\s+tickets?|them|these)\s+to\s+(.+?)\s*$/i);
  if (!m) return null;
  const who = _s(m[1]).replace(/[.,;]$/, '');
  if (_isEmail(who)) return { email: who.toLowerCase() };
  const id = _posInt(who);
  if (id) return { assigneeId: id };
  return { raw: who };            // a NAME — the caller must resolve it; guessing an id here picks a stranger
}
