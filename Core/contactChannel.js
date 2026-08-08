// Core/contactChannel.js — v2.74.2122. HOW (and whether) to reach the homeowner.
//
// The design shift (user, 2026-08-08): "Creating a ticket that has to be actioned by support (sending an email to
// the customer) is redundant as orchard has the machinery to send the ask email to the customer directly. 1.
// orchard could track the ticket and action the reply (# of switches, type, etc). 2. less support work."
// That is right, and it is the requester=customer arc: a Zendesk ticket whose requester is the homeowner emails
// them and threads their reply back, which Orchard can then read for the count.
//
// It also moves a decision that used to be a human's onto us. A support agent looking at the task would not have
// emailed a homeowner about someone else's trade, and would have phoned the ones who asked to be phoned. Automating
// the send means encoding both, so this module answers ONE question — does this row earn an email, a call, or
// neither — and answers it conservatively.
//
// CONCERN 1, the user's: "the contacts record has a 'contact Method:' field, so far we've only seen it with a
// 'Any' value, but it might be specified to 'Phone'."
//   Evidence: across BOTH TaskContacts captures (2 tasks, 8 contact rows) the only values are "Any" ×6 and "-1" ×2.
//   "Phone" is unobserved — and the `-1` sentinel is proof the field IS an enum with values we have not seen. So
//   the email path is an ALLOW-LIST, never a deny-list: only a value we affirmatively read as email-permitting
//   sends mail, and ANY unrecognized value routes to a human instead. Getting this backwards would mean the first
//   homeowner who asked to be phoned gets emailed by a machine — the exact failure the field exists to prevent.
//
// CONCERN 2, the user's: "since 'Not Deako' is retired, customer might get an unnecessary email."
//   Exactly right, and it is a cause-level fact rather than a contact-level one. When the three dispositions
//   collapsed to two, `other-trade` stopped being its own arm and started landing in `contact homeowner` — but its
//   question ("who owns this? it reads as another trade") is addressed to the TEAM, not to the customer. Emailing
//   a homeowner to ask which trade owns their work is both useless and faintly insulting. Causes are therefore
//   split by WHO CAN ANSWER, and only customer-answerable ones can ever reach a customer.
//
// PURE — no chrome.*, no network, no DOM.

const _s = (v) => (v == null ? '' : String(v).trim());

/** Which causes a CUSTOMER can actually answer. Anything absent from this set never reaches them. */
export const CUSTOMER_ANSWERABLE = Object.freeze(['no-count', 'named-product-unresolved']);

/**
 * Causes whose question belongs to US, not to the homeowner. These land in the UNRESOLVED channel.
 *  · other-trade     — "which trade owns this?" is an internal routing question (the user's concern 2).
 *  · already-handled — "was this already sent?" is answered by our own records and the task history; asking the
 *                      homeowner to confirm what we shipped reads as a company that does not know what it did.
 */
export const INTERNAL_ONLY = Object.freeze(['other-trade', 'already-handled']);

// The ONLY ContactMethod values that permit an automated email. Allow-list by design (see CONCERN 1).
//   "Any"  — observed, and means no restriction.
//   "Email"/"E-mail" — not observed here, but if the enum says email, email is right.
//   "-1" / "" / null — the unset sentinel, observed: no preference was ever recorded. Treated as permitted, since
//   a blank preference is an absence of objection rather than a stated one — but it is REPORTED distinctly so a
//   reviewer sees the difference between "they said Any" and "nobody asked them".
const _EMAIL_OK = /^(any|e-?mail)$/i;
const _UNSET = /^(-?1|none|null|)$/i;

/** How the record says to reach this person. PURE. @returns {'any'|'email'|'unset'|'other'} */
export function contactMethodClass(raw) {
  const v = _s(raw);
  if (_UNSET.test(v)) return 'unset';
  if (/^any$/i.test(v)) return 'any';
  if (/^e-?mail$/i.test(v)) return 'email';
  return 'other';                       // Phone, Text, Mail, or anything this codebase has never seen
}

/**
 * Decide the channel for ONE contact row + cause. PURE.
 *
 * @returns {{channel:'email'|'call'|'unresolved', why:string, method:string}}
 *   email    — send the ask to the customer directly (the new primary path)
 *   call     — a person must phone them: they asked to be phoned, or we hold no address
 *   unresolved — the customer is not involved at all; the task still needs work, and it is ours
 *                (name chosen by the user 2026-08-08 over 'internal')
 */
export function decideChannel({ cause = '', person = null } = {}) {
  const c = _s(cause);
  const method = contactMethodClass(person && person.prefers);

  if (INTERNAL_ONLY.includes(c)) {
    return { channel: 'unresolved', method, why: c === 'other-trade'
      ? 'reads as another trade — routing is ours to decide, not the homeowner\'s'
      : 'the note says it was already handled — our own records answer that, not the homeowner' };
  }
  if (!CUSTOMER_ANSWERABLE.includes(c)) {
    // An unknown cause is not a licence to contact someone.
    return { channel: 'unresolved', method, why: `unrecognised cause "${c || '(none)'}" — nobody is contacted on a guess` };
  }
  if (!person || !_s(person.email)) {
    return { channel: 'call', method, why: 'no email address on the record' };
  }
  if (method === 'other') {
    return { channel: 'call', method, why: `they asked to be reached by "${_s(person.prefers)}" — not email` };
  }
  return { channel: 'email', method, why: method === 'unset' ? 'no contact preference recorded' : `contact method "${_s(person.prefers)}"` };
}

/**
 * Split a planned set into what gets emailed, what needs a call, and what never involves the customer. PURE.
 * `items` = [{ id, label, outcome:{cause}, person }] — person is the homeowner from Core/contactRoles.js.
 */
export function planChannels(items) {
  const out = { email: [], call: [], unresolved: [] };
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it) continue;
    const d = decideChannel({ cause: it.outcome && it.outcome.cause, person: it.person });
    out[d.channel].push({ ...it, decision: d });
  }
  return out;
}

/** The reviewer's one-line summary, before anything is sent. PURE. Every bucket is named, including the empty. */
export function describeChannelPlan(plan) {
  const p = (plan && typeof plan === 'object') ? plan : { email: [], call: [], unresolved: [] };
  const n = (k) => (Array.isArray(p[k]) ? p[k].length : 0);
  const bits = [];
  if (n('email')) bits.push(`**${n('email')} emailed to the homeowner**`);
  if (n('call')) bits.push(`**${n('call')} needing a phone call** (they asked to be phoned, or we hold no address)`);
  if (n('unresolved')) bits.push(`**${n('unresolved')} left unresolved** (not the homeowner's question — ours to settle)`);
  if (!bits.length) return 'Nothing to send — no task needs the homeowner.';
  return bits.join(' · ');
}
