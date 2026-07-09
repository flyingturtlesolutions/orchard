# DESIGN — Overview: the leg workbench (OV-1..)

*Status: design (v2.74.1413). The Overview home becomes the developer/substrate plane where LEGS are added, tested,
verified, and published into the catalog apps consume. Apps stay pure consumers. Design-first (the canvas over-build
lesson): this doc locks the flow + the fork choices before the surface is built.*

## 1. The two planes

Orchard has two planes, and they were conflated until now:

- **Overview (home) = the SUBSTRATE / developer plane.** The reserved general-assistant conversation (`OVERVIEW_ID`,
  the ⌂ Rail pin) is the non-app home. Legs are GLOBAL — not owned by any app — so the home is their natural registry.
  Overview is where a leg is authored → tested → verified → published.
- **Apps = CONSUMERS.** Each app is a configured instance that, at setup, picks legs from the catalog Overview
  maintains (the AS-5 capability multi-select). An app never authors a leg; it selects and runs them.

"Overview becomes where legs are developed" = extend the Overview home from a plain general-assistant chat into a
**leg workbench**: its home view renders the cross-Ground leg inventory + the Add / Test affordances. The general
assistant stays; only the home VIEW changes (leg registry instead of generic suggestion cards).

## 2. The leg model (reuses what exists)

A "leg" is any invocable capability — the tri-class from `groundToolSurface` (DESIGN_connectors.md §18):

- **Drive** — a taught DOM capability (fragment/strategy/workflow; OBS demonstration).
- **Ride** — a session-ride recipe (curated `CONNECTOR_RECIPES` or §17-harvested), the API-less tail.
- **Broker** — an OAuth/MCP tool (`BROKER_CATALOG`).

Every leg already carries the lifecycle fields the workbench needs (no new schema): `provenance`
(curated/harvested/observed/broker), `safetyClass` (auto/gated/destructive/forbidden), `reviewState` (pending →
accepted), `trust`, `enabled`, and `armable` (the §18 arm guard — a stale/rejected/pending leg cannot run). A leg is
**verified** (ready for apps) when `armable && reviewState !== 'pending' && enabled`.

## 3. The flow (leg lifecycle)

```
        Add                 Test                  Verify              Maintain
  form/capture/demo  →  invoke live + verdict  →  accepted+armed  →  re-verify / disable / retire
     (pending)          (edit fields, retest)     (→ app catalog)      (arm guard gates runs)
```

1. **Add** — a leg enters `reviewState: pending` by one of three inputs (all have a code path already):
   - **Manual form** — host · method · endpoint · params · safety (hand-authoring a `CONNECTOR_RECIPES` entry, in
     the UI). Replaces the code edit.
   - **Capture** — do it once in the live tab → §17 harvest / persisted-op sniff derives the recipe. Replaces the ritual.
   - **Demonstrate** — "show me" → OBS drive (+ CX-8 forged ride).
2. **Test** — invoke the leg LIVE with sample params against the real site → render the result + a **pass/fail
   verdict**. On fail, **edit the leg's fields and re-test** — the no-code version of the SH-T loop (the `{company}`
   placeholder-echo / the `customerInput` variable name would each be a field edit + retest, not a code change).
3. **Verify** — a passing leg → `accepted` + armed + trust set → it appears in the app setup catalog (AS-5).
4. **Maintain** — re-verify on drift (`reverifyCapability`), disable, retire; the arm guard keeps a broken/unreviewed
   leg out of live runs regardless.

## 4. The Overview surface

The Overview home renders the **cross-Ground leg inventory** — one `groundToolSurface` per ground/connector,
aggregated (`Core/legOverview.js`, OV-1): grouped by ground/app, each leg a card showing class · name · safety ·
review state, with a **work queue** at top (pending / unverified legs). Two entry points:

- **Cards** (the home view) — Add-leg button per ground; per-card Test / Verify / Disable actions.
- **Chat commands** in the Overview thread (Orchard is chat-first): `legs` (show inventory) · `add leg` (form/capture) ·
  `test <leg>` (invoke + verdict). The fast path.

## 5. Fork choices (LOCKED)

- **Add, primary path** — **form + capture** (form replaces the code edit; capture replaces the sniff ritual).
  Demonstrate rides on the existing OBS flow.
- **Test verdict** — **structural** (non-error reply + expected fields present, deterministic like the trial gate) +
  the raw result shown for the eyeball. Not LLM-judged (a read returning the wrong shape is a structural miss).
- **Render** — cards as the home view + chat commands as the fast path.

## 6. Build order (slices — pure-first, each independently valuable + testable)

Status: **OV-1..6 BUILT + gate-green (v2.74.1417)** — headless-verified for the pure cores; the panel render + live
invoke need a live eyeball (chrome.storage/session seams the harness can't reach).

- **OV-1 (pure) — `Core/legOverview.js`** ✅: the cross-Ground inventory aggregator + rollups + work queue. Reuses
  `groundToolSurface`. Tested headless (7/7). *Bug fixed in the pass:* `armable` is DERIVED (enabled+accepted), not read
  from a non-existent stored field — else a `rejected` leg read as verified.
- **OV-2 — background `GET_LEG_OVERVIEW`** ✅ (`sg.js`): gathers every ground's ride recipes + a read-only drive
  (page-capability) summary, runs OV-1. Broker legs deferred (need linked-provider plumbing).
- **OV-3 — Overview render** ✅: `legs` renders a NUMBERED console inventory (work-queue first), not cards — the
  low-risk first cut; a cards home-view swap is a follow-up.
- **OV-4 — Test loop** ✅ (`Core/legTestVerdict.js` + `test N`): invokes a leg live → a structural pass/fail verdict.
  **Scoped to GET reads** (auto safety) — a write is NEVER auto-fired from the workbench (§9): it's armed here and fired
  only through an app's confirm gate. Two safety belts: the `safetyClass !== 'auto'` gate AND an explicit `method==='GET'`
  guard. *Known limit:* Shopify-class **gql/csrf reads** aren't testable here yet — `recipeFromCatalogEntry` is a lossy
  projection (drops gql/csrf/persistedOp), so the stored record can't faithfully reconstruct that transport. Follow-up:
  make the stored record the faithful invoke source (or fetch the catalog leg).
- **OV-5 — Add** ✅ (`Core/manualRecipe.js` + `add leg on <site>: <Name> | <M> <path>` + `ADD_RIDE_RECIPE`): author a
  ride recipe by a compact one-line spec (method-derived safety, lands `pending`). A DOM form is a follow-up.
- **OV-6 — Verify/arm** ✅ (`verify N` → existing `EDIT_RIDE_RECIPE {op:'review'}`): pending → accepted → app-consumable.
- Capture/demonstrate Add paths reuse §17 harvest + OBS (wire, don't rebuild) — not yet wired into the workbench UI.

## 7. Non-goals / reuse

Not rebuilt: `groundToolSurface` (per-Ground tri-class), §17 harvest (`recipeFromHarvest`), §18 arm guard + reviewState,
OBS demonstration, the trial/verify gate (`reverifyCapability`), the AS-5 setup catalog (the consumer end). OV assembles
these into one lifecycle surface; it does not invent a parallel one.
