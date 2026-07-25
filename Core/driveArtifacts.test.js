// Core/driveArtifacts.test.js — the built-in DRIVE catalog + per-Ground model (HL, v2.74.1454).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DRIVE_ARTIFACTS, driveFromCatalogEntry, seedFromCatalog, mergeArtifacts,
  seededDriveLegs, buildDriveFragment, buildDriveStrategy,
} from './driveArtifacts.js';

const VS_ORIGIN = 'vendorsuite.drhorton.com';
const seed = () => seedFromCatalog(DRIVE_ARTIFACTS, { groundId: 'g1', origin: VS_ORIGIN });

describe('DRIVE_ARTIFACTS — catalog integrity', () => {
  it('ships the vendorsuite review set: three tier-1 fragments + the tier-2 review composite', () => {
    const ids = DRIVE_ARTIFACTS.map((e) => e.id);
    for (const id of ['vsd_select_division', 'vsd_open_status_tab', 'vsd_open_task_row', 'vsd_review_warranty_task']) {
      assert.ok(ids.includes(id), `${id} present`);
    }
    const s1 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_review_warranty_task');
    assert.equal(s1.tier, 2);
    assert.deepEqual(s1.compose, ['vsd_select_division', 'vsd_open_status_tab', 'vsd_open_task_row']);
  });

  it('every tier-2 compose id resolves to a tier-1 entry in the catalog (no dangling references)', () => {
    const byId = new Map(DRIVE_ARTIFACTS.map((e) => [e.id, e]));
    for (const e of DRIVE_ARTIFACTS.filter((x) => x.tier === 2)) {
      for (const cid of e.compose) {
        const c = byId.get(cid);
        assert.ok(c, `${e.id} composes ${cid} which exists`);
        assert.equal(c.tier, 1, `${cid} is tier 1`);
      }
    }
  });

  it('every tier-1 step with a {{PARAM}} value declares that param (no orphan placeholders)', () => {
    for (const e of DRIVE_ARTIFACTS.filter((x) => x.tier !== 2)) {
      const declared = new Set((e.params || []).map((p) => p.name));
      for (const s of e.steps) {
        const m = /\{\{([A-Z0-9_]+)\}\}/.exec(String(s.value || ''));
        if (m) assert.ok(declared.has(m[1]), `${e.id} declares ${m[1]}`);
      }
    }
  });

  it('F1 waits for a REAL division control, clicks the header toggle, picks by label (v2.74.1804)', () => {
    // The old shape asserted `#divisionMenu` — an element live traces proved absent (WAIT_FOR timed out 15s on a
    // painted, authenticated page; the gate probe saw it false too). The test encoded a FACT about the page that
    // turned out to be wrong, so it moves with the fix. Intent is unchanged: wait, click the toggle, pick by label.
    const f1 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_select_division');
    assert.ok(f1.catalogVersion >= 4, 'a step fix must bump catalogVersion so stale hydrations are invalidated');
    assert.equal(f1.steps[0].action, 'WAIT_FOR');
    assert.ok(!f1.steps[0].selector.includes('#divisionMenu'), 'the phantom id must not gate readiness');
    assert.ok(f1.steps[0].selector.includes('pointer-select'), 'waits on a control the live page actually has');
    assert.equal(f1.steps[1].action, 'CLICK');
    assert.ok(f1.steps[1].selector.includes('dhicon-down-open'), 'the toggle a real replay clicked successfully');
    assert.equal(f1.steps[1].optional, true, 'a toggle-shape change degrades, never fails the walk');
    assert.equal(f1.steps[1].proto, undefined);
    assert.equal(f1.steps[2].action, 'CLICK_BY_LABEL');
    assert.equal(f1.steps[2].selector, 'body', 'label-scoped like the other two entries');
  });
});

