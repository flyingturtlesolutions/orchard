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

  // v2.74.2179 — NO SELECTOR MAY USE `:has()` / `:has-text()`. `resolveElement` (ContentScripts/contentScript.js
  // :631) SKIPS any candidate containing them — "not supported in all querySelector contexts and causes silent
  // failures" — so such a step matches nothing, always, and an `optional` one degrades in total silence. v2178
  // shipped exactly that and burned four live attempts on a guard that was never evaluated. This is the cheapest
  // possible permanent stop: the resolver's policy, asserted where the selectors are authored.
  it('no catalog selector uses :has() — the resolver silently skips those (contentScript.js:631)', () => {
    for (const e of DRIVE_ARTIFACTS) {
      for (const s of (e.steps || [])) {
        const sel = String(s.selector || '');
        assert.ok(!sel.includes(':has('), `${e.id}: ${s.action} selector uses :has(), which resolveElement refuses`);
        assert.ok(!sel.includes(':has-text('), `${e.id}: ${s.action} selector uses :has-text(), which is Playwright-only`);
      }
      for (const c of (e.postcondition || [])) {
        assert.ok(!String(c.selector || '').includes(':has('), `${e.id}: postcondition selector uses :has()`);
      }
    }
  });

  it('F1 waits for a REAL division control, clicks the header toggle, picks by label (v2.74.1804)', () => {
    // The old shape asserted `#divisionMenu` — an element live traces proved absent (WAIT_FOR timed out 15s on a
    // painted, authenticated page; the gate probe saw it false too). The test encoded a FACT about the page that
    // turned out to be wrong, so it moves with the fix. Intent is unchanged: wait, click the toggle, pick by label.
    // v2.74.2185 — asserted BY ROLE, not by index. This block has been re-indexed by hand three times as steps
    // were inserted ahead of it (v2180, v2183, v2185), and each re-index was an opportunity to assert the wrong
    // step. Find each one by what it is.
    const f1 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_select_division');
    assert.ok(f1.catalogVersion >= 15, 'a step fix must bump catalogVersion so stale hydrations are invalidated');
    const at = (pred) => f1.steps.findIndex(pred);

    // v2185 — ENTER BY CLICKING THE NAV ITEM. `SHOW_SOURCES` sets the URL from outside the page, which can skip
    // the app's own router transition — the transition that loads the division data. The user found this by
    // hand: clicking the Warranty tab then the eye works; letting the drive navigate does not.
    const nav = f1.steps.find((s) => s.action === 'CLICK' && /title="Warranty"/i.test(s.selector || ''));
    assert.ok(nav, 'the section is entered by clicking its nav item, not by a URL change');
    assert.equal(nav.optional, true, 'a nav-shape change degrades to the warm path, which works');
    assert.equal(at((s) => s === nav), 0, 'and it happens FIRST — every later step assumes the section is really open');

    const viewWait = f1.steps.find((s) => s.action === 'WAIT_FOR' && s.selector.includes('input[type="search"]'));
    assert.ok(viewWait, 'v2180 — the warranty VIEW must be up before the app-header control is trusted');
    assert.notEqual(viewWait.optional, true, 'a blank page is not a degraded state, it is an unrunnable one');

    const dataWait = f1.steps.find((s) => s.action === 'WAIT_FOR' && s.selector.includes(':not(:empty)'));
    assert.ok(dataWait, 'v2183 — the division NAME must be populated before the menu is opened');
    assert.ok(dataWait.selector.includes('pointer-select'), 'waits on a control the live page actually has');
    assert.ok(!dataWait.selector.includes('#divisionMenu'), 'the phantom id must not gate readiness');
    assert.ok(!dataWait.selector.includes(','), 'a single selector — an OR lets "the toggle exists" satisfy "the toggle is populated"');

    const toggle = f1.steps.find((s) => s.action === 'CLICK' && /dhicon-down-open/.test(s.selector || ''));
    assert.ok(toggle, 'the toggle a real replay clicked successfully');
    assert.equal(toggle.optional, true, 'a toggle-shape change degrades, never fails the walk');
    assert.equal(toggle.proto, undefined);

    const pick = f1.steps.find((s) => s.action === 'CLICK_BY_LABEL');
    assert.equal(pick.selector, 'body', 'label-scoped like the other two entries');

    // ORDER is the contract: enter → view up → data loaded → open the menu → pick.
    assert.ok(at((s) => s === nav) < at((s) => s === viewWait));
    assert.ok(at((s) => s === viewWait) < at((s) => s === dataWait));
    assert.ok(at((s) => s === dataWait) < at((s) => s === toggle), 'the menu is opened only after its data exists');
    assert.ok(at((s) => s === toggle) < at((s) => s === pick));
  });

  // v2.74.2171 — re-authored from a loaded-list DOM read. These assertions encode FACTS ABOUT THE PAGE, which is
  // why the previous versions of them moved: `li.pointer-select` alone is the class the NAV wears (its first
  // match on a bare section is "Settings"), and `table`/`[role="grid"]`/`[role="tablist"]` match nothing at all
  // on this app — three reads running.
  it('F3 waits on a LIST ROW, not on application chrome (v2.74.2171)', () => {
    const f3 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_open_task_row');
    assert.ok(f3.catalogVersion >= 12, 'a step fix must bump catalogVersion so stale hydrations are invalidated');
    // v2.74.2176 — the wait is no longer step 0: a SEARCH types first, because the list renders collapsed into
    // project groups and the rows do not exist in the DOM until something narrows it. Find the wait by ACTION
    // rather than by index, so the next step insertion does not move this assertion again.
    const wait = f3.steps.find((s) => s.action === 'WAIT_FOR');
    assert.ok(wait, 'the row step still waits for a row before clicking');
    // EVERY alternative must be list-scoped, not just the selector as a whole: one unscoped branch in an OR is
    // enough to make the wait meaningless again, and an OR-list is exactly how the old one degraded into chrome.
    const alts = wait.selector.split(',').map((s) => s.trim()).filter(Boolean);
    assert.ok(alts.length > 0);
    for (const a of alts) {
      assert.ok(a.startsWith('ul.item-list.grouped '), `"${a}" is scoped to the GROUPED task list — plain ul.item-list is also the division menu and the status filter`);
      assert.ok(!/table|role="grid"|role="table"/.test(a), 'dead selectors: this app has no table and no grid');
    }
  });

  it('F3 clicks inside the LIST, so a page-wide text match can never stand in for a row (v2.74.2171)', () => {
    const f3 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_open_task_row');
    const click = f3.steps.find((s) => s.action === 'CLICK_BY_LABEL');
    assert.notEqual(click.selector, 'body', 'body is how FIND="Las Vegas" matched the division trigger and returned success');
    assert.equal(click.selector, 'ul.item-list.grouped', 'plain ul.item-list resolves to the status filter list (v2174 live evidence)');
    assert.ok(!click.selector.includes(','), 'querySelector resolves a comma list in DOCUMENT order, not selector order — an OR cannot express priority here');
    assert.equal(click.value, '{{FIND}}');
    assert.notEqual(click.optional, true, 'the ROW click is the point of the artifact — it must not degrade silently');
  });

  // v2.74.2176 — the list renders COLLAPSED into project groups (live 20:23:33: `Available: "Hudson Glen(1)",
  // "Middleton(1)", "Sherwood Estates(1)"`), and the user's DOM read shows the inner `<ul class="item-list">` is
  // EMPTY with a `dhicon-down-open` chevron. So no selector could ever have found a row: the rows do not exist
  // until the list is narrowed. The page ships `<input type="search" placeholder="Find a ticket or task…">`.
  it('F3 SEARCHES before it clicks — the rows do not exist until the list is narrowed', () => {
    const f3 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_open_task_row');
    const type = f3.steps.find((s) => s.action === 'TYPE');
    assert.ok(type, 'without a search there is nothing in the list to click');
    assert.match(type.selector, /input\[type="search"\]/);
    assert.equal(type.value, '{{SEARCH}}');
    assert.ok(f3.params.some((p) => p.name === 'SEARCH'), 'the param is declared, so it is bindable');
    // ORDER matters: search, then wait, then click. A click before the search would race an unnarrowed list.
    const idx = (a) => f3.steps.findIndex((s) => s.action === a);
    assert.ok(idx('TYPE') < idx('WAIT_FOR'), 'search precedes the wait');
    assert.ok(idx('WAIT_FOR') < idx('CLICK_BY_LABEL'), 'the wait precedes the click');
  });

  // Typing is IDEMPOTENT — unlike expanding a group, whose chevron toggles. That is why search beat the group
  // route: this arc has already produced three toggle hazards (division menu v2164, status trigger v2175).
  it('the search step is not optional and types into a single input — no toggle, no second join', () => {
    const f3 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_open_task_row');
    const type = f3.steps.find((s) => s.action === 'TYPE');
    assert.notEqual(type.optional, true, 'the search is what makes the row exist');
    const key = f3.steps.find((s) => s.action === 'KEY');
    assert.equal(key && key.optional, true, 'Enter is a belt for a search that needs submitting — never a failure');
  });

  // v2.74.2177 — the search RESULT is still a collapsed group, so the row needs one more click. Live 15:42:29
  // (v2176): the search narrowed Las Vegas from two groups to one (`Available: "Heartland Trails 1.08(1)"`,
  // where the unsearched list had shown that plus "NPVV - Juno Pointe(1)") — and the row still was not there.
  it('F3 EXPANDS the collapsed result group, and can never collapse an open one (v2.74.2177)', () => {
    const f3 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_open_task_row');
    const expand = f3.steps.find((s) => s.action === 'CLICK' && /group-header/.test(s.selector || ''));
    assert.ok(expand, 'a search result is a collapsed group; something must open it');
    // THE IDEMPOTENCE GUARD. `dhicon-down-open` is the COLLAPSED chevron, so an already-open group does not
    // match and is not clicked. Four toggle hazards in this arc (division menu v2164, status trigger v2175,
    // and this header both ways) — this is the first one closed by the selector instead of by hoping.
    assert.match(expand.selector, /span\.dhicon-down-open/, 'must target the COLLAPSED chevron, so it cannot close an open group');
    assert.equal(expand.optional, true, 'an already-expanded list is a valid state, not a failure');
    const idx = (pred) => f3.steps.findIndex(pred);
    assert.ok(idx((s) => s.action === 'TYPE') < idx((s) => s === expand), 'the search runs before the expand');
    assert.ok(idx((s) => s === expand) < idx((s) => s.action === 'CLICK_BY_LABEL'), 'the expand runs before the row click');
  });

  it('F3 declares a POSTCONDITION — the artifact says what ARRIVING looks like (v2.74.2171)', () => {
    const f3 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_open_task_row');
    assert.ok(Array.isArray(f3.postcondition) && f3.postcondition.length, 'without one, ok means only "the clicks did not throw"');
    assert.equal(f3.postcondition[0].type, 'selector_present');
    assert.ok(f3.postcondition[0].selector.includes('warrantyTaskDetails'), 'the pane an open task renders');
  });

  it('F2 carries no dead tab selectors and stays optional (v2.74.2171)', () => {
    const f2 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_open_status_tab');
    const all = JSON.stringify(f2.steps);
    assert.ok(!/nav-tabs|role=\\?"tablist/.test(all), 'three DOM reads put tablist at 0 — there is no tab strip');
    for (const s of f2.steps) assert.equal(s.optional, true, 'narrowing by status is a convenience; the ROW is the goal');
    const click = f2.steps.find((s) => s.action === 'CLICK_BY_LABEL');
    assert.notEqual(click.selector, 'body', 'scoped to the filter list, not the whole page');
  });

  // The tier-2 composite must NOT restate the postcondition: it references the fragment, so it inherits one.
  // A copy is how the two drift when the next DOM read moves the landmark.
  it('the tier-2 composite declares no postcondition of its own — it inherits F3\u2019s by reference', () => {
    const s1 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_review_warranty_task');
    assert.equal(s1.postcondition, undefined);
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

  // v2.74.2171 — the postcondition's three hops, the ride Invariant-#3 shape. Hop 1 is here; hop 2 (mergeArtifacts)
  // is automatic via the `{ ...r }` spread; hop 3 (buildDriveFragment → fragment.postconditions) is asserted below.
  // A seeded Ground is the ONLY path that exercises all three — a catalog-invoked leg reads the entry directly and
  // would never notice a drop.
  it('the POSTCONDITION survives onto the record — the seeded path is the one that loses fields', () => {
    const f3 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_open_task_row');
    const rec = driveFromCatalogEntry(f3, { groundId: 'g1', origin: VS_ORIGIN });
    assert.deepEqual(rec.postcondition, f3.postcondition);
    assert.notEqual(rec.postcondition[0], f3.postcondition[0], 'copied, not shared with the frozen catalog');
  });

  it('an entry with no postcondition does not grow an empty one (absent stays absent)', () => {
    const rec = driveFromCatalogEntry({ id: 'x', appHost: 'a.com', tier: 1, steps: [] }, { groundId: 'g', origin: 'a.com' });
    assert.equal(rec.postcondition, undefined);
  });

  it('tier-2 params derive as the UNION of the composed tier-1 params (catalog-derived, no drift)', () => {
    const s1 = DRIVE_ARTIFACTS.find((e) => e.id === 'vsd_review_warranty_task');
    const rec = driveFromCatalogEntry(s1, { groundId: 'g1', origin: VS_ORIGIN });
    assert.deepEqual(rec.params.map((p) => p.name), ['DIVISION', 'STATUS', 'SEARCH', 'FIND']);
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
    assert.deepEqual(s1.params, ['DIVISION', 'STATUS', 'SEARCH', 'FIND']);
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
    // v2.74.2185 — F1 opens with the nav CLICK now, so find the readiness wait by role, not by index.
    assert.ok(actions.some((a) => a.action === 'WAIT_FOR'));
    assert.ok(!actions.some((a) => String(a.selector || '').includes('#divisionMenu')), 'v1803 — the phantom id is gone from the built actions too');
    const click = actions.find((a) => a.action === 'CLICK' && a.selector.includes('dhicon-down-open'));
    assert.ok(click);
    assert.equal(click.landmark, undefined);
    const pick = actions.find((a) => a.action === 'CLICK_BY_LABEL' && a.value === '{{DIVISION}}');
    assert.ok(pick);
    assert.equal(pick.selector, 'body');
  });

  // v2.74.2171 — hop 3. `postconditions: []` was the whole of "engine-success does not mean arrived": the engine
  // probes this array after the run and fails the fragment when it does not hold, and every drive artifact was
  // opting out of it.
  it('the record’s postcondition reaches fragment.postconditions — the gate the engine actually reads', () => {
    const f3 = seed().find((r) => r.id === 'vsd_open_task_row');
    const built = buildDriveFragment(f3, deps());
    assert.deepEqual(built.fragment.postconditions, f3.postcondition);
    assert.notEqual(built.fragment.postconditions[0], f3.postcondition[0], 'copied, not aliased to the record');
    assert.deepEqual(built.fragment.preconditions, [], 'preconditions stay empty — the section settle is the caller’s job');
  });

  it('a record with no postcondition still builds, with an empty array (never undefined)', () => {
    const built = buildDriveFragment(rec(), deps());
    assert.deepEqual(built.fragment.postconditions, [], 'the engine reads Array.isArray — undefined would be silently skipped');
  });

  it('paces interactive actions after WAIT_FOR (no double-wait before the settle step)', () => {
    const actions = JSON.parse(buildDriveFragment(rec(), deps()).fragment.rawJson);
    // v2.74.2180 — F1 now opens with TWO waits (the warranty view, then the division control), so assert the
    // PROPERTY rather than fixed indexes: consecutive WAIT_FORs get no pacing between them, and the first
    // interactive step is preceded by exactly one WAIT.
    // v2.74.2185 — the first step is the nav CLICK now, so state the invariant over EVERY interactive action
    // rather than over index 0: each is immediately preceded by exactly one pacing WAIT, and no pacing is
    // inserted ahead of a settle step. That survives any future re-ordering.
    const interactive = new Set(['CLICK', 'CLICK_BY_LABEL', 'TYPE', 'KEY']);
    actions.forEach((a, i) => {
      if (!interactive.has(a.action)) return;
      assert.ok(i > 0 && actions[i - 1].action === 'WAIT', `human-cadence gap before ${a.action}`);
    });
    actions.forEach((a, i) => {
      if (a.action !== 'WAIT_FOR' || i === 0) return;
      assert.notEqual(actions[i - 1].action, 'WAIT', 'no pacing is inserted before a settle step');
    });
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
    const built = buildDriveFragment(rec(), { ...deps(), resolvedSelectors: { 3: '#realMenu' } });   // v2185 — index 3 = the toggle CLICK (0 nav click, 1 view wait, 2 data wait)
    // the TOGGLE click specifically — step 0's nav click is also a CLICK since v2185, and `find` would take it.
    const clicks = JSON.parse(built.fragment.rawJson).filter((a) => a.action === 'CLICK');
    assert.ok(clicks.some((a) => a.selector === '#realMenu'), 'the probe-resolved selector replaced the catalog guess');
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
    { fragmentId: 'f_row', params: ['SEARCH', 'FIND'] },   // v2176 — the row fragment searches, then clicks
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
    assert.deepEqual(built.strategy.params.map((p) => p.name), ['DIVISION', 'STATUS', 'SEARCH', 'FIND']);
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
