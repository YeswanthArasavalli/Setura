$ErrorActionPreference = "Continue"
$u = "https://gzcqasntcbqqmgsoikms.supabase.co/functions/v1"
$origin = "https://setura-delta.vercel.app"
$headers = @{
  "Origin"                         = $origin
  "Access-Control-Request-Method"  = "POST"
  "Access-Control-Request-Headers" = "apikey,authorization,content-type,x-client-info,x-hospital-id"
}
foreach ($fn in @("executive-analytics", "command-center")) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Options -Uri "$u/$fn" -Headers $headers
    Write-Output ("OPTIONS {0} -> HTTP {1}" -f $fn, [int]$r.StatusCode)
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { Write-Output ("OPTIONS {0} -> ERR {1}" -f $fn, $_.Exception.Message); continue }
    Write-Output ("OPTIONS {0} -> HTTP {1}" -f $fn, [int]$resp.StatusCode)
  }
  $hd = $r.Headers
  foreach ($k in @("access-control-allow-origin", "access-control-allow-headers", "access-control-allow-credentials", "vary", "server")) {
    if ($hd[$k]) { Write-Output ("   {0}: {1}" -f $k, ($hd[$k] -join " | ")) }
  }
}
Write-Output "== POST without apikey (contract check only) =="
try {
  $r2 = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$u/executive-analytics" -ContentType "application/json" -Body '{"action":"portfolio"}' -Headers @{ Origin = $origin }
  Write-Output ("   HTTP {0} {1}" -f [int]$r2.StatusCode, $r2.Content)
} catch {
  $resp = $_.Exception.Response
  $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
  Write-Output ("   HTTP {0} {1}" -f [int]$resp.StatusCode, $reader.ReadToEnd())
}
