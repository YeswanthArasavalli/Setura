$ErrorActionPreference = "Continue"
$site = "https://setura-delta.vercel.app"

# 1. Recover the PUBLIC anon key + URL from the shipped browser bundle (they are
#    embedded in the deployed JS by design; never committed, printed by length only).
$idx = Invoke-WebRequest -UseBasicParsing -Uri "$site/"
$js = ([regex]::Matches($idx.Content, '/assets/[A-Za-z0-9._-]+\.js') | ForEach-Object { $_.Value }) | Select-Object -First 1
$bundle = Invoke-WebRequest -UseBasicParsing -Uri "$site$js"
$url = ([regex]::Matches($bundle.Content, 'https://[a-z0-9]+\.supabase\.co') | ForEach-Object { $_.Value }) | Select-Object -Unique
$cands = @()
$cands += [regex]::Matches($bundle.Content, 'sb_publishable_[A-Za-z0-9_\-]+') | ForEach-Object { $_.Value }
$cands += [regex]::Matches($bundle.Content, 'eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}') | ForEach-Object { $_.Value }
$anon = $cands | Select-Object -First 1
Write-Output ("   bundle={0} url={1} anon_kind={2} anon_len={3} candidates={4}" -f $js, ($url -join ","), ($(if ($anon -like 'sb_*') { "publishable" } else { "jwt" })), $anon.Length, $cands.Count)
$base = $url | Where-Object { $_ -like "*gzcqasntcbqqmgsoikms*" } | Select-Object -First 1

function Get-StagingTok($email) {
  $b = @{ email = $email; password = "Setura@123" } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{ apikey = $anon } -ContentType "application/json" -Body $b
    return $r.access_token
  } catch { Write-Output "   login failed for $email : $($_.Exception.Message)"; return $null }
}

function Call-Analytics($tok, $hid, $body) {
  $h = @{ apikey = $anon; Authorization = "Bearer $tok" }
  if ($hid) { $h["X-Hospital-ID"] = $hid }
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/functions/v1/executive-analytics" -Headers $h -ContentType "application/json" -Body ($body | ConvertTo-Json)
    return @{ status = [int]$r.StatusCode; body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { return @{ status = "none"; body = $_.Exception.Message } }
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    return @{ status = [int]$resp.StatusCode; body = $reader.ReadToEnd() }
  }
}

Write-Output "== S1. global_admin login on staging (server-to-server: no CORS involved)"
$gtok = Get-StagingTok "root@setura.test"
if ($gtok) {
  $u = Invoke-RestMethod -Uri "$base/auth/v1/user" -Headers @{ apikey = $anon; Authorization = "Bearer $gtok" }
  Write-Output ("   email={0} role_claim={1} token_len={2}" -f $u.email, $u.role, $gtok.Length)
  $hs = Invoke-RestMethod -Uri "$base/rest/v1/hospitals?select=id,name&order=name.asc&limit=1" -Headers @{ apikey = $anon; Authorization = "Bearer $gtok" }
  Write-Output ("   RLS hospitals read rows={0} first={1}" -f $hs.Count, $hs[0].id)
  $hid = $hs[0].id
  $p = Call-Analytics $gtok $hid @{ action = "portfolio" }
  Write-Output ("   portfolio -> HTTP {0}" -f $p.status)
  Write-Output ("   body_head={0}" -f ($p.body.Substring(0, [Math]::Min(180, $p.body.Length))))
  if ($p.status -eq 200) {
    $pf = ($p.body | ConvertFrom-Json).data.portfolio
    Write-Output ("   date={0} total_hospitals={1} active_hospitals={2} rows={3}" -f $pf.date, $pf.total_hospitals, $pf.active_hospitals, @($pf.hospitals).Count)
  }
  $b = Call-Analytics $gtok $hid @{ action = "benchmarks" }
  Write-Output ("   benchmarks -> HTTP {0}" -f $b.status)
  if ($b.status -eq 200) {
    $bm = ($b.body | ConvertFrom-Json).data.benchmarks
    Write-Output ("   window={0}..{1} rows={2}" -f $bm.from_date, $bm.to_date, @($bm.benchmarks).Count)
  } else { Write-Output ("   body_head={0}" -f ($b.body.Substring(0, [Math]::Min(180, $b.body.Length)))) }
}

Write-Output "== S2. hospital_admin asking for the global action (server-to-server)"
$atok = Get-StagingTok "admin@surya.test"
if ($atok) {
  $ah = Invoke-RestMethod -Uri "$base/rest/v1/user_roles?select=hospital_id,role&order=hospital_id.asc&limit=3" -Headers @{ apikey = $anon; Authorization = "Bearer $atok" }
  $d = Call-Analytics $atok "00000000-0000-4000-8000-000000000001" @{ action = "portfolio" }
  Write-Output ("   portfolio -> HTTP {0} body={1}" -f $d.status, ($d.body.Substring(0, [Math]::Min(200, $d.body.Length))))
  $d2 = Call-Analytics $atok "00000000-0000-4000-8000-000000000001" @{ action = "daily_operations" }
  Write-Output ("   daily_operations -> HTTP {0} (len {1})" -f $d2.status, $d2.body.Length)
}

Write-Output "== S3. does the deployed bundle still expose the OLD CORS header set?"
foreach ($fn in @("executive-analytics", "enterprise-reports")) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Options -Uri "$base/functions/v1/$fn" -Headers @{
      Origin                         = $site
      "Access-Control-Request-Method" = "POST"
      "Access-Control-Request-Headers" = "apikey,authorization,content-type,x-client-info,x-hospital-id"
    }
    Write-Output ("   {0} allow-headers: {1}" -f $fn, $r.Headers["access-control-allow-headers"])
  } catch { Write-Output ("   {0} ERR {1}" -f $fn, $_.Exception.Message) }
}
