# Runs the Google Maps scraper on Windows with Docker Desktop.
# 1. In Client Engine > Find, download queries.txt and put it in this folder.
# 2. Right-click this file > Run with PowerShell (or: powershell -ExecutionPolicy Bypass -File run-scraper.ps1)
# 3. When it finishes, import gmaps-output\results.csv in Client Engine > Find.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path "queries.txt")) { Write-Host "queries.txt not found in $PSScriptRoot"; exit 1 }
New-Item -ItemType Directory -Force -Path "gmaps-output" | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd-HHmm"
docker run --rm `
  -v gmaps-playwright-cache:/opt `
  -v "${PWD}\queries.txt:/queries.txt:ro" `
  -v "${PWD}\gmaps-output:/out" `
  gosom/google-maps-scraper `
  -input /queries.txt -results "/out/results-$stamp.csv" -email -depth 3 -c 2 -lang en -exit-on-inactivity 3m
Write-Host "Done: gmaps-output\results-$stamp.csv"
