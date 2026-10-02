$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:54321"
$anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

function Token($email) {
  $body = @{ grant_type = "password" } | ConvertTo-Json
  $b = @{ email = $email; password = "Setura@123" } | ConvertTo-Json
  $r = Invoke-RestMethod -Method Post -Uri "$base/auth/v1/token?grant_type=password" -Headers @{ apikey = $anon } -ContentType "application/json" -Body $b
  return $r.access_token
}

function Hdr($tok, $hid) {
  $h = @{ apikey = $anon; Authorization = "Bearer $tok" }
  if ($hid) { $h["X-Hospital-ID"] = $hid }
  return $h
}

function Analytics($tok, $hid, $body) {
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$base/functions/v1/executive-analytics" -Headers (Hdr $tok $hid) -ContentType "application/json" -Body ($body | ConvertTo-Json)
    return @{ ok = $true; data = $r }
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    $stream = $_.Exception.Response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    return @{ ok = $false; status = $status; body = $reader.ReadToEnd() }
  }
}

Write-Output "== 1. global admin login (root@setura.test)"
$gtok = Token "root@setura.test"
$u = Invoke-RestMethod -Uri "$base/auth/v1/user" -Headers (Hdr $gtok $null)
Write-Output ("   logged_in email={0} postgrest_role={1} token_len={2}" -f $u.email, $u.role, $gtok.Length)

Write-Output "== 2. RLS read of hospitals as global_admin (context source for the required header)"
$hs = Invoke-RestMethod -Uri "$base/rest/v1/hospitals?select=id,name,slug,is_active&order=name.asc&limit=3" -Headers (Hdr $gtok $null)
$hs | ForEach-Object { Write-Output ("   {0} | {1} | active={2}" -f $_.id, $_.name, $_.is_active) }
$hid = $hs[0].id

Write-Output "== 3. portfolio action (global_admin + X-Hospital-ID)"
$p = Analytics $gtok $hid @{ action = "portfolio" }
if ($p.ok) {
  $pf = $p.data.data.portfolio
  Write-Output ("   success={0} date={1} total_hospitals={2} active_hospitals={3} rows={4}" -f $p.data.success, $pf.date, $pf.total_hospitals, $pf.active_hospitals, $pf.hospitals.Count)
  $pf.hospitals | Select-Object -First 3 | ForEach-Object { Write-Output ("   row: {0} bookings={1} revenue={2} outstanding={3} sla={4} sessions={5}" -f $_.name, $_.bookings_today, $_.revenue_today, $_.outstanding_balance, $_.sla_status, $_.active_sessions) }
} else { Write-Output ("   HTTP {0} {1}" -f $p.status, $p.body) }

Write-Output "== 4. benchmarks action (global_admin + X-Hospital-ID)"
$b = Analytics $gtok $hid @{ action = "benchmarks" }
if ($b.ok) {
  $bm = $b.data.data.benchmarks
  Write-Output ("   success={0} window={1}..{2} rows={3}" -f $b.data.success, $bm.from_date, $bm.to_date, $bm.benchmarks.Count)
  $bm.benchmarks | Select-Object -First 3 | ForEach-Object { Write-Output ("   row: {0} bookings={1} completed={2} avg_wait={3} efficiency={4} revenue={5}" -f $_.name, $_.bookings, $_.completed, $_.avg_wait_minutes, $_.efficiency_pct, $_.revenue_inr) }
} else { Write-Output ("   HTTP {0} {1}" -f $b.status, $b.body) }

Write-Output "== 5. hospital_admin (admin@surya.test) must be DENIED the same action"
$atok = Token "admin@surya.test"
$d = Analytics $atok "00000000-0000-0000-0000-000000000001" @{ action = "portfolio" }
Write-Output ("   ok={0} status={1} body={2}" -f $d.ok, $d.status, $d.body)

Write-Output "== 6. global_admin with NO X-Hospital-ID must fail the header contract"
$nd = Analytics $gtok $null @{ action = "portfolio" }
Write-Output ("   ok={0} status={1} body={2}" -f $nd.ok, $nd.status, $nd.body)
