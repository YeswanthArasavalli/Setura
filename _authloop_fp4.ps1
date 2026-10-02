param([string]$Path)
$s = [IO.File]::ReadAllText((Resolve-Path $Path))
$j = $s.IndexOf(".auth.onAuthStateChange((")
Write-Output "callbackIdx=$j"
if ($j -ge 0) { Write-Output $s.Substring($j, [Math]::Min(400, $s.Length - $j)) }
