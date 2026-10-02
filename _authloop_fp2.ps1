param([string]$Path)
$s = [IO.File]::ReadAllText((Resolve-Path $Path))
$anchor = "Could not load your staff profile."
$i = $s.IndexOf($anchor)
Write-Output "anchorIndex=$i"
if ($i -ge 0) {
  $start = [Math]::Max(0, $i - 1500)
  $seg = $s.Substring($start, [Math]::Min(3600, $s.Length - $start))
  $j = $seg.IndexOf("onAuthStateChange")
  if ($j -ge 0) { $k = $seg.IndexOf("`"", $j + 20); $k = $seg.IndexOf("`"", $k + 1); Write-Output "CALLBACK SEGMENT:"; Write-Output $seg.Substring($j, [Math]::Min(900, $seg.Length - $j)) } else { Write-Output "no onAuthStateChange near anchor" }
}
