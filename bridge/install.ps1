# bridge/install.ps1 — DB-1 (v2.74.972): register the orchard dev-bridge native-messaging host.
# Idempotent: re-running rewrites the manifest + registry value in place. HKCU only — no admin.
#
# What it does (docs/DESIGN_dev_bridge.md §3.1):
#   1. Derives the extension id from manifest.json's "key" (the id pin), so the host manifest's
#      allowed_origins always matches the loaded unpacked extension.
#   2. Writes bridge/com.orchard.devbridge.json (machine-specific absolute path — git-ignored).
#   3. Points HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.orchard.devbridge at it.
#   4. Preflights node + the claude CLI and prints a summary.

$ErrorActionPreference = 'Stop'
$HostName = 'com.orchard.devbridge'
$BridgeDir = $PSScriptRoot
$RepoRoot = Split-Path -Parent $BridgeDir

# ── 1. extension id from the manifest "key" (SHA-256 of the DER key, first 16 bytes, a–p alphabet) ──
$manifest = Get-Content (Join-Path $RepoRoot 'manifest.json') -Raw | ConvertFrom-Json
if (-not $manifest.key) { throw 'manifest.json has no "key" — the extension id is not pinned (spec §3.1)' }
$der = [Convert]::FromBase64String($manifest.key)
$sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($der)
$extId = -join (0..15 | ForEach-Object {
  $b = $sha[$_]
  [char][int]([int][char]'a' + ($b -shr 4)), [char][int]([int][char]'a' + ($b -band 0xF))
})
Write-Host "extension id : $extId"

# ── 2. host manifest (absolute .bat path; machine-specific → git-ignored) ──
$hostManifest = [ordered]@{
  name            = $HostName
  description     = 'orchard dev bridge - Claude Code in the side panel (DB-1)'
  path            = (Join-Path $BridgeDir 'host.bat')
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$extId/")
}
$manifestPath = Join-Path $BridgeDir "$HostName.json"
# DB-1 fix — write BOM-less UTF-8. `Set-Content -Encoding UTF8` emits a BOM on Windows PowerShell 5.1,
# and Chrome's native-messaging manifest parser REJECTS a leading BOM (the host then never registers).
# WriteAllText with UTF8Encoding($false) is BOM-less on both PS 5.1 and pwsh 7.
[System.IO.File]::WriteAllText($manifestPath, ($hostManifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "host manifest: $manifestPath"

# ── 3. registry ──
$regKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $regKey -Force | Out-Null
Set-ItemProperty -Path $regKey -Name '(Default)' -Value $manifestPath
Write-Host "registry     : $regKey"

# ── 4. preflight ──
$nodeV = ''
try { $nodeV = (& node --version) 2>$null } catch {}
if (-not $nodeV) { Write-Warning 'node not found on PATH - the host cannot run' }
else { Write-Host "node         : $nodeV" }
$claudeV = ''
try { $claudeV = (& cmd /c 'claude --version') 2>$null | Select-Object -First 1 } catch {}
if (-not $claudeV) { Write-Warning 'claude CLI not found on PATH - bridge runs will fail preflight' }
else { Write-Host "claude       : $claudeV" }

Write-Host ''
Write-Host 'Installed. Reload the extension, enable the dev bridge in chat settings (grants the'
Write-Host 'optional nativeMessaging permission), and the panel can connect.'
