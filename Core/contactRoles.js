// Core/contactRoles.js — v2.74.2112. THE ONE contact reader, and the "who is the CSR on this?" ask.
//
// WHY THIS FILE EXISTS. A warranty task's contact list mixes the customer with the builder's own staff, and every
// path that reads it has to make the same distinction or it phones the wrong person. Before this file there were
// two readers drifting apart:
//   · warrantyContact.js grew its own (for the support-request body),
//   · peritemMap.js `_isPrimary`/'other' had another (for the Shopify customer lookup ladder),
// and BOTH were role-string guesses over invented field names. The `also`-drilled payload settles it with flags, so
// the reader belongs in one place that everyone imports. Adding a third reader is the bug, not the feature.
//
// THE PAYLOAD (HAR-verified 2026-08-08, GET /api/Vendor/Warranty/TaskContacts/{taskId}, two sampled tasks, same
// four-row shape both times — Core/connectorRecipes.js:915 `vs_task_contacts`):
//
//   Email · HomePhone · WorkPhone · CellPhone · ContactMethod · IsPrimary · IsDrHorton · IsBuyer ·
//   AssignmentType · Id · FirstName · LastName · FullName
//
//   IsDrHorton:true + AssignmentType "CSR" / "COORDINATOR"  → the BUILDER's staff — never the customer
//   IsBuyer:true + IsPrimary:true                           → the primary homeowner
//   IsDrHorton:false with no AssignmentType                 → the co-buyer (secondary homeowner)
//
// The last line is an inference and a deliberate one: the serializer OMITS false booleans, so the co-buyer arrives
// carrying no `IsBuyer` and no `IsPrimary` at all. Reading "no flags" as "not a homeowner" would drop the second
// person; reading it as builder staff would be worse. Absence of a DRH marker is read as homeowner-side — the safe
// direction, since a homeowner mislabelled secondary still gets called, while a dropped one does not.
//
// PURE — no chrome.*, no network, no DOM.

const _s = (v) => (v == null ? '' : String(v).trim());

/** The roles a user can name. Closed set — an ask outside it returns null and this module stays out of the way. */
export const CONTACT_ROLES = Object.freeze(['primary', 'secondary', 'homeowner', 'csr', 'coordinator', 'staff']);

// The contacts sidecar key. The map enrich pass keeps the FULL list here (chat.js:6588) and conversationFocus
// preserves it through storage (CT-1, v2.74.1990) — the flat columns hold only contact[0], which is why reading
// the row's own fields returns whichever person happens to sit first regardless of side.
const _CONTACTS_KEY = '__contacts';

/**
 * EVERY contact on a record, classified by the record's OWN flags. PURE.
 * @returns {Array<{name,email,phone,phoneLabel,phones,prefers,role,roleStated,isPrimary,isHomeowner,isStaff}>}
 */
export function readContacts(row) {
  const r = (row && typeof row === 'object') ? row : {};
  const raw = [r[_CONTACTS_KEY], r.contacts].find((x) => Array.isArray(x) && x.length) || [];
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
    const isHomeowner = !isStaff;
    const role = assignment
      ? (isDrh ? `${assignment} (D.R. Horton)` : assignment)
      : (isPrimary ? 'Primary homeowner' : 'Secondary homeowner');

    // Every number, each keeping its LABEL — a work line and a cell are not interchangeable, and "call the
    // homeowner" against a work number is a different act from calling their cell.
    const phones = [['cell', g(/^cellphone$|mobile/i)], ['home', g(/^homephone$/i)], ['work', g(/^workphone$/i)]]
      .filter(([, v]) => v).map(([label, number]) => ({ label, number }));
    if (!phones.length) { const any = g(/phone/i); if (any) phones.push({ label: '', number: any }); }
    const prefersRaw = g(/^contactmethod$/i);                // "Any" · "-1" (the unset sentinel) · a named method
    const first = g(/first/i); const last = g(/last/i); const full = g(/^fullname$|^name$|displayname/i);

    const person = {
      name: _s(full || [first, last].filter(Boolean).join(' ')),
      email: g(/email/i),
      phone: phones.length ? phones[0].number : '',
      phoneLabel: phones.length ? phones[0].label : '',
      phones,
      prefers: /^-?1$/.test(prefersRaw) ? '' : prefersRaw,   // "-1" means no preference recorded, not a method
      role, roleStated: !!assignment, isPrimary, isHomeowner, isStaff,
    };
    if (person.name || person.email || person.phone) out.push(person);
  }
  // Homeowners first (primary ahead of co-buyer), staff after — every caller reads top-down.
  const rank = (p) => (p.isHomeowner ? (p.isPrimary ? 0 : 1) : 2);
  return out.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map((x) => x.p);
}

