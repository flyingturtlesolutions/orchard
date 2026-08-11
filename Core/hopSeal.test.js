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
  'apiHost', 'csrfHeader', 'csrfCookie', 'retention', 'listPath',
  // safety axes (→ mode/safety/tool booleans)
  'write', 'destructive', 'outward', 'reversible',
  // identity + presence probes (→ tool)
  'verifyIdentity', 'identityProbe', 'probeAccept', 'identityGql', 'capClass', 'autoRequires',
  // human-page + digest + join markers (→ tool)
  'itemUrl', 'listUrl', 'displayId', 'joinKey', 'writeMap', 'pulse', 'drill', 'resolve', 'lookup', 'display',   // v2.74.2064 RC-0 — `lookup` threaded hop 1 (rideRecipe.js) + hop 3 (connectorLeg.js), sealed here
  // consumed upstream of the leg, by name:
  'console',           // signInLandingPath (connectorRecipes.js:926) — the human sign-in landing path (v1704 ZD `/agent`); a connections-flow field, never a leg field
  // v2.74.1877 — `coverage` is read by `coverageOf()` (Core/synthEntity.js) from the CATALOG, keyed by recipe id,
  // and DELIBERATELY never reaches the leg. That is the design, not an oversight: it decides whether a completed
  // scan may say "isn't in any of them" (a partition) or only "not in what I read" (a selection), and putting it
  // on the leg would expose it to the three-hop drop this seal exists to catch. Reading from the catalog makes the
  // seeded path irrelevant, and an unknown recipe resolves to `selection` — so a DROP would weaken a sentence
  // rather than falsify one. The seal caught its absence here on the first run, which is the ratchet working.
  'coverage',          // coverageOf (Core/synthEntity.js) — partition-vs-selection; catalog-read by id, never a leg field, fail-safe when absent
  // v2.74.2203 — the REVERSAL pair, and this seal is what forced the choice between threading and catalog-reading.
  //   undoLeg — WHICH leg undoes this one. `reversible: true` has asserted that an undo exists since v1681 without
  //             naming it, so every consumer had to know the pair by heart; PP-0d (DESIGN_peritem_pipeline.md §6)
  //             asked for exactly this ("reversible becomes a leg REFERENCE, not a boolean") and the Records
  //             card's delete is the first surface that has to ASK.
  //   gidType — the entity a created id belongs to, so a caller can rebuild the gid the delete wants without
  //             knowing the vendor's naming.
  // CATALOG-READ BY ID, deliberately, on `coverage`'s precedent and for its reason: `_recordUndoLeg` (chat.js)
  // resolves both against CONNECTOR_RECIPES, exactly as `_recordOpenUrl` beside it already resolves `itemUrl`.
  // Reading from the catalog makes the seeded path irrelevant, so there is no three-hop drop to catch — and a
  // DROP here would remove a button rather than fire a wrong delete, which is the fail-safe direction for a
  // destructive act. Threading them to the leg would put an irreversible operation's address on the surface this
  // seal exists because things fall off.
  'undoLeg', 'gidType',
  // AU-6 (v2.74.2204, §12.4) — the WARM WINDOW, catalog-read at the ONE seam that knows which recipe wrote a
  // record: `recordCreate` (background/handlers/audit.js) resolves it through `warmWindowMs` and banks the
  // resulting `warmUntil` on the row. Never a leg field — the leg is the thing being INVOKED, and this describes
  // how long what it produced is worth re-reading, which is a property of the record, not of the call.
  'warm',
  // AU-6 (v2.74.2207, §12.9/§12.4) — the WATCH quartet on a collection READ leg, all four catalog-read by the
  // poll (`pollPlan` / `reconcileCollection`, Core/recordObserve.js) and none of them a leg field:
  //   watches — which record KINDS this collection's rows answer for; it is what makes a leg a poll candidate
  //   observe — what counts as NEWS on one of those rows (declared paths only — a poll cannot invent an event)
  //   rows    — where the vendor rows live in the reply
  //   rowId   — the member identity within them
  // They describe how a record is WATCHED, which is a property of the record's life, not of invoking the read.
  // The poll reads the catalog by id (the `coverage` precedent), so there is no seeded path to drop them, and a
  // drop stops a watch rather than firing a wrong write.
  'watches', 'observe', 'rows', 'rowId', 'pollGapMs',
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
