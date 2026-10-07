# Client Engine nightly scraper. Runs from Windows Task Scheduler (see install-schedule.ps1).
# 1. Asks the app which searches to run tonight (only for products running low on people).
# 2. Runs the Google Maps scraper in Docker, once per product and segment.
# 3. Uploads the results to the app, which cleans, reads websites, scores and drafts on its own.
# Works in Windows PowerShell 5.1 and PowerShell 7.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path 'logs', 'gmaps-output' | Out-Null
$logFile = Join-Path 'logs' ((Get-Date -Format 'yyyy-MM-dd') + '.log')
function Log($msg) { $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $msg; Write-Host $line; Add-Content -Path $logFile -Value $line }

if (-not (Test-Path 'config.json')) { Log 'config.json not found. Copy config.example.json to config.json and fill it in.'; exit 1 }
$cfg = Get-Content 'config.json' -Raw | ConvertFrom-Json
$site = $cfg.site.TrimEnd('/')
$max = 6; if ($cfg.maxSearches) { $max = [int]$cfg.maxSearches }

function Api($body) {
  $json = $body | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Uri "$site/api" -Method Post -Headers @{ 'x-app-key' = $cfg.appKey } -ContentType 'application/json; charset=utf-8' -Body $bytes
}

function Run-Scraper($queriesFile, $outName) {
  if ($env:CE_FAKE_SCRAPER) { Copy-Item $env:CE_FAKE_SCRAPER (Join-Path 'gmaps-output' $outName); return }
  $here = (Get-Location).Path
  & docker run --rm -v gmaps-playwright-cache:/opt -v "${here}\${queriesFile}:/queries.txt:ro" -v "${here}\gmaps-output:/out" `
    gosom/google-maps-scraper -input /queries.txt -results "/out/$outName" -email -depth 3 -c 2 -lang en -exit-on-inactivity 3m 2>&1 |
    ForEach-Object { if ($_ -match 'error|blocked|captcha') { Log "  scraper: $_" } }
}

try {
  $next = Api @{ action = 'scrape.next'; limit = $max }
} catch { Log "Could not reach the app at ${site}: $($_.Exception.Message)"; exit 1 }
$queries = @($next.queries)
if ($queries.Count -eq 0) { Log 'Nothing to search tonight: every product has enough people ready, or the search plan is empty.'; exit 0 }

if (-not $env:CE_FAKE_SCRAPER) {
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) { Log 'Docker is not running. Start Docker Desktop (and set it to start when you sign in).'; exit 1 }
}

$keep = 'title', 'category', 'address', 'website', 'phone', 'review_count', 'review_rating', 'emails', 'status', 'complete_address', 'link', 'about', 'descriptions'
$groups = $queries | Group-Object -Property { "$($_.productId)|$($_.segment)" }
foreach ($g in $groups) {
  $productId, $segment = $g.Name.Split('|')
  $stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
  $qFile = "queries-$productId-$segment.txt"
  ($g.Group | ForEach-Object { $_.query }) -join "`n" | Set-Content -Path $qFile -Encoding ascii
  $outName = "results-$productId-$segment-$stamp.csv"
  Log "$productId / ${segment}: $($g.Count) searches"
  Run-Scraper $qFile $outName
  $csv = Join-Path 'gmaps-output' $outName
  if (-not (Test-Path $csv)) { Log "  no results file. Google may have blocked this connection for now; it will retry another night."; continue }
  $rows = @(Import-Csv $csv | Select-Object -Property $keep)
  Log "  $($rows.Count) listings found"
  if ($rows.Count -eq 0) { Log '  0 listings. Google may be blocking; try fewer searches per night.'; continue }
  $added = 0
  for ($i = 0; $i -lt $rows.Count; $i += 300) {
    $batch = @($rows[$i..([Math]::Min($i + 299, $rows.Count - 1))])
    $r = Api @{ action = 'prospects.import'; productId = $productId; segment = $segment; kind = 'maps'; rows = $batch; sourceFile = $outName }
    $added += [int]$r.added
  }
  Log "  $added new people added"
}
Log 'Done.'
