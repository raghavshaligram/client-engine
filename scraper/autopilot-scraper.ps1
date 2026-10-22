# Client Engine nightly job. Runs from Windows Task Scheduler (see install-schedule.ps1).
# 1. Virginia: if the server couldn't download Virginia's association list this week, download it here and send it.
# 2. Texas: read the next batch of HOA management certificates (OCR in Docker) and send any volunteer emails found.
# 3. Google Maps: run the searches the app asks for (only for products running low on people) and upload the results.
# 4. Email checks: ask Reacher (in Docker, on this computer) whether each new address exists, without sending anything.
# Works in Windows PowerShell 5.1 and PowerShell 7.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
New-Item -ItemType Directory -Force -Path 'logs', 'gmaps-output' | Out-Null
$logFile = Join-Path 'logs' ((Get-Date -Format 'yyyy-MM-dd') + '.log')
function Log($msg) { $line = (Get-Date -Format 'HH:mm:ss') + '  ' + $msg; Write-Host $line; Add-Content -Path $logFile -Value $line }

if (-not (Test-Path 'config.json')) { Log 'config.json not found. Copy config.example.json to config.json and fill it in.'; exit 1 }
$cfg = Get-Content 'config.json' -Raw | ConvertFrom-Json
$site = $cfg.site.TrimEnd('/')
$max = 6; if ($null -ne $cfg.maxSearches) { $max = [int]$cfg.maxSearches }
$texasPerNight = 200; if ($null -ne $cfg.texasPerNight) { $texasPerNight = [int]$cfg.texasPerNight }
$verifyPerNight = 300; if ($null -ne $cfg.verifyPerNight) { $verifyPerNight = [int]$cfg.verifyPerNight }
$reacher = 'http://localhost:8080'; if ($env:CE_REACHER_URL) { $reacher = $env:CE_REACHER_URL }
$here = (Get-Location).Path

function Api($body) {
  $json = $body | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Uri "$site/api" -Method Post -Headers @{ 'x-app-key' = $cfg.appKey } -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 120
}

function Docker-Ready {
  if ($env:CE_OCR_CMD -and $env:CE_FAKE_SCRAPER) { return $true }
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) { Log 'Docker is not running. Start Docker Desktop (and set it to start when you sign in).'; return $false }
  return $true
}

try { $status = Api @{ action = 'source.status' } }
catch { Log "Could not reach the app at ${site}: $($_.Exception.Message)"; exit 1 }

# ---- 1. Virginia fallback --------------------------------------------------------
if ($status.virginia.needsUpload) {
  try {
    Log 'Virginia: the server could not download the list, fetching it from here'
    $va = Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri 'https://www.dpor.virginia.gov/sites/default/files/Records%20and%20Documents/Regulant%20List/0550__crnt.txt'
    $text = if ($va.Content -is [byte[]]) { [Text.Encoding]::GetEncoding('ISO-8859-1').GetString($va.Content) } else { [string]$va.Content }
    $r = Api @{ action = 'source.virginia'; text = $text }
    Log "  $($r.total) associations, $($r.volunteers) with a volunteer's address, $($r.added) new"
  } catch { Log "  Virginia failed: $($_.Exception.Message)" }
}

# ---- 2. Texas certificates ------------------------------------------------------------
if ($texasPerNight -gt 0 -and (Docker-Ready)) {
  try {
    $offset = 0; if ($status.texas.offset) { $offset = [int]$status.texas.offset }
    $q = 'https://data.texas.gov/resource/8auc-hzdi.json?$order=:id&$limit=' + $texasPerNight + '&$offset=' + $offset
    $certs = @(Invoke-RestMethod -Uri $q -TimeoutSec 120 | ForEach-Object { $_ })   # enumerate: PowerShell returns the JSON array as one object
    if ($certs.Count -eq 0) { Log "Texas: no new certificates since the last run (read up to $offset)." }
    else {
      Log "Texas: reading certificates $offset to $($offset + $certs.Count - 1)"
      $work = Join-Path $here 'texas-work'
      if (Test-Path $work) { Remove-Item -Recurse -Force $work }
      New-Item -ItemType Directory -Path $work | Out-Null
      $i = 0
      foreach ($c in $certs) {
        $i++
        $url = [string]$c.certificate.url
        if (-not $url) { continue }
        $url = $url.Replace(' ', '%20').Replace('[', '%5B').Replace(']', '%5D')
        try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri $url -OutFile (Join-Path $work "c$i.pdf") } catch { }
        Start-Sleep -Milliseconds 300   # be gentle with the state's site
      }
      if ($env:CE_OCR_CMD) { & $env:CE_OCR_CMD $work }
      else {
        & docker image inspect ce-ocr *> $null
        if ($LASTEXITCODE -ne 0) { Log '  building the OCR image (first run only)'; & docker build -q -t ce-ocr (Join-Path $here 'ocr') | Out-Null }
        & docker run --rm -v "${work}:/work" ce-ocr 2>&1 | Out-Null
      }
      $out = @()
      $i = 0
      foreach ($c in $certs) {
        $i++
        $txt = Join-Path $work "c$i.txt"
        $emails = @()
        if (Test-Path $txt) { $emails = @([regex]::Matches((Get-Content $txt -Raw), '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}') | ForEach-Object { $_.Value }) }
        $out += @{ name = $c.name; city = $c.city; county = $c.county; zip = $c.zip; type = $c.type; emails = $emails }
      }
      $r = Api @{ action = 'source.texas'; certs = $out; done = $certs.Count; offset = $offset + $certs.Count }
      Log "  $($r.volunteers) volunteer emails found, $($r.added) new people added"
      Remove-Item -Recurse -Force $work
    }
  } catch { Log "Texas failed: $($_.Exception.Message)" }
}

