$js = Invoke-WebRequest -Uri "https://setura-delta.vercel.app/assets/index-D23ak40u.js" -UseBasicParsing -TimeoutSec 60
$s = $js.Content
Write-Output "len=$($s.Length)"
Write-Output ("hasOnAuthStateChange=" + $s.Contains("onAuthStateChange"))
$pat = ".user.id==="
$i = $s.IndexOf($pat)
Write-Output "skipPatternIndex=$i"
if ($i -ge 0) { Write-Output $s.Substring([Math]::Max(0, $i - 300), 560) }
