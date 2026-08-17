# DESIGN_self_update.md — Fleet self-update for repo-direct distribution (SU)

**Intent (one line):** a deliberate promotion builds a VERIFIED artifact and converges every fleet install's
FILES onto it — automatically and observably, never a tree that can't load — while the RELOAD onto those
files stays a human act (the existing header reload button, lit), because the app ships internally from the
repo, not the Web Store, and there is no store updater to lean on.

Written 2026-08-14 from the internal-release ruling: no Web Store listing; installs clone this repo and
`Load unpacked` (the repo root IS the extension — no build step). **Amended same day** after the
underspecification review — twelve rulings (§11) reshaped v1: manual reload via the reused dev-reload
button, no rings / no deadline, fix-forward only, an updater heartbeat relayed through the existing CW ship,
a dev-side promotion gate, per-profile extension-minted identity, and a Windows + macOS fleet.
**Amended AGAIN same day** after a multi-agent critical review — eight confirmed findings folded (§12):
the promotion gate now tests the artifact it ships (not the dev's dirty checkout), the kill switch moved off
the payload branch, the updater runs from a copy outside the clone it resets, the signal path split SW
detection from panel arming, load-validation walks the manifest's file references, the tick gained crash
recovery + stamps every exit, and the §4.6 skew mechanism was corrected (it was backwards).

Companion specs: `DESIGN_cloud_logs.md` (the CW ship the beacons ride), `DESIGN_exec_channel.md`
§"reload is special" (teardown ordering for any reload path), `DESIGN_dev_bridge.md` §5 (the reload button
this generalizes from dev-only to dual-source).

---

## 1. Why Chrome can't do this natively here

- **Web Store auto-update:** unavailable — internal release, not listed.
- **Self-hosted CRX + `update_url` + `ExtensionInstallForcelist`:** the "official" off-store path, but the
  policy is honored only on MANAGED browsers (domain-joined or CBCM-enrolled). The fleet runs on unmanaged
  Windows + macOS machines, where Chrome ignores the policy — and it would introduce a pack/sign step into a
  repo whose identity is *no build step*. Revisit only if the fleet becomes managed (§8-B).
- **Unpacked extensions have NO native updater** — but they serve files from DISK. That is the whole
  opportunity: replace the files, then reload, and the update is live. This spec is the discipline around
  those two steps — with the ruling that step two is a human's click.

## 2. Shape — three parties across the existing trust boundaries

- **Host half — the updater** (installed COPY, not the clone): a 10-minute scheduler firing **one node CLI,
  `updater.cjs`** (ruling 22, superseding the twin-wrapper ruling 12) — Windows: Scheduled Task; macOS:
  LaunchAgent; each just runs `node <state-dir>/updater.cjs`. ONE tested recipe, no cross-shell drift, no
  per-OS JSON parser; the launchers stay per-OS only because scheduling + the credential store are genuinely
  platform-specific, the logic is not. It reuses `promoteChecks.cjs`, so promote and the updater share one
  pure core. Owns code ACQUISITION only: fetch → control → validate → apply → stamp. **The script the
  scheduler runs lives in the per-OS-account STATE DIR, not in `tools/updater/` inside the clone** (ruling 15
  / §4 ruling 8) — because the updater hard-resets that clone, and a script that resets its own source lets a
  bad push rewrite the updater and run arbitrary host-shell as the logged-in user on the next tick.
  `tools/updater/` in the repo is the SOURCE the installer copies out; updater upgrades happen only by
  re-running the installer, a human act. Prerequisites on both platforms: **git and node**, both one-time
  installs (the "no node on fleet" assumption was relaxed 2026-08-14 — node buys the single tested recipe;
  ruling 22). The extension never holds git; the updater never touches Chrome. Everything Chrome-side is
  platform-identical by construction — unpacked serving, profile-scoped storage, the `_`-prefix load refusal
  are Chrome rules, not OS rules.
- **Extension half — the signal** (SW poll + the header reload button): owns UPDATE VISIBILITY and
  OBSERVABILITY, never timing. The **service worker DETECTS** disk-newer-than-loaded and publishes the fact
  to `chrome.storage.local`; the **panel ARMS** the reload button's dot from that published state (§3.3 —
  the SW cannot touch panel DOM, so detection and arming are split across the storage boundary). Beacons
  ride the existing CW ship so the fleet is readable from `glf`.
- **The human — the reload gate** (ruling 6): the user clicks the lit reload button when THEY are at a
  stopping point. No auto-reload exists, so no update can ever interrupt a demonstration, a walk, or a live
  customer interaction. A full Chrome restart also lands the new version (unpacked loads fresh from disk at
  browser start) — the free backstop for users who never notice the dot.

The handshake between halves is files on disk; the handshake with the human is one lit button.

## 3. The cycle

### 3.1 Promotion (dev side — the runs-but-broken gate, ruling 5; hardened by the second review)

`node tools/updater/promote.cjs`, run on the dev machine (where node + the toolchain live). It **never
trusts the working tree it sits in** — this repo's steady state is a dirty checkout (uncommitted, LIVE-on-
reload builds), so "run `npm test` here" would gate a tree the fleet will never see. Instead it builds and
tests the exact artifact it ships:

1. `git fetch origin main` → resolve the **candidate sha = `origin/main` tip** (never local `main`, never
   the working tree — both can carry uncommitted or unpushed state; pushing `fleet` from an unpushed local
   main would even publish orphan commits `origin/main` never referenced). Refuse if `origin/main` is
   unreachable.
2. Materialize that sha in a throwaway worktree OUTSIDE the repo root:
   `git worktree add --detach "$TMPDIR/orchard-promote-<sha7>" <sha>` (temp dir, never under the repo — a
   worktree at root would itself trip the `_`-prefix load refusal, and scratch-outside-root already governs).