# ---- 4. Email checks (defined here, run at the end) ------------------------------------
function Verify-Emails {
  if ($verifyPerNight -le 0) { return }
  try {
    if (-not $env:CE_REACHER_URL) {
      if (-not (Docker-Ready)) { return }
      & docker start reacher *> $null
      if ($LASTEXITCODE -ne 0) { & docker run -d --name reacher --restart unless-stopped -p 8080:8080 reacherhq/backend:latest *> $null }
      Start-Sleep -Seconds 10
    }
    $batch = Api @{ action = 'verify.next'; limit = $verifyPerNight }
    $list = @($batch.emails | ForEach-Object { $_ })
    Log "Email checks: $($list.Count) to check ($($batch.markedUnknown) Yahoo/AOL/Microsoft addresses marked as can't-check)"
    $results = @(); $counts = @{}
    foreach ($e in $list) {
      $reach = 'unknown'
      try {
        $r = Invoke-RestMethod -Uri "$reacher/v0/check_email" -Method Post -ContentType 'application/json' -Body (@{ to_email = $e.email } | ConvertTo-Json) -TimeoutSec 60
        if ($r.is_reachable) { $reach = [string]$r.is_reachable }
      } catch { }
      $counts[$reach] = 1 + [int]$counts[$reach]
      $results += @{ id = $e.id; reachable = $reach }
      if ($results.Count -ge 50) { Api @{ action = 'verify.results'; results = $results } | Out-Null; $results = @() }
      Start-Sleep -Milliseconds 500   # one at a time, gently
    }
    if ($results.Count) { Api @{ action = 'verify.results'; results = $results } | Out-Null }
    Log ("  " + (($counts.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', '))
  } catch { Log "Email checks failed: $($_.Exception.Message)" }
}

# ---- 3. Google Maps searches ----------------------------------------------------------
function Run-Scraper($queriesFile, $outName) {
  if ($env:CE_FAKE_SCRAPER) { Copy-Item $env:CE_FAKE_SCRAPER (Join-Path 'gmaps-output' $outName); return }
  & docker run --rm -v gmaps-playwright-cache:/opt -v "${here}\${queriesFile}:/queries.txt:ro" -v "${here}\gmaps-output:/out" `
    gosom/google-maps-scraper -input /queries.txt -results "/out/$outName" -email -depth 3 -c 2 -lang en -exit-on-inactivity 3m 2>&1 |
    ForEach-Object { if ($_ -match 'error|blocked|captcha') { Log "  scraper: $_" } }
}

try { $next = Api @{ action = 'scrape.next'; limit = $max } } catch { Log "Could not get tonight's searches: $($_.Exception.Message)"; exit 1 }
$queries = @($next.queries)
if ($queries.Count -eq 0) { Log 'Maps: nothing to search tonight (every product has enough people ready, or the search plan is empty).'; Verify-Emails; Log 'Done.'; exit 0 }
if (-not $env:CE_FAKE_SCRAPER -and -not (Docker-Ready)) { Verify-Emails; exit 1 }

$keep = 'title', 'category', 'address', 'website', 'phone', 'review_count', 'review_rating', 'emails', 'status', 'complete_address', 'link', 'about', 'descriptions'
$groups = $queries | Group-Object -Property { "$($_.productId)|$($_.segment)" }
foreach ($g in $groups) {
  $productId, $segment = $g.Name.Split('|')
  $stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
  $qFile = "queries-$productId-$segment.txt"
  ($g.Group | ForEach-Object { $_.query }) -join "`n" | Set-Content -Path $qFile -Encoding ascii
  $outName = "results-$productId-$segment-$stamp.csv"
  Log "Maps: $productId / ${segment}: $($g.Count) searches"
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
Verify-Emails
Log 'Done.'
