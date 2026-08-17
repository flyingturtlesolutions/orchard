# BUILD ARC — fleet self-update (SU)

*Sequenced plan for `DESIGN_self_update.md` (specced 2026-08-14; amended once from an underspecification pass,
then again from a multi-agent critical review that confirmed 8 findings — §12 of the spec). This doc is the
ORDER with the dependency logic stated; the spec is the contract. Decisions this arc adds are marked
**[arc-owned]** — those are this doc's to defend, not citations.*

**Where this picks up:** nothing is built. `tools/updater/` does not exist. The reusable seams the arc leans
on already exist and are used unchanged: the reload button + its dot (`#btn-dev-reload`, chat.html;
`_wireDevReload`/`onReloadState` in chat.js ~20321; the dev-bridge arm-source in `Services/Chat/devBridge.js`
~1882), the per-profile install id (`cloudlogs:installId`, `Services/Cloud/CloudLogShipper.js:93`), the CW
ship (`settings:cloudLogs`, default off), the decision-marker manifest (`Core/decisionMarkers.js`), and the
SW alarm idiom (`chrome.alarms.create` in background.js).

**The destination, and how it is measured.** A push no longer strands the fleet on an old build, and a bad
push is survivable without touching every machine. This is not abstract: internal release means no store
updater, so today every install freezes at whatever version it was cloned at until a human re-pulls it by
hand. **The arc closes when a `promote` lands a bump, every enrolled install converges its files within a
tick and beacons it in `glf`, AND an injected bad promotion can be frozen (`hold`) and fixed-forward
(`promote` → `release`) with no per-machine touch.** Convergence alone is half the feature; survivability is
the other half, and it is the half a naive build skips.

**The organizing principle** (borrowed from `BUILD_ARC_exec_channel.md`, and it earns its place twice here):
the thing that can fail for reasons OUTSIDE this repo goes FIRST, and the thing that delivers the benefit goes
LAST — so a half-finished arc is inert rather than loose. For this feature the ordering has a happy property:
the host updater is the mechanism and the dot is only the affordance, so **host-convergence-first** means a
half-built arc already works via the Chrome-restart backstop (§2 of the spec), and the signal is pure
enhancement stacked on top. Building the dot first would instead leave an affordance pointing at nothing.

---

## Rung 0 — SPIKE: the two load-bearing platform truths (the stop condition)

**What:** prove BY HAND, no product code, on one Windows box AND one Mac, the two assumptions the whole of
Alternative A rests on and that `DESIGN_self_update.md` §10 flags as believed-not-proven:

1. **Fresh-disk read.** On an unpacked install, from the service worker,
   `fetch(chrome.runtime.getURL('update/ready.json'), { cache: 'no-store' })` returns the CURRENT disk bytes
   after the file is changed on disk under a running extension — and **rejects** (TypeError /
   `ERR_FILE_NOT_FOUND`, not a 404 Response) when the file is absent. Test the absent case too: the SW poll's
   entire "unmanaged install → inert" behaviour depends on catch-not-404 (spec §3.3.1).
2. **Reset-then-reload lands the tree.** `git reset --hard` to a different commit on the loaded folder,
   followed by `chrome.runtime.reload()` (and separately, a full browser restart), runs the NEW tree in one
   hop — new service worker AND new content scripts, not a stale snapshot.

**Honest sizing:** half a day, most of it fighting two machines, not code.

**Why first — it is the arc's stop condition.** If truth 1 is false, the signal path cannot detect anything;
if truth 2 is false, the reload doesn't apply the update. Either falsification voids Alternative A wholesale,
and the honest response is to build NONE of the rest and pivot to Alternative D (HTTPS-zip artifact) or B
(managed CRX) — both of which change the transport but keep the promotion gate and beacons. **[arc-owned]:**
making this a cheap hands-on spike rather than "we'll find out at SU-2" is the whole point — the assumption
that can sink the design is the one you test before writing the code that assumes it. This is the repo's
recorded "DESIGN FIRST — twice over-built ahead of it" lesson applied to a platform assumption.

