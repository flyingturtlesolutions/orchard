# tools/updater — Orchard fleet self-update (SU)

Host-side tooling for repo-direct fleet updates. Design: `docs/DESIGN_self_update.md`; build order:
`docs/BUILD_ARC_self_update.md`. **Local toolchain only — never shipped in the extension bundle** (these run git +
node). Prerequisites on every machine: **git and node** (both one-time installs).

## What's here

| File | Role |
|---|---|
| `promoteChecks.cjs` | Pure checks (semver, manifest parse, the two-tier reference walk, version-movement). Shared by both promote and the updater — one core, no drift. |
| `promote.cjs` | **Dev-side** promotion gate (rung 2). Builds + tests a throwaway worktree of `origin/main`, then pushes `fleet` to exactly that sha. Also `hold`/`release` (the kill switch on the `fleet-control` ref). |
| `updater.cjs` | **Fleet-side** tick (rung 3). One node recipe: lock → recover torn apply → fetch → control → validate → apply → stamp. Run every ~10 min from the installed copy. |
| `install-updater.ps1` / `.sh` | One-time enrollment. Copies the updater to the state dir, registers a Scheduled Task / LaunchAgent pointing at the **copy**, seeds the read-only credential, stamps a machine GUID. |
| `promote.test.cjs` / `updater.test.cjs` | Standalone fixture drills (`node tools/updater/<x>.test.cjs`). Not in the ESM `npm test` gate. |

## Why node, not dual PowerShell+bash

The updater is ONE node CLI, not two shell wrappers. The fleet already installs git; node is a comparable
one-time install, and paying it buys a single unit-tested recipe with zero cross-shell drift and no per-OS JSON
parser. (This reverses the spec's original "no node on fleet" assumption — user ruling 2026-08-14.) The launchers
stay per-OS because scheduling and the credential store are genuinely platform-specific; the *logic* is not.

## Operating it

**Promote a build to the fleet (dev machine):**
```
node tools/updater/promote.cjs            # gate origin/main in a temp worktree, push fleet to the verified sha
node tools/updater/promote.cjs hold       # freeze the fleet (kill switch)
node tools/updater/promote.cjs release     # unfreeze
```
Dry-run / CI knobs: `ORCHARD_PROMOTE_DRY_RUN=1`, `ORCHARD_PROMOTE_TEST_CMD`, `ORCHARD_PROMOTE_SKIP_NODECHECK`.

**Enroll a fleet machine (once per OS account):**
```
# Windows (PowerShell):
.\tools\updater\install-updater.ps1 -Clone C:\path\to\orchard-clone
# macOS:
./tools/updater/install-updater.sh /path/to/orchard-clone
```
Then turn on cloud logs in the extension (`settings:cloudLogs`) or the `UPDATE ▸` beacons stay local (§3.3
precondition). The updater applies files; the human clicks the lit reload button (or restarts Chrome) to load them.

**Decommission:** unregister the task / `launchctl unload` the agent, revoke the deploy token, delete the state
dir and the clone.

**Provenance signing (SU-6, opt-in):** to refuse any fleet tip that didn't come through `promote.cjs` (a raw
push that skipped the gate):
```
node tools/updater/promote.cjs keygen        # mints update/promote-key.pem (gitignored) + prints the public key
```
Save the printed public key to a file and pin it at enrollment: `install-updater.ps1 -Pubkey key.pem` /
`install-updater.sh <clone> 10 key.pem`. Thereafter `promote.cjs` signs each push (publishing
`update/attest.json` to `fleet-control`) and the updater refuses an un-attested tip (`state=refused:unattested`).
Rotation = re-`keygen` + re-pin (re-enroll). Without a pinned key the check is skipped (default).

## Run-from-copy invariant

The scheduler runs `node <state-dir>/updater.cjs`, a COPY — never `tools/updater/` in the clone, because the
updater hard-resets that clone. A script that resets its own source would let a bad push to `fleet` rewrite the
updater and run arbitrary host-shell on the next tick (spec ruling 15). Upgrading the updater = re-run the
installer (a human act).

## What's tested vs. live-owed

Green headless: `promote.test.cjs` (40) + `updater.test.cjs` (21) — the whole recipe and every refusal against
fixture repos. **Live-owed** (needs a real machine, can't run in the harness): the schtasks/LaunchAgent cadence
across sleep/wake, the DPAPI/Keychain credential available non-interactively to the scheduled task, and one full
promote→converge→reload pass on the real fleet (SU-4/SU-5).