3. Run the FULL gate IN THAT WORKTREE — the only tree that gets executed, byte-identical to what the fleet
   hard-resets onto: `npm ci` + `npm test` (green) + `node --check` on every shipped `.js` + the
   manifest-reference walk (§3.1a).
4. **Version-movement check:** refuse if the candidate's `manifest.json` version equals the current
   `fleet`-tip version while any shipped file differs. An unbumped behavior change would land fleet-wide with
   ZERO signal (§3.3.2 is a version gate) and can race Chrome's cached SW script against new disk files. A
   bump is required to ship — the versioning discipline is now an update-delivery invariant.
5. Push `fleet` to EXACTLY the verified sha: `git push origin <sha>:refs/heads/fleet` (fast-forward in the
   normal case). The ref the fleet pulls is the one that passed the gate — not "whatever main is now."
6. Remove the worktree (and on any failure/refusal, remove it too — a `finally`).

Since the fleet updates simultaneously (ruling 8, no rings), promotion is the ONLY line between a bad tree
and every machine. It is now a line that actually executes the tree it authorizes; promote deliberately,
never as a reflex after every `main` push.

#### 3.1a The manifest-reference walk (closes the two-item-blocklist gap — §12 finding 5)

Parse the candidate `manifest.json` and refuse if any referenced file is absent from the tree. Two tiers:
- **Brick tier — won't load at all:** `background.service_worker`, every `content_scripts[].js`/`.css`, and
  every icon (`icons`, `action.default_icon`). Chromium's load-time validation checks these exist and
  DISABLES the extension if one is missing — the exact fleet-wide-brick morning §4.1 exists to prevent, and
  a dangling reference (rename/delete a file without updating the manifest) is the likeliest won't-load cause
  in a no-build-step repo. It passes `npm test` (no test loads the SW/content-script entry), passes
  `node --check` (it only checks files that exist), and — before this walk — passed both blockers.
- **Broken tier — loads, fails at use:** `side_panel.default_path`, `web_accessible_resources`. Cheap to
  check; closes the adjacent hole no other gate covers (a missing `chat.html` is a panel that won't open,
  not a brick).

This node-side walk is authoritative (real JSON parse + globbing). The host tick re-runs a lighter brick-tier
existence check (§3.2.5) as defense in depth.

### 3.2 Updater tick (host, every 10 min) — one recipe, both wrappers

The whole body runs inside a `try/finally`: the `finally` releases the lock AND stamps
`update/updater-state.json` on EVERY exit path (success, refuse, hold, error) — so no failure is silent
(§12 finding 7). Steps:

1. **Take the lock** (`<stateDir>/lock`, carrying `{ pid, at, host }`). If held, check liveness: steal the
   lock if its `pid` is dead OR its `at` is older than 3× cadence (~30 min) — a crash mid-tick (power loss)
   must not wedge the updater forever. Otherwise exit. (Ruling 18 — the old "if held, exit" had no stale
   rule; a dead tick froze the heartbeat and read in `glf` as "task deleted.")
2. **Recover a torn apply first.** If `update/apply-in-progress` exists (written before the last reset,
   cleared after), a prior `git reset --hard` was interrupted (Defender/indexer handle, crash) — the tree is
   dirty with the updater's OWN half-written state. Force-re-run `git reset --hard <journal.sha>` REGARDLESS
   of the dirty guard (the guard protects HUMAN dirt; the journal proves this dirt is ours), then clear the
   journal. Without this, step 6's dirty-REFUSE would reject the torn tree forever and §6's "next tick
   re-applies" could never happen.
3. `git fetch origin fleet fleet-control` (both refs; explicit refspec so single-branch clones still see
   them — §7 clone-shape note).
4. **Read control from its OWN ref** (ruling 14): `git show origin/fleet-control:update/control.json` →
   `{ hold }`. Control lives on the dedicated `fleet-control` branch, NOT on the payload `fleet` branch, so
   the kill switch is reachable regardless of whether `main`/`fleet` is mid-arc or red (§3.2a). Control is
   DATA ONLY; the script's verbs are fixed. **Unparseable control → treat as `hold: true`** (fail safe) and
   stamp `lastError` — a fat-fingered trailing comma must freeze, not crash every updater into silent death.
   On `hold`: stop before apply, but still fetch + stamp (the heartbeat, now carrying `hold: true`, so a
   frozen fleet is VISIBLE in `glf`, not indistinguishable from healthy-current).
5. HEAD already == `origin/fleet` → skip to step 7.
6. **Validate the target tree WITHOUT touching the live directory** (the brick invariant, §4.1):
   `git ls-tree <sha> --name-only` — any root `_`-prefixed entry → REFUSE; the manifest (`git show
   <sha>:manifest.json`) fails to parse / lacks `version` → REFUSE; brick-tier manifest references absent
   from the tree → REFUSE (the host mirror of §3.1a; parse the manifest with the per-OS tool of §7, no node).
   A refusal stamps `lastError`/`refuseReason` and exits via the `finally`.