describe('driveFromCatalogEntry — catalog → per-Ground record (hop 1, invocation-complete on the seeded path)', () => {
  it('curated defaults: trusted, accepted, enabled, safetyClass auto (read-shaped review flows)', () => {
    const rec = driveFromCatalogEntry(DRIVE_ARTIFACTS[0], { groundId: 'g1', origin: VS_ORIGIN });
    assert.equal(rec.provenance, 'curated');
    assert.equal(rec.reviewState, 'accepted');
    assert.equal(rec.enabled, true);
    assert.equal(rec.trust, 1);
    assert.equal(rec.safetyClass, 'auto');
    assert.equal(rec.groundId, 'g1');
    assert.equal(rec.origin, VS_ORIGIN);
  });

  it('a write entry classes gated (slice 2 lives behind HITL)', () => {
    const rec = driveFromCatalogEntry({ id: 'x', appHost: 'a.com', tier: 1, write: true, steps: [] }, { groundId: 'g', origin: 'a.com' });
    assert.equal(rec.safetyClass, 'gated');
  });

  it('steps + protos + sectionPath survive WHOLE onto the record (the Invariant-#3 lesson, applied from day one)', () => {
    const f1 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_select_division');
    const rec = driveFromCatalogEntry(f1, { groundId: 'g1', origin: VS_ORIGIN });
    assert.equal(rec.steps.length, f1.steps.length);
    assert.deepEqual(rec.steps[0].proto, f1.steps[0].proto);
    assert.equal(rec.sectionPath, '/#warranty');
    assert.notEqual(rec.steps[0], f1.steps[0], 'steps are copied, not shared with the frozen catalog');
  });

  it('tier-2 params derive as the UNION of the composed tier-1 params (catalog-derived, no drift)', () => {
    const s1 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_review_warranty_task');
    const rec = driveFromCatalogEntry(s1, { groundId: 'g1', origin: VS_ORIGIN });
    assert.deepEqual(rec.params.map((p) => p.name), ['DIVISION', 'STATUS', 'FIND']);
    assert.deepEqual(rec.compose, s1.compose);
  });
});

describe('seedFromCatalog — origin matching', () => {
  it('seeds the vendorsuite set for the vendorsuite origin (subdomains ride, foreign hosts do not)', () => {
    assert.equal(seed().length, 4);
    assert.equal(seedFromCatalog(DRIVE_ARTIFACTS, { groundId: 'g', origin: 'sub.vendorsuite.drhorton.com' }).length, 4, 'a subdomain rides its appHost (the ride matching rule)');
    assert.equal(seedFromCatalog(DRIVE_ARTIFACTS, { groundId: 'g', origin: 'example.com' }).length, 0);
    assert.equal(seedFromCatalog(DRIVE_ARTIFACTS, { groundId: 'g', origin: 'drhorton.com' }).length, 0, 'the parent domain alone does not match the deeper appHost');
  });
});

describe('mergeArtifacts — re-seed preserves user state AND hydration stamps', () => {
  it('mechanical fields refresh; user fields survive', () => {
    const cur = seed();
    const existing = [{ ...cur[0], enabled: false, reviewState: 'rejected', name: 'My name', steps: [] }];
    const merged = mergeArtifacts(existing, cur);
    const r = merged.find((x) => x.id === cur[0].id);
    assert.equal(r.enabled, false, 'user disable survives');
    assert.equal(r.reviewState, 'rejected', 'user reject survives');
    assert.equal(r.name, 'My name', 'user rename survives');
    assert.equal(r.steps.length, cur[0].steps.length, 'mechanical steps refresh from the catalog');
  });

  it('hydration stamps survive a catalog refresh ONLY when catalogVersion is unchanged — a step fix bumps version and clears them', () => {
    const cur = seed();
    // v2.74.1804 — derive the version from the catalog; hardcoding it made this test fail on every legitimate
    // catalog fix, which is exactly the event it exists to verify.
    const V = cur[0].catalogVersion;
    const existing = [{ ...cur[0], capabilityId: 'cap_1', fragmentId: 'frag_1', hydratedAt: 111, hydratedCatalogVersion: V }];
    const kept = mergeArtifacts(existing, cur).find((x) => x.id === cur[0].id);
    assert.equal(kept.capabilityId, 'cap_1');
    const bumped = [{ ...cur[0], catalogVersion: V + 1 }];
    const cleared = mergeArtifacts(existing, bumped).find((x) => x.id === cur[0].id);
    assert.equal(cleared.catalogVersion, V + 1);
    assert.equal(cleared.capabilityId, undefined);
    assert.equal(cleared.fragmentId, undefined);
  });

  it('records absent from incoming are kept; a hard-deleted curated id re-appears', () => {
    const cur = seed();
    const taught = { id: 'user_taught', groundId: 'g1', provenance: 'demonstrated' };
    const merged = mergeArtifacts([taught], cur);
    assert.ok(merged.some((r) => r.id === 'user_taught'), 'non-curated record kept');
    assert.equal(merged.length, cur.length + 1, 'every curated id re-seeded');
  });
});

