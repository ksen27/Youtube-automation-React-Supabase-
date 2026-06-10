# Tests each proxy two ways:
#   1. curl raw connectivity to YouTube (fast — shows tunnel/502 issues)
#   2. yt-dlp metadata fetch on the video that was failing (real-world)
# Edit $videoId if you want to test a different clip.

$videoId = "k5ps2f7UM8I"
$videoUrl = "https://www.youtube.com/watch?v=$videoId"

$proxies = @(
  "72.1.159.153:6543:ttremosg:mhzaruqkenoa"
  "63.246.158.234:6482:ttremosg:mhzaruqkenoa"
  "203.160.124.95:5294:ttremosg:mhzaruqkenoa"
  "69.30.79.183:5236:ttremosg:mhzaruqkenoa"
  "45.56.153.80:5945:ttremosg:mhzaruqkenoa"
  "138.226.92.174:5862:ttremosg:mhzaruqkenoa"
  "185.205.204.147:5833:ttremosg:mhzaruqkenoa"
  "45.45.202.54:7055:ttremosg:mhzaruqkenoa"
  "9.142.6.10:7668:ttremosg:mhzaruqkenoa"
  "45.56.168.83:5984:ttremosg:mhzaruqkenoa"
)

$results = @()

foreach ($p in $proxies) {
  $parts = $p.Split(":")
  $host_ = $parts[0]; $port = $parts[1]; $user = $parts[2]; $pass = $parts[3]
  $proxyUrl = "http://${user}:${pass}@${host_}:${port}"
  Write-Host "`n=== Testing $host_`:$port ===" -ForegroundColor Cyan

  # 1) Raw curl connectivity — what IP does YouTube see through this proxy
  $curlOut = & curl.exe -s -x $proxyUrl --max-time 25 -o NUL -w "%{http_code}" "https://www.youtube.com/" 2>&1
  $curlCode = "$curlOut".Trim()
  Write-Host "  curl youtube.com -> HTTP $curlCode"

  # 2) Real yt-dlp metadata fetch (no download, just resolve the page)
  $ytErr = & yt-dlp --proxy $proxyUrl --simulate --no-warnings --print "%(title)s" --socket-timeout 25 $videoUrl 2>&1
  $ytExit = $LASTEXITCODE
  if ($ytExit -eq 0) {
    Write-Host "  yt-dlp -> OK: $ytErr" -ForegroundColor Green
    $status = "OK"
  } else {
    $short = ("$ytErr" -replace "\s+", " ")
    if ($short.Length -gt 160) { $short = $short.Substring(0,160) }
    Write-Host "  yt-dlp -> FAIL: $short" -ForegroundColor Red
    $status = "FAIL"
  }

  $results += [PSCustomObject]@{ Proxy = "$host_`:$port"; Curl = $curlCode; YtDlp = $status }
}

Write-Host "`n===== SUMMARY =====" -ForegroundColor Yellow
$results | Format-Table -AutoSize
$ok = ($results | Where-Object { $_.YtDlp -eq "OK" }).Count
Write-Host "$ok / $($results.Count) proxies working with yt-dlp" -ForegroundColor Yellow