7. **Apply.** Guards: dirty working tree → REFUSE (never destroy human edits); `.orchard-dev` marker at root
   → REFUSE permanently (§5). Otherwise: write `update/apply-in-progress` = `{ sha }`, `git reset --hard
   <sha>` (never `git clean` — untracked state must survive), clear the journal. Then **scan the live root**
   for any untracked `_`-prefixed file (the stray-probe accident CLAUDE.md documents — invisible to the
   ls-tree check, since it's untracked, and it bricks the load anyway); if found, stamp `lastError` and warn
   — do not stamp `ready.json`.
8. **Stamp `update/ready.json` LAST** and only when stale relative to HEAD (`{ version, sha, at }` mirroring
   HEAD's manifest — the SIGNALING commit point for the dot; stamped on catch-up too, so a hand-pulled
   machine still converges). Untracked + git-ignored. (Note: this gates only the DOT — Chrome serves the
   on-disk tree to new content-script injections and boots onto it whole the moment step 7 lands, so
   "stamp-last is the transaction" is a statement about SIGNALING, never about what Chrome runs — §12
   finding 6.)

Every exit then lands in the `finally`: stamp `updater-state.json`
`{ at, head, fetchOk, lastError, refuseReason, hold }`, release the lock.

#### 3.2a The `fleet-control` ref (kill switch off the payload — §12 finding 2)

The kill switch used to ride `fleet` itself, whose only mover is the test-gated `promote.cjs` — so flipping
`hold` during an incident either required a green `main` (unavailable exactly when you need it, mid-refactor)
or shipped whatever `main` carried. Fix: a dedicated **`fleet-control`** branch holds ONLY
`update/control.json`. `promote.cjs hold` / `promote.cjs release` commit+push ONLY that one file to that one
branch — NO test gate, instant. Normal `promote` never touches it. The incident path is then clean and each
step has a mechanism that ships nothing unvetted:

1. `promote.cjs hold` — freezes the whole fleet at the next tick (laggards and asleep machines included),
   visible in `glf` via the `hold` heartbeat field.
2. Prepare the fix on `main` (revert + version bump) at whatever pace; `main` can be red meanwhile.
3. `promote.cjs` — the normal gate builds/tests the fixed artifact and advances `fleet`.
4. `promote.cjs release` — unfreezes; the next tick applies the now-fixed `fleet`.

### 3.3 Extension tick — SW detects, panel arms (§12 finding 4)

The MV3 service worker has NO access to the panel DOM, and the reload button (`#btn-dev-reload`) is today
single-owner: `devBridge.js` pushes `{enabled:false}` at every panel init on a non-dev install and
`chat.js`'s `onReloadState` unconditionally toggles the button hidden + overwrites its title. A naive second
arm-source is clobbered milliseconds after it shows. So ownership is split across the storage boundary:

**Service worker (SW alarm, every 5 min) — detection only:**
1. `fetch(chrome.runtime.getURL('update/ready.json'), { cache: 'no-store' })` — unpacked serves live disk;
   `no-store` defeats caching. An absent extension resource makes `fetch` **REJECT** (TypeError /
   `ERR_FILE_NOT_FOUND`), it does NOT resolve to a 404 Response — so `catch → treat as {ok:false}` (ruling
   toward `Core/updateSignal.js` shaped as `{ok, ...}`). `{ok:false}` → hard noop: no `ready.json` means no
   updater manages this install (dev machines, hand-run clones), so the dot never arms on unmanaged installs.
2. Compare `ready.version` vs `chrome.runtime.getManifest().version`. Equal → noop (version gate). **Arm only
   when `ready.version` is strictly NEWER** (semver compare, ruling 16 tail): a force-pushed-back `fleet`
   would otherwise light "Update ready — v<older>" and a click would execute the storage-shape-breaking
   downgrade that ruling 3 forbids — instead log a distinct `UPDATE ▸ ready-older` (informational, no arm).
3. Newer → publish `update:signal = { readyVersion, readySha, at }` to `chrome.storage.local`, and log
   `UPDATE ▸ ready v<disk> (loaded v<loaded>)` **once per version** — the seen-set is PERSISTED in
   `chrome.storage.local` (`update:seenReady`), because MV3 tears the SW down after ~30s idle so nearly every
   5-min tick is a cold boot; an in-memory set would re-log every tick and corrupt the skew read.
4. Also read `update/updater-state.json` and relay `UPDATE ▸ updater head=<sha7> state=<ok|refused:dirty|
   refused:invalid|held|error> fetchOk=<bool> age=<mins>` — the liveness pulse (ruling 4). The `state` enum
   is what makes a wedged machine legible (a permanent dirty-refusal now reads as `refused:dirty`, not as
   healthy-and-quiet). Throttle to once per 24h per profile, plus immediately when `state`, `fetchOk`, or
   `head` changes. It rides the extension's existing authenticated CW ship, so the updater needs no AWS
   credentials.

**Panel (chat.js) — arming only:** at panel init AND on `chrome.storage.onChanged` for `update:signal`,
recompute the button's visibility as **one merged `OR(devArm, updateArm)`** in a single owner — never two
sources toggling `hidden` independently. `updateArm = update:signal.readyVersion !== loadedVersion`; tooltip
shows the pending version. The click path is bridge-independent: `chrome.runtime.reload()` directly (what
`devBridge.reloadExtension()` already reduces to), so a non-dev install with no bridge still reloads.

> **Observability precondition (minor, but load-bearing for every "visible in `glf`" claim):** the beacons
> only reach the fleet view if `settings:cloudLogs` is opted in (it **defaults OFF** —
> `Services/Cloud/CloudLogShipper.js`) AND the install has a bound OrchardAuth identity. A never-opted-in
> install looks exactly like "never enrolled." So enrollment (SU-1 installer / README) turns cloud logs on
> as a step, and SU-3/SU-4 verify beacons per-install against the enrollment roster.

### 3.4 Boot diary (the applied beacon, ruling 2)

On every SW boot: compare `chrome.storage.local` `update:lastRunVersion` against the loaded version. Differ →
log `UPDATE ▸ applied v<new> from v<old> lag=<mins>` and set `lastRunVersion`. Lag epoch = `ready.json.at`;
if `ready.json` is absent or older than the boot (e.g. files swapped while Chrome was closed, or a torn
apply), log `lag=unknown` rather than a garbage figure. This catches EVERY landing path uniformly — button
click, Chrome restart, closed-at-apply — with no persist-before-reload choreography and no way for an update
to land unreported.

### 3.5 Markers

Three shapes join `Core/decisionMarkers.js` as SEPARATE entries so the metric side can express the skew that
§4.6 calls the operational read: `update-ready` (`metric: true`), `update-applied` (`metric: true`), and
`update-updater` (`metric: true` but with a narrowed `metricPattern` so the daily heartbeat doesn't swamp
`ready`/`applied`). All carry versions/sha7/booleans/enums only — they ride the scrubbed ring adding nothing
scrub-worthy (the `state` enum is a fixed vocabulary, not a raw git string). This is invariant #1 in its
restructured form: the manifest is the single source; decisions view + CW metric filters both derive.

## 4. Safety rulings

1. **Never apply a tree that can't load.** Host-side validation runs against the fetched ref BEFORE any live
   file moves, and the authoritative reference-walk runs dev-side at promotion (§3.1a). A bricked extension
   cannot signal or reload; the sole recovery is one manual `chrome://extensions` ↻ after the updater pulls
   the fix — prevention keeps that from being a fleet-wide morning.
2. **Fix forward, only forward (ruling 3).** No downgrade machinery: code rolls back but `chrome.storage`
   state does not, so the incident path is revert + bump + promote. The dot arms only on NEWER versions
   (§3.3.2) so a force-pushed-back `fleet` can't invite a downgrade click. `hold` freezes while the fix is
   prepared.
3. **No rings, no deadline (ruling 8).** Small, test-scoped fleet; every install pulls each promotion
   simultaneously and reloads at its user's leisure. The promotion gate is the blast-radius control until the
   fleet outgrows "everyone can be told in one channel."
4. **Reload storms can't form** — a human fires every reload.
5. **Push-to-`fleet` is fleet code execution.** `fleet` moves only via `promote.cjs`; fleet machines hold
   READ-ONLY credentials (§7); the updater's command surface never widens beyond fetch/show/ls-tree/reset.
   Nothing in the repo tree is ever executed by the tick (git hooks are untracked; the `.gitattributes` merge
   driver needs per-clone opt-in and the updater never merges) — see ruling 8.
6. **The skew window is open-ended — named, accepted, measured, and its mechanism corrected (§12 finding 8).**
   Between files landing and the user's click, what is served old-vs-new is NOT what the original draft
   claimed. Manifest-declared content scripts (`contentScript.js`, etc.) are **snapshotted at extension
   load**, so new navigations during skew inject the OLD script under the OLD SW — consistent and safe (this
   is why editing an unpacked content script needs a reload to take effect). The REAL disk-fresh paths are
   `chrome.scripting.executeScript({files:[…]})` (~21 sites across 8 files — chat.js, background.js,
   handlers/sg.js, explore.js, connector.js, canvas.js, Services/TemplateWalker.js) and
   `registerContentScripts` (sg.js, harvest sessions), which read disk per call — so a walk step or a harvest
   arm can inject NEW code under the OLD SW on a tab that never navigated. The discipline:
   - keep SW↔content-script message contracts backward-compatible across the **compat window**, defined as
     the OLDEST loaded version still live in `glf` (not "one release" — panel-closed users run releases
     behind);
   - for the same-file-two-versions case, the content-script re-injection guard (`window.__agentHubContent…`)
     already makes first-loaded win, so version-stamp CS replies and no-op a re-injection whose guard version
     differs;
   - watch the `ready`-vs-`applied` gap in `glf`; chronic skew-hours is the signal to add a gentle
     browser-idle auto-reload (SU-6), not to widen contracts.
7. **Crash recovery is designed, not assumed (§12 finding 6).** Stale-lock steal (PID + age) and the
   apply-in-progress journal (§3.2 steps 1–2, 7) mean a killed tick self-heals on the next fire instead of
   wedging; the `lag=unknown` fallback (§3.4) keeps the boot diary honest across torn/closed applies.
8. **The updater cannot rewrite itself (ruling 15 / §12 finding 3).** The scheduler runs the COPY in the
   state dir; `tools/updater/` in the clone is inert source. A push to `fleet` therefore stays
   Chrome-extension-context code, never host-shell code — the guarded branch can't rewrite the guard.
   Updater upgrades = re-run the installer (human act).

## 5. The dev-machine exception

The dev checkout NEVER auto-moves: dirty-tree refusal catches it in practice; `.orchard-dev` at root by
declaration (its own `.gitignore` line — the name must NOT start with `_`, which Chrome refuses to load).
On the extension side the dot never arms without `ready.json` (§3.3). If the updater is ever test-run on the
dev machine, DELETE `update/ready.json`, `update/updater-state.json`, and any `update/apply-in-progress`
afterward — a stale stamp is what would leave the dot lying. Racing lanes, `.wt/preview`, and the
dev-bridge's own arm-source on the shared button are untouched (the merged `OR` visibility, §3.3, is exactly
what keeps them coexisting).

