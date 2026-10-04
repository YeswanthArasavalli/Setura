# _soak_sampler.ps1 — WS-OPS-1 24h staging soak in-window sampler (scratch, not committed).
# Read-only census against LIVE setura-staging via the already-approved
# `supabase db query --linked` diagnostic. One sample per hour, 26 samples.
# Loss of samples (machine sleep) does NOT fail the soak: the authoritative
# window record is staging's own durable telemetry, read at closure.
Set-Location d:\Projects\datasets\setura
for ($i = 1; $i -le 26; $i++) {
  "--- sample $i local=$(Get-Date -Format o) ---" | Add-Content _soak_samples.log
  supabase db query --linked -f _soak_sample.sql 2>$null | Add-Content _soak_samples.log
  Start-Sleep -Seconds 3600
}
"--- sampler done local=$(Get-Date -Format o) ---" | Add-Content _soak_samples.log
