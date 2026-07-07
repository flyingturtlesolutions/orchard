# Review register — chat + capability stack (2026-07-03, @ v2.74.1337 / 6b47f35)

Six parallel domain passes (chat core · legs/interpret · Drive+Ride · Broker · canvas+sources · Thread/Rail UX)
against the project invariants (fail-closed writes, busy-marking, hint threading, escape-first, Invariant #1/#2),
followed by spot verification of every load-bearing claim. Gate at review time: 1823 passing, 0 failing.
Status tags: **V** = verified by direct code read during synthesis · **C** = reviewer-confirmed (path traced) ·
**P** = plausible (needs a runtime check). Nothing here is fixed yet — this is the pre-fix register.

## The four systemic themes

1. **Turn-context globals are re-read after awaits.** `_currentConversationId/AppId/Seed/Config` + `_memoryId()`
   are read at completion time all over chat.js; every await is a window for a conversation switch to misroute
   output, misbank memory, or bypass a policy gate. One structural fix (a per-turn context snapshot captured at
   send and threaded through) collapses ~8 findings.
2. **Enforcement layers exist but are not wired.** `leg.safety` is computed by every producer and consumed by no
   live dispatcher; `policyFilter`/`assemblePalette` run only in a dormant module; the §18 arm guard is dead at
   runtime (mis-keyed in one handler, absent in the other); the server-side write re-check is a fail-open
   allowlist. The gates that DO hold (chat-side HITL confirms + handler fail-close) are re-derived ad-hoc per
   branch — currently correct, structurally fragile.
3. **The newest code (canvas/source bank, v1320–1337) concentrates the storage/context races** — per-context
   write chains, unserialized seq counters, error-blind doc lifecycle.
4. **The setup wizard is the one place bad state *persists*** — garbage becomes "verified" connections that
   poison later routing; everything else in the review is recoverable in-session.

## P1 — verified bugs

| # | Where | Defect |
|---|---|---|
| P1-1 **V** | chat.js:925 + post-await appends (4638, 4158-4182, 3513, 2148) | `appendMessage` stamps the conversation **current at append time**; the v1230 pin only protects pre-await bubbles. Switch conversations mid-flight → the reply renders into and persists to the WRONG conversation. |
| P1-2 **V** | chat.js:4337-4341, 4373-4377 vs 810/2280 | The CX-6 (ride) + CX-5c (broker) write-confirm bars never register with `_registerBarCancel`; a conversation switch wipes the buttons with the promise pending → `sendChatMessage`'s finally never runs → the conversation shows "● working…" forever. |
| P1-3 **V** | chat.js:5652-5662 | `handleInvocationCompleted` untracks and RETURNS when the bubble is gone (switched away) — the completed capability's result is never persisted anywhere; the origin conversation keeps the ask with no reply. |
| P1-4 **V** | Services/Storage/CanvasStore.js:38 | The RMW chain is a module-level Map = **per JS context**. The canvas tab and the SW each have one → compose-in-flight overwrites the user's concurrent textarea edits (rev clobber). Fix: CAS on `rev` or single-owner writes via the SW. |
| P1-5 **V** | background/handlers/canvas.js:102-105 (_renderGdoc) | ANY `get_document` failure (incl. `broker-unauthorized`, network) is treated as "doc vanished" → drops the stored doc id and creates a NEW Doc on recovery; the old one (shares/comments) is orphaned. Fix: recreate only on not-found. |
| P1-6 **C** (probe half needs one live eyeball) | chat.js:1694-1702 + Core/connection.js:127-131 + connector.js VERIFY_CONNECTION | Setup banks garbage: any single word shapes to an origin (`gmail` → `https://gmail`); the generic probe classifies the error-tab's URL SHAPE (no load signal) → verdict `connected` → pinned app + poisoned `target` for every later interpret. Whole sentences are rejected (space is a forbidden host char) — the trap is single words. |

## P2 clusters

### A. Safety layers unwired (legs/ride/broker)
- **V** chat.js dispatchers never read `leg.safety`; `IL_PANEL_LEGS` runs `NEW_DEV_CONVERSATION`/`TOGGLE_TRACKING`
  (both 'confirm') bare — and since v1180 `_tryIlCommand` fires as the DEFAULT fallback when interpret is
  unavailable, not just on explicit `il:`.
- **C** `policyFilter`/`assemblePalette` (the 'forbidden' floor + rule table) run only in dormant `Core/ilRun.js`;
  sg.js INTERPRET_ASK hand-assembles with no floor.
- **V** §18 arm guard dead: SESSION_REPLAY (where harvested recipes execute) has no `armable()` re-check and
  receives no groundId/recipeId (chat.js:4344); INVOKE_SESSION matches `payload.recipeId` (= prefixed `leg.key`,
  execPlan.js:99) against bare stored ids (rideRecipe.js:46) → never matches, always falls through.
- **V** index.js:1350-1358 `connectorIsWrite` is a fail-OPEN allowlist — unknown tool = read = no server confirm
  re-check; zero entries for MCP servers; MP-2c live tools never enumerated. Client `write` flag is
  client-supplied (brokerInvoke.js:26 trusts planExec).
- **C** SESSION_FETCH (contentScript:6141-6159) runs any non-GET handed to it — the confirm belt exists only in
  INVOKE_SESSION; single-belt.
- **C** Curated session WRITES have no HITL confirm branch in `_ilRunBuiltin` (only header-replay + oauth get
  one) → they dispatch unconfirmed, the handler fail-closes → the entire curated write catalog is unreachable
  (safe but a trap: the "obvious fix" would bypass HITL).
- **C** `safety:'gated'` (destructive, e.g. delete_event) renders the identical single confirm as 'confirm' —
  label-only tier.

### B. Turn-context globals after awaits (beyond the P1s)
- **C** chat.js:2415/2067 — the CV-6 write gate reads the CURRENT conversation's config at step time; chains keep
  running across switches → read-only app's chain can act under a permissive app's policy (and vice-versa false-blocks).
- **C** chat.js:4536-4541, 1638-1639, 2826 — `_bankCapabilityOutcome` uses `_memoryId()` at completion; fan-out
  synthesis uses seed/appId after minutes-long awaits → cross-app memory contamination (AP-0 defeated).

### C. Learning-loop poison
- **C** chat.js:4596 + 4342/4378 — user CANCEL of a write confirm returns `false` → banked as a capability
  failure (mismatch delta) — the same poison class v1328 fixed, on the cancel path. Return 'cancelled', skip bank.

### D. Persistence gaps (transcript honesty)
- **C** `_tryIlCommand` (4646-4739) + `_ilRunBuiltin` terminals + `_orchRun`/`_orchRunObservation`/`_orchRunChain`
  outcomes + interpret's teach line: zero `_orchFinalize` → replies are DOM-only, vanish on reload (CR-U1 class
  re-introduced on the newer paths).
