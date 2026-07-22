/**
 * Core/groundFacts.js — SUBSTRATE FACTS for the step decomposer (v2.74.1672). Pure.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §0 (the pipeline shape) · the perspective drive implementation.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────────────────
 * The decomposer produced a 4-step plan for an intent that needs 5, and no amount of prompt wording could have
 * fixed it. The missing step was "read the instructions on each one", and it is missing because the model has no
 * way to know that `Instructions` is not on the warranty-task LIST row — it arrives only through the leg's
 * declared per-item drill. That is CATALOG knowledge, sitting in the recipe, that the decomposition never saw.
 *
 * This is the `proposePerspectives`-receives-the-form-oracle move. That prompt does not ask the model to guess
 * which fields a form requires; code reads the DOM and hands it the list, and the comment there states why:
 * *"Coverage becomes guaranteed by construction."* Same division here — code reads the catalog, the model does
 * the interpretation.
 *
 * ── WHAT IS AND IS NOT DERIVABLE, HONESTLY ──────────────────────────────────────────────────────────────────
 * `Instructions` is NOT declared anywhere in `CONNECTOR_RECIPES`. It was discovered live by the field read's
 * enrichment pass. So the per-field answer ("which fields need a drill") CANNOT be derived, and this module does
 * not pretend to.
 *
 * What IS declared, and is structurally sufficient: **the list leg carries `drill`.** From that one fact it
 * follows — always, for any field — that reading a per-item detail is a SEPARATE per-item fetch, and therefore
 * a separate step. The model does not need to know which fields; it needs to know that this shape exists here.
 * That is the difference between a fact and a guess, and it is the whole reason this stays useful when the
 * catalog changes.
 *
 * ── AND IT MUST NOT LEAK LEG IDS ────────────────────────────────────────────────────────────────────────────
 * The prompt's role separation is "you do NOT pick legs or write parameters". Handing the model a list of
 * `recipeId`s would invite exactly the naming it forbids. So the render is in HUMAN terms — what kinds of thing
 * can be read, whether a list has per-item detail, whether a cross-system lookup is a ladder — and never an id.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));
const _arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Strip a leading verb/article and normalize number, so "Find a Shopify customer by email" and
 * "Search Shopify customers by name" land in the SAME ladder bucket.
 *
 * v2.74.1672 — the plural was a real bug: those two produced "shopify customer" and "shopify customers", split
 * into two buckets, and the ladder lost its third rung.
 */
const _noun = (s) => _str(s).toLowerCase()
  .replace(/^(?:find|look ?up|search|get|list|show)\s+(?:a|an|the)?\s*/i, '')
  .replace(/\s+by\s+.*$/i, '')
  .replace(/(\w)s\b/g, '$1')     // customers → customer
  .trim();

/**
 * Render one `joinKey` entry in human terms.
 *
 * v2.74.1672 — `joinKey` is a MIXED array: plain field names AND `{contact, type}` rungs
 * (`'AddressLine1'`, `{contact:'primary', type:'email'}`, …). Mapping it through a string coercion produced
 * "matches on AddressLine1 or [object Object] or [object Object]" — **the third instance of the truthy-object
 * coercion this session** (summarizeItem v1663, decomposeAsk v1667, this). Writing the lesson twice did not
 * prevent the third; the tests below pin the mixed shape so the next one fails loudly instead.
 */
const _joinKeyLabel = (k) => {
  if (typeof k === 'string') return _str(k);
  if (k && typeof k === 'object') {
    const who = _str(k.contact);
    const what = _str(k.type);
    if (what) return who && who !== 'primary' ? `${who} ${what}` : what;
  }
  return '';
};

/**
 * Derive the facts a decomposer needs from a ground's recipe records. PURE.
 *
 * @param {Array} recipes  stored per-Ground records or curated catalog entries (both carry the same markers)
 * @returns {{lists:Array, lookups:Array, writes:Array, hosts:string[]}}
 */
