param([string]$Path)
$s = [IO.File]::ReadAllText((Resolve-Path $Path))
$j = $s.IndexOf(".auth.onAuthStateChange(")
Write-Output "idx=$j len=$($s.Length)"
if ($j -ge 0) { Write-Output $s.Substring($j, [Math]::Min(420, $s.Length - $j)) }
