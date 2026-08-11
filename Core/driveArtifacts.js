// Core/driveArtifacts.js — the BUILT-IN DRIVE catalog + per-Ground drive-artifact model (v2.74.1454).
//
// Heterogeneous legs, the tri-class model's payoff: on one site, RIDE handles quick retrieval (credential-free
// API replay) and DRIVE handles visual review + further action (landmark-backed clicks on the live page). Ride
// is built-in (CONNECTOR_RECIPES), so drive must be too — but a Drive capability is landmark-backed, and a
// built-in artifact is authored with NO live DOM, so it cannot ship a verified landmark. The answer is the
// PS-3 doctrine ("stage, verify-on-first-use", Core/synthFromGap.js): each catalog step ships a best-known
// SELECTOR GUESS plus a PROTO identity (role + accessibleName, no verified selector). On FIRST invoke the
// artifact HYDRATES — the live page is probed (LANDMARK_PROBE_OR_RECOVER, selector-first then identity
// recovery), the same library entities a taught capability produces are composed (Fragment(s) + Strategy +
// sgCapability, steps carrying INLINE SG-LM-3 landmarks so replay self-heals), persisted marked
// trial.verdict:'observed' — and that first run IS the visible trial: a clean pass promotes to 'trial-pass'.
//
// TIERS mirror specs/TIER_MODEL.md: a tier-1 entry is ONE reusable fragment (select a division, open a status
// tab, open a task row); a tier-2 entry COMPOSES tier-1 ids into a Strategy that REFERENCES their fragments
// (the T1→T2 reuse — hydrating the composite hydrates its fragments as standalone capabilities too).
//
// The per-Ground model mirrors Core/rideRecipe.js exactly: seeded by origin from this catalog, merged on read
// (mechanical fields refresh, user state preserved — and HYDRATION stamps preserved, the Invariant-#3 analogue:
// a catalog re-seed must never orphan an already-hydrated capability). PURE: no chrome / DOM / LLM / clock;
// `now` + `newId` are injected into the builders.

import { originMatchesAppHost, armable } from './rideRecipe.js';
export { originMatchesAppHost, armable };