describe('seededDriveLegs — record → OfferedLeg (hop 3, the palette projection)', () => {
  it('projects an armable record as a connector-domain ACT leg with the drive impl marker', () => {
    const legs = seededDriveLegs(seed(), { host: VS_ORIGIN, groundId: 'g1' });
    assert.equal(legs.length, 4);
    const s1 = legs.find((l) => l.tool.driveId === 'vsd_review_warranty_task');
    assert.equal(s1.mode, 'act');
    assert.equal(s1.domain, 'connector');
    assert.equal(s1.tool.impl, 'drive');
    assert.equal(s1.tool.groundId, 'g1');
    assert.equal(s1.tool.sectionPath, '/#warranty');
    assert.equal(s1.tool.hydrated, false);
    assert.deepEqual(s1.params, ['DIVISION', 'STATUS', 'FIND']);
    assert.deepEqual(s1.paramSchema.properties.STATUS.enum, ['new', 'open', 'fixed', 'closed'], 'enums reach the binder');
    assert.ok(s1.paramSchema.properties.FIND.hint, 'hints reach the binder');
  });

  it('the arm guard applies: disabled / pending / rejected records never project', () => {
    const recs = seed();
    recs[0] = { ...recs[0], enabled: false };
    recs[1] = { ...recs[1], reviewState: 'pending' };
    const legs = seededDriveLegs(recs, { host: VS_ORIGIN, groundId: 'g1' });
    assert.equal(legs.length, 2);
  });

  it('dedups via seenKeys and marks a hydrated record on the leg', () => {
    const recs = seed().map((r) => r.id === 'vsd_select_division' ? { ...r, capabilityId: 'cap_9' } : r);
    const seen = new Set();
    const first = seededDriveLegs(recs, { host: VS_ORIGIN, groundId: 'g1', seenKeys: seen });
    assert.equal(first.find((l) => l.tool.driveId === 'vsd_select_division').tool.hydrated, true);
    assert.equal(seededDriveLegs(recs, { host: VS_ORIGIN, groundId: 'g1', seenKeys: seen }).length, 0, 'second projection dedups');
  });
});

