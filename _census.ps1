# temp secret census (counts only; values never printed)
Write-Host "== tracked secret files? =="
git ls-files | Select-String -Pattern '_keys|\.env$|vercel-tmp|access_token' | Out-String
Write-Host "== frontend secrets task =="
deno task check:frontend-secrets 2>&1 | Select-Object -Last 4 | Out-String
Write-Host "== pattern census (working tree, counts only) =="
$pats = [ordered]@{
  sb_secret        = 'sb_secret_[A-Za-z0-9]'
  legacy_jwt_pair  = 'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}'
  crn_secret_assign = 'CRON_SECRET["'':= ]{1,3}[A-Za-z0-9_\-@$.]{12,}'
  worker_secret_assign = 'WORKER_SECRET["'':= ]{1,3}[A-Za-z0-9_\-@$.]{12,}'
  razorpay_secret  = 'rzp_(secret|live)_[A-Za-z0-9]{8,}'
  meta_app_secret  = 'META_APP_SECRET["'':= ]{1,3}[A-Za-z0-9]{12,}'
  vercel_token     = 'vc_(usr|ses)_[A-Za-z0-9]+'
  db_password      = 'postgres://[^''"@ ]+:[^''"@ ]{8,}@'
  device_code      = 'user_code=[A-Z0-9-]{8,12}'
}
$files = Get-ChildItem -Recurse -File -Include *.ts,*.tsx,*.sql,*.json,*.md,*.mjs,*.cjs,*.ps1,*.yml,*.toml |
  Where-Object { $_.FullName -notmatch 'node_modules|graphify-out|\.qoder|\.remember|\.ua|\\dist\\|package-lock|deno\.lock' }
foreach ($k in $pats.Keys) {
  $c = ($files | Select-String -Pattern $pats[$k] | Measure-Object).Count
  Write-Host ("$k = $c")
}
