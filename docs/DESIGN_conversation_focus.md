# DESIGN — Conversation Focus (the FC arc)

**Status: as-built v1 (FC-0..FC-5, v2.74.1552).** Companion to `DESIGN_target_routing.md` (the content∥target
split, one level down) and `DESIGN_conversations.md` (cases, DK-8). Live evidence: traces 20260716-133636 /
-142359 / -144407 — "show this ticket" inside a case navigated the WRONG SITE with the literal noun, three
different upstream claims in a row (interpret leg-pick, then the FL-1e section-opener twice).

## 1. The problem, stated once

A case is an entity-scoped conversation — it exists to hold ONE item (DK-8e: "each case is born holding its
record + join ids"). Yet a reference ask inside it ("show this ticket", "what's the address?") was resolved by
lexical intercepts racing each other over the BARE TEXT, none of which could know the conversation held an
entity. Each failure got a phrase-pattern patch (v1550, v1551); each patch was one more racer.

The root cause is a broken invariant, not a missing intercept:

> **Orchard is a dual-plane system: every artifact exists as STRUCTURE for the code and PROSE for the model**
> (a leg: `tool` vs `name/does`; a walk: steps vs intent; a target decision: the pure ladder vs the `TARGET ▸`
> line). The case spawn built the prose plane only — `CASE_RECORD` seed fence + `case_record` message — and
> DISCARDED the structure (`fanoutItems` row, the drilled record object, the source leg) at `planSubTasks`'
> `{label, detail}` projection. Every consumer then had to re-parse prose or miss.

## 2. The concept

**Every conversation carries a `focus`: a persisted, ordered working set of grounded entity handles. A case is
a conversation BORN WITH FOCUS. Reference resolution — binding a referential ask to a focus entry — is one
deterministic stage; a bound referent's provenance settles the target before any vocabulary ranking runs.**

- One mechanism, two entry points: **seeded** (case spawn pins its record) and **accreted** (any grounded read
  pushes an entry — the durable generalization of `_lastGroundedRead`/FL-1d, which was the right semantics with
  the wrong scope: a module variable with a 10-minute TTL).
- Focus is **working state, not memory**: it dies with the conversation, is never promoted to instance/preset
  memory, and the desk membrane (§5 of the target spec) does not apply to it.
- Referent ≠ venue: focus binds the ENTITY; the entity's **provenance** (ground, leg, drill, itemUrl, bound
  params) supplies the venue. The verb picks the surface (on-site open vs field answer vs render).

## 3. Schema (`Core/conversationFocus.js`, pure)

```js
{ kind: 'record' | 'list',
  noun: 'warranty tasks',            // from the source leg's name, cut at by/for/with qualifiers
  nounTokens: ['warranty','task'],   // derived vocabulary (+ singulars) — binder + TR-2 hints read these
  label: '1441 Carisbrooke Drive…',  // display identity (also the dedupe key with kind+host)
  fields: { …scalars only },         // record entries: the drilled object MERGED over the list row
  rows: [ … ≤6 pruned rows ],        // list entries
  provenance: { groundId, host, recipeId, itemUrl, drill: {via, from, param}, params, labels },
  pinned: true?,                     // the case-born record — the conversation's identity entry
  at, }
```

Pruning discipline: scalars only, strings ≤400 chars, ≤48 keys, rows ≤6 — an entry stays ≤~4KB; the set is
capped at `FOCUS_CAP = 5`, newest first, **pinned entries exempt from eviction**, dedupe by kind+label+host
(re-reading a record updates in place and moves to front).

## 4. The referent stage (binder rules)

Gate (lexical SHAPE only — `referentialAsk`): verb ∈ show/open/view/display/pull up/bring up, then a deictic —
`this|that|it` (+ optional noun), `the <noun>` (definite REQUIRES a noun), or bare. Any ≥3-digit run → null
(an explicit number keeps the v1522 on-site intercept). Binding requires ENTRY EVIDENCE (`bindReferent`):

