// Core/contextAnswer.js — v2.74.1872 — "WHICH DIVISION AM I IN RIGHT NOW", answered from the RESOLVER.
//
// THE SIX-PASS BUG THIS CLOSES. The ask routes perfectly (`vs_state`, conf 0.95), the read succeeds, and the
// user gets "you have access to 121 divisions across multiple regions…" — every division except theirs. I
// diagnosed it as a SHAPER gap five passes running, because the trace shows decisions and never payloads, so
// by elimination the residue landed on the one stage I couldn't see into. It was never a shaper problem:
// `access.DefaultDivision.Id` is read on virtually every VendorSuite turn already — by the PARAM RESOLVER, via
// the `defaultPath` on the same `resolve` spec that binds a blank {divisionId}. `RIDE_RESOLVE ▸ divisionId
// "(default)" → 32 (Raleigh)` is the answer, printed into the trace on turns where nobody asked for it.
//
// So: no LLM, no payload guessing, no new recipe field. This module finds the resolve specs that the recipe the
// user JUST READ is the state source for (`spec.via === recipe.endpoint` — the same link `_rideResolveVia`
// follows), and answers from `resolveRideParam(spec, '', state)`, the identical call the binder makes.
//
// GENERAL, not VendorSuite-shaped: any host whose catalog declares a `defaultPath` resolve spec gets "which X
// am I in" answered for free. The noun comes off the param name (`divisionId` → "division").
//
// DELIBERATELY ANCHORED. The ask patterns are `^…$` so a SCOPE use of the noun can never be mistaken for a
// question ABOUT it — "get open warranty tasks in my current division" contains the noun, "my", and "current",
// and must stay an act. A miss here is a no-op that leaves today's behaviour exactly as it was, so the cost of
// being tight is a phrasing that doesn't trigger; the cost of being loose is stealing a read. (Against the
// standing "an unnameable capability is worse than an unbuilt one" rule: the shapes below cover the wh-question,
// the possessive, and the bare noun-phrase — the live phrasing is the first one.)

const _norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/[\u2019]/g, "'").replace(/\s+/g, ' ');

/** `divisionId` → "division"; `accountId` → "account"; `work_order_id` → "work order". PURE. */
export function nounForParam(param) {
  const raw = String(param || '').replace(/[_-]+/g, ' ').replace(/\bid\b/gi, '').replace(/Id$/, '');
  const spaced = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().toLowerCase();
  return spaced || String(param || '').toLowerCase();
}

/**
 * The resolve specs for which THIS recipe is the state source — i.e. the payload just read is the object
 * `defaultPath` indexes into. Deduped by param name (one catalog spec is shared by every consumer leg, so the
 * same {param, spec} pair is reached many times over). PURE.
 * Returns [{ param, noun, spec }].
 */
export function contextSpecsFor(endpoint, catalog) {
  const ep = String(endpoint || '').trim();
  if (!ep || !Array.isArray(catalog)) return [];
  const out = [];
  const seen = new Set();
  for (const r of catalog) {
    const specs = (r && r.resolve && typeof r.resolve === 'object') ? r.resolve : null;
    if (!specs) continue;
    for (const [param, spec] of Object.entries(specs)) {
      if (!spec || typeof spec !== 'object') continue;
      if (String(spec.via || '') !== ep) continue;      // this read IS that spec's via-read
      if (!spec.defaultPath) continue;                  // no declared "current context" → nothing to answer
      if (seen.has(param)) continue;
      seen.add(param);
      out.push({ param, noun: nounForParam(param), spec });
    }
  }
  return out;
}

// The three shapes, built per-noun. Anchored end to end; `n` is escaped by construction (it comes off a param
// name, but escaping keeps a future param with a regex char from silently breaking the match).
function _askShapes(noun) {
  const n = String(noun).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return [
    // "which division am I in right now" · "what division are we in" · "what's my current division"
    new RegExp(`^(?:so\\s+)?(?:which|what)(?:'s|\\s+is)?\\s+(?:the\\s+|my\\s+|our\\s+)?(?:current\\s+)?${n}\\s*(?:(?:am\\s+i|are\\s+we)\\s*(?:in|on|under|using)?)?\\s*(?:right\\s+now|currently|now|at\\s+the\\s+moment)?\\s*[?.!]*$`, 'i'),
    // "show me my current division" · "tell me our current division"
    new RegExp(`^(?:show|tell|give)\\s+(?:me|us)\\s+(?:my|our|the)\\s+current\\s+${n}\\s*[?.!]*$`, 'i'),
    // "my current division" · "current division?"
    new RegExp(`^(?:my|our|the\\s+)?\\s*current\\s+${n}\\s*[?.!]*$`, 'i'),
  ];
}

/** Which declared context noun (if any) is this ask ASKING FOR? Returns the matching entry or null. PURE. */
export function contextAskFor(ask, specs) {
  const q = _norm(ask);
  if (!q || !Array.isArray(specs)) return null;
  for (const entry of specs) {
    if (!entry || !entry.noun) continue;
    if (_askShapes(entry.noun).some((re) => re.test(q))) return entry;
  }
  return null;
}

/**
 * The sentence. `resolved` is `resolveRideParam(spec, '', state)` output; `total` the accessible-row count;
 * `conversation` the label the CONVERSATION has been scoped to (chat.js `_divisionCtx`), stated only when it
 * DIFFERS — in the live 202123 trace the site was Raleigh while the thread had stuck on Charlotte North, and
 * answering either one alone would have been half-true. PURE. Markdown.
 */
export function contextAnswerLine({ noun, resolved, total, conversation } = {}) {
  if (!resolved || resolved.value === undefined || resolved.value === null) return null;
  const label = String(resolved.label ?? resolved.value);
  const idPart = (String(resolved.value) !== label) ? ` (${noun} ${resolved.value})` : '';
  const totalPart = Number.isFinite(total) && total > 1 ? ` — 1 of ${total} you can access.` : '.';
  let line = `You're in **${label}**${idPart}${totalPart}`;
  const conv = conversation == null ? '' : String(conversation).trim();
  if (conv && _norm(conv) !== _norm(label)) {
    line += `\n\nThis conversation has been reading **${conv}**, not your current ${noun} — name a ${noun} in your ask, or say “${label}”, to move it.`;
  }
  return line;
}
