$ErrorActionPreference = "Continue"
$site = "https://setura-delta.vercel.app"

# 1. Recover the PUBLIC anon key + URL from the shipped browser bundle (public by design; printed by length only).
$idx = Invoke-WebRequest -UseBasicParsing -Uri "$site/"
$js = ([regex]::Matches($idx.Content, '/assets/[A-Za-z0-9._-]+\.js') | ForEach-Object { $_.Value }) | Select-Object -First 1
$bundle = Invoke-WebRequest -UseBasicParsing -Uri "$site$js"
$url = ([regex]::Matches($bundle.Content, 'https://[a-z0-9]+\.supabase\.co') | ForEach-Object { $_.Value }) | Select-Object -Unique
$cands = @()
$cands += [regex]::Matches($bundle.Content, 'sb_publishable_[A-Za-z0-9_\-]+') | ForEach-Object { $_.Value }
$cands += [regex]::Matches($bundle.Content, 'eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}') | ForEach-Object { $_.Value }
$anon = $cands | Select-Object -First 1
$base = $url | Where-Object { $_ -like "*gzcqasntcbqqmgsoikms*" } | Select-Object -First 1
Write-Output ("base={0} anon_len={1}" -f $base, $anon.Length)

function Get-Tok($email) {
  $b = @{ email = $email; password = "Setura@123" } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{ apikey = $anon } -ContentType "application/json" -Body $b
    return $r.access_token
  } catch { Write-Output ("login failed {0}: {1}" -f $email, $_.Exception.Message); return $null }
}
function Fn($tok, $hid, $body) {
  $h = @{ apikey = $anon }
  if ($tok) { $h["Authorization"] = "Bearer $tok" }
  if ($hid) { $h["X-Hospital-ID"] = $hid }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/functions/v1/financial-command-center" -Headers $h -ContentType "application/json" -Body ($body | ConvertTo-Json)
    return @{ status = [int]$r.StatusCode; body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { return @{ status = "none"; body = $_.Exception.Message } }
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    return @{ status = [int]$resp.StatusCode; body = $reader.ReadToEnd() }
  }
}
function Rpc($tok, $fn, $args) {
  $h = @{ apikey = $anon }
  if ($tok) { $h["Authorization"] = "Bearer $tok" }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/rest/v1/rpc/$fn" -Headers $h -ContentType "application/json" -Body ($args | ConvertTo-Json)
    return @{ status = [int]$r.StatusCode; body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { return @{ status = "none"; body = $_.Exception.Message } }
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    return @{ status = [int]$resp.StatusCode; body = $reader.ReadToEnd() }
  }
}
function Snip($s, $n) { if ($s.Length -le $n) { return $s } else { return $s.Substring(0,$n) } }

$A = "00000000-0000-4000-8000-000000000001"

Write-Output "== hospital_admin (admin@surya.test) @ A =="
$atok = Get-Tok "admin@surya.test"
foreach ($act in @("overview","forecast","reconciliation")) {
  $p = Fn $atok $A @{ action = $act }
  Write-Output ("  {0} -> HTTP {1}" -f $act, $p.status)
  Write-Output ("    {0}" -f (Snip $p.body 300))
}

Write-Output "== global_admin (root@setura.test) @ valid header =="
$gtok = Get-Tok "root@setura.test"
if ($gtok) {
  $hs = Invoke-RestMethod -Uri "$base/rest/v1/hospitals?select=id,name&order=name.asc" -Headers @{ apikey = $anon; Authorization = "Bearer $gtok" }
  $ghid = $hs[0].id
  Write-Output ("  using acting hospital {0} ({1}) of {2} visible" -f $ghid, $hs[0].name, $hs.Count)
  $g = Fn $gtok $ghid @{ action = "overview" }
  Write-Output ("  overview -> HTTP {0}" -f $g.status)
  Write-Output ("    {0}" -f (Snip $g.body 220))
  # capture a NON-A hospital id for the cross-tenant probe
  $B = ($hs | Where-Object { $_.id -ne $A } | Select-Object -First 1).id
} else { $B = $null }
if (-not $B) { $B = "00000000-0000-4000-8000-000000000002" }
Write-Output ("  cross-tenant target B={0}" -f $B)

Write-Output "== receptionist (reception@surya.test) @ A =="
$rtok = Get-Tok "reception@surya.test"
foreach ($act in @("overview","forecast","reconciliation")) {
  $p = Fn $rtok $A @{ action = $act }
  Write-Output ("  {0} -> HTTP {1} {2}" -f $act, $p.status, (Snip $p.body 140))
}

Write-Output "== doctor (dr@surya.test) @ A =="
$dtok = Get-Tok "dr@surya.test"
foreach ($act in @("overview","forecast","reconciliation")) {
  $p = Fn $dtok $A @{ action = $act }
  Write-Output ("  {0} -> HTTP {1} {2}" -f $act, $p.status, (Snip $p.body 140))
}

Write-Output "== missing X-Hospital-ID (hospital_admin token) =="
$p = Fn $atok $null @{ action = "overview" }
Write-Output ("  overview -> HTTP {1} {2}" -f $p.status, (Snip $p.body 160))

Write-Output "== anonymous (no Bearer) =="
$p = Fn $null $A @{ action = "overview" }
Write-Output ("  overview -> HTTP {0} {1}" -f $p.status, (Snip $p.body 160))

Write-Output "== cross-tenant: admin(A member) reads B =="
$p = Fn $atok $B @{ action = "overview" }
Write-Output ("  overview -> HTTP {0} {1}" -f $p.status, (Snip $p.body 200))

Write-Output "== direct RPC privilege (authenticated client, expect denial) =="
foreach ($fn in @("get_financial_command_center","get_revenue_forecast","get_reconciliation_summary")) {
  $r = Rpc $atok $fn @{ p_hospital_id = $A }
  Write-Output ("  rpc {0} -> HTTP {1} {2}" -f $fn, $r.status, (Snip $r.body 180))
}