- **C** chat.js:2120-2129 — `_orchFinalize` persists `textContent` with `markdown:false` → multi-line/markdown
  replies rehydrate as one run-on line. Persist the source text + markdown flag instead.
- **C** chat.js:5455-5459 — legacy param-fill cancel not persisted (unlike its sibling path).

### E. Stop coverage
- **C** chat.js:2859-2951 — `_orchRunChain` neither increments `_planLive` nor checks `_walkAbortFlag`: a
  runaway saved-workflow chain is invisible to "stop" (CR-S1 class re-introduced for the chain runner).

### F. Prompt/injection hygiene (all fence-adjacent, none currently exploitable end-to-end)
- **C** canvasPrompt SOURCES block is not sentinel-fenced — raw page text sits inline with a prose disclaimer;
  a poisoned article can spoof MEDIA MENU/ASK lines and steer minted LINKS (images are stripped; links are not)
  into a customer-facing draft. Wrap in BEGIN/END sentinels + a links-only-from-source rule (or strip minted
  links in deliverables too).
- **V** sourceBank.js:84 `ensureSourceAttribution` interpolates the untrusted page TITLE into `[title](kb:N)`
  unescaped — a `]`/`(` in a title forges a link to an attacker URL in the shipped draft. Escape/strip md metachars.
- **C** harvested-recipe + live-MCP `name`/`does` enter the interpret prompt unsanitized (`sanitizeToolString`
  runs only on the RAG path) — a crafted `does` can forge TOOL_CATALOG lines. Sanitize at render in
  buildInterpretMessages.