## 6. Failure modes, named

| Failure | Behavior |
|---|---|
| Repo unreachable (offline, credential rot) | Updater exits via `finally`; install keeps running. `UPDATE ▸ updater state=error fetchOk=false` (relayed on flip) makes it visible per install in `glf`. |
| Updater task deleted / never enrolled | Heartbeat `age` grows / never appears. Distinguish from "current and quiet" via `head` sha + absence of any `applied` — and from a wedge via `state` (below). |
| Target tree invalid (`_` file, bad/dangling manifest) | Host REFUSES; `state=refused:invalid` relayed; fleet stays put. §3.1a should have made this unreachable — a host refusal firing at all is a promotion-gate bug. |
| Apply refused: human-dirty tree | `git reset` skipped; `state=refused:dirty` relayed each tick until the machine is cleaned. Visible in `glf`, not silent. |
| Loads-but-crashes tree | Host validation can't catch it (no node on fleet machines); `promote.cjs`'s worktree gate is the line (§3.1). If one slips through: `promote hold` → revert → bump → `promote` → `release` (§3.2a). |
| Chrome closed at apply time | Files land; next Chrome start runs the new version; boot diary beacons `applied` (`lag=unknown` if `ready.json.at` predates boot). No special case. |
| `reset --hard` interrupted (torn tree) | `apply-in-progress` journal is present at next tick → step 2 force-re-runs the reset EXEMPT from the dirty guard, then clears the journal. Self-heals; not a permanent dirty-REFUSE. |
| Lock left by a crashed tick | Next tick steals it (dead PID or age > 3× cadence) — the updater resumes instead of wedging. |
| Two ticks overlap | Live lock (PID alive, fresh): second tick exits. |
| Machine asleep at tick time | Both schedulers skip and catch up on wake (schtasks; launchd `StartInterval`); convergence late, never lost — heartbeat `age` shows the gap. |
| Kill switch engaged | `state=held` relayed each tick — a frozen fleet is visible, distinct from healthy-current. |
| User never clicks, never restarts | `ready`-without-`applied` skew visible per install in `glf`; a nudge is social, not mechanical, at this fleet size. |

