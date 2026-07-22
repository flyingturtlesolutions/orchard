/**
 * Core/branchClassify.js — PP-5 (v2.74.1662): model classification for FREE-TEXT branch arms, pure half.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §1.1b (predicate kind follows FIELD kind) · §6 PP-5 · §5 (LLM egress) ·
 * §10.2 (classify ALL items before acting on ANY). Redaction: docs/DESIGN_llm_privacy.md §5.
 *
 * ── WHY THIS IS THE PRIMARY MECHANISM, NOT A FALLBACK ────────────────────────────────────────────────────────
 * For a human-authored free-text field, literal matching does not fail loudly — it fails SILENTLY and
 * confidently. The decisive case is negation, not synonyms:
 *
 *     Instructions: "Homeowner asked about replacements — do NOT send one, we're repairing under warranty."
 *
 * `contains "replacement"` → TRUE → the item routes to the replacements arm and a draft order is created. Not
 * uncertain, not a near-miss: confidently wrong, and no amount of added keywords fixes it. `not_contains` and
 * `negate` (which the deterministic vocabulary does have) only move the goalposts — "declined", "already sent",
 * "under repair instead" all break the same way.
 *
 * So the rule is: enumerated/structured field → deterministic predicate; human-authored free text → this.
 *
 * ── THE FOUR REQUIREMENTS PP-5 PUTS ON THIS FILE ─────────────────────────────────────────────────────────────
 * 1. ONE BATCHED CALL PER RUN, never per item. That is the property that makes cost a non-argument — the
 *    original "deterministic is cheaper" case rested on N items = N calls, which was simply wrong.
 * 2. `unknown` IS A FIRST-CLASS ANSWER. A classifier forced to pick an arm is no better than a keyword. A
 *    negated or context-dependent instruction is exactly what should land in `unknown` for a human to read.
 * 3. THE VERDICT IS BANKED with its reason, so an item does not flip arms between runs, a wrong call is visible
 *    and correctable per item, and a re-run only classifies what is new or changed.
 * 4. IDENTITY IS REDACTED BEFORE THE TEXT LEAVES. See below — this is the part a regex cannot do alone.
 *
 * ── REDACTION: SEEDED FROM THE RECORD, NOT GUESSED ───────────────────────────────────────────────────────────
 * §5 requires ADDRESSES redacted from instruction text, and no regex reliably detects a street address. But we
 * are not guessing: the address is a FIELD ON THE ROW (it has been the map's join key since v1633). So the
 * redaction set is seeded from the item's OWN identity-bearing field values — we redact the address because the
 * record told us what it is, not because a pattern matched. Emails/phones/ids are still caught by pattern on top.
 *
 * Note what has always been true and must stay true: row values used as LOOKUP KEYS ride into a search parameter,
 * never into a prompt. The join key has therefore never reached a model, and this file must not be the thing
 * that changes that — it sends the instruction TEXT, with the key's value redacted out of it.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** Field names whose VALUES seed the per-item redaction set. Matched case-insensitively, substring. */
export const IDENTITY_FIELD_HINTS = Object.freeze([
  'address', 'addr', 'street', 'name', 'requester', 'customer', 'homeowner',
  'contact', 'email', 'phone', 'recipient', 'shipto',
]);

/** An arm whose `when` carries this type is classified by the model rather than by a scope predicate. */
export const CLASSIFY_TYPE = 'classify';

/** True when a branch verdict contains at least one model-classified arm (so the caller knows to batch a call). */
export function hasClassifyArms(verdict) {
  const arms = (verdict && Array.isArray(verdict.arms)) ? verdict.arms : [];
  return arms.some((a) => a && a.when && a.when.type === CLASSIFY_TYPE);
}

/** The arms a classification pass must decide, in declared order. */
export function classifyArms(verdict) {
  const arms = (verdict && Array.isArray(verdict.arms)) ? verdict.arms : [];
  return arms.filter((a) => a && a.when && a.when.type === CLASSIFY_TYPE);
}

