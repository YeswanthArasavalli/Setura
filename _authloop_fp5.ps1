param([string]$Path)
$s = [IO.File]::ReadAllText((Resolve-Path $Path))
$a = $s.IndexOf("Invalid email or password.")
Write-Output "signInAnchor=$a"
if ($a -ge 0) {
  $start = [Math]::Max(0, $a - 2600)
  $seg = $s.Substring($start, $a - $start + 200)
  $j = $seg.LastIndexOf(".auth.onAuthStateChange((")
  if ($j -ge 0) { Write-Output "PROVIDER CALLBACK:"; Write-Output $seg.Substring($j, [Math]::Min(360, $seg.Length - $j)) } else { Write-Output "callback not found in window" }
}
