<#
  enroll.ps1 — ONE-SHOT workstation setup (SU, DESIGN_self_update.md). Wraps clone + install-updater so a
  non-technical installer runs a single command, signs in once, and finishes with three clicks in Chrome.
  Auto-pins the promote public key if it's committed in the repo (update/promote-pubkey.pem) → provenance on.

  Usage (from anywhere):
    powershell -ExecutionPolicy Bypass -File enroll.ps1 -RepoUrl https://github.com/flyingturtlesolutions/orchard.git
  Optional: -Dir <folder>  (default %USERPROFILE%\orchard)   -IntervalMinutes 10
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepoUrl,
  [string]$Dir = (Join-Path $env:USERPROFILE 'orchard'),
  [int]$IntervalMinutes = 10
)
$ErrorActionPreference = 'Stop'

function Ok($m)  { Write-Host $m -ForegroundColor Green }
function Warn($m){ Write-Host $m -ForegroundColor Yellow }
function Die($m) { Write-Host "SETUP STOPPED: $m" -ForegroundColor Red; exit 1 }

# 1. prerequisites — fail with a plain message instead of a confusing error later
foreach ($exe in @('git', 'node')) {
  if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
    Die "$exe is not installed. Ask your setup contact to install Git and Node, then run this again."
  }
}

# 2. get the code (clone; reuse the folder if it's already there)
if (Test-Path (Join-Path $Dir 'manifest.json')) {
  Ok "Using the existing app folder: $Dir"
} elseif (Test-Path $Dir) {
  Die "The folder $Dir exists but isn't the app. Delete it or choose another with -Dir, then run again."
} else {
  Write-Host "Downloading the app to $Dir …"
  & git clone $RepoUrl $Dir
  if ($LASTEXITCODE -ne 0) { Die "Download failed. Check the link and your login, then run again." }
}

# 3. enroll (auto-pin provenance if the public key ships in the repo)
$installer = Join-Path $Dir 'tools\updater\install-updater.ps1'
if (-not (Test-Path $installer)) { Die "This doesn't look like the Orchard app (installer missing)." }
$pub = Join-Path $Dir 'update\promote-pubkey.pem'
Write-Host "Enabling auto-update…"
if (Test-Path $pub) { & $installer -Clone $Dir -Pubkey $pub -IntervalMinutes $IntervalMinutes }
else { Warn "note: no signing key shipped in the repo — enrolling WITHOUT update-signature checks."; & $installer -Clone $Dir -IntervalMinutes $IntervalMinutes }
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) { Die "Enrollment failed above — send the red text to your setup contact." }

# 4. the two things only a human can do in Chrome
Write-Host ""
Ok "Auto-update is on. Two last steps in Chrome:"
Write-Host "  1) Open a new tab, type  chrome://extensions  and press Enter. Turn ON 'Developer mode' (top-right)."
Write-Host "  2) Click 'Load unpacked' and choose this folder:"
Write-Host "        $Dir" -ForegroundColor Cyan
Write-Host "  Then click the puzzle-piece icon, pin 'Orchard', open its side panel, and turn on cloud logs."
Write-Host ""
Ok "Done. When an update is ready a reload button lights up — click it to apply."