/**
 * Collect the identity-bearing VALUES on one record — the seed for redaction. PURE.
 *
 * Deliberately value-based rather than pattern-based: this is how an address gets redacted at all. Values under
 * 3 chars are dropped (a name like "Al" would otherwise pseudonymize half the prose).
 */
export function identityValues(item, { hints = IDENTITY_FIELD_HINTS } = {}) {
  const rec = (item && typeof item === 'object') ? item : {};
  const out = [];
  for (const [k, v] of Object.entries(rec)) {
    const key = String(k).toLowerCase();
    if (!hints.some((h) => key.includes(h))) continue;
    const val = _str(v);
    if (val.length >= 3) out.push(val);
  }
  return [...new Set(out)];
}

/**
 * Build the batched classification request. PURE — returns a plain object the caller hands to the LLM service.
 *
 * @param {Object}   spec
 * @param {Array}    spec.items    `[{ id, text }]` — text ALREADY REDACTED by the caller
 * @param {Array}    spec.arms     `[{ label, is }]` — `is` is the arm's plain-language criterion
 * @param {string}   [spec.field]  the field being classified, for the prompt's framing
 */
export function buildClassifyRequest({ items = [], arms = [], field = '' } = {}) {
  const armLines = arms.map((a, i) => `${i + 1}. "${_str(a.label)}" — ${_str(a.is) || 'no criterion given'}`).join('\n');
  const itemLines = items.map((it) => `<item id="${_str(it.id)}">\n${_str(it.text)}\n</item>`).join('\n\n');

  const system = [
    'You classify records into named groups by reading one free-text field.',
    '',
    'RULES — the third is the one that matters most:',
    '1. Judge ONLY by what the text says. Do not infer from the group names what the text "probably" means.',
    '2. NEGATION AND CONTEXT DECIDE. "do NOT send a replacement", "a replacement was already sent", "declined a',
    '   replacement" all mean the item does NOT belong to a replacements group, even though the word appears.',
    '   This is the entire reason a model is doing this instead of a keyword match.',
    '3. ANSWER "unknown" WHENEVER YOU CANNOT TELL. Ambiguous, contradictory, empty, or off-topic text is',
    '   unknown — not a guess at the closest group. An unknown is reviewed by a human, which is the correct',
    '   outcome; a wrong group causes real work to happen against the wrong record.',
    '4. An item may match no group. That is "none", and it is different from "unknown": "none" means the text is',
    '   clear and describes something else; "unknown" means you could not judge it.',
    '',
    'Reply with JSON only: {"verdicts":[{"id":"<item id>","group":"<label|none|unknown>","why":"<12 words max>"}]}',
    'Return exactly one verdict per item, using the ids given.',
  ].join('\n');

  const user = [
    field ? `Field being read: ${_str(field)}` : '',
    '',
    'GROUPS:',
    armLines || '(none declared)',
    '',
    'ITEMS:',
    itemLines || '(none)',
  ].filter(Boolean).join('\n');

  return { system, user, itemCount: items.length, armLabels: arms.map((a) => _str(a.label)) };
}

/**
 * Parse and VALIDATE the classifier's reply. PURE.
 *
 * Validation is strict in one direction on purpose: anything the model returns that we cannot map onto a
 * declared arm and a known item becomes `unknown`, never a guess. An invented group label is the exact failure
 * this stage exists to catch — it looks like a confident answer and is not one.
 *
 * @returns {{byId:Map<string,{group:string,why:string}>, invalid:number, missing:string[]}}
 */
