#!/usr/bin/env bash
# tools/fleet-trace/pull-cloudshell.sh — BREAK-GLASS fleet-trace pull (CloudShell, manual).
# The PRIMARY consumer path is CW-8: the mailbox repo (orchard-fleet-logs) that any Claude Code git-pulls —
# use this script only when the mailbox/exporter is down. CW-8a DRIFT NOTE: the jq flattener below is a
# THIRD copy of the gl line grammar (owner: orchard-cloud lambda/api/glLine.cjs, golden-tested there);
# UTC clock, message-only — if the owner changes, this copy must follow by hand.
#
# Runs in AWS CloudShell (us-east-1 — where the credentials live; this dev machine holds none by design).
#   bash pull-cloudshell.sh                      # every stream, last 60 minutes
#   bash pull-cloudshell.sh ins_2mke8ceams98gw7p # one install, last 60 minutes
#   bash pull-cloudshell.sh ins_2mke8ceams98gw7p 6h
#
# Output: ~/orchard-logs-fleet-<install|all>-<UTCstamp>.txt — download it (Actions → Download file), drop it
# in Downloads, and a `gl` pass ingests it like any local trace (the filename matches the orchard-logs-*
# pattern deliberately; the # header names the stream/window/version so findings entries can cite them).
#
# READ-ONLY (get/describe only). Line grammar: `HH:MM:SS.mmm LEVEL tag message` — byte-compatible with the
# local export, which is the entire point (DESIGN_cloud_logs.md CW-7: fleet traces ENTER the loop unchanged).

set -u
GROUP="/orchard/dev/client"
INSTALL="${1:-}"
SINCE="${2:-60m}"

case "$SINCE" in
  *h) MS=$(( ${SINCE%h} * 3600000 ));;
  *m) MS=$(( ${SINCE%m} * 60000 ));;
  *)  MS=3600000;;
esac
NOW=$(( $(date +%s) * 1000 ))
FROM=$(( NOW - MS ))
STAMP=$(date -u +%Y%m%d-%H%M%S)

if [ -n "$INSTALL" ]; then
  STREAMS=$(aws logs describe-log-streams --log-group-name "$GROUP" \
    --query "logStreams[?ends_with(logStreamName, \`/$INSTALL\`)].logStreamName" --output text)
  OUTNAME="orchard-logs-fleet-${INSTALL}-${STAMP}.txt"
else
  STREAMS=$(aws logs describe-log-streams --log-group-name "$GROUP" --query 'logStreams[].logStreamName' --output text)
  OUTNAME="orchard-logs-fleet-all-${STAMP}.txt"
fi
[ -z "$STREAMS" ] && { echo "no matching streams in $GROUP"; exit 1; }

OUT="$HOME/$OUTNAME"
{
  echo "# orchard fleet trace (glf pull) · group $GROUP · window last $SINCE (to $(date -u +%FT%TZ))"
  for S in $STREAMS; do
    echo "# ── stream $S ──"
    aws logs get-log-events --log-group-name "$GROUP" --log-stream-name "$S" \
      --start-time "$FROM" --end-time "$NOW" --start-from-head --output json \
    | jq -r 'def pad(n): tostring | . + ((((n - length) * " ") // ""));
        .events[].message | (try fromjson catch {t:0, lvl:"INFO", tag:"?", msg:.}) |
        "\(.t/1000 | floor | gmtime | strftime("%H:%M:%S")).\(.t % 1000 | tostring | ("00" + .)[-3:]) \(.lvl | pad(5)) \(.tag | pad(20)) \(.msg)"'
  done
} > "$OUT"
LINES=$(grep -vc '^#' "$OUT" || true)
echo "wrote $OUT (${LINES} event line(s))"
echo "download: CloudShell Actions → Download file → $OUTNAME → save to Downloads, then run a gl pass"
