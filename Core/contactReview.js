// Core/contactReview.js — v2.74.2124. The REVIEW CARD for one warranty contact decision.
//
// User direction: "approves means send the customer the email - as drafted. Calls will just list the contact
// information and internal just the ticket instructions and parser justification. Actually all will have the
// instructions and parser justification, and home owner's contact information. The email will have a draft and
// approve to send etc. what's the best version of this?"
//
// The design, and why each part is the way it is:
//
// 1. ONE CARD, THREE TAILS — not three card types. The common core (what the task says · what I read · who the
//    homeowner is) is IDENTICAL in all three, so a reviewer builds one reading habit and the channel-specific part
//    is the only thing they have to think about. Three layouts would make the differences look bigger than they
//    are, when the actual decision is one line.
//
// 2. THE JUSTIFICATION NAMES ITS RULE AND QUOTES ITS EVIDENCE. Not "4 switches (high confidence)" but
//    `count 4 — EXPLICIT, from "4 light switches sticking"`. The extraction already derives a named route
//    (EXPLICIT / RANGE_UPPER / SUM_OF_PLACES / SINGLE_FAULT), so a wrong number is traceable to a named rule
//    rather than to a model's adjective — the v2107 lesson, carried into the human-facing surface.
//
// 3. EVERY CHANNEL GETS AN OUTCOME CONTROL. In the MVP a call is ACKNOWLEDGED by the person who made it.
//    The user's eventual design is better and is deliberately deferred: every outbound call mints a Zendesk ticket
//    with the phone number as requester, and the transcript becomes its body — so Orchard can find the call by
//    searching for that requester and read the count out of the transcript with the parser it already has, with no
//    button at all. That removes the chore AND makes the outcome evidence rather than self-report. It needs one
//    capture first (what a phone-requester user looks like, and whether the transcript is the description or the
//    first comment), so the ack ships now and the detector replaces it later. When it does, this control is
//    deleted, not kept alongside — two ways to close a call is two sources of truth.
//
// 4. OVERRIDE IS FIRST-CLASS ON ALL THREE. The channel was decided by an allow-list that is deliberately
//    conservative (Core/contactChannel.js), so it WILL be wrong toward caution — an unrecognised ContactMethod
//    routes to a call even when email was fine. The override is how that gets corrected, and recording it is the
//    only way to learn whether the list is too tight.
//
// 5. APPROVAL IS PER ITEM AND THE BUTTON NAMES THE RECIPIENT. "Approve" is a word about a list; "Send to
//    dana@example.com" is a sentence about a person. Bulk send stays a separate, explicit act that lists its
//    recipients — a bad parse becomes N bad emails to real customers exactly at that seam.
//
// PURE — returns a structured card (text + controls); the renderer draws it. No chrome.*, no network, no DOM.

