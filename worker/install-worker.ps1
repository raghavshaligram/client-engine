# Sets up the build worker in Windows Task Scheduler. Run once:
#   right-click > Run with PowerShell   (or: powershell -ExecutionPolicy Bypass -File install-worker.ps1)
# It runs every 10 minutes while you're signed in, and does nothing when there are no jobs.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'agency-worker.mjs'
if (-not (Test-Path (Join-Path $PSScriptRoot 'config.json'))) { Write-Host 'Fill in config.json first (copy config.example.json).'; exit 1 }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host 'Node.js is not installed. Install the LTS version from nodejs.org, then run this again.'; exit 1 }
& $node $script --check
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3) -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName 'Website Studio worker' -Action $action -Trigger $trigger -Settings $settings -Description 'Builds and deploys client sites for Client Engine' -Force | Out-Null
Write-Host 'Done. "Website Studio worker" checks for jobs every 10 minutes. Logs go to the logs folder next to this file.'