- Verified good: LEARNED ("STANDING RULES") writers are user-channel only; renderRecentTurns/subTasks collapse
  newlines; every chat.js innerHTML interpolation goes through escHtml/escAttr; strategy html fenced by
  isSafeStrategyResultHtml incl. rehydrate.

### G. Canvas/source seams (beyond P1-4/5)
- **V** canvasLower.js:35 — `_([^_]+)_` italic has no boundary guards: `file_name_v2`/underscored URLs are
  silently corrupted in SHIPPED drafts (markdown.js already carries the guarded version — copy it).
- **C** handlers/canvas.js:28 `_openCanvasTab` matches by substring — `app=x&conv=` prefixes `app=x&conv=abc`;
  the `canvas` command can focus the WRONG canvas tab. Exact-hash match.
- **V** sourceBank `mergedRefMap` iterates newest-first with Object.assign → on ref collision the OLDEST wins
  (comment says newest); + BANK_SOURCE seq counter is unserialized RMW (duplicate kb:N ids under concurrency).
- **C** the TAB backend never resolves inline `![alt](kb:…)`/`[title](kb:N)` (renderMarkdown has no image rule;
  kb: fails isSafeUrl) → literal ref text renders on tab-backend apps while BACKEND_PROFILES claims all-native.
- **C** canvasSpec diffSpec + canvas.js `_applyDiff`: id-less blocks land in added+removed every diff → vanish on
  live update; duplicate ids patch the wrong node. Dedupe/assign ids in normalize; fresh nodes for falsy ids.
- **P** handlers/canvas.js:114-125 image-fallback retry reuses the pre-paint `bodyEndIndex` — if attempt 1
  applied but its response was lost, the retry double-paints. Re-`get_document` before the fallback paint.
- **C** banked sources = up to 3×8k chars of arbitrary page text retained indefinitely and attached to every
  future compose — no `sources` list/clear command, no "rides future drafts" notice (llm_privacy egress surface).
- **C** every compose/revision steals tab+window focus (no `focus:false` from chat.js call sites); the
  deleted-Doc recreate is silent. Focus only on first open; add a "recreated your Doc" line.
- **P** latent: COMPOSE_CANVAS `p.sources` (panel-supplied) would bypass attribution/resolution which read
  `banked` — no live caller yet.

### H. Broker robustness/ops
- **C/ops** the REAL Google client secret is plaintext in `cdk.out/OrchardP0Dev.template.json` (git-ignored but
  on disk + readable via cloudformation:GetTemplate). Move to Secrets Manager (oauth.cjs reads at runtime) and
  ROTATE the current secret.
- **C** gmail.modify is consented + vaulted with NO working channel (google-gmail absent from CONNECTOR_CHANNEL
  and MCP_ENDPOINTS) — palette even offers a send that dies `unknown-mcp-server`. Drop from catalog/scopes until
  a REST adapter exists.
- **C** brokerInvoke.js:39-44 thrown-path drops `err.body` — server `write-needs-confirm` (403) is misnamed
  `broker-unauthorized` + wrong advice; 409/503 hints lost (the v1314 lesson applied only to the 200 path).
- **C** dead refresh token never downgrades `linked` (handleConnectorTools pushes provider before refresh; hint
  discarded) — palette keeps offering legs that fail only at invoke.
- **C** `_refreshConnectorState` rebuilds liveTools from this round only — one transient tools/list failure wipes
  a server's cached schemas. Merge per-server.
- **P** serial listMcpTools ×15s vs 29s Lambda budget → whole-route timeout with 2+ slow servers. Promise.all.
- **C** no access-token cache — a Google refresh-exchange on every invoke (quota + latency).
- **C** chat.js:4335/4371 — the HITL preview truncates at 400 chars while the FULL payload is sent: the user can
  approve content they never saw. Scrollable full preview.
- **C** gdoc renders bypass CONNECTOR_INVOKE ▸ observability (direct cloudInvokeConnector) — scope is bounded
  (storage-plumbed doc id, server re-checks), but §8.1-auto writes are invisible to a decisions download.
- **P4** UNLINK leaves the provider's liveTools entries in storage (inert).