export function parseClassifyOutput(raw, { items = [], armLabels = [] } = {}) {
  const known = new Set(armLabels.map((l) => _str(l)));
  const wanted = new Set(items.map((it) => _str(it.id)));
  const byId = new Map();
  let invalid = 0;

  let obj = null;
  if (raw && typeof raw === 'object') obj = raw;
  else {
    const m = String(raw ?? '').match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
  }
  const list = (obj && Array.isArray(obj.verdicts)) ? obj.verdicts : [];

  for (const v of list) {
    if (!v || typeof v !== 'object') { invalid++; continue; }
    const id = _str(v.id);
    if (!wanted.has(id) || byId.has(id)) { invalid++; continue; }   // unknown or duplicate id → not a verdict
    const g = _str(v.group);
    const group = (g === 'none' || g === 'unknown') ? g : (known.has(g) ? g : 'unknown');
    if (group === 'unknown' && g && g !== 'unknown') invalid++;      // an INVENTED label — counted, then downgraded
    byId.set(id, { group, why: _str(v.why).slice(0, 120) });
  }

  // An item the model simply skipped is unknown, and is REPORTED — silence is the one outcome a reader cannot
  // interpret, and a missing verdict must never read as "no arm matched".
  const missing = [];
  for (const it of items) {
    const id = _str(it.id);
    if (!byId.has(id)) { byId.set(id, { group: 'unknown', why: 'no verdict returned for this item' }); missing.push(id); }
  }
  return { byId, invalid, missing };
}

/**
 * Fold a classification result into the per-item evaluator `evalBranch` injects. PURE.
 *
 * Returns `(assertion, item) => true | false | undefined`, matching Core/branchScope.js's contract exactly, so
 * a branch can mix deterministic and classified arms in one verdict: whichever kind an arm declares, the answer
 * comes back in the same three-valued shape.
 *
 * @param {Map} byId            from parseClassifyOutput
 * @param {(item:Object)=>string} idOf   how to identify a row (must match the ids used when building the request)
 * @param {Function} fallback   evaluator for NON-classify assertions (the deterministic adapter)
 */
export function makeClassifyEvaluator({ byId, idOf, fallback = null } = {}) {
  return function evaluate(assertion, item) {
    if (!assertion || assertion.type !== CLASSIFY_TYPE) {
      return typeof fallback === 'function' ? fallback(assertion, item) : undefined;
    }
    const v = byId && byId.get ? byId.get(_str(typeof idOf === 'function' ? idOf(item) : '')) : null;
    if (!v) return undefined;                       // never classified → UNKNOWN, not false
    if (v.group === 'unknown') return undefined;    // the model said it could not tell → UNKNOWN
    return v.group === _str(assertion.label);       // 'none' matches no arm, which is a genuine FALSE
  };
}

/**
 * The banked record for one item's classification (§1.1b's determinism-by-banking).
 *
 * Determinism is recovered by BANKING THE VERDICT, not by avoiding the model: an item does not flip arms between
 * runs, a wrong call is visible and correctable per item, and a re-run classifies only what is new or changed.
 */
export function bankedVerdict({ id, group, why, at = 0, model = 'model' }) {
  return { id: _str(id), arm: _str(group), why: _str(why), classifiedAt: Number(at) || 0, by: model, reviewed: false };
}

/** Which items still need classifying, given what is already banked. §10.2 + PP-5's cheap-re-run requirement. */
export function unbankedItems(items, banked, { idOf = (x) => x && x.id, textOf = (x) => x && x.text } = {}) {
  const have = new Map((Array.isArray(banked) ? banked : []).map((b) => [_str(b && b.id), b]));
  const out = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const id = _str(idOf(it));
    const prior = have.get(id);
    if (!prior) { out.push(it); continue; }
    // Re-classify when the TEXT changed — a banked verdict describes the text it was made about.
    if (prior.textHash && prior.textHash !== textHash(_str(textOf(it)))) out.push(it);
  }
  return out;
}

/** A cheap, stable hash for change-detection on banked verdicts. PURE, not cryptographic. */
export function textHash(s) {
  const str = _str(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}`;
}

/** Honest tally naming every class INCLUDING the zeroes (§5.5). */
export function classifyTally(byId, armLabels = []) {
  const n = Object.create(null);
  for (const l of armLabels) n[l] = 0;
  n.none = 0; n.unknown = 0;
  for (const v of (byId && byId.values ? byId.values() : [])) {
    const k = v && v.group;
    if (k && n[k] !== undefined) n[k]++; else n.unknown++;
  }
  const parts = [...armLabels.map((l) => `${l} ${n[l]}`), `no arm ${n.none}`, `couldn’t tell ${n.unknown}`];
  return parts.join(' · ');
}