## 7. Identity, clone shape & credentials

**Identity (rulings 1, 11):** each extension INSTANCE mints its own id at first run — the existing
`cloudlogs:installId` (`Services/Cloud/CloudLogShipper.js`), per Chrome profile by construction
(`chrome.storage.local` is profile-scoped), already in every shipped log line. N profiles on one clone share
one folder and one updater. To collapse N profiles' identical `updater-state` relays into one logical updater
in `glf`, the INSTALLER stamps a per-clone **machine GUID** into `updater-state.json`, and the relayed
`updater` line carries it — so `glf` dedups by GUID (real machinery: the GUID is in the line; there is no
magic "deduped by content"). Otherwise an idle second profile would read as a permanent
`ready`-without-`applied` phantom install on every SU-4 pass. The updater itself needs no per-install
identity (rings died with ruling 8).

**Clone shape (minor):** enrollment must use a full-ref clone or an explicit refspec so `origin/fleet` and
`origin/fleet-control` exist — a `--single-branch`/`--depth-1` clone lacks them and step 3 fails forever.
Pin the clone command and set `remote.origin.fetch = +refs/heads/fleet:refs/remotes/origin/fleet` (and the
same for `fleet-control`), and check out `fleet` in a DEDICATED working dir so `reset --hard` never silently
repoints local `main`.