**Verify:** both truths observed on both OSes, or the arc stops. Write the observation into findings with the
Chrome version — this is the one result that ages with the browser and will need re-confirming after a major
Chrome update.

## Rung 1 — SU-0: branches, ignores, control (foundations, no behavior)

**What:** create the `fleet` branch and the dedicated `fleet-control` branch (holding only
`update/control.json` = `{ "hold": false }`, spec §3.2a); add `.gitignore` entries on `main`
(`/update/ready.json`, `/update/updater-state.json`, `/update/apply-in-progress`, `/.orchard-dev`); land the
spec + this arc. No runtime behavior.

**Honest sizing:** ~1 hour. It is pure plumbing, and it is deliberately its own rung so the two-branch model
(payload on `fleet`, kill-switch on `fleet-control`) exists before anything reads from either.

**Verify:** `git show fleet-control:update/control.json` parses; the ignore entries hold against a stray stamp
file at root; `fleet` exists at `main`'s tip.

## Rung 2 — SU-1a: `promote.cjs` — the gate that guards `fleet`

**What:** `tools/updater/promote.cjs`, the dev-side gate, per spec §3.1 + §3.1a + §3.2a:
- **default subcommand (promote):** fetch `origin/main` → candidate = its tip → materialize that sha in a
  throwaway detached worktree under `$TMPDIR` (never the repo root) → run the FULL gate THERE (`npm ci` +
  `npm test` + `node --check` on every shipped `.js` + the manifest-reference walk) → version-movement check
  (refuse if the candidate's `manifest.version` equals `fleet`-tip's while any shipped file differs) → push
  `fleet` to exactly that sha → remove the worktree in a `finally`.
- **`hold` / `release` subcommands:** commit+push only `update/control.json` to `fleet-control`, NO test
  gate, instant.
- **the manifest-reference walk (§3.1a):** brick tier (`background.service_worker`, `content_scripts[].js/css`,
  icons) + broken tier (`side_panel.default_path`, `web_accessible_resources`); refuse on any absent
  reference.

**Honest sizing:** medium (~1–2 days). The worktree orchestration is the fiddly part; the checks themselves
are cheap. It is `.cjs` in `tools/` — local toolchain, never the shipped bundle (it runs git + node), same
posture as `tools/progress-digest`.