### I. Leg-contract drift
- **C** primitives are rendered in TOOL_CATALOG (retrieveTools appends them) but `_idSet` rejects `op` → a model
  picking `act{capabilityId:'OPEN_URL'}` bounces to teach ("want to show me?") for a valid primitive.
- **C** two same-host connector instances emit IDENTICAL leg keys (`me.zendesk.read_ticket` ×2, different
  origins) — dispatch takes the first; the second instance is silently unreachable. Suffix host into the key.
- **C** four ref-precedence orders (palette keyOf / route _toolKey / interpret _idSet / interpretPrompt _toolRef)
  — route() would reject a key-only connector leg. One exported `legRef()`.
- **C** `applyConfidenceGate` skips `decompose`; interpret-built decompose decisions carry no `lowConfidence`
  flag → conf-0.1 decompose reaches the chain confirm (route.js fixed this exact class for its own path).
- **C** the act→replay confirm names the capability with `d.why` (LLM free text) and drops `reversible` → an
  irreversible replay gets soft wording. Look up the retrieved candidate; carry name/alias/reversible.
- **C** brokerLegsForLinked never adds to seenKeys (host variants → duplicate broker legs); `_seen` seeded from
  ragLegs `.key` which RAG candidates don't have (dedup intent is a no-op).
- **C** header-replay writes ignore `bodyType`/`contentType` (recipeToLeg drops them; chat.js hardcodes JSON) —
  form writes mis-send as JSON; raw-string bodies send EMPTY; SESSION_REPLAY reports 4xx as "✅ Sent → 400".
  Use fillWriteBody + carried contentType.
- **C** coerceParams handles integer/number only — a stringized `public:"false"` on add_comment serializes as a
  truthy string (the one field where that leaks an internal note). Coerce booleans.
- **P** ephemeral managed ride tabs leak when the SW dies before the 8s setTimeout close (module-singleton map).
  Reconcile on SW start or use chrome.alarms.

### J. UX (beyond the setup P1)
- **C** setup: "done" at zero connections silently re-renders (no "need ≥1 site" line); ALL commands typed
  mid-setup are consumed as answers (`link: google` → "I need a site…"); `_setupState` is in-memory only — a
  panel reload mid-setup silently routes wizard answers to the LLM.
- **C** no `help`/command list — setup/memory/remember:/seed:/teach:/link:/source/canvas:/subtasks:/workflows/
  distill/save as app:/tool: are learnable only from scattered hints; the slash picker lists capabilities only;
  typing "help" routes to the LLM (or becomes `https://help` mid-setup).
- **C** double-fire buttons: 👍/👎/🗑 feedback bar, dedup Merge, workflows ▶ Run neither remove-bar-first nor
  disable — ▶ Run double-click launches the chain twice. One shared once-guard.
- **C** the CX-6/CX-5c HITL confirm bodies are markdown rendered as PLAIN TEXT (literal ** and ``` walls at the
  highest-stakes moment) — pass `{markdown:true}` (escape-first path).
- **C** Rail rows are mouse-only divs (no tabindex/role/keydown); icon buttons title-only; #messages lacks
  aria-live → replies unannounced.
- **C** every Rail single-click is delayed 220ms by the dblclick disambiguation timer; dblclick-open is
  undiscoverable.
- **C** emoji voice leaks the internal route (🧠 = interpret path AND memory subsystem; grounded replies
  unprefixed; ✅/⚠️ inconsistent). Standardize outcomes; reserve 🧠.
- **C** placeholder rebrands to "Message Agent HUB…" after the first routed send (product is Orchard; the "/"
  hint is lost with it).
- **P** `.intent-menu` chip rows append to the `.message` flex ROW (not `.message-content`) and have no CSS —
  setup/rich-intent chips likely render squeezed beside the bubble. Needs one eyeball.
- **P4** trivia: every non-dev row gets an "app" badge; "🔌 Connecting to X…" bubbles never update with the
  verdict; no conversation rename affordance; `source` success template reads fields unguarded; canvas meta
  double-escapes appId.

### K. Maintenance / observability
- **C** chat.js is five programs (~Rail 224-770 · app/setup/fan-out 1091-1835 · grounded ORCH runtime 2036-3775 ·
  LLM front door 4140-4947 · legacy invocation lifecycle 5561-6008) + a 540-line command cascade with ~18
  hand-repeated guard blocks. Extract the command cascade to a declarative table FIRST (forces the per-turn
  context object = the structural fix for theme 1), then lift the ORCH runtime into Services/Chat/.
- **C** dead shelf: Core/ilRun.js + RETRIEVE_TOOLS handler + route.js Tier-0 alias branch (lookupAlias never
  injected) + PS_REACTIVE_SYNTH block + the unreachable `il:` strip (chat.js:5342); orchComprehend/orchRoute
  still live on the `tool:` cascade pending R-7.
- **C** Invariant-#1 gaps: NO `WORKFLOW ▸` marker exists (workflow recall pre-empts interpret invisibly); the
  ride-write confirm/send has no marker; the SW-side `INTERPRET_ASK "` line (candidate count + ground + RAW
  intent) is not in `_DECISION_RE`.