**Credentials (ruling 10):** a keystore cannot remove the local secret, only shrink it — fetching from AWS
Secrets Manager itself needs an AWS credential (one turtle down). An unattended machine irreducibly holds
SOME durable bootstrap secret. v1 is a per-machine READ-ONLY repo deploy token, protected at rest by the
platform store: Windows via git-credential-manager (DPAPI-bound), macOS via `git-credential-osxkeychain`
(login Keychain — ships with git). Never plaintext on disk. Platform gotchas the installer must handle:
- **Windows:** register the task to run **only when the user is logged on** (NOT S4U / "run whether logged
  on or not" + `/NP`) — S4U has no DPAPI master key, so the credential fetch fails every tick even while the
  user is logged in.
- **macOS:** pin ABSOLUTE `git` and `node` paths (launchd's minimal PATH may resolve neither, and the CLT git
  shim breaks after major-OS upgrades — "invalid active developer path"); do one INTERACTIVE fetch at
  enrollment to seed the Keychain ACL ("Always Allow"), and README the re-prompt after CLT updates.
- **JSON parsing** is no longer a per-OS gotcha (ruling 22): the updater is node, so `control.json` /
  `manifest.json` parse with `JSON.parse` on both platforms — the old `ConvertFrom-Json` vs `plutil`/`python3`
  split, and the twin-wrapper drift drill it required, are gone.

**Offboarding:** revoke the deploy token, unregister the task/LaunchAgent, delete the clone — AND revoke the
install's CloudWatch shipping credential, which lives in the Chrome profile (`Services/Cloud/…`), not in the
clone: a stolen laptop otherwise keeps authenticated CW egress (and could forge `UPDATE ▸` lines) after the
git token is gone. This is a pre-existing exposure the update feature simply must not pretend §7 closes.

Precision note (both platforms): "per machine" means **per OS account** — scheduler, credential store, and
clone are account-scoped. N Chrome profiles under one OS login share one enrollment; a second OS login on the
same hardware is a second enrollment (the fleet correctly sees two). Deferred (§8-D′): an orchard-cloud
token-vending endpoint exchanging a low-value device credential for short-lived git tokens — worth it only if
per-machine revocation stops scaling.

**Push protection — provenance BUILT (SU-6, opt-in, 2026-08-14):** ruling 5 ("`fleet` moves only via
`promote.cjs`") needs enforcement, and branch protection may be unavailable on a GitHub Free private repo.
Primary control stays a ruleset on `fleet` + `fleet-control`; the cryptographic belt is now built
(`tools/updater/attest.cjs`): `promote.cjs keygen` mints an Ed25519 keypair (private key gitignored on the
dev box, `update/promote-key.pem`); `promote.cjs` signs each pushed sha and publishes `update/attest.json` to
`fleet-control`; each fleet machine PINS the public key at enrollment (`install-updater … --pubkey`) and the
updater refuses (`refused:unattested`) any fleet tip lacking a valid signature. OPT-IN + backward-compatible:
no pinned key → the check is skipped. An attacker with fleet/fleet-control write can push a malicious sha +
forged attest.json but cannot forge a signature valid under the locally-pinned key (no private key), and the
pinned key can't be rewritten by a branch push (it's local). Rotation = re-`keygen` + re-pin (re-enroll).

## 8. Alternatives considered

- **A (chosen): git-pull updater + human-fired reload.** Zero new infrastructure; the repo is already the
  distribution channel; unpacked-serves-disk is the native mechanism; the human gate removes the interruption
  problem class.
- **B: self-hosted CRX + `update_url` + force-install policy.** Native pipeline; requires managed browsers
  and a pack/sign step. Revisit under CBCM — it would replace §3.2–3.3 wholesale; beacons survive either way.
- **C: extension updates itself.** Impossible — an extension cannot write its own directory. This is why the
  host half exists.
- **D: HTTPS-zip artifact channel (orchard-cloud/S3).** Mooted for v1 by ruling 9 (git is an install-step
  prerequisite); retained for a future install class that can't hold repo credentials. **D′:** the
  token-vending variant survives as the deferred credential upgrade (§7).
- **E: native-messaging host for a rich local channel.** Dead for v1 — `ready.json` down and CW beacons up
  cover everything.

## 9. Build ladder

- **SU-0** — `fleet-control` branch created holding `update/control.json` (`{ "hold": false }`); `.gitignore`
  on `main`: `/update/ready.json`, `/update/updater-state.json`, `/update/apply-in-progress`, `/.orchard-dev`;
  create the `fleet` branch; this doc. No behavior.
- **SU-1a (BUILT + TESTED 2026-08-14)** — the dev-side gate: `tools/updater/promote{,Checks}.cjs` (worktree
  gate + `hold`/`release` + version-movement + manifest-ref walk). `promote.test.cjs` = 40 (unit + fixture:
  candidate = origin/main with the dirty local checkout ignored, failing-gate, dangling-ref, version-non-
  movement, node --check, no-op, hold/release off the payload).
- **SU-1b (BUILT + TESTED 2026-08-14)** — the fleet-side updater as ONE node CLI (ruling 22, not twin shell
  wrappers): `tools/updater/updater.cjs` (lock steal → torn-apply journal recovery → fetch → control →
  validate → apply → stamp, reusing `promoteChecks.cjs`), thin launchers `install-updater.ps1` / `.sh` (copy
  to state dir + register task/agent against the COPY per ruling 15; Windows logged-on-only, NOT S4U; macOS
  absolute node+git + interactive-seed Keychain; machine GUID; clone refspec), and `README.md`.
  `updater.test.cjs` = 21 fixture drills: apply+stamp, no-op-when-current, hold, unparseable-control-→-hold,
  dirty-refusal, torn-apply recovery, stale-lock steal vs live-lock yield, brick-tree refusal, fetch-failure,
  stamp-on-every-exit. Live-owed (real machine): schtasks/LaunchAgent cadence across sleep/wake, the
  DPAPI/Keychain credential non-interactive to the task.
- **SU-2 (BUILT 2026-08-14, core verified · glue live-owed)** — extension half. Pure logic in
  `Core/updateSignal.js` (evaluateReady / evaluateBoot / the line formatters / updaterLine / shouldRelay) —
  npm gate, 21 tests; the three `UPDATE ▸` shapes into `Core/decisionMarkers.js` (5 tests, metric patterns
  literal). SW glue `background/handlers/updatePoll.js`: alarm poll (`no-store`, fetch-reject→`{ok:false}`),
  publishes `update:signal` + persisted `update:seenReady`, boot diary (`update:lastRunVersion`,
  `lag=unknown` fallback), throttled heartbeat relay; wired in `background.js` as a self-registering alarm
  owner (`initUpdatePoll`). Panel `chat.js` `_wireDevReload` refactored to merged `OR(devArm, updateArm)`
  visibility (single-owner `_applyReloadBtn`, semver newer-only arm, bridge-independent reload click) so the
  fleet source and the dev-bridge source can't clobber each other. `background/handlers/` glue stays outside
  the test glob (undef-clean; full suite 4942). LIVE-OWED: the SW poll firing on the alarm, the dot arming
  outside dev mode without breaking the dev-bridge cycle, and the beacons landing in `glf`.
- **SU-3** — beacons proven in `glf`: `ready`, `applied` (each landing path), `updater` heartbeat + each
  `state` value (ok / refused:dirty / refused:invalid / held / error), verified per-install against the
  enrollment roster (catches a never-opted-in install masquerading as unenrolled).
- **SU-4** — live fleet drill (INCLUDING at least one Mac): promote a trivial bump → watch every install
  `ready` → click one, restart another, leave one → confirm the three convergence paths, the skew read, and
  the multi-profile GUID dedup.
- **SU-5** — incident drill: `promote hold` → confirm every install `state=held` and stops applying →
  revert+bump on main → `promote` → `release` → confirm convergence. End-to-end fix-forward.
- **SU-6 provenance (BUILT 2026-08-14)** — Ed25519 signed attestation (`attest.cjs`, `promote keygen`/sign,
  updater `refused:unattested` verify, installer `--pubkey` pin). Tests: `attest.test.cjs` 11 + 6 updater
  drills. Opt-in; live-owed = one real keygen→pin→promote→verify pass.
- **SU-6 (still deferred)** — token-vending credentials (D′); gentle browser-idle auto-reload IF `glf` shows
  chronic skew-hours (§4 ruling 6 tripwire); rings IF the fleet outgrows one channel; the signed-tag push
  guard if branch protection proves unavailable (§7).

## 10. Verification honesty

Headless-provable: all of SU-1 (fixture-repo drills, both wrappers), the SU-2 pure signal logic. Live-eyeball
OWED before trusting the fleet:
- `fetch(chrome.runtime.getURL(...), {cache:'no-store'})` genuinely re-reads DISK per call on an unpacked
  install, rejects (not 404s) when the file is absent, and does so for a file outside
  `web_accessible_resources` (believed from the unpacked serving model; never proven here). The same serving
  assumption underlies `executeScript({files})` reading fresh disk in §4 ruling 6 — confirm once.
- The merged-visibility button: fleet-arming shows the button OUTSIDE dev mode without breaking the
  dev-bridge arm/clear cycle (the exact clobber this design routes around).
- A full Chrome restart loads the post-`reset` tree in one hop (dev-branches doc asserts it; confirm on a
  fleet-shaped clone).
- Windows: logged-on-only task cadence + DPAPI credential across lock/sleep/login.
- macOS: LaunchAgent cadence across sleep/wake, absolute-git resolution under launchd's PATH, Keychain
  credential non-interactive after the enrollment seed, one full tick end-to-end.
- Stale-lock steal and torn-apply journal recovery on a REAL machine (fixtures prove the logic; a real
  Defender/indexer race proves the trigger).
- One full SU-4 drill and one SU-5 drill on the REAL fleet before declaring the feature live.

## 11. Rulings record (2026-08-14)

*First review (open-question answers):*
1. Identity = instance-minted at install, log-visible → per-profile `cloudlogs:installId`; updater needs no
   identity (§7).
2. Boot diary (`lastRunVersion`) replaces persist-before-reload pending-notes (§3.4).
3. Fix forward only; no downgrade machinery (§4.2).
4. Updater liveness → heartbeat relayed through the extension's existing CW pipeline; the updater never talks
   to AWS itself (§3.3).
5. Runs-but-broken class → dev-side `promote.cjs` gate; fleet tracks `fleet`, never `main` (§3.1).
6. No auto-reload — reuse the header reload button + dot; the user fires the reload (§2, §3.3).
7. Updater-vs-updater race → lock file (§3.2); reload races moot per ruling 6.
8. No rings, no 6h deadline — small test fleet, simultaneous convergence (§4.3).
9. Git on fleet machines is a documented install-step prerequisite (§2).
10. Keystore cannot eliminate the local bootstrap secret; v1 = scoped read-only token, platform-store
    protected, per-machine revocable; token-vending deferred (§7).
11. N+1 profiles → N+1 extension-minted ids sharing one updater (§7).
12. Windows + macOS: ~~twin wrappers around one recipe~~ **superseded by ruling 22** — one node CLI, per-OS
    launchers only; DPAPI / login-Keychain; enrollment per OS account (§2, §7, SU-1).

*Third review (Rung 3 implementation):*
22. **The updater is one node CLI, not two shell wrappers** (2026-08-14, user ruling "no node isn't a hard
    requirement"). node joins git as a fleet prerequisite; in return the tick recipe is a single
    `updater.cjs` — unit-tested like `promote.cjs`, sharing `promoteChecks.cjs`, with zero cross-shell drift
    and no per-OS JSON parser. The launchers (`install-updater.ps1` / `.sh`) stay per-OS because scheduling +
    the credential store are platform-specific; the logic is not. Reverses ruling 12's twin-wrapper shape and
    retires the §7 "JSON without node" gotcha (§2, §7, §9 SU-1b).

*Second review (confirmed-finding fixes):*
13. **promote tests the artifact, not the checkout** — candidate = `origin/main`, materialized in a temp
    worktree, gated there, pushed as exactly that sha; version-bump required (§3.1, §3.1a). *[finding 1 + the
    version-movement minor]*
14. **Kill switch off the payload** — control lives on a dedicated `fleet-control` ref, flipped gate-free by
    `promote hold`/`release`; `hold` is stamped into the heartbeat; unparseable control fails safe to hold
    (§3.2.4, §3.2a, §6). *[finding 2]*
15. **Updater runs from a copy** — installer copies the script to the state dir and registers the task there;
    the clone's `tools/updater/` is inert source; upgrades = re-run the installer (§2, §4 ruling 8).
    *[finding 3]*
16. **SW detects, panel arms** — detection published to `chrome.storage.local`, one merged `OR`-visibility
    owns the button, seen-set persisted, arm only on strictly NEWER version, fetch-reject handled (§3.3).
    *[finding 4]*
17. **Load validation walks manifest references** — brick tier + broken tier, authoritatively at promotion,
    mirrored host-side (§3.1a, §3.2.6). *[finding 5]*
18. **Crash recovery designed** — PID+age stale-lock steal + apply-in-progress journal that exempts the
    updater's own torn apply from the dirty guard; `lag=unknown` fallback (§3.2, §3.4, §4 ruling 7).
    *[finding 6]*
19. **Every exit is visible** — a `finally` stamps state (`lastError`/`refuseReason`/`hold`) on every path;
    the relayed heartbeat carries a `state` enum; refusals show in `glf` (§3.2, §3.3, §6). *[finding 7]*
20. **Skew mechanism corrected** — manifest content scripts are old-on-old (safe); the compat discipline
    targets `executeScript({files})`/`registerContentScripts`, no-ops guard-version-mismatched re-injection,
    and defines the compat window as the oldest live version in `glf` (§4 ruling 6). *[finding 8]*
21. **Observability precondition stated** — beacons require `cloudLogs` opt-in (default OFF) + bound
    identity; enrollment turns it on; SU-3/SU-4 verify per-install against the roster (§3.3, §9). Folded
    minors: fetch-reject semantics, clone refspec, Windows S4U, macOS git-PATH/Keychain, no-node JSON parse,
    control-parse-fail, offboarding CW credential, multi-profile GUID dedup, untracked-root-`_` scan, push
    protection (§3, §7, §9).

## 12. Second-review amendment record (what changed and why)

A multi-agent critical review (5 lenses → triage → adversarial verification) confirmed 8 findings against the
first-amendment spec; all are folded above. Verifiers checked claims against the live codebase (chat.js,
devBridge.js, CloudLogShipper.js, .gitattributes) and reproduced the one refuted claim empirically.

- **F1 (critical) — promote gated the dirty checkout, not the shipped sha.** This repo's steady state IS a
  dirty tree; the old gate could pass a tree the fleet never receives. → §3.1 worktree gate. *Ruling 13.*
- **F2 (critical) — the kill switch rode the payload branch,** so `hold` was unreachable while `main` was
  red — exactly during an incident. → §3.2a `fleet-control` ref. *Ruling 14.*
- **F3 (critical) — `fleet` could rewrite the updater itself,** escalating a bad push from extension-context
  to host-shell RCE. → §2 run-from-copy. *Ruling 15.*
- **F4 (critical) — the signal path crossed the MV3 SW→DOM boundary and clobbered the shared button.**
  Verified single-owner wiring in `chat.js`/`devBridge.js`. → §3.3 split detect/arm + merged visibility.
  *Ruling 16.* (The review REFUTED the sub-claim that "no surface while panel closed" is a bug — it is a
  deliberate ruling; the Chrome-restart backstop stands.)
- **F5 (major) — "won't load" was a two-item blocklist;** a dangling manifest reference bricks the fleet
  through both gates. → §3.1a reference walk. *Ruling 17.*
- **F6 (major) — a killed tick wedged the updater** (stale lock; torn `reset` → permanent dirty-REFUSE), and
  the "stamp-last is the transaction" claim protected only the dot, not what Chrome runs. → §3.2 lock-steal +
  journal; §3.4 `lag=unknown`. *Ruling 18.*
- **F7 (major) — error paths exited before the heartbeat stamp** and the relay omitted any reason, so a
  wedged machine read as healthy. → §3.2 `finally` + §3.3 `state` enum. *Ruling 19.*
- **F8 (major) — §4.6's skew mechanism was backwards:** manifest content scripts snapshot at load; the real
  disk-fresh path is `executeScript({files})`. → §4 ruling 6 rewrite. *Ruling 20.*
- **Refuted — CRLF phantom-dirt wedging the Windows fleet:** disproved on git ≥2.8 (`autocrlf=true` ⇒
  `text=auto` skips CRLF-committed blobs) and the repo has zero CRLF blobs. The surviving sliver — "dirty" is
  undefined — is handled by defining the guard as `git status --porcelain --untracked-files=no` (so the
  stamps and stray files don't count) plus the untracked-root-`_` scan (§3.2.7).

### Rung 7 — security red-team of the whole SU surface, 2026-08-14 (CLEAN)

A multi-lens red-team (command-injection · trust-boundary · a concrete attempt of the six named attacks +
integrity/DoS) over the updater, promote, installers, and the extension signal returned **zero confirmed
holes**. 13 guards were attacked and held: run-from-copy (a hostile fleet tree rewriting `tools/updater/*`
is inert — the scheduler runs the state-dir copy, and its require graph never resolves back into the reset
clone); `control.json` is data-only (only `parsed.hold` is read + boolean-coerced — a `{"hold":"; rm -rf ~"}`
payload reaches no arg or shell); every updater git call is `execFileSync` (no shell, no metacharacter/arg
injection); the untracked-root-`_` scan blocks the stamp on BOTH the apply and up-to-date paths (incl.
space/non-ASCII via `-z`); a torn reset self-heals via the journal; a human-dirtied tree is `refused:dirty`;
the extension signal is same-origin (no page/other-extension influence) and reaches the panel via
`btn.title` (a DOM property, not `innerHTML` — no XSS even from a script-payload version). All 8 raised
findings were refuted as either the explicitly-accepted "push-to-fleet is fleet code execution" trust model
(ruling 5 — an attacker already needs fleet-branch WRITE), the accepted compromised-box exposure (§7), or the
one genuine defense-in-depth residual — host-side signature/provenance verification of the fleet ref — which
is already named in §7 "Push protection (minor)" and deferred to SU-6, with a git-host branch-protection
ruleset as the primary control. Two cheap hardenings the pass recommended were folded in immediately:
`parseManifest` now enforces a dotted-numeric version format (keeps a malformed/hostile version out of the
compare + skew read and off the log lines), and the `UPDATE ▸` line formatters strip non-vocabulary chars
from the version/head/state/guid fields (log-line-injection defense-in-depth).

### Third review — Rung 3 implementation (`updater.cjs` + launchers), 2026-08-14

A third adversarial review (over the BUILT node updater) confirmed 11 findings, all folded into the code
(documented as `F1`–`F10` in the `updater.cjs` header, each with a fixture drill in `updater.test.cjs` — 32
passing). Two were latent-critical: a failed `git reset --hard` (Defender/indexer lock) cleared the recovery
journal anyway, defeating the very self-heal ruling 18 built (now: journal stays on a failed reset); and on
default Windows PowerShell 5.1, `Set-Content -Encoding utf8` wrote `config.json` with a BOM that node's
`JSON.parse` rejects, silently resolving `CLONE` to the wrong dir and killing the feature (now: installer
writes BOM-free + updater reads BOM-tolerant + fails loud on a non-work-tree `CLONE`). The majors: control
now fails safe to hold on ANY non-`{hold:…}` read (missing blob / wrong key), not only malformed JSON; the
per-clone machine GUID is stamped INTO `updater-state.json` (was a dead sidecar file); the macOS absolute git
path is pinned into `config.json` (launchd's minimal PATH); and the up-to-date fast-path now runs the
untracked-`_` scan (with `-z`, so space/non-ASCII names aren't missed) before stamping. Minors: refuse a
clone that is AHEAD of fleet (unpushed commits) rather than orphaning it, and the installers check out a
dedicated `fleet` branch so `reset --hard` never repoints local `main`. Four findings were refuted
(cloudLogs-wording, missing-control-blob-as-happy-path, lock TOCTOU, dev-marker-via-torn-apply) — see the
review transcript.