const _s = (v) => (v == null ? '' : String(v).trim());
const _q = (v, n = 240) => { const t = _s(v).replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const _ROUTE_SAID = Object.freeze({
  EXPLICIT: 'a number written in the note',
  RANGE_UPPER: 'a range — upper bound taken',
  SUM_OF_PLACES: 'one per place named',
  SINGLE_FAULT: 'one fault described',
  NONE: 'no count anywhere in the note',
});

/** WHY the parser decided what it did — the rule NAME plus the words it read. PURE. */
export function justificationLines(outcome = {}) {
  const o = (outcome && typeof outcome === 'object') ? outcome : {};
  const f = (o.fields && typeof o.fields === 'object') ? o.fields : {};
  const out = [];
  if (o.arm === 'replacement needed' && o.count != null) {
    out.push(`Read as ${o.count} × ${o.product || 'the standard switch'}`);
  }
  const route = _s(f.count_route).toUpperCase();
  if (route) out.push(`count — ${_ROUTE_SAID[route] || route.toLowerCase().replace(/_/g, ' ')}`);
  if (f.product === 'NAMED_OTHER' && f.product_name) out.push(`product — the note names "${_q(f.product_name, 60)}"`);
  else if (f.product === 'OTHER_TRADE') out.push('product — not a Deako switch');
  else if (f.product === 'SIMPLE_ROCKER') out.push('product — no type named, so the standard rocker');
  if (f.already_handled) out.push(`already handled — "${_q(f.already_handled, 80)}"`);
  if (o.cause) out.push(`needs a person — ${o.cause}`);
  if (f.note) out.push(`note — ${_q(f.note, 120)}`);
  return out;
}

/** Everyone on the task worth showing, homeowners first, each with the record's own title. PURE. */
export function contactLines(people = []) {
  const all = Array.isArray(people) ? people : [];
  return all.filter((p) => p && p.isHomeowner).map((p) => {
    const bits = [];
    for (const ph of (Array.isArray(p.phones) ? p.phones : [])) bits.push(`${ph.number}${ph.label ? ` (${ph.label})` : ''}`);
    if (p.email) bits.push(p.email);
    if (p.prefers) bits.push(`prefers: ${p.prefers}`);
    return { name: p.name || '(name not stated)', role: p.role || '', detail: bits.join(' · ') };
  });
}

/**
/**
 * v2.74.2149 (DESIGN_audit.md §12.8.2) — `reference`: a FOURTH kind, and the distinction is load-bearing.
 *
 * `primary` / `secondary` / `override` all DECIDE or MUTATE. Showing the task decides nothing: it can be taken
 * freely, any number of times, at any point in the review, and it leaves the case exactly as it was. That is a
 * real safety property for a reviewer whose pointer is two positions from a `danger` control, so it is ENCODED
 * rather than left to styling — a renderer may never give a `reference` control the danger treatment, and a
 * mis-click costs nothing.
 *
 * On EVERY channel, not just `email`. The motivating case is AMBIGUOUS warranty instructions, which resolves to
 * the `unresolved` channel — the row where reading the source task matters most.
 *
 * Ordered LAST so the channel's primary stays the dominant control: the decision is the point of the card, the
 * reference is support. The drive itself is the renderer's job (this module is pure); it routes to the existing
 * `drill.matchOn` walk, which means Invariant #2 busy-marking is REQUIRED at that seam.
 */
const SHOW_TASK = Object.freeze({ id: 'show-task', kind: 'reference', label: 'Show task' });

/**
 * The controls for one card. PURE.
 *
 * The primary control is the ACT; the others are the override. Every channel has exactly one primary, so a
 * reviewer never has to work out which button is "the" button.
 */
export function controlsFor(channel, { email = '', phone = '' } = {}) {
  const c = _s(channel);
  if (c === 'email') {
    return [
      { id: 'send', kind: 'primary', label: email ? `Send to ${email}` : 'Send', danger: true },
      { id: 'edit', kind: 'secondary', label: 'Edit the draft' },
      { id: 'to-call', kind: 'override', label: 'Call instead' },
      { id: 'to-unresolved', kind: 'override', label: 'Leave unresolved' },
      SHOW_TASK,
    ];
  }
  if (c === 'call') {
    // MVP: the person who called says so, and says what they learned. Superseded later by call-ticket detection.
    return [
      { id: 'called', kind: 'primary', label: phone ? `Mark called — ${phone}` : 'Mark called' },
      { id: 'to-email', kind: 'override', label: 'Email instead' },
      { id: 'to-unresolved', kind: 'override', label: 'Leave unresolved' },
      SHOW_TASK,
    ];
  }
  return [
    { id: 'close', kind: 'primary', label: 'Close — nothing owed to the homeowner' },
    { id: 'to-email', kind: 'override', label: 'Email them anyway' },
    { id: 'to-call', kind: 'override', label: 'Call them anyway' },
    SHOW_TASK,
  ];
}

/**
 * The whole card for one item. PURE.
 * @param {{label, instructions, outcome, people, decision, draft}} spec
 * @returns {{label, channel, why, sections:Array<{title,lines}>, draft:object|null, controls:Array}}
 */
export function buildReviewCard({ label = '', instructions = '', outcome = {}, people = [], decision = {}, draft = null } = {}) {
  const channel = _s(decision.channel) || 'unresolved';
  const owners = contactLines(people);
  const primary = (Array.isArray(people) ? people : []).find((p) => p && p.isHomeowner && p.isPrimary)
    || (Array.isArray(people) ? people : []).find((p) => p && p.isHomeowner) || null;

  const sections = [
    // The evidence FIRST and verbatim: every downstream claim is a reading of these words, so they outrank ours.
    { title: 'WHAT THE TASK SAYS', lines: [instructions ? `"${_q(instructions, 400)}"` : '(no instructions on the task)'] },
    { title: 'WHAT I READ', lines: justificationLines(outcome).length ? justificationLines(outcome) : ['(nothing derived)'] },
    {
      title: owners.length > 1 ? 'HOMEOWNERS' : 'HOMEOWNER',
      lines: owners.length
        ? owners.map((o) => `${o.name} — ${o.role}${o.detail ? `\n    ${o.detail}` : ''}`)
        : ['(no homeowner on the record — look them up in VendorSuite)'],
    },
  ];

  // The channel line always states its REASON, because that is what a reviewer is being asked to agree with.
  sections.push({ title: 'DECISION', lines: [`${channel.toUpperCase()} — ${_s(decision.why) || 'no reason recorded'}`] });

  return {
    label: _s(label),
    channel,
    why: _s(decision.why),
    sections,
    draft: channel === 'email' ? (draft || null) : null,
    controls: controlsFor(channel, { email: (primary && primary.email) || '', phone: (primary && primary.phone) || '' }),
  };
}

/** Render a card to markdown, for the panel. PURE. */
export function renderReviewCard(card) {
  const c = (card && typeof card === 'object') ? card : null;
  if (!c) return '';
  const out = [`**${c.label || 'this task'}**`, ''];
  for (const s of c.sections) {
    out.push(`**${s.title}**`);
    for (const l of s.lines) out.push(`  ${l}`);
    out.push('');
  }
  if (c.draft) {
    out.push(`**DRAFT EMAIL** → ${c.draft.to || '(no address)'}`);
    if (c.draft.subject) out.push(`  Subject: ${c.draft.subject}`);
    out.push('', '```', _s(c.draft.body), '```', '');
  }
  out.push(c.controls.map((b) => `[ ${b.label} ]`).join('  '));
  return out.join('\n');
}
