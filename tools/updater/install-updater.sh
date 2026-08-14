#!/usr/bin/env bash
# install-updater.sh — one-time enrollment of a macOS fleet machine (SU rung 3; DESIGN_self_update.md §2, §7).
# Registers the node updater on a ~10-minute LaunchAgent. Run ONCE per macOS account (enrollment is per OS
# account — §7). Re-run to upgrade the updater script itself (the human act ruling 15 requires).
#
# Mirrors install-updater.ps1 exactly, macOS lane:
#  - COPIES updater.cjs + promoteChecks.cjs into the state dir; the LaunchAgent points at the COPY, never the
#    clone it hard-resets (ruling 15 — else a bad push to `fleet` is host-shell RCE).
#  - writes config.json {clone,...} so the agent command is just `node updater.cjs`.
#  - stamps a per-clone machine GUID (§7 dedup key).
#  - pins the clone fetch refspec so origin/fleet + origin/fleet-control resolve (§7).
#  - pins an ABSOLUTE node+git path (launchd's PATH is minimal, and the CLT git shim breaks after OS upgrades — §7),
#    and does one interactive fetch to seed the login-Keychain credential (a background agent can't prompt).
#
# Usage:  ./install-updater.sh /path/to/orchard-clone   [interval_minutes]
set -euo pipefail

CLONE="${1:?usage: install-updater.sh <clone-path> [interval-minutes]}"
INTERVAL_MIN="${2:-10}"
CLONE="$(cd "$CLONE" && pwd)"
[ -f "$CLONE/manifest.json" ] || { echo "Clone '$CLONE' has no manifest.json — is it the Orchard extension clone?" >&2; exit 1; }

GIT="$(command -v git || true)";   [ -n "$GIT" ]  || { echo "git is required on PATH." >&2; exit 1; }
NODE="$(command -v node || true)"; [ -n "$NODE" ] || { echo "node is required on PATH (one-time install, like git)." >&2; exit 1; }

STATE_DIR="$HOME/Library/Application Support/orchard-updater"
mkdir -p "$STATE_DIR"
HERE="$(cd "$(dirname "$0")" && pwd)"

# run-from-copy (ruling 15)
cp -f "$HERE/updater.cjs"       "$STATE_DIR/updater.cjs"
cp -f "$HERE/promoteChecks.cjs" "$STATE_DIR/promoteChecks.cjs"

# config (no env marshalling through launchd). Pin the ABSOLUTE git path so the launchd tick resolves the same
# git the credential was seeded under, not launchd's minimal PATH (review F5 / §7 — only node was pinned before).
cat > "$STATE_DIR/config.json" <<JSON
{ "clone": "$CLONE", "remote": "origin", "fleet": "fleet", "control": "fleet-control", "cadenceMin": $INTERVAL_MIN, "git": "$GIT" }
JSON

# per-clone machine GUID (§7)
[ -f "$STATE_DIR/machine-guid" ] || uuidgen > "$STATE_DIR/machine-guid"

# pin fetch refspec (§7) + seed the Keychain credential with one interactive fetch
"$GIT" -C "$CLONE" config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
echo "Seeding the git credential (a one-time interactive fetch)..."
"$GIT" -C "$CLONE" fetch origin fleet fleet-control
# check out a DEDICATED fleet branch so reset --hard moves `fleet`, never local `main` (review F11 / §7)
"$GIT" -C "$CLONE" checkout -B fleet origin/fleet

# LaunchAgent — StartInterval every N minutes; absolute node path (launchd PATH is minimal, §7).
LABEL="com.orchard.fleet-updater"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$STATE_DIR/updater.cjs</string>
  </array>
  <key>StartInterval</key><integer>$((INTERVAL_MIN * 60))</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$STATE_DIR/updater.out</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/updater.err</string>
</dict></plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Enrolled. LaunchAgent $LABEL runs $NODE $STATE_DIR/updater.cjs every $INTERVAL_MIN min for clone $CLONE."
echo "NOTE: turn on cloud logs in the extension (settings:cloudLogs) or the UPDATE beacons stay local (§3.3 precondition)."
echo "To decommission: launchctl unload $PLIST && rm $PLIST; revoke the deploy token; delete '$STATE_DIR' and the clone."