/** host of an origin/url — lowercased, no scheme / trailing slash. PURE. */
function _host(origin) { return String(origin || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase(); }

// ── The curated catalog ───────────────────────────────────────────────────────────────────────────────────
// Authoring format per entry:
//   id/app/appHost/name/does  — identity + coaching text (same contract as CONNECTOR_RECIPES)
//   tier                      — 1 (one fragment) | 2 (composes tier-1 ids)
//   sectionPath               — the human page the artifact lives on (the nav-THEN-drive composition, v1453)
//   params                    — [{name (UPPER_SNAKE — a {{NAME}} template slot), enum?, hint?, required?}]
//   steps (tier 1)            — [{action, selector (best-known GUESS), proto:{role, accessibleName}?, value?}]
//                               proto is the recovery identity; an empty {{PARAM}} label SKIPS its click.
//   compose (tier 2)          — ordered tier-1 ids; params derive as the union of the composed entries'.
//   opens                     — v2.74.2196: the DOMAIN NOUN of the record this artifact walks to ('task' ·
//                               'ticket' · 'call'). Declared HERE because this is the thing that knows: the
//                               artifact is what reaches the record, so it is what can name it. Two surfaces
//                               read it and neither hardcodes a noun — the case card's button label, and the
//                               composer phrase that must key to this artifact rather than be interpreted.
//                               An artifact that only changes what the page SHOWS (pick a division, open a
//                               status tab) declares nothing: it does not open a record.
//   postcondition (tier 1)    — [{type, …}] page-family conditions (Services/ConditionVocabulary.js) that must
//                               hold AFTER the steps run, or the fragment FAILS. `{{PARAM}}` is substituted
//                               before the probe. This is what makes `ok` mean ARRIVED rather than "the clicks
//                               did not throw" — a tier-2 composite inherits it through the fragment it
//                               references, so declare it on the atomic entry that reaches the destination.
//   write                     — true → safetyClass 'gated' (slice 1 ships READ-shaped review flows only).

const VSD = Object.freeze({ app: 'vendorsuite', appHost: 'vendorsuite.drhorton.com', sectionPath: '/#warranty', catalogVersion: 15 });   // v2.74.2185 — 14→15: F1 CLICKS the Warranty nav item first, so the app runs its own route transition instead of inheriting an external hash change; v2.74.2183 — 13→14: F1 waits for the division NAME to be populated (:not(:empty)) before opening the menu — opening it while State is in flight crashes the site; v2.74.2180 — 12→13: F1 waits for the warranty VIEW (input[type=search]) before the app-header division control, so a cold start no longer clicks into a blank page; v2.74.2179 — 11→12: the expand step targets the chevron SPAN; :has() is REFUSED by resolveElement (contentScript.js:631) so v2178 never matched anything; v2.74.2177 — 10→11: after the search, EXPAND the collapsed result group (:has(.dhicon-down-open), so it can never collapse an open one); v2.74.2176 — 9→10: the row step SEARCHES first (the list renders collapsed into project groups, so the rows do not exist until narrowed); v2.74.2175 — 8→9: the status step is scoped to the OPTION list (ul.item-list.collapse-list); the old div.vertical-list matched the TRIGGER and opened the menu without selecting; v2.74.2174 — 7→8: the container is `ul.item-list.grouped`; `section.item-column ul.item-list` resolved to the status FILTER list (live: Available "Open","Closed","Fixed","New","Payment Requested"); v2.74.2172 — 6→7: the container scope moved from `ul.item-list` (generic — it is also the division dropdown) to `section.item-column ul.item-list`; v2.74.2171 — 5→6 re-invalidates the entities hydrated from the F2/F3 steps, re-authored below from a LOADED-LIST DOM read; v2.74.1812 — 4→5 for the previous F2/F3 pass; v2.74.1804 — 3→4 INVALIDATES the entities hydrated from the broken #divisionMenu steps; without the bump the stale fragments would replay forever

// ── v2.74.2171 — THE LOADED-LIST DOM, and it settles three things the catalog had been guessing ─────────────
// Read supplied by the user at `/#warranty` with task rows ON SCREEN and one task open (masked; the shapes are
// what matter). This is the read v2169 said the row and status steps could not be re-authored without.
//
//   counts: li_pointer 6 · table 0 · grid 0 · tablist 0
//   row:    span.bold    < div.flex.align-center.justify-between.pointer-select < div.flex-fill
//                        < li.pointer-select.flex.selected < ul.item-list < li
//   row:    span.medium  < (same chain)                       — the task NUMBER, beside the address
//   status: h5 < div.flex.justify-end.filter-button < div.vertical-list.collapsed.immediate-collapse
//   open:   article#warrantyTask · article#warrantyTaskDetails
//
// 1. THE TASK LIST IS `ul.item-list`, and its rows are `li.pointer-select` — the address is a `span.bold` and
//    the task number a `span.medium` inside each. v1812 authored `li.pointer-select` ALONE from a taught
//    replay's click path and kept only the first token, which is the generic pointer class the whole app puts
//    on nav items too (v2169: the first match on a bare section is "Settings"). Scoping by the LIST is what
//    separates the data from the chrome.
// 2. THERE IS NO TAB STRIP (`tablist: 0`, third read in a row). The statuses are `.filter-button`s inside a
//    `div.vertical-list.collapsed.immediate-collapse` — a COLLAPSED filter list, not tabs. `.nav-tabs,
//    [role="tablist"]` could never have matched anything.
// 3. AN OPEN TASK RENDERS `article#warrantyTaskDetails`. That is the first arrival landmark this arc has had —
//    see the postcondition on F3.
// v2.74.2172 — SCOPED BY THE SECTION, because `ul.item-list` is generic too. Live 13:09:24 with v2171's
// `ul.item-list` container: `Available: (none found); searched 0: (nothing with text)` — the container RESOLVED
// and held nothing, while the WAIT_FOR one step earlier had matched in ~1s. Both cannot be true of one element,
// so `querySelector('ul.item-list')` was returning a DIFFERENT list than the one the wait found. This file's own
// v1456 note says which: the division dropdown is "the OPEN dropdown list (`ul.item-list` of divisions)". Same
// mistake as `li.pointer-select`, one level up — I scoped to a class the app reuses.
// `section.item-column` is the task list's attested container (it is the row chain's top ancestor in the loaded
// read) and the division trigger lives in a page header, outside it. Document order then yields the OUTER
// grouped list, which holds every row.
// v2.74.2174 — AND `section.item-column ul.item-list` IS THE STATUS FILTER. Live 13:21:59, with the division and
// status both applied successfully: `Available: "Open", "Closed", "Fixed", "New", "Payment Requested"; searched 5`.
// The section's HEADER holds a `ul.item-list` of status filters and it precedes the task list in document order,
// so `querySelector` returned it. Third time a class in this app turned out to be shared — `li.pointer-select`
// (nav), `ul.item-list` (division menu), and now `ul.item-list` inside the section too. The task list's OWN
// distinguishing class is `grouped` (attested: `ul.flex-fill.item-list.grouped.vertical-overflow.webkit-scroll`,
// the group-header chain's parent); a flat 5-item filter list is not grouped. Single selector, not an OR —
// `querySelector` resolves a comma list in DOCUMENT order, not selector order, so an OR cannot express priority
// and would just re-introduce the same wrong-list win.
const VSD_TASK_LIST = 'ul.item-list.grouped';
// The ROW SHAPE, for the readiness wait: a list row's address span. Deliberately NOT `li.pointer-select` — that
// is the class the nav wears too, which is exactly how the old wait came to be satisfied by the sidebar.
// Scoped to the SAME root as the click, so the wait cannot pass against a list the click will not search — that
// disagreement is precisely what made the v2171 failure hard to read.
const VSD_TASK_ROW_READY = 'ul.item-list.grouped li.pointer-select span.bold, ul.item-list.grouped li.pointer-select div.flex-fill';
// v2.74.2175 — THE STATUS CONTROL'S REAL MARKUP, user-supplied:
//   <ul class="item-list vertical-list-content vertical-division-list job-view-list flex-fill item-list-hover
//              collapse-list">
//     <li data-value="open">Open</li> <li data-value="closed">Closed</li> … </ul>
// Two things follow, and the second is a defect.
//
// 1. IT CONFIRMS `ul.item-list.grouped`. The status menu carries `item-list` but NOT `grouped`, so the v2174
//    task-list container cannot match it. `collapse-list` marks a menu here and `vertical-division-list` says
//    the division picker is the same component — which is why plain `ul.item-list` kept resolving to a menu.
// 2. THE OLD SELECTOR CLICKED THE TRIGGER, NOT AN OPTION. `div.vertical-list` matched the control whose text is
//    the CURRENT value, so `CLICK_BY_LABEL "open"` hit `<div>Open</div>` — the trigger — which OPENS the menu
//    and selects nothing. Live twice (13:32:52, 13:33:31: `CLICK landed on <div> "Open"`), and the user watched
//    it: "status menu is opened then nothing after". The real options are `<li data-value>` inside the ul above,
//    and they are a different element entirely.
//
// SCOPED TO THE OPTION LIST, and that choice is deliberately PICK-ONLY: this container exists only while the
// menu is open, so a closed menu yields "no container matched" → the step is optional → it skips. The step can
// therefore never OPEN a menu, which is the v2164 rule (an optional open paired with a skippable close leaks the
// open state) enforced by construction rather than by care. Making status narrowing actually WORK needs an
// explicit trigger-click + option-click pair that cannot half-run; that is deferred, and it costs nothing today
// because the drive no longer sends STATUS at all (chat.js) and the ROW is the goal.
const VSD_STATUS_LIST = 'ul.item-list.collapse-list';
// Live DOM (v1456): `#divisionMenu` is the OPEN dropdown list (`ul.item-list` of divisions), NOT the header toggle.
// The toggle is the sibling `.self-stretch…pointer-select` showing the current division name + chevron.
// v2.74.1804 — `#divisionMenu` DOES NOT EXIST on the live site. Proven twice: the drive walk's own step
// (`WAIT_FOR #divisionMenu` timed out after 15s on a painted, authenticated page at /#warranty — trace 214431)
// and, independently, the gate probe before it (divisionMenu=false statusTabs=false — trace 212347). Every
// division selector here hung off that id, INCLUDING this toggle via `:has(#divisionMenu)`, so all three steps
// were unreachable. Replaced with the chain a REAL replay exercised successfully on this page (trace 190406:
// `SCROLL_TO → success` then `CLICK → success`, "CLICK landed on <h5>").
const VSD_DIVISION_TOGGLE = 'div.self-stretch.flex.align-center.pointer-select > h5.dhicon-down-open';
// Readiness: the toggle itself, or its container if the icon child differs — an OR so one class rename can't
// re-wall the walk. Used only to WAIT; the click uses the precise, evidence-backed form above.
const VSD_DIVISION_READY = 'div.self-stretch.flex.align-center.pointer-select > h5.dhicon-down-open, div.self-stretch.flex.align-center.pointer-select';

export const DRIVE_ARTIFACTS = Object.freeze([
  // F1 — atomic: wait for header chrome, click the division TOGGLE (not #divisionMenu — that's the list panel),
  // then pick a row inside #divisionMenu by label ("Atlanta West" matches "Atlanta West - 210 All" via contains).
  { ...VSD, id: 'vsd_select_division', tier: 1, name: 'Pick a division on the page',
    does: 'on the live VendorSuite warranty page, open the division menu and click a division by its NAME — a visual step (changes what the page shows), returns no data',
    params: [{ name: 'DIVISION', hint: 'the division name (e.g. "Atlanta West") — matches the menu row that contains it; blank keeps the current one' }],
    steps: [
      // v2.74.2180 — WAIT FOR THE WARRANTY VIEW, NOT THE APP CHROME. User, after the first two successful
      // walks: "works! but only if the starting state is https://vendorsuite.drhorton.com/#warranty — doesn't
      // work if user is on any other tab: opens /#warranty and stalls."
      //
      // The trace shows exactly that. Three Las Vegas clicks in one window (21:04:14, 21:05:14, 21:06:40) all
      // read `CLICK_BY_LABEL "Las Vegas" @ body — Available: (none found); searched 0: (nothing with text)`.
      // An EMPTY BODY: the division toggle had been found and clicked ~1.7s earlier, and then there was nothing
      // on the page at all. A fourth (21:04:51) timed out on the division control itself. Meanwhile the two
      // walks that started already ON /#warranty completed end to end.
      //
      // WHY THE OLD WAIT PASSED TOO EARLY: `VSD_DIVISION_READY` is the division toggle, which lives in the app
      // HEADER — it renders with the shell, before the warranty SECTION's content exists. So the wait was
      // satisfied by chrome again, one layer up from the v2171 `li.pointer-select` version of this same
      // mistake. `SHOW_SOURCES` cannot cover it either: a hash-only change does no document load, so
      // `_waitTabComplete` returns at once (the v2161 note in chat.js).
      //
      // The search input is the warranty VIEW's own control — attested on that page and already required by
      // fragment 3 — so it is the honest readiness signal. NOT optional: if the warranty view never renders,
      // every later step is a click into a blank page, and failing here names the real reason instead of
      // producing `Available: (none found)` three fragments later.
      // v2.74.2185 — ENTER THE SECTION THE WAY A PERSON DOES: CLICK THE NAV ITEM. User, and it is the whole
      // answer: "from any non-warranty tab, if I click warranty tab then eye -> it works. But if the auto drive
      // 'clicks' warranty the rest doesn't run. Is the click performed differently?"
      //
      // It is. We never click — `SHOW_SOURCES` does `chrome.tabs.update({url: '…/#warranty'})`, a hash change
      // applied from OUTSIDE the page. Clicking the nav item runs the app's own router transition, which is what
      // loads the division data; an external hash change can leave that transition unrun, so
      // `DivisionMenuContainer` renders with `menuItems: undefined` and throws (browser console, v2181).
      //
      // THIS RETIRES FOUR HYPOTHESES, all of which were about TIMING — cold navigation (v2181), our toggle click
      // inside the State window (v2181'), unpopulated division data (v2183), post-success detail state (v2184).
      // Each fitted one window and was refuted by the next, because none of them was about the MECHANISM of
      // arrival. Waiting longer cannot substitute for a route transition that never ran.
      //
      // Optional and first: on a tab already correctly in the section this is a no-op re-click of the current
      // nav item, and if the selector is wrong it degrades to exactly today's behaviour (which works warm).
      // The nav shape is attested — v2169's read showed `<li to="…" class="flex nowrap align-center
      // pointer-select" title="Settings">`, so nav items are `li.pointer-select` carrying a `title`.
      { action: 'CLICK', selector: 'li.pointer-select[title="Warranty" i]', optional: true },
      { action: 'WAIT_FOR', selector: 'input[type="search"]', value: '20000' },
      // v2.74.2183 — WAIT FOR THE DIVISION DATA, NOT THE DIVISION CONTROL. This is the readiness signal three
      // previous attempts missed, and it is expressible after all.
      //
      // The crash: our toggle click makes `DivisionMenuContainer` render with `menuItems: undefined`, `.reduce`
      // throws, no error boundary, React unmounts the tree (browser console, user-supplied). The window is the
      // app's own `/api/VendorSuite/State` fetch — "the cold read is ~7-12s", a number this codebase prints on
      // every ask. Every earlier wait asked "has it PAINTED?" (nav v2171, header filter v2174, view search box
      // v2180); the question is "has the DATA arrived?", and a selector cannot normally ask that.
      //
      // But it can here, because the toggle DISPLAYS the current division. User DOM read:
      //   <div class="self-stretch flex align-center pointer-select "><h5>Columbus</h5><h5 class="dhicon-down-open"></h5></div>
      // The name is the FIRST h5 and carries no class; the chevron is the second and carries one. `:empty`
      // matches an element with no children AND no text, so `:not(.dhicon-down-open):not(:empty)` means "the
      // name h5 exists and has something in it" — which it cannot before State lands, since the app has no
      // division to name. Pure CSS, no `:has()` (the v2179 lesson), so `resolveElement` will actually evaluate it.
      //
      // A SINGLE selector, not an OR: an OR would let "the toggle exists" satisfy "the toggle is populated",
      // which is the exact substitution that made the previous three waits meaningless. NOT optional — opening
      // that menu early destroys the page, so proceeding without this is worse than failing here.
      { action: 'WAIT_FOR', selector: 'div.self-stretch.flex.align-center.pointer-select > h5:not(.dhicon-down-open):not(:empty)', value: '20000' },
      // `optional` so a toggle-shape change degrades to "menu already open / unchanged division" instead of
      // failing the whole walk — the RISK this leaves is a blank {{DIVISION}}: its label-click skips (the v877
      // contract) and the opened menu could overlay fragment 2. Watch the next trace for a status-tab mis-click.
      { action: 'CLICK', selector: VSD_DIVISION_TOGGLE, optional: true },
      { action: 'CLICK_BY_LABEL', selector: 'body', value: '{{DIVISION}}' },
    ] },
  // F2 — atomic: open one of the warranty status tabs (label-scoped click — no brittle tablist proto).
  { ...VSD, id: 'vsd_open_status_tab', tier: 1, name: 'Open a warranty status tab',
    does: 'click the new / open / fixed / closed status tab on the live VendorSuite warranty page — a visual step, returns no data',
    params: [{ name: 'STATUS', enum: ['new', 'open', 'fixed', 'closed'], hint: 'which status tab to open' }],
    steps: [
      // v2.74.2171 — `.nav-tabs, [role="tablist"]` IS DELETED, not re-pointed. Three consecutive DOM reads put
      // `tablist: 0` on this page: there is no tab strip and there never was, so both halves of that OR were
      // dead selectors burning their budget (they were optional, so they burned it silently).
      //
      // What the statuses actually are: `.filter-button`s inside `div.vertical-list.collapsed.immediate-collapse`
      // — a COLLAPSED filter list. The container scope below is a real narrowing over `body` (which is how
      // "no option matched 'open' in container 'body'" happened, and how a stray `body` match on a division
      // name produced the false success of 16:51:18). It is NOT a fix: `collapsed` most likely means the
      // buttons are not visible, and clicking a hidden element does nothing.
      //
      // NOT GUESSED AT FURTHER, deliberately. Making this work needs an EXPAND click paired with the collapse,
      // and v2164's lesson is precisely that an optional OPEN with a skippable CLOSE is a leak by construction.
      // Narrowing by status is a CONVENIENCE anyway; the goal is the ROW (F3). So this stays optional and
      // degrades, and the walk's success no longer depends on it at all now that F3 has a postcondition.
      { action: 'CLICK_BY_LABEL', selector: VSD_STATUS_LIST, value: '{{STATUS}}', optional: true },
    ] },
  // F3 — atomic: open ONE task row by visible text (the durable form of v1453's generic text-click).
  { ...VSD, id: 'vsd_open_task_row', tier: 1, name: 'Open a warranty task row',
    does: 'open ONE task on the live VendorSuite warranty list — type its number into the page search box, then click the row; identify the row by the street address exactly as the list shows it, or the task number',
    params: [
      { name: 'SEARCH', hint: 'the task or ticket NUMBER to type into the page search box ("Find a ticket or task…") — this is what makes the row exist; blank leaves the list as found' },
      { name: 'FIND', hint: 'the row text to click — a street address as displayed, or a task/claim number' },
    ],
    steps: [
      // v2.74.2171 — WAIT FOR A ROW, NOT FOR THE APP. The old wait was
      // `li.pointer-select, table, [role="grid"], [role="table"]`: `table`/`grid` match nothing here (counts 0,
      // three reads running), and `li.pointer-select` is the class the NAV wears — on a bare section its first
      // match is "Settings". So the step that exists to wait for the list was satisfied instantly by the
      // sidebar, and the walk always proceeded to click against a list that had not rendered. That is the
      // single mechanism behind `Available: "toggle menu", "Download CSV"`.
      // v2.74.2176 — SEARCH FIRST, because the rows DO NOT EXIST until something narrows the list. This is the
      // answer to four versions of container-hunting, and it was never a selector problem at the end: with
      // `ul.item-list.grouped` finally resolving to the real task list (v2174), live 20:23:33 reported
      // `Available: "Hudson Glen(1)[id]", "Middleton(1)[id]", "Sherwood Estates(1)[id]"` — the list renders
      // COLLAPSED into project groups and holds only headers. The user's DOM read proves it:
      //   <li><h5 class="group-header … pointer-cursor" data-code="…"><span class="icon dhicon-down-open">…
      //       </h5><ul class="item-list"></ul></li>          ← the inner list is EMPTY; rowsNow: 0
      // The chevron is `dhicon-down-open` (collapsed), so the rows are rendered on expand and no selector could
      // ever have found them.
      //
      // WHY SEARCH RATHER THAN EXPANDING THE GROUP: the same read found
      //   <input type="search" placeholder="Find a ticket or task…">
      // The app ships the exact affordance this artifact needs. Expanding a group would mean clicking a header
      // whose chevron TOGGLES — the third toggle hazard in this arc after the division menu (v2164) and the
      // status trigger (v2175) — and would need the project name banked on the case as a fourth join. Typing a
      // number into a search box has no such state: it is idempotent, needs no new field, and an unset
      // `{{SEARCH}}` types blank (the v2.74.809 contract) which simply leaves the list as found.
      { action: 'TYPE', selector: 'input[type="search"]', value: '{{SEARCH}}' },
      // Optional: a `type=search` input usually filters as you type; Enter is the belt if this one needs a
      // submit. Optional so a no-op keypress cannot fail the walk.
      { action: 'KEY', selector: 'input[type="search"]', value: 'Enter', optional: true },
      // v2.74.2177 — EXPAND THE SEARCH RESULT. The search WORKS (live 15:42:29, v2176: `TYPE → success
      // "[task]"` then Enter, and the list narrowed from two groups to one — `Available: "Heartland Trails
      // 1.08(1)"` where the unsearched list had shown that plus "NPVV - Juno Pointe(1)"). But a search RESULT is
      // still a collapsed GROUP, so the row is not in the DOM yet. The user, watching it: "the division is
      // selected and the search is performed but no final two clicks — first on the search result, then on the
      // item".
      { action: 'WAIT_FOR', selector: 'ul.item-list.grouped h5.group-header', value: '6000', optional: true },
      // IDEMPOTENT BY SELECTOR, which is the whole design. `:has(span.dhicon-down-open)` matches ONLY a
      // COLLAPSED group — that chevron is the collapsed state (user DOM read: `<span class="icon
      // dhicon-down-open">` on a header whose inner `<ul class="item-list">` is empty). An already-expanded
      // group therefore does not match and is not clicked, so this step CANNOT collapse what it is meant to
      // open. That closes the toggle hazard by construction rather than by hoping the page is in the state we
      // expect — the fourth time in this arc a toggle has bitten (division menu v2164, status trigger v2175,
      // and the group header would have been the third and fourth).
      // Plain CLICK, not CLICK_BY_LABEL: after the search there is ONE group and it is THE result, so clicking
      // the first collapsed header needs no label — which means no project name to bank as a fourth join.
      // v2.74.2179 — `:has()` IS UNUSABLE HERE, and the resolver says so in as many words. contentScript.js:631:
      //   "Skip any selector using :has() — not supported in all querySelector contexts and causes silent
      //    failures."  →  `if (c.includes(':has(') …) continue;`
      // So v2178's guard was never evaluated at all: four live attempts, four `CLICK: no element matched …
      // :has(span.dhicon-down-open) [matches per prefix: seg1:1]` — the container matched and the step was
      // skipped by policy, not by the page. I authored a CSS feature the resolver explicitly refuses, with the
      // refusal written in the file I was calling.
      //
      // The chevron SPAN gives the same property without `:has()`: `span.dhicon-down-open` exists only while the
      // group is collapsed, so this cannot target an open one, and the click bubbles to the `pointer-cursor`
      // header — the same bubbling the division pick already relies on (`CLICK landed on <span> "Las Vegas -
      // 631"`). If it turns out the chevron class does NOT flip on expand, the next trace says so directly:
      // the click will succeed on an already-open group and the row wait will then fail with rows absent.
      { action: 'CLICK', selector: 'ul.item-list.grouped h5.group-header span.dhicon-down-open', optional: true },
      { action: 'WAIT_FOR', selector: VSD_TASK_ROW_READY, value: '8000', optional: true },
      // CONTAINER = THE LIST, not `body`. With `body`, CLICK_BY_LABEL's all-descendants scan can match ANY
      // element whose text contains the value — which is exactly how `FIND="Las Vegas"` matched the `<h5>Las
      // Vegas</h5>` inside the division trigger, clicked it, opened the dropdown, and returned success while
      // the page never moved (16:51:18). Scoped to `ul.item-list` that whole class of false positive is
      // unreachable: the division trigger is not in the list. The exact-match pass then lands on the row's own
      // `span.bold` (address) or `span.medium` (task number) and the click bubbles to `li.pointer-select` —
      // the same shortest-containing-element path the division pick already relies on (contentScript v1537).
      { action: 'CLICK_BY_LABEL', selector: VSD_TASK_LIST, value: '{{FIND}}' },
    ],
    // v2.74.2171 — THE FIRST POSTCONDITION IN THIS CATALOG, and the rung the journal has been naming since
    // v2163: "until the artifact declares a postcondition, every grade on it is a grade on the engine's opinion
    // of itself". An open task renders `article#warrantyTaskDetails` — attested in the loaded-list read above.
    // ExecutionEngine already probes fragment postconditions after the run (5s stabilisation) and FAILS the
    // fragment when they do not hold, so this converts `d.ok` from "the clicks did not throw" into "the task
    // detail is on screen". `vsd_review_warranty_task` inherits it for free: the tier-2 strategy REFERENCES
    // this fragment rather than copying its steps.
    //
    // RESIDUAL RISK, stated rather than hidden: if that article is present-but-hidden on the bare section, this
    // passes trivially. The evidence cannot rule that out — it was taken with a task already open. It is
    // self-checking in one run, because the log line already carries the independent `end=` witness (v2164): a
    // line reading `engine ok` together with `end="/#warranty"` would prove the condition trivial and nothing
    // else would. A DOM read on the bare section settles it outright and is the cheaper answer.
    postcondition: [{ type: 'selector_present', selector: 'article#warrantyTaskDetails' }] },
  // S1 — composite: the visual-review flow (the drive twin of the vs_warranty_tasks ride drill).
  { ...VSD, id: 'vsd_review_warranty_task', tier: 2, compose: ['vsd_select_division', 'vsd_open_status_tab', 'vsd_open_task_row'],
    // v2.74.2196 — VendorSuite calls it a TASK. Zendesk would say 'ticket' and Aircall 'call', and neither of
    // those needs an edit at either surface: the label and the phrase both resolve through `recordOpenerForHost`.
    opens: 'task',
    name: 'Review a warranty task on the page',
    does: 'OPEN the live VendorSuite site and visually walk to one warranty task — pick the division, open the status tab, open the task row. Use this to SHOW/REVIEW a task on screen (so you can eyeball or act on it); use the warranty-task data reads to ANSWER questions.' },
]);

// ── Catalog → per-Ground record (hop 1 of the seeded path) ────────────────────────────────────────────────

/**
 * Project one curated DRIVE_ARTIFACTS entry into a per-Ground record. PURE. Curated → trusted (trust 1),
 * `accepted`, `enabled`; safetyClass 'auto' for a click/nav review flow, 'gated' when the entry declares
 * `write:true` (slice 2). Steps + params + compose ride WHOLE onto the record — the record must stay
 * invocation-complete on the seeded path (the ride Invariant-#3 lesson, applied from day one here).
 * Tier-2 params derive as the UNION of the composed tier-1 entries' params (catalog-derived, no drift).
 */
export function driveFromCatalogEntry(entry, { groundId = '', origin = '', catalog = DRIVE_ARTIFACTS } = {}) {
  const e = (entry && typeof entry === 'object') ? entry : {};
  const rec = {
    id: String(e.id || ''),
    groundId: String(groundId || ''),
    origin: _host(origin) || _host(e.appHost),
    name: String(e.name || e.id || ''),
    does: String(e.does || ''),
    tier: e.tier === 2 ? 2 : 1,
    provenance: 'curated',
    safetyClass: e.write === true ? 'gated' : 'auto',
    trust: 1,
    enabled: true,
    reviewState: 'accepted',
  };
  if (e.sectionPath) rec.sectionPath = String(e.sectionPath);
  // v2.74.2196 — hop 1 of three, the ride Invariant-#3 discipline applied to the drive catalog. Hop 2 is
  // `mergeArtifacts` (`{ ...r }` carries it automatically); hop 3 is `seededDriveLegs`. Not a user field: the
  // noun is what the SYSTEM calls the record, so a re-seed refreshes it like any other mechanical field.
  if (e.opens) rec.opens = String(e.opens).toLowerCase().slice(0, 24);
  if (e.catalogVersion != null) rec.catalogVersion = Number(e.catalogVersion);
  if (Array.isArray(e.compose)) rec.compose = e.compose.slice();
  // v2.74.2171 — hop 1 of the postcondition's three (the ride Invariant-#3 shape, applied here): the record must
  // stay invocation-COMPLETE on the seeded path, so the success predicate rides onto it whole. Hop 2 is
  // mergeArtifacts, where `{ ...r }` carries it automatically; hop 3 is buildDriveFragment, which is the only
  // reader. Deep-copied so a catalog entry can never be mutated through a record.
  if (Array.isArray(e.postcondition)) rec.postcondition = e.postcondition.map((c) => ({ ...c }));
  if (Array.isArray(e.steps)) rec.steps = e.steps.map((s) => {
    const step = { ...s };
    if (s && s.proto) step.proto = { ...s.proto };
    else delete step.proto;
    return step;
  });
  let params = Array.isArray(e.params) ? e.params : null;
  if (!params && rec.tier === 2 && rec.compose) {
    params = []; const seen = new Set();
    for (const cid of rec.compose) {
      const c = (Array.isArray(catalog) ? catalog : []).find((x) => x && x.id === cid);
      for (const p of (c && Array.isArray(c.params) ? c.params : [])) {
        if (p && p.name && !seen.has(p.name)) { seen.add(p.name); params.push({ ...p }); }
      }
    }
  }
  rec.params = (params || []).map((p) => ({ ...p }));
  return rec;
}

/**
 * Seed a Ground's drive-artifact collection from the catalog: entries whose `appHost` matches the origin,
 * projected to records. PURE. The bridge from the global catalog → the per-Ground collection (mirrors ride).
 */
export function seedFromCatalog(catalog, { groundId = '', origin = '' } = {}) {
  const list = Array.isArray(catalog) ? catalog : [];
  return list
    .filter((e) => e && originMatchesAppHost(origin, e.appHost))
    .map((e) => driveFromCatalogEntry(e, { groundId, origin, catalog: list }));
}

// User-owned fields survive a re-seed; HYDRATION stamps survive too — a catalog refresh must NEVER orphan an
// already-hydrated capability (the drive analogue of ride's Invariant #3: the seeded path is the one that breaks).
const _USER_FIELDS = ['name', 'does', 'enabled', 'reviewState', 'safetyClass', 'trust'];
const _HYDRATION_FIELDS = ['capabilityId', 'fragmentId', 'strategyId', 'hydratedAt', 'hydratedCatalogVersion'];

/**
 * Merge `incoming` (a curated re-seed) into `existing` BY id, preserving user state + hydration stamps. PURE.
 * Mechanical fields (steps/params/compose/sectionPath/tier/catalogVersion) refresh from `incoming`; existing
 * records absent from `incoming` are kept. Hydration stamps survive ONLY when `hydratedCatalogVersion` matches
 * the incoming `catalogVersion` — a catalog step fix (bump catalogVersion) invalidates stale first-use entities
 * so the next invoke re-hydrates from the corrected steps (the v1455 live lesson: wrong protos frozen bad fragments).
 */
export function mergeArtifacts(existing, incoming) {
  const ex = Array.isArray(existing) ? existing : [];
  const inc = Array.isArray(incoming) ? incoming : [];
  const byId = new Map(ex.map((r) => [r.id, r]));
  const out = []; const seen = new Set();
  for (const r of inc) {
    const prior = byId.get(r.id);
    if (prior) {
      const keep = {};
      for (const k of _USER_FIELDS) if (prior[k] !== undefined) keep[k] = prior[k];
      const merged = { ...r, ...keep };
      const verMatch = Number(prior.hydratedCatalogVersion || 0) === Number(r.catalogVersion || 0);
      if (verMatch) {
        for (const k of _HYDRATION_FIELDS) if (prior[k] !== undefined) merged[k] = prior[k];
      }
      out.push(merged);
    } else out.push(r);
    seen.add(r.id);
  }
  for (const r of ex) if (!seen.has(r.id)) out.push(r);
  return out;
}

/**
 * v2.74.2196 — WHICH artifact opens a record on this host, and what that system CALLS the record.
 * PURE — reads the catalog (or a Ground's records), no storage, no DOM, so a surface can call it at render.
 *
 * The ruling this exists to satisfy: "Show task" is too domain-specific. The button, and the phrase it teaches,
 * are for viewing *whichever* record the case is tied to — a VendorSuite task, a Zendesk ticket, an Aircall
 * call. So neither surface may name a noun; both ask the artifact that reaches the record what to call it.
 *
 * A TIER-2 composite wins over a tier-1 fragment: the composite is the whole walk (division → search → row),
 * and it is what both surfaces invoke. Ties go to document order, which is authoring order.
 *
 * @param host      the system the record lives on ('vendorsuite.drhorton.com')
 * @param catalog   DRIVE_ARTIFACTS, or a Ground's merged records (same `opens`/`appHost`/`origin` shape)
 * @returns {{driveId:string, noun:string}|null}   null when no artifact on this host opens a record
 */
export function recordOpenerForHost(host, catalog = DRIVE_ARTIFACTS) {
  // Cut any path/hash/query, not just the scheme: callers hold a bare host today, but a URL landing here would
  // otherwise return null SILENTLY — a wrong verdict, which is the failure shape `incitedOpener` was already
  // bitten by. `_capIncitedBy` normalises the same way.
  const h = _host(host).replace(/[/#?].*$/, '');
  if (!h) return null;
  let best = null;
  for (const e of (Array.isArray(catalog) ? catalog : [])) {
    if (!e || !e.opens) continue;
    // A catalog entry carries `appHost`; a per-Ground record carries `origin`. Accept either so a caller can
    // pass whichever collection it is holding — the same shape tolerance `seedFromCatalog` relies on.
    if (!originMatchesAppHost(h, e.appHost || e.origin)) continue;
    if (!best || (Number(e.tier) === 2 && Number(best.tier) !== 2)) best = e;
  }
  return best ? { driveId: String(best.id || ''), noun: String(best.opens).toLowerCase() } : null;
}

/**
 * v2.74.2198 — HOW DO WE KNOW THIS WALK ARRIVED? PURE. Returns `{ declared, sectionPath }`.
 *
 * `declared` is true when the artifact carries a postcondition — DIRECTLY (a tier-1 fragment) or through a
 * fragment it composes (a tier-2 strategy REFERENCES its fragments, so the composite inherits the contract
 * without copying it). When it is true, the engine's verdict already means "the destination is on screen":
 * ExecutionEngine probes the postcondition after the run and fails the fragment when it does not hold.
 *
 * WHY THIS FUNCTION EXISTS, and it is a correction. v2164 ruled that engine-success is not arrival and made the
 * landing URL the witness instead — correctly, at the time: F3 shipped `postconditions: []`, so `ok` genuinely
 * meant "the clicks did not throw". v2171 filled that array. The URL witness then outlived its premise and
 * started vetoing a walk that HAD arrived — live, a successful `show task` reported "couldn't reach task
 * 4903279 — a step failed", because VendorSuite renders the task detail into the page without changing its
 * hash, so `end` stays `/#warranty` on success.
 *
 * `sectionPath` rides back so the URL fallback — which still applies to any artifact that declares nothing —
 * compares against the artifact's OWN section instead of a hardcoded `#warranty`.
 */
export function arrivalContract(driveId, catalog = DRIVE_ARTIFACTS) {
  const list = Array.isArray(catalog) ? catalog : [];
  const e = list.find((x) => x && x.id === String(driveId || ''));
  if (!e) return { declared: false, sectionPath: '' };
  const has = (x) => Array.isArray(x && (x.postcondition || x.postconditions)) && (x.postcondition || x.postconditions).length > 0;
  const declared = has(e) || (Array.isArray(e.compose) && e.compose.some((cid) => has(list.find((x) => x && x.id === cid))));
  return { declared, sectionPath: String(e.sectionPath || '') };
}

// ── Record → OfferedLeg (hop 3: the palette projection) ───────────────────────────────────────────────────

/**
 * Project a Ground's ARMABLE drive artifacts to interpret palette legs, next to its ride legs (heterogeneous
 * legs: ride ANSWERS, drive SHOWS). PURE. `domain:'connector'` + `tool.impl:'drive'` — the chat dispatch
 * branches on the impl marker (the v1453 sectionNav precedent), navigates to `sectionPath`, then invokes.
 * The §18-style arm guard applies (enabled + accepted only); dedup via `seenKeys`.
 */
export function seededDriveLegs(records, { host = '', groundId = '', seenKeys = null } = {}) {
  const out = [];
  for (const r of (Array.isArray(records) ? records : [])) {
    if (!r || !armable(r)) continue;
    const key = `me.drive.${r.id}@${host}`;
    if (seenKeys) { if (seenKeys.has(key)) continue; seenKeys.add(key); }
    const params = Array.isArray(r.params) ? r.params : [];
    const properties = {};
    for (const p of params) {
      if (!p || !p.name) continue;
      const prop = { type: 'string' };
      if (Array.isArray(p.enum)) prop.enum = p.enum.slice();
      if (p.hint) prop.hint = String(p.hint);
      properties[p.name] = prop;
    }
    out.push({
      key, name: r.name, does: r.does,
      mode: 'act', domain: 'connector', source: 'builtin',
      safety: r.safetyClass === 'auto' ? 'auto' : 'gated',
      params: params.map((p) => p && p.name).filter(Boolean),
      paramSchema: { type: 'object', properties, required: params.filter((p) => p && p.required === true).map((p) => p.name) },
      tool: {
        impl: 'drive', driveId: r.id,
        origin: r.origin || host, groundId: String(groundId || ''),
        sectionPath: r.sectionPath || '/', tier: r.tier || 1,
        ...(r.opens ? { opens: String(r.opens) } : {}),   // v2.74.2196 — hop 3: the noun rides the palette leg too, so a model-selected drive can name what it opens
        hydrated: !!r.capabilityId,
      },
    });
  }
  return out;
}

// ── Hydration builders (record + live-probe results → the library entities) ──────────────────────────────

/** Capability record shared shape — mirrors the observed/harvested caps (synthFromGap / DERIVE), UNVERIFIED
 *  until the first-use run passes. PURE. */
function _driveCapability(rec, { groundId, localeUrl, now, id, fragmentId = null, strategyId = null, fragmentIds = null, params = [] }) {
  const cap = {
    id, groundId,
    intent: rec.name, description: rec.does || rec.name,
    shape: 'observed', source: 'curated-drive',
    localeUrl: localeUrl || '', perspectiveId: null,
    landmarkUids: [],
    params: params.map((n) => ({ name: n, label: String(n).toLowerCase().replace(/_/g, ' '), used: true, value: '' })),
    aliases: [], phases: [rec.name], binding: [],
    synthesized: true, createdAt: now,
    trial: { score: null, verdict: 'observed', trialRef: null },
  };
  if (strategyId) { cap.strategyId = strategyId; cap.fragmentIds = Array.isArray(fragmentIds) ? fragmentIds.slice() : []; }
  else { cap.fragmentId = fragmentId; cap.fragmentIds = [fragmentId]; }
  return cap;
}

/**
 * Build a tier-1 artifact's Fragment + capability from its record and the live-probe results. PURE
 * (`now`/`newId` injected; the handler does the probes + saves). Steps keep INLINE SG-LM-3 landmarks
 * (role + accessibleName + the resolved-or-guessed selector) so replay self-heals via probe-or-recover.
 * `resolvedSelectors` maps step index → the probe-resolved selector (overrides the catalog guess).
 * @returns {{fragment:object, capability:object}|null}
 */
const _INTERACTIVE = new Set(['CLICK', 'CLICK_BY_LABEL', 'TYPE', 'SELECT', 'SET_FILE', 'KEY']);
const _PACING_SKIP = new Set(['WAIT', 'WAIT_FOR', 'WAIT_FOR_GONE', 'NAVIGATE', 'SCROLL_TO']);

export function buildDriveFragment(rec, { groundId = '', localeUrl = '', now = 0, newId = () => 'id', resolvedSelectors = {} } = {}) {
  if (!rec || !groundId || !Array.isArray(rec.steps) || !rec.steps.length) return null;
  const declared = (Array.isArray(rec.params) ? rec.params : []).map((p) => p && p.name).filter(Boolean);
  const actions = [];
  rec.steps.forEach((s, i) => {
    const selector = resolvedSelectors[i] || s.selector || '';
    const a = { action: s.action, selector };
    if (s.value != null) a.value = String(s.value);
    if (s.optional === true) a.optional = true;
    if (s.proto && (s.proto.role || s.proto.accessibleName)) {
      a.landmark = { role: s.proto.role ?? null, accessibleName: s.proto.accessibleName ?? null, selector: selector || null, hierarchicalContext: null };
    }
    // Human-cadence pacing after SPA settle steps — not before WAIT_FOR (which IS the settle).
    if (_INTERACTIVE.has(s.action)) {
      const prev = actions[actions.length - 1];
      actions.push((!actions.length || (prev && _PACING_SKIP.has(prev.action)))
        ? { action: 'WAIT', value: 1200, jitter: 600 }
        : { action: 'WAIT', value: 350, jitter: 750 });
    }
    actions.push(a);
  });
  const used = declared.filter((n) => actions.some((a) => typeof a.value === 'string' && a.value.includes(`{{${n}}}`)));
  const fragmentId = newId();
  const fragment = {
    id: fragmentId, groundId,
    name: String(rec.name || rec.id).slice(0, 80),
    description: rec.does || rec.name,
    rawJson: JSON.stringify(actions),
    params: used,
    // v2.74.2171 — hop 3, and the reason the field exists. `postconditions: []` shipped this catalog's artifacts
    // opting OUT of the one gate that could make success mean anything: ExecutionEngine probes this array after
    // the run (5s stabilisation) and fails the fragment when it does not hold. Empty was the whole of
    // "engine-success does not mean arrived".
    preconditions: [], postconditions: Array.isArray(rec.postcondition) ? rec.postcondition.map((c) => ({ ...c })) : [],
    healthStatus: 'untested', lastExecutedAt: null,
    synthesized: true, createdAt: now, updatedAt: now,
  };
  const capability = _driveCapability(rec, { groundId, localeUrl, now, id: newId(), fragmentId, params: used });
  return { fragment, capability };
}

/**
 * Build a tier-2 artifact's Strategy + capability, REFERENCING the composed tier-1 fragments (the T1→T2
 * reuse — no fragment duplication). PURE. `composed` = ordered [{fragmentId, params:[names the FRAGMENT
 * declares]}]; each fragment param binds `{kind:'strategy_param'}` so values flow scope → fragment at replay.
 * @returns {{strategy:object, capability:object}|null}
 */
export function buildDriveStrategy(rec, composed, { groundId = '', localeUrl = '', now = 0, newId = () => 'id' } = {}) {
  if (!rec || !groundId || !Array.isArray(composed) || !composed.length) return null;
  const usedNames = [];
  const fragmentSteps = composed.map((c) => {
    const paramBindings = {};
    for (const n of (Array.isArray(c.params) ? c.params : [])) {
      paramBindings[n] = { kind: 'strategy_param', name: n };
      if (!usedNames.includes(n)) usedNames.push(n);
    }
    return { type: 'fragment', fragmentId: c.fragmentId, paramBindings };
  });
  const strategyId = newId();
  const strategy = {
    id: strategyId, groundId,
    name: String(rec.name || rec.id).slice(0, 80),
    goal: rec.does || rec.name,
    // required:false — an unbound param substitutes '' and its label-click SKIPS (the v2.74.877 contract),
    // so "review the open tasks" without a division still walks as far as it can.
    params: usedNames.map((n) => ({ name: n, kind: 'scalar', type: 'string', required: false, label: String(n).toLowerCase().replace(/_/g, ' '), default: '' })),
    fragmentSteps, aliases: [], outcomeSignal: null,
    synthesized: true, createdAt: now, updatedAt: now,
  };
  const capability = _driveCapability(rec, { groundId, localeUrl, now, id: newId(), strategyId, fragmentIds: composed.map((c) => c.fragmentId), params: usedNames });
  return { strategy, capability };
}
