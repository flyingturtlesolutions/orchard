// Core/goldenAsks.test.js — A-0b: the corpus coverage meta-test (Stage 2, v2.74.1726).
//
// Two directions, both load-bearing (docs/HANDOFF_hardening_arc.md §4):
//   → CATALOG → CORPUS: every leg is covered or VISIBLY waived — a new leg with no golden ask is red.
//   ← CORPUS → CATALOG: every entry's ids/intents exist — an entry naming a deleted leg is red (corpus rot is
//     loud, never silent).
// Plus the entry-shape discipline and the class cross-checks (mustBeGated / mustNotWrite verified against the
// catalog's OWN declarations, so a negative can never drift out of sync with the thing it forbids).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GOLDEN_ASKS, WAIVED_LEGS, coveredLegIds, corpusStats } from './goldenAsks.js';
import { CONNECTOR_RECIPES } from './connectorRecipes.js';
import { BUILTIN_LEGS } from './palette.js';
import { INTENTS } from './interpret.js';
import { safetyClassForMethod } from './rideRecipe.js';

const RECIPE_IDS = new Set(CONNECTOR_RECIPES.map((r) => r.id));
const BUILTIN_KEYS = new Set(BUILTIN_LEGS.map((l) => l.key));
const ALL_IDS = new Set([...RECIPE_IDS, ...BUILTIN_KEYS]);
const COVERED = coveredLegIds();
const WAIVED = new Set(WAIVED_LEGS.map((w) => w && w.id));

describe('goldenAsks — A-0b COVERAGE: every leg has a golden ask, or a visible waiver', () => {
  it('every curated recipe is covered or waived (a new leg with no ask is red)', () => {
    const missing = [...RECIPE_IDS].filter((id) => !COVERED.has(id) && !WAIVED.has(id));
    assert.deepEqual(missing, [], `uncovered recipes: ${missing.join(', ')}`);
  });

  it('every builtin leg is covered or waived', () => {
    const missing = [...BUILTIN_KEYS].filter((k) => !COVERED.has(k) && !WAIVED.has(k));
    assert.deepEqual(missing, [], `uncovered builtins: ${missing.join(', ')}`);
  });

  it('v0 ships with ZERO waivers — and any future waiver must carry {id, why} and not shadow coverage', () => {
    assert.equal(WAIVED_LEGS.length, 0, 'v0 is full-coverage; a waiver added later must be argued in its why');
    for (const w of WAIVED_LEGS) {
      assert.ok(w.id && w.why, 'a waiver without a why is a silent skip');
      assert.ok(!COVERED.has(w.id), `${w.id} is covered — a stale waiver must be removed, the list only shrinks`);
    }
  });
});

describe('goldenAsks — ANTI-ROT: every entry points at things that exist', () => {
  it('every expect.legId names a real recipe or builtin', () => {
    for (const e of GOLDEN_ASKS) {
      if (e.expect && e.expect.legId) assert.ok(ALL_IDS.has(e.expect.legId), `"${e.ask}" → unknown leg ${e.expect.legId}`);
    }
  });

  it('every expect.intent is in the INTENTS vocabulary', () => {
    for (const e of GOLDEN_ASKS) {
      if (e.expect && e.expect.intent) assert.ok(INTENTS.includes(e.expect.intent), `"${e.ask}" → unknown intent ${e.expect.intent}`);
    }
  });

  it('every mustNotResolve id names a real leg (a forbidden ghost forbids nothing)', () => {
    for (const e of GOLDEN_ASKS) {
      for (const id of (e.mustNotResolve || [])) assert.ok(ALL_IDS.has(id), `"${e.ask}" forbids unknown leg ${id}`);
    }
  });
});

describe('goldenAsks — entry SHAPE and stamp discipline', () => {
  it('every entry: non-trivial ask, exactly one expectation XOR a pure negative, a valid mintedAt stamp', () => {
    for (const e of GOLDEN_ASKS) {
      assert.ok(typeof e.ask === 'string' && e.ask.trim().length >= 3 && e.ask.length <= 160, `bad ask: ${e.ask}`);
      const hasLeg = !!(e.expect && e.expect.legId);
      const hasIntent = !!(e.expect && e.expect.intent);
      assert.ok(!(hasLeg && hasIntent), `"${e.ask}" carries BOTH legId and intent`);
      const isPureNegative = !e.expect && ((e.mustNotResolve && e.mustNotResolve.length) || e.mustNotWrite);
      assert.ok(hasLeg || hasIntent || isPureNegative, `"${e.ask}" expects nothing and forbids nothing`);
      assert.match(String(e.mintedAt || ''), /^v2\.74\.\d+$/, `"${e.ask}" missing its provenance stamp`);
    }
  });

  it('no duplicate asks (case-insensitive) — one ask, one golden meaning', () => {
    const seen = new Set();
    for (const e of GOLDEN_ASKS) {
      const k = e.ask.trim().toLowerCase();
      assert.ok(!seen.has(k), `duplicate ask: "${e.ask}"`);
      seen.add(k);
    }
  });
});

describe('goldenAsks — CLASS cross-checks: negatives verified against the catalog they constrain', () => {
  const _recipe = (id) => CONNECTOR_RECIPES.find((r) => r.id === id);
  const _builtin = (k) => BUILTIN_LEGS.find((l) => l.key === k);

  it('every mustBeGated target derives to a NON-auto class in the catalog itself', () => {
    for (const e of GOLDEN_ASKS) {
      if (!e.mustBeGated || !e.expect || !e.expect.legId) continue;
      const r = _recipe(e.expect.legId);
      const cls = r ? safetyClassForMethod(r.method, { destructive: !!r.destructive }) : (_builtin(e.expect.legId) || {}).safety;
      assert.ok(cls && cls !== 'auto', `"${e.ask}" demands a gate but ${e.expect.legId} derives to ${cls}`);
    }
  });

  it('every mustNotWrite entry with a positive expectation points at a genuine READ', () => {
    for (const e of GOLDEN_ASKS) {
      if (!e.mustNotWrite || !e.expect || !e.expect.legId) continue;
      const r = _recipe(e.expect.legId);
      assert.ok(!r || !r.write, `"${e.ask}" must not write but expects the write leg ${e.expect.legId}`);
    }
  });

  it('the case→Zendesk canonical is present and points both ways (the v1686 class, frozen forever)', () => {
    const canon = GOLDEN_ASKS.find((e) => e.expect && e.expect.legId === 'OPEN_CASE' && (e.mustNotResolve || []).includes('create_ticket'));
    assert.ok(canon, 'the founding negative must never leave the corpus');
  });

  it('corpusStats reports the v0 shape (the numbers a dashboard would show)', () => {
    const s = corpusStats();
    assert.ok(s.entries >= 88, `entries ${s.entries}`);
    assert.equal(s.legsCovered, RECIPE_IDS.size + BUILTIN_KEYS.size, 'full coverage: every recipe + every builtin');
    assert.ok(s.intents >= 5, 'the per-item clause family is represented');
    assert.ok(s.negatives >= 3 && s.gated >= 5, `negatives ${s.negatives}, gated ${s.gated}`);
    assert.equal(s.waived, 0);
  });
});