1. **Specific noun** — ask tokens ∩ `entry.nounTokens` ("the warranty task", "that zendesk ticket"). Two
   distinct entries tie → **ambiguous** → ask the user (the ladder's never-guess doctrine).
2. **Generic noun** ("the ticket/task/record/claim/item/case") — matches any `record` entry; **pinned beats
   recency** (in a case, "this ticket" IS the case — the user's framing), then newest.
3. **Pure deictic / bare** ("show this", "open it") — head of focus (pinned first, then newest) — the FL-1d
   recency precedent, made durable.
4. List words (them/list/results/items) bind list entries — v1 the stage does NOT act on them (falls through
   to the existing bare-show flow); reserved FC-6.

Acting (`_openFocusEntry`): find-value + division from **fields/labels** (`recordFind`/`recordDivision` — key
priority: /ticket/ → /task number/ → `drill.from` → any id-ish ≥6 digits) → synthesize the canonical phrase →
the PROVEN `_openRecordOnSite` walk/drill machinery, siteWord from provenance host (exact, not the v1550
`'site'` generic that survived only while one drill-bearing ground existed). Last resort: a banked `itemUrl`
that fills entirely from the record's own ids → SHOW_SOURCES. The SYNTHESIZED phrase is what runs and what
alias-records — a demonstrative can never key an alias.

Back-compat: a pre-FC case (no `conv.focus`) falls back to `focusFromSeedRecord` — the fenced `CASE_RECORD`
parsed once into a synthetic entry (fields from its `Key: value` lines) — same stage, same opener.

## 5. Consumers collapsed

| Was | Now |
|---|---|
| v1550/1551 demonstrative bridge (regex over seed prose) | **deleted** — the referent stage over structure |
| `_fieldFollowup` → `_lastGroundedRead` only (TTL; dead in a reopened case) | falls back to the focus head record — durable; stale (>30 min) answers carry a `refresh` hint |
| FL-1d bare-show recency (module var) | unchanged live; focus is the durable twin (list-entry act = FC-6) |
| `case_record` message | a RENDER of focus (refresh re-upserts it), no longer a parallel source |
| `_showSection` demonstrative reject (v1551) | kept — belt |

Accretion (FC-3): the four grounded-read sites that set `_lastGroundedRead` also push a focus entry (record or
list). The module var stays as the fast in-panel cache; focus is the conversation-scoped durable layer.

## 6. Target routing interaction (FC-4)

- When the referent stage claims, it logs BOTH lines: `FOCUS ▸ "<ask>" → <label> (find, division) on <host>`
  and `TARGET ▸ tier=TR-2/focus target=<host> why=focus(<noun>) auto` — the target question is DERIVED
  (dereference, not inference); the TR ladder is untouched for non-referential asks.
- `resolveTarget` ctx gains `focus: [{groundId, host, nouns}]`: TR-2's conversation-tier candidate pool =
  desk connections ∪ focus provenance grounds, with focus-noun matches counted into the affinity score and
  `why=focus affinity (…)` when the focus ground wins from outside the desk pool. Both markers pre-exist in
  `_DECISION_RE`/devBridge `DECISION_RE` (`FOCUS ▸`, `TARGET ▸`) — invariant #1 satisfied.

## 7. Safety posture (unchanged, now explicit)

- Focus binds ids/params into **banked recipes and taught walks only**. Provenance is a `groundId`/host
  reference captured at sweep time from the trusted catalog — never minted from record CONTENT ("targets
  resolve against KNOWN origins only" holds). `itemUrl` is a curated/banked template filled with record ids.
- The `CASE_RECORD` fence stays exactly as-is (the LLM's copy; focus is the code's copy). Record content
  remains data-never-instructions; nothing in focus is promotable to memory; write verbs keep both belts.

## 8. Staleness (FC-5)

Snapshots age (the $0 budget gets approved; the task gets assigned). Routing is immune — ids don't age.
Display answers from a focus record older than 30 min append a one-line hint; `refresh` (`re-pull`) re-runs
the drill via provenance (`GET_RIDE_RECIPES` → parent leg → `drill.via` → join id from `fields[drill.from]`),
re-prunes fields, re-upserts the `case_record` card. No head with drill provenance → the word falls through
to normal routing unchanged.

## 9. Build ladder (as built)

- **FC-0** — thread structure through the spawn seam: `fanoutItems` row + drilled object merged into
  `item.fields`; `planSubTasks` carries `focus`; `ConversationStore.create/patchMeta` accept `focus`; restore
  on rehydrate. *(appDef.js, connector spawn path in chat.js, ConversationStore.js)*
- **FC-1** — `Core/conversationFocus.js` + tests: schema/prune/push, `referentialAsk`, `bindReferent`,
  `recordFind`/`recordDivision`, `nounFromLeg`, seed-record fallback parser.
- **FC-2** — the referent stage in `sendChatMessage` (above the ops/bare-show/section intercepts), the
  `_openFocusEntry` opener, `_fieldFollowup` focus fallback; v1550/51 bridge deleted.
- **FC-3** — grounded reads accrete focus entries (module var demoted to in-panel cache).
- **FC-4** — `TARGET_RESOLVE` threads `ctx.focus`; TR-2 pool ∪ focus + noun bonus; tests.
- **FC-5** — staleness hint + `refresh` via drill provenance.
- **FC-6 (deferred)** — list-entry actions ("open the second one", "show them"), full `_lastGroundedRead`
  retirement, cross-case sibling references ("the other Raleigh case").

## 10. Open questions

- Refresh cadence: on-reopen auto-refresh vs on-demand only (current: on-demand + hint).
- Should a case's pinned entry survive `clear chat`? (Today: yes — focus lives on the entity, not messages.)
- Ambiguity UX: the v1 "which one?" text reply vs the pick-bar component the ladder uses elsewhere.