/** The people matching one role name. PURE. Unknown role → []. */
export function selectContacts(people, role) {
  const all = Array.isArray(people) ? people : [];
  switch (_s(role).toLowerCase()) {
    case 'primary':     return all.filter((p) => p.isHomeowner && p.isPrimary);
    case 'secondary':   return all.filter((p) => p.isHomeowner && !p.isPrimary);
    case 'homeowner':   return all.filter((p) => p.isHomeowner);
    case 'csr':         return all.filter((p) => p.isStaff && /csr|customer\s*service/i.test(p.role));
    case 'coordinator': return all.filter((p) => p.isStaff && /coordinat/i.test(p.role));
    case 'staff':       return all.filter((p) => p.isStaff);
    default:            return [];
  }
}

// Role vocabulary, longest/most-specific first — "primary homeowner" must not be eaten by the bare "homeowner"
// pattern, and "customer service representative" must reach `csr` rather than falling through to a homeowner read.
const _ROLE_PATTERNS = [
  // Plurals matter: "who are the CSRs" is the natural distributive phrasing, and `\bcsr\b` does not match "CSRs"
  // — so without the optional s the role failed to parse at all and the whole ask fell through.
  [/\b(csrs?|customer\s*service(\s*reps?(resentatives?)?)?)\b/i, 'csr'],
  [/\bcoordinators?\b/i, 'coordinator'],
  [/\b(primary|main|first)\s+(home\s*owner|homeowner|buyer|contact|customer)\b/i, 'primary'],
  [/\b(secondary|second|co|other)[-\s]*(home\s*owner|homeowner|buyer|contact|customer)\b/i, 'secondary'],
  [/\bco[-\s]?buyer\b/i, 'secondary'],
  [/\b(home\s*owner|homeowner|buyer)s?\b/i, 'homeowner'],
  [/\bprimary\b/i, 'primary'],
  [/\bsecondary\b/i, 'secondary'],
];

// What the user wants BACK. A bare "who is…" wants the person; naming a channel wants that channel.
const _WANTS = [[/\b(phone|number|call|cell|mobile)\b/i, 'phone'], [/\b(e-?mail|address to email)\b/i, 'email']];

/**
 * Does this ask name a CONTACT ROLE on a record? PURE. Returns null on anything unclear — null means "stay out of
 * the way", the same discipline as fieldRead's askWhoRole (v2.74.1923).
 *
 * The guard against over-claiming: the ask must both NAME a role and READ like a question about a person. "process
 * the primary tasks" names a role word and is not a contact ask; "who is the CSR" is. Requiring an interrogative or
 * an explicit channel word keeps this off the generic branch/route paths.
 * @returns {{role:string, want:'name'|'phone'|'email', each:boolean, ticket:string}|null}
 */
