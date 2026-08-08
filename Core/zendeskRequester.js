// Core/zendeskRequester.js — v2.74.2119. The Orchard warranty-desk REQUESTER identity.
//
// Every Zendesk ticket has a requester, and the user's ruling is that Orchard is it on a warranty support request
// ("every ticket has a requestor - orchard can be the requestor here"). Until now `requester_id` was an optional
// number nobody supplied, so tickets would have been attributed to whatever human session happened to be signed
// in — which reads, to the colleague receiving it, as that person asking. A desk account makes the provenance
// honest: the warranty desk raised it, automatically, and the reply thread belongs to the desk rather than to
// whoever last logged in.
//
// HAR-VERIFIED (deako.zendesk.com, 2026-08-08) — the shapes below are quoted from real traffic:
//   POST /api/v2/users  -> 201  {"user":{"id":<number>,"name":…,"email":…,"role":"end-user","verified":false,…}}
//   POST /api/v2/users  -> 422  {"error":"RecordInvalid","description":"Record validation errors",
//                                "details":{"email":[{"description":"Email: … is already being used by another
//                                 user","error":"DuplicateValue"}]}}
//
// THE 422 IS THE IMPORTANT ONE. Creating the desk account is not a one-shot: the second attempt fails with
// DuplicateValue, and that is not an error — it means the account already exists and we simply do not hold its id.
// Treating it as a failure would make the desk un-bootstrappable on every run after the first. So the classifier
// below reports THREE states, and only one of them is a real failure.
//
// NOT verified here: the ticket create itself. This HAR contains no POST to any ticket endpoint, so
// `create_ticket`'s body template remains unproven against the live tenant — say so rather than implying the
// whole chain is evidenced.
//
// PURE — no chrome.*, no network, no DOM.

const _s = (v) => (v == null ? '' : String(v).trim());

/** The desk account's stable identity. The name is what a colleague sees as the ticket's requester. */
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
  return 'Requester: your signed-in Zendesk account — the warranty desk account is not set up yet, so these would appear to come from you.';
}
