// Core/warrantySwitch.test.js — v2.74.2105. The warranty reader's CODE half: coercion + derivation.
//
// This is the gate the previous design never had. Eleven consecutive prompt fixes shipped with no behaviour
// fixture, so each regression was found by the user in the panel; one "compression" silently re-opened two closed
// defects because the guarantees lived in prose sentences rather than in code. Every historical failure below is a
// row here, asserted on the DERIVED outcome — the property that makes the failure structurally impossible, not the
// wording that used to forbid it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCT_ROUTES, COUNT_ROUTES, WARRANTY_ARMS, CONTACT_CAUSES, DEFAULT_PRODUCT,
  coerceVerdict, deriveWarrantyOutcome, readWarrantyItem, tallyOutcomes,
  buildWarrantyExtractSystem, EXTRACT_EXAMPLES,
} from './warrantySwitch.js';

const read = (fields, text = '', opts = {}) => readWarrantyItem(fields, text, opts);
const REPLACE = 'replacement needed';
const CONTACT = 'contact homeowner';

describe('warrantySwitch — the grammar has no escape hatch', () => {
  it('no arm, cause, or route value means "unknown" / "none" / "cannot tell"', () => {
    const all = [...WARRANTY_ARMS, ...CONTACT_CAUSES, ...COUNT_ROUTES, ...PRODUCT_ROUTES].join(' ').toLowerCase();
    for (const banned of ['unknown', 'none of', 'couldn', 'unclear', 'ambiguous']) {
      assert.equal(all.includes(banned), false, `"${banned}" must not be an emittable value`);
    }
    assert.equal(COUNT_ROUTES.includes('NONE'), true);   // NONE is a NAMED counting outcome, not a refusal
  });
  it('NOT DEAKO is gone — an arm with no positive test cannot exist to absorb doubt', () => {
    assert.deepEqual([...WARRANTY_ARMS], [REPLACE, CONTACT]);
  });
  it('the prompt never supplies the doubt vocabulary the old one leaked', () => {
    const sys = buildWarrantyExtractSystem().toLowerCase();
    for (const w of ['confirm', 'unclear', 'not specified', 'ambiguous', 'catalog', 'indefinite', 'unknown']) {
      assert.equal(sys.includes(w), false, `the prompt must not contain "${w}" (the model quotes it back)`);
    }
  });
});

// ── The eleven historical failures, as derived-outcome assertions ──────────────────────────────────────────────
describe('warrantySwitch — every historical failure is structurally blocked', () => {
  it('#1/#3/#11 "light switches without confirming/Deako/catalog" → REPLACE 4', () => {
    const r = read({ product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: 4 }, 'Need 4 light switches');
    assert.equal(r.arm, REPLACE); assert.equal(r.count, 4); assert.equal(r.product, DEFAULT_PRODUCT);
  });
  it('#2 "rocker switch but not Simple Rocker specifically" → REPLACE 2 (SUM_OF_PLACES)', () => {
    const r = read({ product: 'SIMPLE_ROCKER', count_route: 'SUM_OF_PLACES', count: 2 }, 'one rocker for office, one for master bath');
    assert.equal(r.arm, REPLACE); assert.equal(r.count, 2);
  });
  it('#4 "indefinite range 4-5" → REPLACE 5 (the upper bound is a ROUTE, not an obstacle)', () => {
    const r = read({ product: 'SIMPLE_ROCKER', count_route: 'RANGE_UPPER', count: 5 }, 'pointed 4-5 out');
    assert.equal(r.arm, REPLACE); assert.equal(r.count, 5);
  });
  it('#5 invented arms / "no arm" → impossible: the model emits no label at all', () => {
    const r = read({ product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: 3, group: 'requesting replacement' }, '3 switches');
    assert.equal(WARRANTY_ARMS.includes(r.arm), true);
    assert.equal(r.arm, REPLACE);   // a stray label field is ignored — code decides
  });
  it('#6 "problem described but no count specified" → SINGLE_FAULT = REPLACE 1', () => {
    const r = read({ product: 'SIMPLE_ROCKER', count_route: 'SINGLE_FAULT', count: 1 }, 'light switch sticking at middle bedroom');
    assert.equal(r.arm, REPLACE); assert.equal(r.count, 1);
  });
  it('#7 "light flickering, unclear if switch" → REPLACE 1', () => {
    const r = read({ product: 'SIMPLE_ROCKER', count_route: 'SINGLE_FAULT', count: 1 }, 'prim bath 1 light flickering');
    assert.equal(r.arm, REPLACE); assert.equal(r.count, 1);
  });
  it('#8 the model mislabels the route but HAS the number → coerced to EXPLICIT and acted on', () => {
    const r = read({ product: 'SIMPLE_ROCKER', count_route: 'NONE', count: 4 }, 'Need 4 light switches');
    assert.equal(r.fields.count_route, 'EXPLICIT');
    assert.equal(r.arm, REPLACE); assert.equal(r.count, 4);
  });
  it('#9 a dropped guard cannot re-open a defect: the guarantees are code, not sentences', () => {
    // Same input, no prose involved — the derivation is the guarantee.
    assert.equal(read({ product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: 6 }, '6 wall switches').arm, REPLACE);
  });
  it('#10 the component\'s own "unknown" is unreachable — an unrecognised product falls to the default class', () => {
    const r = read({ product: 'unknown', count_route: 'EXPLICIT', count: 2 }, '2 switches');
    assert.equal(r.fields.product, 'SIMPLE_ROCKER');
    assert.equal(r.arm, REPLACE);
  });
});

