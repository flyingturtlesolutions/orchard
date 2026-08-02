// Core/hopSeal.test.js — v2.74.1855 — EXPERIMENT C of the falsification protocol (tools/law-ledger/README.md):
// the INVARIANT-#3 HOP SEAL. The invariant's failure class ("the curated app worked, the forged/seeded Ground
// silently lost the marker" — ≥5 recorded recurrences: v1428, v1430, v1432, v1434, v1755) is made STRUCTURAL:
// for EVERY catalog entry, project the leg down BOTH real pipelines —
//   direct: CONNECTOR_RECIPES → recipeToLeg (via connectorLegsForConnections — the app-selects-a-curated-leg path)
//   seeded: CONNECTOR_RECIPES → recipeFromCatalogEntry (hop 1) → harvestedRecipeLegs (hop 2, the spread) →
//           recipeToLeg (hop 3) — the forged/Overview-workbench Ground path
// — and demand the seeded leg is FIELD-IDENTICAL to the direct leg, up to the declared seeded-only transport set.
// A field added to an entry tomorrow that hop 1 forgets to carry reddens HERE, in the same commit, with the field
// NAMED. The v1680 comment describes this exact walk catching `outward:false` by hand ("the unit tests passed
// throughout because they build a leg by hand and never traverse hop 1") — this file is that walk, permanent.
//
// Pre-registered prediction (law-ledger README, Experiment C): the hop-drop class rate goes to ZERO — a single
// new hop-drop incident after this seal lands falsifies the structure-prevents-the-class claim outright.
//
// The comparison deliberately catches ASYMMETRIC losses (hops 1/2 — one path has the field, the other doesn't).
// A field BOTH paths drop (hop 3 never reads it) is invisible to the diff, so the second half is the hop-3
// RATCHET: every field present on any entry must be DECLARED in ENTRY_FIELD_MAP (read by recipeToLeg, or
// consumed upstream with the consumer named). A new entry field with no declaration reddens with its name.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTOR_RECIPES, connectorLegsForConnections, harvestedRecipeLegs } from './connectorRecipes.js';
import { seedFromCatalog } from './rideRecipe.js';

// The DECLARED seeded-only tool fields — the §20 header-replay transport (harvestedRecipeLegs stamps them after
// projection). NOTE (recorded, not waived): this exception set IS the two-executor split — a seeded leg carrying
// `replay:'headers'` dispatches down SESSION_REPLAY while its curated twin rides INVOKE_SESSION (the live 07-27
// 17:56-vs-19:26 divergence: same leg id, two doors, two failure modes). The seal keeps the set EXPLICIT so any
// growth of the split is a reviewed decision.
const SEEDED_ONLY_TOOL_FIELDS = new Set(['sessionHost', 'replay', 'groundId']);

// Top-level leg fields that must match exactly (key + provenance handled separately; provenance differs by design).
const TOP_COMPARE = ['name', 'does', 'mode', 'safety'];

// The hop-3 ratchet: every field an entry may carry, each either read by recipeToLeg into the leg surface or
// consumed upstream by a NAMED consumer. Adding a field to a recipe without extending this map (and threading it
// per invariant #3) is a red test with the field named — the two-line discipline, enforced.
const ENTRY_FIELD_MAP = new Set([
  // identity + routing surface (read into key/tool/top-level)
  'id', 'app', 'appHost', 'origin', 'name', 'does',
  // transport (recipeToLeg → tool)
  'method', 'endpoint', 'params', 'body', 'bodyType', 'contentType', 'gql', 'csrf', 'urlParam', 'persistedOp',
  'requestHeaders', 'shopProbe',
  // v2.74.1936 — the UPS pair, both threaded to `tool` through all three hops (the seal proves it):
  //   apiHost    — the API lives on a SIBLING host of the ride tab (page www.ups.com, API webapis.ups.com); the
  //                executor builds the URL from it instead of the tab's origin. Every prior ground was same-origin.
  //   csrfHeader — the sniffed token's header NAME is per-site (UPS: x-xsrf-token). Defaults to x-csrf-token at
  //                the executor, so every existing recipe sends exactly what it sent before.
  'apiHost', 'csrfHeader', 'listPath',
  // safety axes (→ mode/safety/tool booleans)
  'write', 'destructive', 'outward', 'reversible',
  // identity + presence probes (→ tool)
  'verifyIdentity', 'identityProbe', 'probeAccept', 'identityGql', 'capClass', 'autoRequires',
  // human-page + digest + join markers (→ tool)
  'itemUrl', 'listUrl', 'displayId', 'joinKey', 'writeMap', 'pulse', 'drill', 'resolve',
  // consumed upstream of the leg, by name:
  'console',           // signInLandingPath (connectorRecipes.js:926) — the human sign-in landing path (v1704 ZD `/agent`); a connections-flow field, never a leg field
  // v2.74.1877 — `coverage` is read by `coverageOf()` (Core/synthEntity.js) from the CATALOG, keyed by recipe id,
  // and DELIBERATELY never reaches the leg. That is the design, not an oversight: it decides whether a completed
  // scan may say "isn't in any of them" (a partition) or only "not in what I read" (a selection), and putting it
  // on the leg would expose it to the three-hop drop this seal exists to catch. Reading from the catalog makes the
  // seeded path irrelevant, and an unknown recipe resolves to `selection` — so a DROP would weaken a sentence
  // rather than falsify one. The seal caught its absence here on the first run, which is the ratchet working.
  'coverage',          // coverageOf (Core/synthEntity.js) — partition-vs-selection; catalog-read by id, never a leg field, fail-safe when absent
]);