describe('buildDriveFragment — tier-1 record + injected deps → Fragment + observed capability', () => {
  const rec = () => seed().find((r) => r.id === 'vsd_select_division');
  const deps = () => { let n = 0; return { groundId: 'g1', localeUrl: 'https://x/#warranty', now: 42, newId: () => `id_${++n}` }; };

  it('actions wait for a real control, click the header toggle, pick by label (v2.74.1804)', () => {
    const built = buildDriveFragment(rec(), deps());
    const actions = JSON.parse(built.fragment.rawJson);
    assert.equal(actions[0].action, 'WAIT_FOR');
    assert.ok(!actions[0].selector.includes('#divisionMenu'), 'v1803 — the phantom id is gone from the built actions too');
    const click = actions.find((a) => a.action === 'CLICK' && a.selector.includes('dhicon-down-open'));
    assert.ok(click);
    assert.equal(click.landmark, undefined);
    const pick = actions.find((a) => a.action === 'CLICK_BY_LABEL' && a.value === '{{DIVISION}}');
    assert.ok(pick);
    assert.equal(pick.selector, 'body');
  });

  it('paces interactive actions after WAIT_FOR (no double-wait before the settle step)', () => {
    const actions = JSON.parse(buildDriveFragment(rec(), deps()).fragment.rawJson);
    assert.equal(actions[0].action, 'WAIT_FOR');
    assert.equal(actions[1].action, 'WAIT', 'human-cadence gap after WAIT_FOR, before first CLICK');
  });

  it('scans {{PARAM}} usage into fragment.params and the capability params; verdict is observed (unverified)', () => {
    const built = buildDriveFragment(rec(), deps());
    assert.deepEqual(built.fragment.params, ['DIVISION']);
    assert.equal(built.fragment.healthStatus, 'untested');
    assert.equal(built.capability.trial.verdict, 'observed');
    assert.equal(built.capability.source, 'curated-drive');
    assert.equal(built.capability.fragmentId, built.fragment.id);
    assert.deepEqual(built.capability.params.map((p) => p.name), ['DIVISION']);
  });

  it('resolvedSelectors override the catalog guess (a live probe upgraded the step)', () => {
    const built = buildDriveFragment(rec(), { ...deps(), resolvedSelectors: { 1: '#realMenu' } });   // index 1 = CLICK (0 = WAIT_FOR)
    const click = JSON.parse(built.fragment.rawJson).find((a) => a.action === 'CLICK' && a.selector);
    assert.equal(click.selector, '#realMenu');
  });

  it('null on a record without steps (a tier-2 record never builds a bare fragment)', () => {
    assert.equal(buildDriveFragment(seed().find((r) => r.tier === 2), deps()), null);
  });
});

describe('buildDriveStrategy — tier-2 record + composed fragments → Strategy referencing the T1 fragments', () => {
  const rec = () => seed().find((r) => r.id === 'vsd_review_warranty_task');
  const composed = [
    { fragmentId: 'f_div', params: ['DIVISION'] },
    { fragmentId: 'f_tab', params: ['STATUS'] },
    { fragmentId: 'f_row', params: ['FIND'] },
  ];
  const deps = () => { let n = 0; return { groundId: 'g1', localeUrl: 'https://x/#warranty', now: 42, newId: () => `id_${++n}` }; };

  it('chains the composed fragments IN ORDER by reference (the T1→T2 reuse — no duplication)', () => {
    const built = buildDriveStrategy(rec(), composed, deps());
    assert.deepEqual(built.strategy.fragmentSteps.map((s) => s.fragmentId), ['f_div', 'f_tab', 'f_row']);
    assert.equal(built.strategy.fragmentSteps[0].type, 'fragment');
    assert.deepEqual(built.strategy.fragmentSteps[0].paramBindings.DIVISION, { kind: 'strategy_param', name: 'DIVISION' });
  });

  it('strategy params are the union, required:false (an unbound label-click SKIPS, the v2.74.877 contract)', () => {
    const built = buildDriveStrategy(rec(), composed, deps());
    assert.deepEqual(built.strategy.params.map((p) => p.name), ['DIVISION', 'STATUS', 'FIND']);
    assert.ok(built.strategy.params.every((p) => p.required === false));
  });

  it('capability references the strategy + all composed fragments, verdict observed', () => {
    const built = buildDriveStrategy(rec(), composed, deps());
    assert.equal(built.capability.strategyId, built.strategy.id);
    assert.deepEqual(built.capability.fragmentIds, ['f_div', 'f_tab', 'f_row']);
    assert.equal(built.capability.trial.verdict, 'observed');
  });

  it('null on empty composition', () => {
    assert.equal(buildDriveStrategy(rec(), [], deps()), null);
  });
});
