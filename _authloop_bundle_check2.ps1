param([string]$Url, [string]$Out)
$js = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 60
$js.Content | Out-File -FilePath $Out -Encoding ascii