export function askContactRole(ask) {
  const a = _s(ask);
  if (!a) return null;
  const role = (_ROLE_PATTERNS.find(([re]) => re.test(a)) || [])[1] || null;
  if (!role) return null;

  const asksWho = /\bwho(\s*'?s|\s+is|\s+are)?\b|\bwhat(\s*'?s|\s+is)\s+the\b|\bcontact\s+(info|details)\b|\bget\s+(me\s+)?the\b/i.test(a);
  const want = (_WANTS.find(([re]) => re.test(a)) || [])[1] || 'name';
  if (!asksWho && want === 'name') return null;             // a bare role word is not a question

  // DISTRIBUTIVE: "who is the CSR FOR EACH?" after a list read is a map over the rows, not a question about one
  // record. Live 2026-08-08: that exact ask fell through to the field-read path, which replied "I couldn't find a
  // CSR field on these records" — true of the flat columns and useless, because the CSR lives in the contacts
  // sidecar, one drill per row.
  const each = /\b(each|every|all|both|any of (them|these)|the (rest|others))\b/i.test(a)
    || /\b(csrs|coordinators|homeowners|buyers)\b/i.test(a);

  // A record the ask NAMES — "#4903279" or "on 4903279". This is a TICKET number as a person types it, never the
  // internal TaskId (Core/connectorRecipes.js:915: feeding a typed number to TaskContacts/{taskId} is a bare 500),
  // so the caller must resolve it through the task LIST before drilling. Reported, never dereferenced here.
  const m = a.match(/#\s*(\d{5,})|\b(?:on|for|of)\s+#?\s*(\d{5,})\b/);
  return { role, want, each, ticket: _s(m && (m[1] || m[2])) };
}

const _fmtPhone = (p) => (p.phone ? `${p.phone}${p.phoneLabel ? ` (${p.phoneLabel})` : ''}` : '');

// How each role is SAID back. The internal keys are terse for matching; "The csr on #4903279 is…" is not English,
// and "the primary" alone drops the noun that makes it meaningful.
const _ROLE_SAID = Object.freeze({
  csr: 'CSR', coordinator: 'coordinator', primary: 'primary homeowner',
  secondary: 'secondary homeowner', homeowner: 'homeowner', staff: 'D.R. Horton staff',
});
const _said = (role) => _ROLE_SAID[_s(role).toLowerCase()] || _s(role);

/** How a role is SAID back to the user ("csr" -> "CSR"). Exported so callers outside the answer path — the
 *  not-in-focus refusal, log lines — never print the terse matching key at a person. PURE. */
export function roleSaid(role) { return _said(role); }

/**
 * The answer text for a resolved contact-role ask. PURE.
 *
 * Honesty rules, each earned: name the role the RECORD states (never the role the user asked for — asking for "the
 * CSR" and getting a coordinator must read as a coordinator); say plainly when nobody holds the role rather than
 * offering the nearest person; and when the record has no contacts at all, say THAT rather than "not found", which
 * reads as "this person does not exist" when it means "we never loaded them".
 */
export function renderContactAnswer({ people = [], role = '', want = 'name', recordLabel = '' } = {}) {
  const on = recordLabel ? ` on ${recordLabel}` : '';
  const all = Array.isArray(people) ? people : [];
  if (!all.length) return `I don't have the contacts${on} loaded, so I can't say who the ${_said(role)} is.`;

  const hits = selectContacts(all, role);
  if (!hits.length) {
    const listed = all.map((p) => `${p.name || '(no name)'} — ${p.role}`).join(' · ');
    return `No ${_said(role)} is listed${on}. The contacts on it are: ${listed}.`;
  }

  const line = (p) => {
    const bits = [];
    if (want === 'phone' || want === 'name') { const ph = _fmtPhone(p); if (ph) bits.push(ph); }
    if (want === 'email' || want === 'name') { if (p.email) bits.push(p.email); }
    if (!bits.length) bits.push(want === 'phone' ? 'no phone on the record' : want === 'email' ? 'no email on the record' : 'no contact details on the record');
    return `${p.name || '(no name)'} — ${p.role} — ${bits.join(' · ')}`;
  };
  if (hits.length === 1) return `The ${_said(role)}${on} is ${line(hits[0])}.`;
  // Markdown list items — the caller renders through renderMarkdown (escape-first, so these page-derived names are
  // escaped before parsing). Indented plain lines would collapse into one paragraph, or at 4 spaces a code block.
  return `${hits.length} people hold that role${on}:\n${hits.map((p) => `- ${line(p)}`).join('\n')}`;
}

/** One-shot: read a record and answer a role ask against it. PURE. Returns null when the ask isn't one. */
export function answerContactRole(row, ask, { recordLabel = '' } = {}) {
  const parsed = askContactRole(ask);
  if (!parsed) return null;
  return {
    ...parsed,
    text: renderContactAnswer({ people: readContacts(row), role: parsed.role, want: parsed.want, recordLabel }),
  };
}

/**
 * The answer for a DISTRIBUTIVE role ask — one line per record. PURE.
 *
 * Every row is named even when it has nobody in the role, because "3 tasks, here are the 2 I could answer" is the
 * honest shape and a silently shortened list reads as a complete one. `items` = [{label, people}].
 */
export function renderContactRoster({ items = [], role = '', want = 'name' } = {}) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return `I don't have any records in hand to read the ${_said(role)} from.`;
  const said = _said(role);
  const out = [];
  let answered = 0;
  for (const it of rows) {
    const people = Array.isArray(it && it.people) ? it.people : [];
    const hits = selectContacts(people, role);
    if (hits.length) answered++;
    const who = hits.length
      ? hits.map((p) => {
        const bits = [];
        if (want === 'phone' || want === 'name') { const ph = _fmtPhone(p); if (ph) bits.push(ph); }
        if (want === 'email' || want === 'name') { if (p.email) bits.push(p.email); }
        // Always state the role verbatim: the ask says "CSR", the record may say "CSR (D.R. Horton)", and the
        // difference is the whole point — the reader must see whose staff this person is.
        return `${p.name || '(no name)'} — ${p.role}${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
      }).join(' · ')
      : (people.length ? `no ${said} listed (${people.length} contact(s) on it)` : 'no contacts on the record');
    out.push(`- **${_s(it && it.label) || '(unlabelled)'}** — ${who}`);
  }
  const head = answered === rows.length
    ? `The ${said} on each:`
    : `${answered} of ${rows.length} have a ${said} listed:`;
  return [head, ...out].join('\n');
}
