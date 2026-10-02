$ErrorActionPreference = "Continue"
$base = "http://127.0.0.1:54321"
$anon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

function Get-Tok($email) {
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
    return @{ status = $r.StatusCode; body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { return @{ status = "none"; body = $_.Exception.Message } }
    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
    return @{ status = [int]$resp.StatusCode; body = $reader.ReadToEnd() }
  }
}

Write-Output "== 5. hospital_admin (admin@surya.test) asking for the global action"
$atok = Get-Tok "admin@surya.test"
if ($atok) {
  $hs = Invoke-RestMethod -Uri "$base/rest/v1/hospitals?select=id&order=name.asc&limit=1" -Headers @{ apikey = $anon; Authorization = "Bearer $atok" }
  Write-Output ("   hospital_admin own tenant header: {0}" -f $hs[0].id)
  $d = Call-Analytics $atok $hs[0].id @{ action = "portfolio" }
  Write-Output ("   portfolio -> HTTP {0} {1}" -f $d.status, $d.body)
  $d2 = Call-Analytics $atok $hs[0].id @{ action = "daily_operations" }
  Write-Output ("   daily_operations -> HTTP {0} (len {1})" -f $d2.status, $d2.body.Length)
}

Write-Output "== 6. global_admin with NO X-Hospital-ID (contract friction)"
$gtok = Get-Tok "root@setura.test"
$nd = Call-Analytics $gtok $null @{ action = "portfolio" }
Write-Output ("   portfolio -> HTTP {0} {1}" -f $nd.status, $nd.body)

Write-Output "== 7. anonymous (no user JWT) asking for the global action"
$someHospital = "4d60b28f-871d-4808-a5ce-06bbc139d21d"
$an = Call-Analytics $anon $someHospital @{ action = "portfolio" }
Write-Output ("   anon-as-bearer -> HTTP {0} {1}" -f $an.status, ($an.body.Substring(0, [Math]::Min(200, $an.body.Length))))