- **C** CJS parity gaps (drift possible with green tests): SSE/JSON response parsing, HTTP header construction,
  tools/call + tools/list normalization, the palette↔googleRest arg-name contract (the v1316 failure class),
  CONNECTOR_WRITE_TOOLS↔catalog write-tools, providerScopes↔adapter needs.
- **C** stale comments: sg.js "reads only" ×3 above a writes-projecting call; harvestedRecipeLegs' dead `mode`
  param; degrade-note formatter triplicated (chat.js ×2 shapes + handler ×1).

## Verified good (what held)
Templating injection (fillEndpoint encodes every value — no host/path/query escape), PKCE + state fail-closed,
anti-SSRF maps server-side + test-pinned, the render_document allowlist resists multi-key/__proto__/array
smuggling (validated set = serialized set), tokens/secrets have no route to the extension, busy-marking on all
engine emitters (session channels correctly not busy-marked), harvestTee is race-free + credential-scoped,
escape-first holds across chat.js and canvas renderer innerHTML sites, canvas diff keyed updates don't clobber a
focused editor, Rail delete cascade + sticky-follow autoscroll correct, astral/UTF-16 Docs indexing consistent.

## Recommended fix batches
- **Batch 0 — ops, immediately:** rotate the Google client secret; Secrets Manager read in oauth.cjs. **Code half
  ✅ BUILT in v2.74.1344**: `orchard/google-oauth-client-secret` Secret in the stack (ARN-only in template/env,
  grantRead), oauth.cjs runtime read (lazy SDK, container cache, JSON-or-raw, env-var fallback for local/tests),
  synth-verified 0 plaintext occurrences. **Remaining user half:** `cdk deploy` → `put-secret-value` with a freshly
  ROTATED secret (Google console: add new secret, keep old active) → verify a linked-Google flow → disable+delete
  the old secret → drop GOOGLE_OAUTH_CLIENT_SECRET from the deploy shell. Refresh tokens survive rotation (bound
  to client id). **2026-07-07 LIVE-VERIFIED**: deploy + put-secret-value + rotation ran; a calendar read answered
  through the full SM-read path. v1345 also committed the (public) client id as the stack default — future deploys
  need no shell env at all. Remaining: disable+delete the OLD secret in the Google console (user).
- **Batch 1 — correctness spine (P1-1/2/3 + clusters B/C/D/E): ✅ FIXED in v2.74.1338.** Shipped: appendMessage
  `convId` origin pin + detached (persist-only) foreign bubbles, threaded through `_tryInterpret`'s turn snapshot
  (`{convId, appId, seed, memoryId, connections, target}` captured pre-await) + `_dispatchRouteDecision`;
  `_registerBarCancel` on the CX-6 + CX-5c write confirms (+ their bodies render as markdown now); a user Cancel
  returns `'cancelled'` and is never banked; `_bankCapabilityOutcome` takes the turn's memoryId; completion
  handler persists a compact terminal to the invocation's origin conversation when the bubble is gone
  (`_invocationConvs`); `_orchFinalize` on every il:/builtin/run/observation/chain terminal + the teach line +
  param-fill cancel; `_setMessageBody` stashes source text + markdown flag so persistence stops flattening
  multi-line replies; `_orchRunChain` registers with `_planLive` (stop works) + clause-boundary abort + origin
  `policyConfig` threaded into `_runResolvedStep` (plan runner pinned too); fan-out synthesis keys to the
  fan-out's own app. NOT yet covered (deferred within cluster B): walk-step + feedback-bubble convId threading
  (legacy paths), `_tryInterpret`-throw placeholder cleanup (P2 chat-8, PLAUSIBLE).
