// Core/zendeskRequester.js — v2.74.2121. The ticket's REQUESTER — i.e. WHOSE ticket it is.
//
// SCOPE CORRECTED (user, 2026-08-08, two rulings in sequence):
//   1. "the requestor isn't a required field when creating a ticket, only the assignee. So no need to create an
//      orchard account."  -> the warranty SUPPORT REQUEST (the contact arm) needs no requester work at all.
//      Zendesk attributes an unspecified requester to the authenticated session, which costs nothing. What that
//      ticket needs is an ASSIGNEE — see Core/zendeskAssignee.js.
//   2. "the requestor will be useful when sending out emails to customer, where the requestor will be the
//      customer."  -> this module survives for THAT case, with its subject changed. The requester is not Orchard;
//      it is the HOMEOWNER. A ticket whose requester is the customer is how Zendesk makes the reply thread reach
//      them by email — which is exactly the customer-facing arc, not the internal one.
//
// WHAT THAT CHANGES HERE. Naming the customer as requester does NOT need find-or-create: the REST ticket create
// accepts an inline `requester: {name, email}` and Zendesk looks up or creates that end user itself. The
// create-user helpers below therefore stop being the main path and become the fallback for the case where an id
// is genuinely needed (e.g. assigning an existing profile, or a tenant that rejects inline requesters).
//
// HAR-VERIFIED (deako.zendesk.com, 2026-08-08):
//   POST /api/v2/users -> 201 {"user":{"id":<number>,…,"role":"end-user"}}
//   POST /api/v2/users -> 422 {"error":"RecordInvalid","details":{"email":[{"error":"DuplicateValue",…}]}}
// The 422 is the important one and the reason classifyUserCreate reports THREE states: a duplicate email means the
// person already exists, which is a success for our purposes, not a failure. Read as an error, any repeat run
// breaks. NOT verified: the inline-requester form on ticket create (documented Zendesk behaviour, unproven here).
//
// PURE — no chrome.*, no network, no DOM.

const _s = (v) => (v == null ? '' : String(v).trim());

/** The desk account's stable identity. The name is what a colleague sees as the ticket's requester. */
/**
 * The inline requester for a CUSTOMER-FACING ticket — the primary path after the user's correction. PURE.
 *
 * Zendesk's ticket create accepts `requester: {name, email}` and resolves it to an existing end user or creates
 * one, so the customer becomes the requester — which is what makes the reply thread reach them by email — with no
 * separate create/search round trip and no account for us to own. Returns null when there is no usable address:
 * a ticket that claims a customer requester and carries a broken one reaches nobody, silently.
 *
 * NOT HAR-verified (documented Zendesk behaviour; this tenant's capture shows only the user-create endpoints), so
 * the create/lookup helpers below remain the fallback if a tenant rejects the inline form.
 */
export function customerRequester({ name = '', email = '' } = {}) {
  const e = _s(email).toLowerCase();
  if (!e || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e)) return null;
  const n = _s(name);
  return n ? { name: n, email: e } : { email: e };
}

export const DESK_USER = Object.freeze({
  name: 'Orchard (Warranty Desk)',
  // The role is a LITERAL in the recipe body, never a parameter — a sweep can never mint an agent or an admin.
  role: 'end-user',
});

/**
 * The create-user params for the desk account. PURE.
 *
 * The email is the caller's to choose and is the account's IDENTITY — Zendesk enforces uniqueness on it, which is
 * exactly what makes find-or-create work. A shared mailbox or a plus-addressed alias is the intended shape.
 * @returns {{name:string, email:string}|null} null when no usable email was given — never invents one.
 */
export function deskUserParams(email, { name = DESK_USER.name } = {}) {
  const e = _s(email).toLowerCase();
  if (!e || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e)) return null;
  return { name: _s(name) || DESK_USER.name, email: e };
}

/** Is this a Zendesk "that email is already taken" verdict? The find-or-create hinge. PURE. */
export function isDuplicateEmail(body) {
  const b = (body && typeof body === 'object') ? body : {};
  const det = (b.details && typeof b.details === 'object') ? b.details : {};
  const list = Array.isArray(det.email) ? det.email : [];
  return list.some((d) => d && (_s(d.error) === 'DuplicateValue' || /already being used/i.test(_s(d.description))));
}

/**
 * Classify a create-user response into the THREE outcomes that actually exist. PURE.
 *
 * `exists` carries no id on purpose: the 422 body names the conflict but not the conflicting user, so the id must
 * come from a lookup. Returning a guessed id here would be the worst kind of wrong — every ticket would be
 * attributed to whoever that number happened to be.
 * @returns {{state:'created'|'exists'|'failed', id:number|null, why:string}}
 */
export function classifyUserCreate(resp) {
  const r = (resp && typeof resp === 'object') ? resp : {};
  const body = (r.value && typeof r.value === 'object') ? r.value : r;
  const user = (body && typeof body.user === 'object') ? body.user : null;

  if (user && Number.isFinite(Number(user.id)) && Number(user.id) > 0) {
    return { state: 'created', id: Number(user.id), why: `created ${_s(user.name) || 'the desk user'}` };
  }
  if (isDuplicateEmail(body)) {
    return { state: 'exists', id: null, why: 'that email already belongs to a Zendesk user — look it up rather than creating a second' };
  }
  // Anything else is a real failure, and it must name itself: a bare "couldn't create" sends the reader nowhere.
  const desc = _s(body && (body.description || body.error))
    || _s(r.error)
    || 'the create returned nothing recognisable';
  return { state: 'failed', id: null, why: desc };
}

/**
 * The desk user's id out of a user LOOKUP result (search or by-id read). PURE.
 *
 * Matches on the email, exactly and case-insensitively — never on the display name, which is not unique and which
 * a person can edit. Returns null rather than the first result when nothing matches the address we asked for.
 */
export function deskUserIdFrom(value, email) {
  const want = _s(email).toLowerCase();
  if (!want) return null;
  const pools = [];
  if (Array.isArray(value)) pools.push(value);
  if (value && typeof value === 'object') {
    if (Array.isArray(value.users)) pools.push(value.users);
    if (Array.isArray(value.results)) pools.push(value.results);
    if (value.user && typeof value.user === 'object') pools.push([value.user]);
  }
  for (const pool of pools) {
    for (const u of pool) {
      if (!u || typeof u !== 'object') continue;
      if (_s(u.email).toLowerCase() !== want) continue;
      const id = Number(u.id);
      if (Number.isFinite(id) && id > 0) return id;
    }
  }
  return null;
}

/**
 * One line describing the requester state, for the ticket preview. PURE.
 *
 * The reviewer's question before any ticket is opened is "who will this appear to be from?", and the honest answer
 * when we have no desk id is that Zendesk will attribute it to the signed-in session — which is a real requester,
 * just not the desk. Never phrase that as "no requester": a ticket always has one.
 */
export function describeRequester({ id = null, email = '', name = DESK_USER.name } = {}) {
  if (Number.isFinite(Number(id)) && Number(id) > 0) {
    return `Requester: ${_s(name) || DESK_USER.name}${_s(email) ? ` <${_s(email)}>` : ''} (Zendesk user ${Number(id)}).`;
  }
  // v2.74.2121 — corrected: there is no desk account to set up, and saying there was implied missing configuration
  // that nobody owes. An internal support request is raised by the signed-in session BY DESIGN; the requester only
  // becomes a real choice on the customer-facing arc, where it is the homeowner (see customerRequester).
  return 'Requester: your signed-in Zendesk account (internal request — no separate account needed).';
}
