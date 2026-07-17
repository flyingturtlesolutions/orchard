# DESIGN — Route-Heal (RH-0 / RH-1): the ride layer's self-heal

**Status: spec v1 (2026-07-17) — not built.** Companion to `DESIGN_connectors.md` (§17 harvest / §18 observability
/ §19 Forage — the machinery this composes), `DESIGN_target_routing.md` (unrelated "route"; this doc's route =
the REQUEST SHAPE). Live evidence: the Shopify 404 arc (traces 084032 + the v1560 `INVOKE ▸ … → FAIL http-404
empty` line) and the user's oracle: their Userdigest implementation — full session REPLAY of captured requests —
has never needed a Shopify relearn, while Orchard's distilled recipe broke.

## 1. The problem

Session-ride recipes ride PRIVATE, unversioned request shapes. Those shapes drift — paths move, required
headers appear, query/body framing changes. Today drift is a live failure → a manual forage → a hand edit.
Every other substrate already has its healing loop:

| Substrate | Drift | Self-heal |
|---|---|---|
| Landmarks | selectors rot | probe-or-recover |
| Walks | pages restructure | re-teach + retire-on-replace + start-establish (v1556) |
| **Ride recipes** | request shapes change | **nothing — RH is this loop** |

"Route" is deliberately broader than "path": the drifting thing is the whole request shape. The live 404 was
almost certainly a newly-required header, not a moved path — which reframes the priority order below.

## 2. RH-0 — capture fidelity (prevention; the Userdigest lesson)

**Full replay is drift-immune to additive requirements; minimal synthesis is not.** Userdigest re-sends the
complete captured request (headers and all); Orchard's harvest distills to endpoint + body and synthesizes a
minimal request — so the day the server starts requiring (or routing on) a header the distillation dropped,
the recipe breaks while a replay keeps working.

- **Harvest keeps headers:** the §17 tee retains request header NAMES + static values on captured reads.
  The credential class is stripped at capture (cookie / authorization / x-csrf-* / set-cookie — the auth layer
  acquires those live per-origin; they are never banked). `recipeFromHarvest` carries the surviving headers
  onto the banked recipe as `requestHeaders`.
- **Curated bases carry them too:** the schema already supports `requestHeaders` (CX-10 — Aircall's routing
  header; threaded to the identity probe AND the main call). The `SH` Shopify base gains its headers from the
  oracle diff (the user's working request vs ours) — the immediate unblock, and RH-0's first instance.
- **Threading discipline:** `requestHeaders` is a mechanical catalog field — invariant #3 applies (hop 1
  additive block / hop 2 spread / hop 3 reader already carry it for Aircall; verify on the seeded path when
  extending).

RH-0 removes most "relearning" before it happens. RH-1 handles the rarer true drift.

## 3. RH-1 — the healing loop

1. **DETECT** *(the v1560 signal, made stateful)* — a route-miss-class failure (`404/405/410` with an empty or
   HTML body) on a **previously-proven** recipe. Proven = curated, or accepted-harvest with a prior success
   (`lastOkAt` — a NEW per-Ground record field stamped by INVOKE_SESSION / SESSION_REPLAY on success; it is
   USER-STATE-class → added to `_USER_FIELDS` so the v1435 merge preserves it). Distinguishable by
   construction: auth failures present as signed-out verdicts; bad params as 400/422 with detail; genuine
   empties as 200. N consecutive (start N=2) → the record gains `driftSuspect` (user-state-class too) + one
   `HEAL ▸ suspect <recipeId> (<status> ×N)` line — the marker enters `_DECISION_RE` + the devBridge copy at
   authoring time (invariant #1).
2. **ARM** — the §17 read-tee on that origin's live tab, CONSENT-SHAPED: the panel proposes
   *"<app>'s request shape changed — do one <action> by hand (or just browse) and I'll relearn it"* — the same
   passive-forage arm the contacts capture used, triggered by the suspect flag instead of by hand. Auto-arm
   without the prompt is a SETTING, default off.
3. **OBSERVE** — the app demonstrates its own current shape; nothing is reverse-engineered.
4. **MATCH** *(the new pure piece — `matchCaptureToRecipe(capture, recipe)`, Core/recipeFromHarvest)* — pair a
   captured fetch with the suspect recipe by what did NOT drift: for GraphQL the query document / operation
   name; for REST the param set + response-key shape (the same fingerprinting the harvest generalizer already
   does, pointed at succession instead of novelty). Ambiguous match → no proposal (never guess).
5. **PROPOSE** — a HITL card showing the DIFF, not a blob: `path /api/shopify/{handle} → …` /
   `+ header x-shopify-…` / `param q → query`. Accept → the record's mechanical fields update via the existing
   `EDIT_RIDE_RECIPE` door. Durability: a CURATED entry's confirmed heal belongs in the catalog (the dev loop
   lands it; the v1435 merge then refreshes every ground) — the local heal is the bridge until it lands. A
   harvested recipe just updates in place.
6. **VERIFY-RATCHET** — the next invoke is the trial: success clears `driftSuspect`, stamps `lastOkAt`
   (the verify-on-first-use doctrine). Failure keeps the suspect state honest.

## 4. Hard lines

- **Reads only.** A WRITE recipe whose shape changed is never auto-re-pointed — a changed write shape can mean
  changed semantics; it goes through full §18 re-review (the write belts, confirm, two-step for destructive).
- The tee stays consent-gated; step 2 proposes, never silently records.
- Captured headers never include credentials (stripped at capture, not at bank).
- Proposals are five-second-readable diffs — the same promotion posture as the trial gate.
- Logs stay body-blind (`HEAL ▸` lines carry ids/status/field-names only).

## 5. Build ladder

- **RH-0a** — the SH `requestHeaders` fix from the oracle diff (unblocks Shopify; no new machinery).
- **RH-0b** — §17 tee retains headers (credential class stripped) + `recipeFromHarvest` banks them.
- **RH-1a** — `lastOkAt` stamping + the detect predicate + `driftSuspect` + `HEAL ▸` (+ decision regexes).
- **RH-1b** — suspect → consent-shaped arm proposal (reuse the passive-forage arm).
- **RH-1c** — `matchCaptureToRecipe` (pure + tested) + the diff card + EDIT_RIDE_RECIPE apply.
- **RH-1d** — verify-ratchet wiring.

The live Shopify break is the test vehicle for the whole ladder: RH-0a fixes it, and the capture that fixes it
seeds RH-1c's first fixtures.

## 6. Open questions

- Curated-heal round-trip: does an accepted local heal of a curated entry auto-file a catalog patch (the dev
  bridge could draft it), or stay a local override until hand-landed? (Local override must survive the v1435
  mechanical refresh — an explicitly-healed field may need shadowing rather than overwriting.)
- Drift telemetry: should `HEAL ▸` events feed OUTCOMES so per-app drift frequency is visible in Studio?
- N and the window for "consecutive" (2 failures within a day vs a week) — tune from live data.
