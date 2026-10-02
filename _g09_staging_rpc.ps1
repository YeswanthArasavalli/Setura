$ErrorActionPreference = "Continue"
$site = "https://setura-delta.vercel.app"
$idx = Invoke-WebRequest -UseBasicParsing -Uri "$site/"
$js = ([regex]::Matches($idx.Content, '/assets/[A-Za-z0-9._-]+\.js') | ForEach-Object { $_.Value }) | Select-Object -First 1
$bundle = Invoke-WebRequest -UseBasicParsing -Uri "$site$js"
$url = ([regex]::Matches($bundle.Content, 'https://[a-z0-9]+\.supabase\.co') | ForEach-Object { $_.Value }) | Select-Object -Unique
$cands = @()
$cands += [regex]::Matches($bundle.Content, 'sb_publishable_[A-Za-z0-9_\-]+') | ForEach-Object { $_.Value }
$cands += [regex]::Matches($bundle.Content, 'eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}') | ForEach-Object { $_.Value }
$anon = $cands | Select-Object -First 1
$base = $url | Where-Object { $_ -like "*gzcqasntcbqqmgsoikms*" } | Select-Object -First 1
$A = "00000000-0000-4000-8000-000000000001"
function Get-Tok($email) {
  $b = @{ email = $email; password = "Setura@123" } | ConvertTo-Json
  (Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{ apikey = $anon } -ContentType "application/json" -Body $b).access_token
}
$atok = Get-Tok "admin@surya.test"
function Snip($s, $n) { if ($null -eq $s) { return "" }; if ($s.Length -le $n) { return $s } else { return $s.Substring(0,$n) } }
Write-Output "== direct RPC, CORRECT named params, authenticated client (expect denial, NOT 2xx) =="
foreach ($call in @(
  @{ fn = "get_financial_command_center"; args = @{ p_hospital_id = $A; p_date = "2026-10-01" } },
  @{ fn = "get_revenue_forecast"; args = @{ p_hospital_id = $A; p_date = "2026-10-01" } },
  @{ fn = "get_reconciliation_summary"; args = @{ p_hospital_id = $A; p_from_date = "2026-09-01"; p_to_date = "2026-10-01" } }
)) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/rest/v1/rpc/$($call.fn)" -Headers @{ apikey = $anon; Authorization = "Bearer $atok" } -ContentType "application/json" -Body ($call.args | ConvertTo-Json)
    Write-Output ("  rpc {0} -> HTTP {1} {2}" -f $call.fn, [int]$r.StatusCode, (Snip $r.Content 220))
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { Write-Output ("  rpc {0} -> NONE {1}" -f $call.fn, (Snip $_.Exception.Message 220)); continue }
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $body = $sr.ReadToEnd()
    Write-Output ("  rpc {0} -> HTTP {1} {2}" -f $call.fn, [int]$resp.StatusCode, (Snip $body 220))
  }
}
