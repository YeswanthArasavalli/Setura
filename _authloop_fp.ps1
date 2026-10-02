param([string]$Path)
$s = [IO.File]::ReadAllText((Resolve-Path $Path))
foreach ($pat in @(".user.id===", ".user.id)", "user.id===")) {
  $i = $s.IndexOf($pat)
  Write-Output "[$Path] pattern '$pat' firstIndex=$i"
}
$i = $s.IndexOf("onAuthStateChange")
if ($i -ge 0) { Write-Output "AUTHSEG:"; Write-Output $s.Substring($i, [Math]::Min(700, $s.Length - $i)) }
