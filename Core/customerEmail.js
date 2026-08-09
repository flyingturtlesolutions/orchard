// Core/customerEmail.js — v2.74.2131. The message the HOMEOWNER actually receives.
//
// WHY THIS FILE EXISTS. The review card rendered the INTERNAL support-request body under
// "DRAFT EMAIL → dana@example.com". Approving that would have sent a customer a message opening "Please confirm
// the quantity on a Deako warranty task before we can ship anything", followed by a HOMEOWNERS block listing their
// own phone numbers AND the builder's CSR and coordinator — the wrong voice and an internal-contact leak in one
// message. So the two artifacts are separate by construction, not by a flag:
//   Core/warrantyContact.js  -> a request to a COLLEAGUE: both homeowners, builder staff, task ids, our reasoning.
//   this file                -> a message to the CUSTOMER: their name, one ask, a sign-off. Nothing else.
//
// v2.74.2131 — THE EMAIL PERFORMS THE ASK; IT DOES NOT NARRATE THE PAPERWORK. The first version quoted the task's
// Instructions back at the homeowner. That was wrong twice over, and the user caught it on the first real draft:
//   · META — the customer does not care how we file their request, and being shown our internal record of it
//     invites them to answer the record rather than the question.
//   · WRONG SPEAKER — those instructions are the BUILDER's work order to Deako ("Please send homeowner deako
//     switches"). The homeowner did not write that sentence, so quoting it back as "It says:" attributes to them
//     a demand addressed to someone else, and reads as bureaucratic nonsense.
// What we actually need is two facts — WHICH switches are faulty and HOW MANY — so the message asks for exactly
// those two facts, offers the easiest way to answer, and stops.
//
// THE LEAK RULE: a customer-facing body may contain only (a) their own name, (b) the ask, (c) our sign-off.
// `assertNoInternals` is the test-visible statement of that, so an edit that pastes a contact block in fails loudly
// rather than shipping.
//
// PURE — no chrome.*, no network, no DOM.

const _s = (v) => (v == null ? '' : String(v).trim());

/**
 * The ask, per cause — phrased for the person who owns the home, not for a colleague.
 *
 * Both causes ask the SAME two questions, because both need the same two answers before anything can ship; they
 * differ only in the hint that makes answering easiest.
 */
export const CUSTOMER_ASKS = Object.freeze({
  'no-count': {
    subject: 'Your Deako replacement switches',
    opening: 'We’re getting replacement switches sent out to you under your Deako warranty.',
    ask: 'Which switches are giving you trouble, and how many need replacing?',
    help: 'Rooms are enough — for example, “kitchen and both upstairs bedrooms”.',
  },
  'named-product-unresolved': {
    subject: 'Your Deako replacement switches',
    opening: 'We’re getting replacement switches sent out to you under your Deako warranty.',
    ask: 'Which switches are giving you trouble, and how many need replacing?',
    help: 'If you can, a photo of one of them helps us send the exact match.',
  },
});

/** Only these causes may ever reach a customer. Mirrors Core/contactChannel.js CUSTOMER_ANSWERABLE. */
export const CUSTOMER_CAUSES = Object.freeze(Object.keys(CUSTOMER_ASKS));

// The greeting name is TITLE-CASED. The record supplies whatever casing it stores, and "Hi harminder," is exactly
// the small wrongness that tells a customer nobody read this before it went out.
const _firstName = (full) => {
  const n = _s(full).split(/\s+/)[0] || '';
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : '';
};

/**
 * The customer-facing email for one task. PURE.
 *
 * `instructions` is accepted and deliberately UNUSED: it is the builder's work order, not the customer's words
 * (see the header). It stays in the signature because callers pass one spec object to both artifacts and the
 * INTERNAL one does need it.
 *
 * Returns null when the cause is not one a customer can answer — a second, independent guard on top of
 * contactChannel's routing, so an `other-trade` row has no message to send even if something routes it wrongly.
 * @returns {{to:string, subject:string, body:string, cause:string}|null}
 */
export function buildCustomerEmail({ person = null, outcome = {}, instructions = '', signOff = 'Deako Warranty' } = {}) {
  void instructions;
  const cause = _s(outcome && outcome.cause);
  const spec = CUSTOMER_ASKS[cause];
  if (!spec) return null;
  const to = _s(person && person.email);
  if (!to) return null;                          // no address is not a draft — the channel decision handles that

  const name = _firstName(person && person.name);
  const lines = [
    name ? `Hi ${name},` : 'Hello,',
    '',
    spec.opening,
    '',
    spec.ask,
    '',
    spec.help,
    '',
    'Just reply to this email and we’ll get them on their way.',
    '',
    'Thanks,',
    signOff,
  ];
  return { to, subject: spec.subject, body: lines.join('\n'), cause };
}

/**
 * The leak guard, exported so it is TESTABLE rather than a comment.
 *
 * Returns the internal things found in a body about to go outside; empty means clean. Deliberately a check for
 * known-internal SHAPES rather than a wordlist: phone numbers, our task ids, the builder's name, and the section
 * headers the internal artifact uses.
 */
export function findInternals(body, { extraNames = [] } = {}) {
  const t = _s(body);
  const hits = [];
  if (/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\+\d{10,}/.test(t)) hits.push('phone number');
  if (/\bD\.?R\.?\s*Horton\b|\bDrHorton\b/i.test(t)) hits.push('builder name');
  if (/\b(CSR|COORDINATOR)\b/.test(t)) hits.push('builder staff role');
  if (/HOMEOWNERS?\s+—|ALSO ON THE TASK|WARRANTY TASK|RAISED BY|WHY THIS NEEDS A PERSON|WHAT WE NEED/.test(t)) hits.push('internal section header');
  if (/\bTicket:\s*#?\d+|\bTaskId\b|\bTask:\s*\d+/i.test(t)) hits.push('internal task id');
  for (const n of extraNames) { if (n && new RegExp(`\\b${_s(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) hits.push(`other contact (${n})`); }
  return hits;
}

/** Throwing form, for callers that want the guarantee at the send door. PURE apart from the throw. */
export function assertNoInternals(body, opts) {
  const hits = findInternals(body, opts);
  if (hits.length) throw new Error(`customer email carries internal detail: ${hits.join(', ')}`);
  return true;
}