// ── The two legitimate contact paths, and only those ───────────────────────────────────────────────────────────
describe('warrantySwitch — contact requires a POSITIVE, checkable fact', () => {
  it('no count anywhere → contact (no-count)', () => {
    const r = read({ product: 'SIMPLE_ROCKER', count_route: 'NONE', count: null }, 'Please send homeowner deako switches');
    assert.equal(r.arm, CONTACT); assert.equal(r.cause, 'no-count');
  });
  it('a NAMED product the catalog does not have → contact (named-product-unresolved)', () => {
    const v = { product: 'NAMED_OTHER', product_name: 'Gen 9 hyperswitch', count_route: 'EXPLICIT', count: 1 };
    assert.equal(read(v, 'send a Gen 9 hyperswitch', { inCatalog: () => false }).cause, 'named-product-unresolved');
    assert.equal(read(v, 'send a Gen 9 hyperswitch', { inCatalog: () => true }).arm, REPLACE);
  });
  it('a named product that RESOLVES is drafted as that product, never substituted', () => {
    const r = read({ product: 'NAMED_OTHER', product_name: 'Gen 2 smart switch', count_route: 'SINGLE_FAULT', count: 1 },
      'deliver a Gen 2 smart switch', { inCatalog: () => true });
    assert.equal(r.arm, REPLACE); assert.equal(r.product, 'Gen 2 smart switch');
  });
  it('outlets → contact (other-trade), per the owner ruling — never a silent skip', () => {
    const r = read({ product: 'OTHER_TRADE', product_name: 'electrical outlets', count_route: 'SINGLE_FAULT', count: 1 },
      'Electrical outlets are loose throughout the home');
    assert.equal(r.arm, CONTACT); assert.equal(r.cause, 'other-trade');
  });
  it('an already-handled QUOTE stops the work — but only if it is really in the text', () => {
    const text = 'Homeowner asked about replacements - do NOT send one, repairing under warranty';
    const good = read({ product: 'SIMPLE_ROCKER', count_route: 'NONE', count: null, already_handled: 'do NOT send one' }, text);
    assert.equal(good.arm, CONTACT); assert.equal(good.cause, 'already-handled');
    // an INVENTED quote is dropped, and the item is read normally instead
    const bad = read({ product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: 2, already_handled: 'the homeowner declined' }, '2 switches sticking');
    assert.equal(bad.fields.already_handled, null);
    assert.equal(bad.arm, REPLACE);
  });
  it('a NAMED_OTHER with no name is not a named product — it is an ordinary switch', () => {
    const r = read({ product: 'NAMED_OTHER', product_name: null, count_route: 'EXPLICIT', count: 1 }, 'send a switch', { inCatalog: () => false });
    assert.equal(r.fields.product, 'SIMPLE_ROCKER');
    assert.equal(r.arm, REPLACE);
  });
});

describe('warrantySwitch — coercions close the silent escapes', () => {
  it('a route with no usable count becomes the honest no-count case', () => {
    const r = read({ product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: null }, 'switches');
    assert.equal(r.fields.count_route, 'NONE'); assert.equal(r.arm, CONTACT); assert.equal(r.cause, 'no-count');
  });
  it('a zero or negative count is not a count', () => {
    assert.equal(read({ product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: 0 }, 'x').arm, CONTACT);
  });
  it('junk in → a valid, self-consistent verdict out (never a throw, never an unknown)', () => {
    const r = read(null, 'anything');
    assert.equal(WARRANTY_ARMS.includes(r.arm), true);
    assert.equal(r.arm, CONTACT); assert.equal(r.cause, 'no-count');
  });
  it('the note is carried but never routes', () => {
    const r = read({ product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: 2, note: 'read the light symptom as a switch fault' }, '2 lights');
    assert.equal(r.arm, REPLACE);
    assert.match(r.fields.note, /light symptom/);
  });
});

