// Core/customerEmail.js — v2.74.2129. The message the HOMEOWNER actually receives.
//
// WHY THIS EXISTS, and why it could not be skipped. The review card rendered the internal support-request body
// under "DRAFT EMAIL → dana@example.com". Approving that would have sent a customer a message opening
// "Please confirm the quantity on a Deako warranty task before we can ship anything", followed by a HOMEOWNERS
// block listing their own phone numbers AND the builder's CSR and coordinator. Two different failures in one
// message: the wrong voice, and an internal-contact leak to an outside party.
//
// So the two artifacts are separate by construction, not by a flag:
//   Core/warrantyContact.js  -> a request to a COLLEAGUE. Carries everything a person needs to act: both
//                               homeowners, the builder's staff, task ids, our reasoning.
//   this file                -> a message to the CUSTOMER. Carries their own words back, one question, and
//                               nothing else. No task id, no staff, no other contact, no internal reasoning.
//
// THE RULE THIS FILE ENFORCES: a customer-facing body may contain only (a) their own name, (b) their own words
// quoted from the task, (c) one question, (d) our sign-off. Anything else is an internal detail that has no
// business leaving. `assertNoInternals` is the test-visible statement of that, so a future edit that pastes a
// contact block in fails loudly rather than shipping.
//
// PURE — no chrome.*, no network, no DOM.

const _s = (v) => (v == null ? '' : String(v).trim());
const _clip = (v, n) => { const t = _s(v).replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The one question, per cause — phrased for the person who owns the home, not for a colleague. */
export const CUSTOMER_ASKS = Object.freeze({
  'no-count': {
    subject: 'About your Deako switch request',
    ask: 'How many switches need replacing?',
    why: 'so we send the right number',
  },
  'named-product-unresolved': {
    subject: 'A quick question about your Deako switches',
    ask: 'Could you tell us which switch it is — or send a photo of it?',
    why: 'so we send the right one',
  },
});

/** Only these causes may ever reach a customer. Mirrors Core/contactChannel.js CUSTOMER_ANSWERABLE. */
export const CUSTOMER_CAUSES = Object.freeze(Object.keys(CUSTOMER_ASKS));

const _firstName = (full) => _s(full).split(/\s+/)[0] || '';

/**
 * The customer-facing email for one task. PURE.
 *
 * Returns null when the cause is not one a customer can answer — which is a second, independent guard on top of
 * contactChannel's routing: if this is ever called for `other-trade`, no message exists to send.
 * @returns {{to:string, subject:string, body:string, cause:string}|null}
 */
export function buildCustomerEmail({ person = null, outcome = {}, instructions = '', signOff = 'Deako Warranty' } = {}) {
  const cause = _s(outcome && outcome.cause);
  const spec = CUSTOMER_ASKS[cause];
  if (!spec) return null;
  const to = _s(person && person.email);
  if (!to) return null;                          // no address is not a draft — the channel decision handles that

  const name = _firstName(person && person.name);
  const note = _clip(instructions, 300);

  const lines = [];
  lines.push(name ? `Hi ${name},` : 'Hello,');
  lines.push('');
  // Their OWN words back, so they recognise their request instead of reading a form letter about "a warranty
  // task". Quoted rather than paraphrased: paraphrasing a customer's complaint back at them reads as correction.
  lines.push(note
    ? `We picked up a warranty request for your home about your Deako switches. It says:\n\n  "${note}"`
    : 'We picked up a warranty request for your home about your Deako switches.');
  lines.push('');
  lines.push(`${spec.ask} — ${spec.why}.`);
  lines.push('');
  lines.push('Just reply to this email and we\'ll get it on its way.');
  lines.push('');
  lines.push('Thanks,');
  lines.push(signOff);

  return { to, subject: spec.subject, body: lines.join('\n'), cause };
}

/**
 * The leak guard, exported so it is TESTABLE rather than a comment.
 *
 * Returns the list of internal things found in a body that is about to go outside. Empty means clean. This is
 * deliberately a positive check for known-internal SHAPES rather than a wordlist: phone numbers, our own task
 * ids, the builder's name, and the section headers the internal artifact uses.
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