const ENTRIES = CONNECTOR_RECIPES.filter((e) => e && e.id && e.appHost);

function projectBoth(host) {
  const direct = connectorLegsForConnections([{ origin: host, label: host }], { account: 'me', trusted: true });
  const records = seedFromCatalog(CONNECTOR_RECIPES, { groundId: 'gseal', origin: host });
  const seeded = harvestedRecipeLegs(records, { host, account: 'me', groundId: 'gseal' });
  return { direct, seeded, records };
}

/** Field names whose values differ between the two tools, exceptions excluded. PURE over the two objects. */
function toolDiff(directTool, seededTool) {
  const diffs = [];
  const keys = new Set([...Object.keys(directTool || {}), ...Object.keys(seededTool || {})]);
  for (const k of keys) {
    if (SEEDED_ONLY_TOOL_FIELDS.has(k)) continue;
    const a = directTool ? directTool[k] : undefined;
    const b = seededTool ? seededTool[k] : undefined;
    try { assert.deepEqual(b, a); } catch { diffs.push(k); }
  }
  return diffs.sort();
}

describe('hop seal — seeded ≡ direct, every entry, every field (invariant #3 structural)', () => {
  for (const e of ENTRIES) {
    const host = String(e.appHost).toLowerCase();
    it(`${e.id} @ ${host}`, () => {
      const { direct, seeded } = projectBoth(host);
      const d = direct.find((l) => l && l.tool && l.tool.recipeId === e.id);
      const s = seeded.find((l) => l && l.tool && l.tool.recipeId === e.id);
      assert.ok(d, 'projects on the DIRECT path');
      assert.ok(s, 'projects on the SEEDED path (the invariant’s historical drop site)');
      assert.equal(s.key, d.key, 'leg IDENTITY matches (the v1755 one-spelling guarantee)');
      for (const k of TOP_COMPARE) assert.deepEqual(s[k], d[k], `top-level ${k} differs on the seeded path`);
      assert.deepEqual(s.params, d.params, 'params');
      assert.deepEqual(s.paramSchema, d.paramSchema, 'paramSchema');
      const diffs = toolDiff(d.tool, s.tool);
      assert.deepEqual(diffs, [], `tool fields dropped/changed on the seeded path: [${diffs.join(', ')}]`);
    });
  }
  it('coverage floor — the seal walks the whole catalog (anti-rot)', () => {
    assert.ok(ENTRIES.length >= 40, `only ${ENTRIES.length} entries walked — the catalog filter rotted`);
  });
});

describe('hop seal — the hop-3 ratchet: every entry field is read or declared', () => {
  for (const e of ENTRIES) {
    it(`${e.id} — all fields mapped`, () => {
      const unmapped = Object.keys(e).filter((k) => !ENTRY_FIELD_MAP.has(k)).sort();
      assert.deepEqual(unmapped, [], `entry fields with no leg mapping and no named consumer: [${unmapped.join(', ')}] — thread them (invariant #3) or declare the consumer here`);
    });
  }
});

describe('hop seal — the seal can go RED (test-the-test, both directions)', () => {
  it('a doctored hop-1 drop is DETECTED (itemUrl deleted from the seeded record)', () => {
    const e = ENTRIES.find((x) => x.itemUrl);
    assert.ok(e, 'an itemUrl-bearing entry exists to doctor');
    const host = String(e.appHost).toLowerCase();
    const { direct } = projectBoth(host);
    const d = direct.find((l) => l.tool.recipeId === e.id);
    const records = seedFromCatalog(CONNECTOR_RECIPES, { groundId: 'gseal', origin: host });
    const rec = records.find((r) => r.id === e.id);
    delete rec.itemUrl;                                             // the planted drop
    const seeded = harvestedRecipeLegs(records, { host, account: 'me', groundId: 'gseal' });
    const s = seeded.find((l) => l.tool.recipeId === e.id);
    const diffs = toolDiff(d.tool, s.tool);
    assert.ok(diffs.includes('itemUrl'), `planted itemUrl drop not detected — the seal is blind (saw: [${diffs.join(', ')}])`);
  });
  it('an unmapped NEW entry field is DETECTED (hop-3 ratchet red-proof)', () => {
    const fake = { ...ENTRIES[0], zzNewMarker: 'x' };
    const unmapped = Object.keys(fake).filter((k) => !ENTRY_FIELD_MAP.has(k));
    assert.deepEqual(unmapped, ['zzNewMarker']);
  });
});