- **Batch 2 — setup wizard (P1-6 + J-setup): host-shape floor + reach-probe belt ✅ FIXED in v2.74.1339** (the
  P1-6 poison-persistence half). Shipped: the live typed-answer path now shapes through the shared `originFromText`
  FLOOR (`chat.js` `_targetFromText` → `Core/setupSpec.js`), so a bare word ("gmail"/"help"/"done!") is rejected and
  the modal re-prompts instead of banking `https://gmail`; `originFromText` parsing fixed so the documented
  `localhost[:port]` dev exception actually works (it was mis-parsing the port as a scheme); `VERIFY_CONNECTION` now
  passes `requestedHost` to `classifyReachProbe`, so a park/redirect onto a foreign host is `unreachable` (belt over
  the already-shipped non-http(s)-final-URL → `unreachable` floor). Tests added (setupSpec + connection).
  **J-setup leftovers ✅ FIXED in v2.74.1340:** command fall-through mid-setup (`_SETUP_COMMAND_RE` — a
  command-shaped message is never consumed as a site answer; the flow pauses in place), the done-at-zero message
  ("nothing is connected yet…" instead of a silent re-render), and `_setupState` persistence across a panel reload
  (mirrored to `chrome.storage.session`, re-adopted lazily per conversation).
- **Batch 3 — safety re-arming (cluster A + F) ✅ FIXED in v2.74.1340.** Shipped: INTERPRET_ASK's candidate set runs
  through `policyFilter` (the 'forbidden' floor is live; `policyFilter` made keyOf-tolerant so RAG candidates pass);
  dispatchers honor `leg.safety` — panel legs (NEW_DEV/TOGGLE_TRACKING) + residual act legs (CLOSE_TABS) confirm via
  the shared `_hitlConfirmBar`, and 'gated' is a REAL tier (two-step destructive confirm, wired into the CX-6 +
  CX-5c write gates too); server write-check fail-closed (`CONNECTOR_READ_TOOLS` allowlist — an unknown tool/server
  now demands `confirmed:true`); arm-guard rekey (legs carry the BARE `tool.recipeId`; execPlan sends it +
  `tool.groundId`, so INVOKE_SESSION's §18 guard actually matches) + SESSION_REPLAY runs the same armable re-check +
  SESSION_FETCH refuses a non-GET without `confirmed:true` (second belt at the content-script boundary); the curated
  session-write HITL branch exists (the write catalog is reachable — exact-request preview, then `confirmed:true`);
  `sanitizeToolString` at render in `buildInterpretMessages` (harvested/MCP name/does/param names); SOURCES text
  sentinel-fenced in canvasPrompt (embedded «…» defanged) + the links-only-from-source rule; attribution title
  markdown-escaped in `ensureSourceAttribution`. Tests added (palette, execPlan, connectorLeg, connectorRecipes,
  interpretPrompt, canvasPrompt, sourceBank — 1836 passing). NOT covered here (unchanged): the Lambda change is
  source-only (deploy is a separate step); gmail catalog/scope removal stays in Batch 5 (H).
- **Batch 4 — canvas seams (P1-4/5 + G) ✅ FIXED in v2.74.1341.** Shipped: **P1-4** — `writeCanvasSpec({ ifRev })`
  CAS so the canvas tab's edit save and the SW's compose can't rev-clobber each other (tab rebases on refusal, up to
  3 retries); **P1-5** — `_renderGdoc` recreates a Doc ONLY on 404/not-found (`googleRest` now carries `status`; auth/
  network failures keep the stored doc id); image-fallback retry **re-gets** before repainting (stale `bodyEndIndex`
  double-paint belt). **G:** italic word-boundary guards in `canvasLower.parseInline`; `mergedRefMap` first-seen-wins
  (newest bank entry wins collisions); `BANK_SOURCE` seq mint serialized (no duplicate `kb:N`); exact hash match for
  canvas tab focus (no `app=x&conv=` prefix trap); tab backend renders markdown via shared `mdToHtml` + banked ref map
  (inline `kb:` images/links resolve); `_hygieneIds` in `normalizeCanvasSpec` (stable `_b<i>` + de-dupe); focus-once
  (compose/revision no longer steals tab/window focus; `display`/`canvas` still focuses); `sources` / `sources clear`
  commands + `LIST_SOURCES`/`CLEAR_SOURCES` handlers; banked-source notice on `source` bank; Doc recreate surfaced
  to the panel ("Your old Doc was gone…"); removed the latent `p.sources` compose override. Tests added (CanvasStore
  CAS, canvasLower italic, canvasSpec id hygiene, sourceBank mergedRefMap — **1840 passing**). NOT covered here
  (unchanged): Lambda `status` field needs deploy for P1-5's 404 belt to be reliable against live Google (hint-regex
  is the fallback for older lambdas).
