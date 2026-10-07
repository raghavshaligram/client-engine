# Sets up the nightly scraper in Windows Task Scheduler. Run once:
#   right-click > Run with PowerShell   (or: powershell -ExecutionPolicy Bypass -File install-schedule.ps1)
# It runs at 1:30 am. If the computer was off or asleep, it runs as soon as it's back on.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'autopilot-scraper.ps1'
if (-not (Test-Path (Join-Path $PSScriptRoot 'config.json'))) { Write-Host 'Fill in config.json first (copy config.example.json).'; exit 1 }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At '1:30am'
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3) -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName 'Client Engine scraper' -Action $action -Trigger $trigger -Settings $settings -Description 'Finds new prospects for Client Engine' -Force | Out-Null
Write-Host 'Done. "Client Engine scraper" will run every night at 1:30 am. Logs go to the logs folder next to this file.'
Write-Host 'To run it now: Start-ScheduledTask -TaskName "Client Engine scraper"'
