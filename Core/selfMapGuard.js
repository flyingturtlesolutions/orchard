// Core/selfMapGuard.js — SM-1 (v2.74.1974). The two tests behind the map executor's self-map diversion.
//
// A `map` clause is a PER-ITEM CROSS-SYSTEM lookup. When the router names a target system that turns out to be the
// system the rows already came from, the executor has to decide what the model actually meant — and there are two
// very different answers hiding under one shape:
//
//   INVENTION  the named system cannot serve the ask at all, so resolution wandered to the nearest leg it could
//              find on some OTHER system. Live 101132: the verdict named "vendorsuite", no vendorsuite "customer
//              by phone" leg exists, resolution landed on `shopify_customer_by_phone`, and the run searched
//              Shopify with a TaskId — then reported the tally as a "vendorsuite lookup". Wrong but plausible,
//              which is the worst class: nothing errors and the number looks like an answer.
//
//   FIELD READ the ask names a FIELD of the row the caller already holds ("for each open task, get the homeowner's
//              phone"). No second record is involved; this belongs on the per-item field-read path.
//
// and one that is neither:
//
//   ENTITY READ the ask names a RELATED RECORD on the same system ("get their last order"). This is an ordinary
//              per-row map and must be left alone.
//
// These lived in chat.js as `_declaresSourceSystem` / an inline host compare, where the harness could not reach
// them. They are pure and they decide whether a user gets an order or a count, so they are tested here.

// Does the DECLARED system name disagree with what the ask actually RESOLVED TO?
//
// v1648 compared the declared name to the SOURCE leg, which answered a different question: that is true for the
// 101132 invention AND for a legitimate same-system read ("shopify" declared, a shopify leg resolved), so it could
// not separate them — and it was the legitimate case that broke live, sending "get their last order" to a field
// read that matched `numberOfOrders`, a COUNT. v1648's own comment names the right pair: "the invention lives in
// the NAME, and resolution then wanders off it." So compare the name to the resolution.
export function declaredMismatchesResolved(declared, target) {
  const d = String(declared || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!d) return false;                       // nothing declared → this test has no opinion
  const th = (target && target.leg && target.leg.tool) || {};
  const host = String(th.appHost || th.origin || '').toLowerCase().replace(/^https?:\/\//, '');
  if (!host) return true;                     // a system was NAMED and nothing resolved — 101132's absence case
  const labels = host.split('.').filter((x) => x && !/^(com|net|org|io|co|www)$/.test(x));
  const agrees = labels.some((l) => l === d || (l.length > 3 && d.length > 3 && (l.includes(d) || d.includes(l))));
  return !agrees;
}

// Did the readAsk resolve to a DIFFERENT leg than the rows came from? If so it names a related RECORD, not a field
// of the row in hand — no new classifier needed, because `target` is already the readAsk resolved. Identity is
// checked at three widths because a leg is re-projected per invocation, so object identity alone is not enough and
// two projections of one recipe must not read as two different records.
export function isEntityRead(target, srcLeg) {
  const t = (target && target.leg) || null;
  if (!t) return false;                       // resolved to nothing → a field read (or the absence case above)
  if (!srcLeg) return true;                   // nothing to be the same AS → it resolved to a record of its own
  if (t === srcLeg) return false;
  const tk = t.key, sk = srcLeg.key;
  if (tk && sk && tk === sk) return false;
  const tr = t.tool && t.tool.recipeId, sr = srcLeg.tool && srcLeg.tool.recipeId;
  if (tr && sr && tr === sr) return false;
  return true;
}
