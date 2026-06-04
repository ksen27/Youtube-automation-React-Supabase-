# Tests each proxy two ways:
#   1. curl raw connectivity to YouTube (fast — shows tunnel/502 issues)
#   2. yt-dlp metadata fetch on the video that was failing (real-world)
# Edit $videoId if you want to test a different clip.

$videoId = "k5ps2f7UM8I"
$videoUrl = "https://www.youtube.com/watch?v=$videoId"

$proxies = @(
  "45.56.149.184:6571:ttremosg:mhzaruqkenoa"
  "9.142.38.25:7695:ttremosg:mhzaruqkenoa"
  "168.158.187.29:6808:ttremosg:mhzaruqkenoa"
  "9.142.49.22:7184:ttremosg:mhzaruqkenoa"
  "9.142.58.58:5721:ttremosg:mhzaruqkenoa"
  "69.30.75.166:6223:ttremosg:mhzaruqkenoa"
  "9.142.28.55:6713:ttremosg:mhzaruqkenoa"
  "207.135.197.210:6151:ttremosg:mhzaruqkenoa"
  "78.31.205.139:5325:ttremosg:mhzaruqkenoa"
  "45.56.140.97:5331:ttremosg:mhzaruqkenoa"
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