- **Batch 5 — contract + drift (I + H-robustness + K-markers/parity) ✅ FIXED in v2.74.1342.** Shipped: **I**
  `Core/legRef.js` (one ref precedence everywhere); primitives `capabilityId:'OPEN_URL'` honored; host-suffixed
  connector keys; decompose `lowConfidence`; replay confirm looks up retrieved name/reversible; `fillWriteBody` +
  `bodyType`/`contentType` on header-replay + session writes; boolean `coerceParams`; **H** `brokerReplyFromCloud`
  reads `err.body`; dead refresh token drops from `linked`; liveTools merge on refresh; oauth access-token cache;
  full (scrollable) HITL preview; gmail catalog removed; **K** `WORKFLOW ▸` / `RIDE_WRITE ▸` / `INTERPRET_ASK "`
  in `_DECISION_RE`; parity tests (`legRef`, oauth cache, fillWriteBody, catalog/scopes). **1856 passing** (headless).
  NOT covered: Lambda deploy for linked-downgrade + token cache; live HITL scroll feel.
- **Batch 6 — UX polish (J) ✅ FIXED in v2.74.1343** (the high-value, clearly-correct subset). Shipped: **once-guard
  buttons** — a shared `_mkOnceBtn` (self-disables synchronously before `fn`, `lockBar` disables the whole bar for
  single-choice bars) applied to the feedback 👍/👎/🗑 (lockBar), the dedup Merge (self, multi-cluster), and both
  workflow ▶ Run bars (the flagged double-launch is closed). **help** — a `help`/`commands`/`?`/`what commands`
  guard renders the grouped command reference (was learnable only from scattered hints; "help" used to route to the
  LLM). **slash-picker verbs** — 15 command verbs surfaced in the `/` picker (a "/" badge; selecting INSERTS the
  verb text, never auto-runs). **placeholder** — restored "Message Orchard… (type / for capabilities)" (was
  "Message Agent HUB…", losing the name + the "/" hint). **a11y** — `#messages` gets `role=log`/`aria-live=polite`;
  Rail rows (`_wireRowKeyboard`) get `role=button`/`tabindex`/`aria-label` + Enter/Space activation (were mouse-only
  divs). **intent-menu** — setup + rich-intent chips append to `.message-content` (not the flex `.message` row) and
  get real chip-row CSS (`.intent-menu`/`.intent-chip` had none). **connecting-line** — the setup "🔌 Connecting to
  X…" probe bubble now SETTLES in place (✅ Connected / 🔑 signed-out / ⚠️ unreachable) instead of dangling +
  spawning a second bubble. Gate 1856/0 (UI-only; not headless-testable). DEFERRED (needs a live eyeball or is a
  design-judgment sweep, noted honestly): **voice standardization** (the 🧠-leaks-the-route emoji rework — a broad,
  subjective, high-churn sweep across hundreds of `_setMessageBody` sites; better done deliberately than mechanically)
  and **Rail 220ms latency** (removing the click/dblclick disambiguation is a feel change that can't be verified
  headless — dblclick-to-open would need a keyboard/UX redesign first). **markdown HITL bodies** was already covered
  in Batch 1 (the CX-6/CX-5c confirms render markdown).