// ── The 13 real queue tasks, held OUT of the prompt and asserted here as the frozen fixture ────────────────────
describe('warrantySwitch — the 13 real open tasks (frozen fixture, expected outcomes)', () => {
  const FIXTURE = [
    ['#4899580 Gen 2 smart switch', { product: 'NAMED_OTHER', product_name: 'Gen 2 smart switch', count_route: 'SINGLE_FAULT', count: 1 }, REPLACE, 1],
    ['#4899327 Need 4 light switches', { product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: 4 }, REPLACE, 4],
    ['#4905013 (6) total switches', { product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: 6 }, REPLACE, 6],
    ['#4908619 one office + one master bath', { product: 'SIMPLE_ROCKER', count_route: 'SUM_OF_PLACES', count: 2 }, REPLACE, 2],
    ['#4899384 6 wall switches flickering', { product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: 6 }, REPLACE, 6],
    ['#4902372 4-5 sticking', { product: 'SIMPLE_ROCKER', count_route: 'RANGE_UPPER', count: 5 }, REPLACE, 5],
    ['#4896510 3 switches SCHEDULE ASAP', { product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: 3 }, REPLACE, 3],
    ['#4899029 3-way switch not working', { product: 'SIMPLE_ROCKER', count_route: 'SINGLE_FAULT', count: 1 }, REPLACE, 1],
    ['#4905736 3 flickering light switches', { product: 'SIMPLE_ROCKER', count_route: 'EXPLICIT', count: 3 }, REPLACE, 3],
    ['#4896970 light switch sticking', { product: 'SIMPLE_ROCKER', count_route: 'SINGLE_FAULT', count: 1 }, REPLACE, 1],
    ['#4900623 1 light flickering, ship replacement', { product: 'SIMPLE_ROCKER', count_route: 'SINGLE_FAULT', count: 1 }, REPLACE, 1],
    ['#4903279 send homeowner deako switches', { product: 'SIMPLE_ROCKER', count_route: 'NONE', count: null }, CONTACT, null],
    ['#4888221 electrical outlets → DCES', { product: 'OTHER_TRADE', product_name: 'electrical outlets', count_route: 'SINGLE_FAULT', count: 1 }, CONTACT, null],
  ];
  for (const [label, fields, arm, count] of FIXTURE) {
    it(`${label} → ${arm}${count != null ? ` ${count}` : ''}`, () => {
      const r = read(fields, label, { inCatalog: () => true });
      assert.equal(r.arm, arm);
      assert.equal(r.count, count);
    });
  }
  it('the fixture as a whole: 11 act, 2 human — and the headline metric is 0 wrong escalations', () => {
    const outcomes = FIXTURE.map(([label, fields]) => read(fields, label, { inCatalog: () => true }));
    const t = tallyOutcomes(outcomes);
    assert.equal(t.total, 13);
    assert.equal(t.byArm[REPLACE], 11);
    assert.equal(t.byArm[CONTACT], 2);
    assert.equal(t.byCause['no-count'], 1);
    assert.equal(t.byCause['other-trade'], 1);
  });
});

describe('warrantySwitch — the exemplar bank', () => {
  it('every exemplar is itself a valid, self-consistent extraction (the bank cannot teach an invalid shape)', () => {
    for (const ex of EXTRACT_EXAMPLES) {
      const f = coerceVerdict(ex.out, ex.text);
      assert.deepEqual({ p: f.product, r: f.count_route, c: f.count },
        { p: ex.out.product, r: ex.out.count_route, c: ex.out.count }, `exemplar drifted: ${ex.text}`);
    }
  });
  it('is skewed toward acting, and ends on an act (recency)', () => {
    const outs = EXTRACT_EXAMPLES.map((e) => deriveWarrantyOutcome(coerceVerdict(e.out, e.text), { inCatalog: () => true }));
    const acts = outs.filter((o) => o.arm === REPLACE).length;
    assert.ok(acts > outs.length - acts, 'exemplars must skew toward acting');
    assert.equal(outs[outs.length - 1].arm, REPLACE);
  });
});
