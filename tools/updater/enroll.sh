#!/usr/bin/env bash
# enroll.sh — ONE-SHOT workstation setup (SU, DESIGN_self_update.md), macOS twin of enroll.ps1. Wraps clone +
# install-updater so a non-technical installer runs one command, signs in once, and finishes with three Chrome
# clicks. Auto-pins the promote public key if it's committed in the repo (update/promote-pubkey.pem).
#
# Usage:  ./enroll.sh https://github.com/flyingturtlesolutions/orchard.git [target-folder] [interval-minutes]
set -euo pipefail

green() { printf '\033[32m%s\033[0m\n' "$1"; }
warn()  { printf '\033[33m%s\033[0m\n' "$1"; }
die()   { printf '\033[31mSETUP STOPPED: %s\033[0m\n' "$1" >&2; exit 1; }

REPO_URL="${1:-}"; [ -n "$REPO_URL" ] || die "usage: ./enroll.sh <repo-url> [folder] [interval-minutes]"
DIR="${2:-$HOME/orchard}"
INTERVAL="${3:-10}"

# 1. prerequisites
for exe in git node; do
  command -v "$exe" >/dev/null 2>&1 || die "$exe is not installed. Ask your setup contact to install Git and Node, then run this again."
done

# 2. get the code
if [ -f "$DIR/manifest.json" ]; then
  green "Using the existing app folder: $DIR"
elif [ -e "$DIR" ]; then
  die "The folder $DIR exists but isn't the app. Delete it or pass another folder, then run again."
else
  echo "Downloading the app to $DIR …"
  git clone "$REPO_URL" "$DIR" || die "Download failed. Check the link and your login, then run again."
fi

# 3. enroll (auto-pin provenance if the key ships in the repo)
INSTALLER="$DIR/tools/updater/install-updater.sh"
[ -f "$INSTALLER" ] || die "This doesn't look like the Orchard app (installer missing)."
PUB="$DIR/update/promote-pubkey.pem"
echo "Enabling auto-update…"
if [ -f "$PUB" ]; then bash "$INSTALLER" "$DIR" "$INTERVAL" "$PUB"
else warn "note: no signing key shipped in the repo — enrolling WITHOUT update-signature checks."; bash "$INSTALLER" "$DIR" "$INTERVAL"; fi

# 4. the human-only Chrome steps
echo
green "Auto-update is on. Two last steps in Chrome:"
echo "  1) Open a new tab, type  chrome://extensions  and press Enter. Turn ON 'Developer mode' (top-right)."
echo "  2) Click 'Load unpacked' and choose this folder:"
printf '        \033[36m%s\033[0m\n' "$DIR"
echo "  Then click the puzzle-piece icon, pin 'Orchard', open its side panel, and turn on cloud logs."
echo
green "Done. When an update is ready a reload button lights up — click it to apply."