**Why here — nothing may reach `fleet` until the gate that guards `fleet` exists.** This is the piece the
critical review's F1 (gate tested the wrong tree) and F5 (two-item blocklist) both land on, and it is the
ONE part of the feature fully testable with no Chrome and no scheduler. **[arc-owned]:** it may be built in
parallel with rung 3, but no real machine is enrolled (rung 3's installer run) until this lands — an updater
pointed at an ungated `fleet` is exactly the fleet-wide-brick path §4.1 exists to prevent.

**Verify — `npm test`-style fixture drills against a bare throwaway repo, every refusal named:**
- candidate is `origin/main`, NOT the local checkout: dirty the working tree with a test-breaking edit,
  confirm promote still passes (it gated the pushed sha, not the dirt) — this is F1's regression, and a
  refusal-by-dirt would mean the gate is still reading the wrong tree.
- version-non-movement refused; a dangling manifest reference (rename a content script, leave the manifest)
  refused; `hold`/`release` move `fleet-control` and NOTHING else; a worktree left behind on failure is a
  bug (assert cleanup).

## Rung 3 — SU-1b: the updater (node CLI) + installers — the external-risk rung

**What:** `tools/updater/updater.cjs` — **ONE node recipe** (spec §3.2, ruling 22 — not twin shell wrappers;
node joins git as a prerequisite, buying a single tested recipe with no cross-shell drift): lock (PID+age
steal) → torn-apply journal recovery → fetch `fleet` + `fleet-control` → read control (unparseable → hold) →
validate (no-`_`, manifest parses, brick-tier references exist) → apply (journal → `reset --hard` →
untracked-root-`_` scan) → stamp `ready.json` last → `finally` stamps `updater-state.json` (with
`state`/`lastError`/`hold`) and releases the lock. It reuses `promoteChecks.cjs`, so promote and the updater
share one pure core. The thin launchers `install-updater.ps1` / `.sh` **copy the script into the state dir and
register the Scheduled Task / LaunchAgent against the COPY** (spec §2, ruling 15 — the updater must not be
able to rewrite itself), set up the read-only credential (Windows logged-on-only task, NOT S4U; macOS
absolute node+git path + one interactive Keychain seed), stamp the per-clone machine GUID, and pin the clone
refspec so `origin/fleet` + `origin/fleet-control` resolve.

**Honest sizing:** medium (~1–2 days — the node-CLI decision halved it vs the twin-wrapper estimate). The
recipe is a single tested file; the risk that lives outside the repo is now confined to the launchers —
schtasks/launchd cadence, DPAPI/Keychain non-interactive access, git+node-under-scheduler PATH.

**Why after the gate, not before:** the updater's FIXTURE drills need only a bare fixture repo (no gate), so
they don't depend on rung 2 — but the first REAL enrollment does. Ordering the gate first means the external-
risk integration is exercised against a `fleet` that is already gated.

**Verify — each wrapper, headless fixture drills (the recipe is portable even where the platform isn't):**
- task/agent path is NOT under the clone (F3 — the run-from-copy invariant; a path under the clone is the
  bug);
- brick-tree refusal (incl. dangling manifest reference and an untracked-root `_` file surviving apply);
- `hold` via `fleet-control` stops apply but still stamps; unparseable control → hold;
- torn-apply journal recovery (leave a journal + dirty tree, confirm the next tick force-re-applies EXEMPT
  from the dirty guard — F6); stale-lock steal (dead PID / aged lock);
- stamp-on-every-exit (refuse paths write `updater-state.json`, not just success — F7); stamp-catch-up after
  a hand-pull; malformed-manifest parse under the per-OS JSON tool.
- **Live, per platform (the part fixtures can't reach):** Windows logged-on task cadence + DPAPI credential
  across lock/sleep/login; macOS LaunchAgent cadence across sleep/wake, absolute-git under launchd's PATH,
  Keychain non-interactive after the enrollment seed.

## Rung 4 — SU-2: the extension signal (SW detects, panel arms)

**What:** the extension half, per spec §3.3–§3.5:
- `Core/updateSignal.js` — PURE: `(pollResult {ok,version,at}, loadedVersion, persistedSeenSet) →
  arm | log-ready | log-ready-older | noop`, with a strict-newer semver arm and the seen-set dedup. Tested in
  the npm gate; this is where F4's logic and the fetch-reject handling live as pure decisions.
- SW alarm (~5 min): poll with `{cache:'no-store'}`, catch-reject → `{ok:false}`, publish
  `update:signal = {readyVersion, readySha, at}` + persist `update:seenReady` to `chrome.storage.local`,
  relay the `updater` heartbeat line (with the `state` enum).
- Panel (chat.js + devBridge.js): at init AND on `storage.onChanged`, compute button visibility as ONE
  merged `OR(devArm, updateArm)` in a single owner — the change that stops the two arm-sources from
  clobbering each other (F4, verified in the existing single-owner wiring); bridge-independent
  `chrome.runtime.reload()` click path.
- Boot diary: `update:lastRunVersion` compare → `UPDATE ▸ applied … lag=<mins|unknown>`.
- Three markers into `Core/decisionMarkers.js` (`update-ready`, `update-applied`, `update-updater`, all
  `metric:true`, the heartbeat's pattern narrowed) — invariant #1, the same-change discipline.

**Honest sizing:** medium (~2 days). The pure module and the markers are quick; the fiddly part is the
chat.js/devBridge.js merge — touching a strippable dev-only module's arm/clear cycle without breaking it is
exactly the seam F4 flagged, so it gets the care.

**Why after the host side:** with rungs 2–3 done, files already converge and a Chrome restart already lands
them — so this rung is the affordance, not the mechanism. A half-built signal (no `ready.json` yet) is inert
by construction (§3.3.1). Building it first would be a dot with nothing to point at.

**Verify:** `npm test` for `Core/updateSignal.js` (every branch: newer-arm, equal-noop, older-log,
fetch-reject-noop, seen-dedup across a simulated cold boot). Live-eyeball only what the harness can't reach —
**[arc-owned]**: the dual-source button showing OUTSIDE dev mode without breaking the dev-bridge arm/clear
cycle (the exact clobber this rung routes around), and the boot diary firing on all three landing paths
(click, restart, closed-at-apply).

## Rung 5 — SU-3: beacons proven in `glf`

**What:** confirm the three `UPDATE ▸` shapes actually reach the fleet view, per-install, and that the
observability precondition is real: cloud logs are on (enrollment turned them on) and identity is bound. A
never-opted-in install must be caught here, because it looks identical to "never enrolled."

**Honest sizing:** ~half day, mostly reading `glf` after a live tick.

**Why a rung, not a checkbox:** editing `decisionMarkers.js` is the change; a marker appearing in a real
fleet-log read is the proof — invariant #1 exists precisely because the edit keeps being made without the
check. And every "visible in `glf`" cell in the spec's §6 table silently assumes this precondition; this rung
is where the assumption is verified instead of asserted.

**Verify:** each `state` value observed (`ok` / `refused:dirty` / `refused:invalid` / `held` / `error`) —
provoke the refusals deliberately; `ready` and `applied` observed for a real convergence; each checked
against the enrollment roster so a cloudLogs-off install is caught rather than mistaken for unenrolled.

## Rung 6 — SU-4 + SU-5: the live fleet drills (the acceptance)

**What:** the two end-to-end drills, and the arc's real acceptance lives here.
- **SU-4 (convergence), including at least one Mac:** `promote` a trivial bump → watch every install `ready`
  → exercise all three landing paths (click one, restart another, leave one) → confirm the skew read and the
  multi-profile GUID dedup.
- **SU-5 (survivability):** `promote hold` → confirm every install relays `state=held` and stops applying →
  revert + bump on `main` → `promote` → `release` → confirm convergence. This is the fix-forward incident
  path, end to end.

**Honest sizing:** ~1 day of work plus real fleet wall-clock (ticks are 10 min; you wait).

**Verify — this is the arc's acceptance test, not a unit gate:**
- convergence: a bumped promotion reaches every install's files within a tick and beacons `applied`;
- survivability: `hold` demonstrably freezes a mid-incident fleet (every install `state=held`, no apply) and
  the fix-forward sequence converges it — with NO per-machine touch.
The second is the one that must not be skipped: convergence without a proven kill-switch is a feature that
can push a break to the whole fleet and not take it back, which is the exact hazard the second review's F2
was about.

## Rung 7 — the security pass, before the feature is trusted with the fleet

**What:** `/security-review` over the arc's whole diff, plus a deliberate red-team of the confirmed-finding
fixes — attack them rather than assert them:
- a fleet **read-only** token proven UNABLE to push `fleet`/`fleet-control` (branch protection or the
  signed-tag push guard, §7);
- the updater proven to run from the state-dir COPY, not the clone — modify `tools/updater/update.ps1` on
  `fleet`, confirm the running task does NOT pick it up (F3);
- `control.json` proven DATA-only — a hostile string in it reaches no command line;
- an untracked root `_` file proven to block `ready.json` (F5 tail); a torn `reset` (kill it mid-checkout)
  proven to self-heal via the journal, not wedge (F6); a hand-dirtied tree proven to surface as
  `state=refused:dirty` in `glf`, not silently (F7).

**Why a rung and not a checklist item:** every rung above proves its own slice works; nothing above asks
"what happens when someone tries to break it," and this feature grants same-day code execution to whoever can
push `fleet`. **[arc-owned]:** the confirmed findings are the pre-registered failure modes; this rung is where
they are attacked, and a fix that can't be attacked is a fix that isn't real yet.

**Verify:** each attack attempted and observed to be refused, with the refusal quoted. An attack that can't
be mounted is a guard that isn't wired.

---

## Milestones — four, each falsifiable

*Each states what must be true, how it fails, and — the column that matters most — what it does NOT prove, so
a milestone read as more than it is doesn't become a false "it works."*

### M1 — "the platform holds" · after rung 0 · no product code

**Claim:** on both OSes, the SW reads fresh disk bytes for `update/ready.json` (and rejects when absent), and
`reset --hard` + reload runs the new tree in one hop.
**Falsified by:** a stale read, a 404-instead-of-reject, or a reload that serves the old tree.
**Does not prove:** that anything is automated — only that Alternative A is physically possible here. It is
the stop condition, reachable without writing the feature.

### M2 — "a machine converges" · after rungs 2 + 3 · one real enrolled install

**Claim:** a `promote`d bump (gated by rung 2) lands on a real machine's disk within a tick, and a Chrome
restart runs it; a torn/failed tick self-heals and shows an honest `state` in `updater-state.json`.
**Falsified by:** files that don't converge · a bad tree that reaches the machine (gate hole) · a wedged
updater after an interrupted apply.
**Does not prove:** the dot, multi-machine, or the incident path. This is convergence via the restart
backstop only — deliberately, because that is the mechanism the dot merely decorates.

### M3 — "the fleet converges observably" · after rungs 4 + 5

**Claim:** every install arms the dot on a newer version, beacons `ready`/`applied`, and `glf` shows the
fleet converging with a readable skew.
**Falsified by:** a dot that clobbers or never arms (F4's regression) · a landing path that doesn't beacon ·
a marker absent from a `glf` read.
**Does not prove:** survivability. A fleet that converges beautifully and cannot be stopped is still one bad
push from a fleet-wide incident.

### M4 — "an incident is survivable" · after rung 6 · the acceptance

**Claim:** `promote hold` freezes a mid-incident fleet visibly, and `promote` → `release` fixes it forward,
with no per-machine touch.
**Falsified by:** a `hold` that can't reach the fleet while `main` is red (the F2 regression) · a held fleet
indistinguishable from healthy in `glf` · any step that requires shipping unvetted `main` work.
**Does not prove:** downgrade/rollback (there is none — fix-forward only, ruling 3). Survivability here means
freeze-and-fix-forward, not undo.

### The abandon criterion **[arc-owned]**

Stop the arc — build no further rungs — if **M1 is falsified** (pivot to Alternative D or B; the gate and
beacons survive the pivot), or if reaching **M2 requires the updater to run from inside the clone or to skip
the promotion gate.** The second is the temptation to watch for: at rung 3 the easy move is to point the
scheduler straight at `tools/updater/update.ps1` in the checkout — which is exactly the self-rewrite RCE F3
names. A convergence bought that way is the opposite of the safety the feature is for.

---

## Status

*Update this table at each rung's landing — an arc doc with no status is a plan, not a tracker.*

| Rung | Slice | Repo/area | Size | State |
|---|---|---|---|---|
| 0 | SPIKE: two platform truths | hands-on, 2 machines | ~half day | not started — **stop condition · → M1 · owed by the human** |
| 1 | SU-0 branches + ignores + control | git/repo | ~1 hr | **DONE** 2026-08-14 — `.gitignore` stamps + `.orchard-dev`; `fleet` (payload, at main tip) and `fleet-control` (orphan, `control.json`=`{hold:false}`) branches pushed to origin |
| 2 | SU-1a `promote.cjs` gate | tools/updater | ~1–2 days | **BUILT + TESTED** 2026-08-14 — `tools/updater/promote{,Checks}.cjs`; `node tools/updater/promote.test.cjs` = 40/40 (unit + fixture-repo integration: dirty-checkout-ignored, failing-gate, dangling-ref, version-not-bumped, node --check, no-op, hold/release off the payload) |
| 3 | SU-1b updater (node CLI) + installers | tools/updater | ~2–3 days | **BUILT + TESTED** 2026-08-14 — `updater.cjs` (one node recipe, not twin shell — ruling 22) + `install-updater.{ps1,sh}` launchers; `updater.test.cjs` = 21/21 (apply, no-op, hold, unparseable→hold, dirty-refuse, torn-apply recovery, stale-lock steal, brick-refuse, fetch-fail, stamp-every-exit). OS registration + credential = live-owed · **→ M2** |
| 4 | SU-2 extension signal | extension | ~2 days | **BUILT** 2026-08-14 — `Core/updateSignal.js` (pure) + test 21/21, 3 `UPDATE ▸` markers in `decisionMarkers.js` (test 5/5); SW glue `background/handlers/updatePoll.js` (poll + boot diary + heartbeat relay) + `background.js` wire + `chat.js` merged dual-source arming — undef-clean, full suite 4942. Core verified; the dot/beacons/SW-poll are **live-owed** |
| 5 | SU-3 beacons in `glf` | extension/observability | ~half day | not started — **→ M3** |
| 6 | SU-4 + SU-5 live drills (incl. Mac) | live fleet | ~1 day + wall-clock | not started — acceptance · **→ M4** |
| 7 | security pass | — | ~half day | **DONE (clean)** 2026-08-14 — multi-lens red-team (injection · trust · the 6 named attacks + integrity/DoS): **0 confirmed holes**; 13 guards tested + held (run-from-copy, control-data-only, no-shell git, untracked-_ block, torn-heal, dirty-refuse, same-origin signal, no-XSS); all 8 findings refuted as the accepted push-to-fleet=code-exec model or the deferred §7 signed-tag item. Folded 2 defense-in-depth hardenings (version-format validation, log-line sanitize) |

Rough total ~7–10 working days, of which rung 0 (platform truth) and rung 3 (scheduler/credential) are the
only ones that can be blocked by something outside this repo. Sizes are the author's estimate at spec time and
have not survived contact with the build.

## Rules that hold across the arc

- **`fleet` never tracks `main` automatically.** Only `promote.cjs` moves it, and only through the worktree
  gate. A raw push to `fleet` is the thing rung 7 tries to make impossible.
- **The updater runs from a COPY.** Never register a scheduler against `tools/updater/` in the clone. Updater
  upgrades = re-run the installer (a human act).
- **Default is inert.** No `ready.json` → the dot never arms; an unmanaged/dev install is unaffected by
  construction. Un-shipping is stopping the scheduler and deleting the stamps, not reverting extension code.
- **Version discipline joins the two halves.** Extension rungs (4–5) bump `manifest.json` and carry a
  findings entry. The host rungs (0–3) touch only `tools/` (never the shipped bundle) and carry NO manifest
  version — so name the state in findings, the way the exec-channel arc names its cloud commits, or the two
  halves can't be joined later.
- **Fix-forward is the only rollback.** No rung adds downgrade machinery; the incident path is always
  `hold` → revert + bump → `promote` → `release`.

## Not in this arc (SU-6 and beyond)

- **Provenance signing — now BUILT (SU-6, 2026-08-14, opt-in).** `tools/updater/attest.cjs` (Ed25519) +
  `promote keygen`/sign + updater `refused:unattested` verify + installer `--pubkey` pin. The Rung 7 review's
  one real residual; closes a raw push that skipped the gate. Tests: attest 11 + 6 updater drills. Live-owed:
  one real keygen→pin→promote→verify pass.
- **Rings / staged rollout** — the fleet is small; everyone converges at once, and the promotion gate is the
  blast-radius control. Revisit only when the fleet outgrows one channel.
- **Gentle browser-idle auto-reload** — deferred; added only IF `glf` shows chronic skew-hours (spec §4
  ruling 6 tripwire). The manual reload is the v1 gate, on purpose.
- **Token-vending credentials (D′)** and the **HTTPS-zip transport (D)** — deferred credential/transport
  upgrades, worth it only if per-machine revocation or git-on-every-machine stops scaling.
- **Downgrade / state rollback** — impossible by ruling 3 (storage shape can't time-travel); never built.
