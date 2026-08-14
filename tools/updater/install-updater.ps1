<#
  install-updater.ps1 — one-time enrollment of a Windows fleet machine (SU rung 3; DESIGN_self_update.md §2, §7).
  Registers the node updater on a 10-minute Scheduled Task. Run ONCE per Windows account (enrollment is per OS
  account, not per machine — §7). Re-run to upgrade the updater script itself (the human act ruling 15 requires).

  What it does, and why each step is here:
   - COPIES updater.cjs + promoteChecks.cjs into the state dir and points the task at the COPY — the updater must
     never run from the clone it hard-resets, or a bad push to `fleet` becomes host-shell RCE (ruling 15).
   - writes config.json {clone,...} so the task command is just `node updater.cjs` (no env to marshal through schtasks).
   - stamps a per-clone machine GUID so N Chrome profiles' identical heartbeats dedupe to one updater in glf (§7).
   - pins the clone's fetch refspec so origin/fleet + origin/fleet-control resolve (a --single-branch clone can't, §7).
   - registers the task LOGGED-ON-ONLY (never S4U/-NP): S4U has no DPAPI master key, so git-credential-manager
     fails every tick even while the user is logged in (§7).

  Usage:  .\install-updater.ps1 -Clone C:\path\to\orchard-clone   [-IntervalMinutes 10]
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Clone,
  [int]$IntervalMinutes = 10,
  [string]$TaskName = 'orchard-fleet-updater'
)
$ErrorActionPreference = 'Stop'

function Need($exe) { if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { throw "$exe is required on PATH. Install it before enrolling (git + node are the two prerequisites)." } }
Need git; Need node

$Clone = (Resolve-Path $Clone).Path
if (-not (Test-Path (Join-Path $Clone 'manifest.json'))) { throw "Clone '$Clone' has no manifest.json — is it the Orchard extension clone?" }

$StateDir = Join-Path $env:LOCALAPPDATA 'orchard-updater'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# run-from-copy (ruling 15): the source of truth is tools/updater/ in the clone; the RUNNING copy lives here.
Copy-Item (Join-Path $PSScriptRoot 'updater.cjs')       (Join-Path $StateDir 'updater.cjs')       -Force
Copy-Item (Join-Path $PSScriptRoot 'promoteChecks.cjs') (Join-Path $StateDir 'promoteChecks.cjs') -Force

# config the task reads (no env marshalling through schtasks). Write BOM-FREE — Windows PowerShell 5.1's
# `Set-Content -Encoding utf8` emits a UTF-8 BOM that node's JSON.parse rejects (review F7), so use
# WriteAllText with a no-BOM UTF8Encoding. Pin the ABSOLUTE git path so the task resolves the same git the
# credential was seeded under, not a PATH surprise (review F5 / §7).
$gitPath = (Get-Command git).Source
$cfg = @{ clone = $Clone; remote = 'origin'; fleet = 'fleet'; control = 'fleet-control'; cadenceMin = $IntervalMinutes; git = $gitPath } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $StateDir 'config.json'), $cfg, (New-Object System.Text.UTF8Encoding $false))

# per-clone machine GUID (§7) — dedup key for N profiles' identical heartbeats
$guidFile = Join-Path $StateDir 'machine-guid'
if (-not (Test-Path $guidFile)) { [guid]::NewGuid().ToString() | Set-Content -Path $guidFile -Encoding ascii }

# pin the fetch refspec so both refs resolve even from a shallow/single-branch clone (§7)
& git -C $Clone config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
# seed the read-only credential interactively ONCE (DPAPI via git-credential-manager); a background task can't prompt
Write-Host 'Seeding the git credential (a one-time interactive fetch)...' -ForegroundColor Cyan
& git -C $Clone fetch origin fleet fleet-control
# check out a DEDICATED `fleet` branch so the updater's `reset --hard` moves `fleet`, never local `main` (review F11 / §7)
& git -C $Clone checkout -B fleet origin/fleet

# register the task LOGGED-ON-ONLY (NOT S4U) — see header. Runs `node <state>\updater.cjs` every N minutes.
$action = New-ScheduledTaskAction -Execute 'node' -Argument (Join-Path $StateDir 'updater.cjs')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

Write-Host "Enrolled. Task '$TaskName' runs node $StateDir\updater.cjs every $IntervalMinutes min for clone $Clone." -ForegroundColor Green
Write-Host "NOTE: turn on cloud logs in the extension (settings:cloudLogs) or the UPDATE beacons stay local (§3.3 precondition)." -ForegroundColor Yellow
Write-Host "To decommission: Unregister-ScheduledTask -TaskName $TaskName; revoke the deploy token; delete $StateDir and the clone." -ForegroundColor DarkGray