export function deriveGroundFacts(recipes) {
  const lists = [];
  const writes = [];
  const hosts = new Set();
  const lookupBuckets = new Map();   // "host|noun" → { host, noun, keys[] }

  for (const r of _arr(recipes)) {
    if (!r || typeof r !== 'object') continue;
    if (r.enabled === false || r.reviewState === 'rejected') continue;
    const host = _str(r.origin || r.appHost).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (host) hosts.add(host);
    const name = _str(r.name);
    if (!name) continue;

    if (r.write === true) { writes.push({ host, what: name }); continue; }

    // A LIST with a declared per-item drill — the fact that produces a missing step when it is unknown.
    if (r.listUrl || r.drill) {
      lists.push({
        host,
        what: name,
        hasDrill: !!(r.drill && typeof r.drill === 'object'),
        // The join key is declared for cross-system matching; naming it lets the model see that a lookup
        // elsewhere keys on something the row already carries, rather than inventing a field.
        joinsOn: [...new Set(_arr(r.joinKey).map(_joinKeyLabel).filter(Boolean))].slice(0, 3),
      });
      continue;
    }

    // A per-item LOOKUP. Several recipes finding the same noun by different keys ARE a ladder — which is why
    // "search Shopify for a matching profile" is one step and not three, and why it is a per-item step.
    const noun = _noun(name);
    if (!noun) continue;
    const key = `${host}|${noun}`;
    const b = lookupBuckets.get(key) || { host, noun, keys: [] };
    const by = name.match(/\bby\s+(.+)$/i);
    if (by) b.keys.push(_str(by[1]).toLowerCase());
    lookupBuckets.set(key, b);
  }

  return {
    lists,
    lookups: [...lookupBuckets.values()].map((b) => ({ ...b, ladder: b.keys.length > 1 })),
    writes,
    hosts: [...hosts],
  };
}

/**
 * Render the facts as a prompt block. PURE. Human terms only — no ids, no endpoints, no parameters.
 *
 * Each line is phrased as a CONSEQUENCE FOR SPLITTING rather than as a catalog dump, because the model is not
 * being asked to learn the substrate — it is being told which splits the substrate forces. A fact the model
 * cannot act on is prompt weight for nothing.
 */
export function renderGroundFacts(facts, { max = 6 } = {}) {
  const f = facts && typeof facts === 'object' ? facts : { lists: [], lookups: [], writes: [] };
  const lines = [];

  const drillLists = _arr(f.lists).filter((l) => l.hasDrill).slice(0, max);
  if (drillLists.length) {
    lines.push('- On this site, these lists show only summary columns per row, and ANY other detail about one item');
    lines.push('  is fetched separately, one item at a time:');
    for (const l of drillLists) lines.push(`    · ${l.what}`);
    lines.push('  So "read <some field> for each one" is ALWAYS its own step, and it comes AFTER the step that');
    lines.push('  produces the list and BEFORE any step that sorts or filters on that field. A filter cannot read');
    lines.push('  a field the list step never fetched.');
  }

  const ladders = _arr(f.lookups).filter((l) => l.ladder).slice(0, max);
  if (ladders.length) {
    lines.push('- Looking one item up on another system tries several keys in turn (that is one step, not one per key):');
    for (const l of ladders) lines.push(`    · ${l.noun}${l.host ? ` on ${l.host}` : ''} — by ${l.keys.slice(0, 4).join(', then ')}`);
  }

  const joins = _arr(f.lists).filter((l) => l.joinsOn && l.joinsOn.length).slice(0, max);
  if (joins.length) {
    lines.push('- Matching an item to another system keys on what the row already carries — do not invent a');
    lines.push('  different key, and do not add a step to look one up:');
    for (const l of joins) lines.push(`    · ${l.what} → matches on ${l.joinsOn.join(' or ')}`);
  }

  const ws = _arr(f.writes).slice(0, max);
  if (ws.length) {
    lines.push('- Things that CHANGE something here (each is its own final step, never bundled with the lookup');
    lines.push('  that found its target):');
    for (const w of ws) lines.push(`    · ${w.what}`);
  }

  return lines.join('\n');
}

/** True when the facts carry anything worth sending. Keeps an empty block out of the prompt entirely. */
export function hasGroundFacts(facts) {
  return !!renderGroundFacts(facts).trim();
}
