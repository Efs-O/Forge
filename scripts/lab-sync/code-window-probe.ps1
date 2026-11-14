param([string]$Match = '')
$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_Process -Filter "name='Code.exe'" |
  Where-Object { $_.CommandLine -match $Match } |
  ForEach-Object {
    $cl = $_.CommandLine
    if ($cl.Length -gt 140) { $cl = $cl.Substring(0, 140) }
    '{0} | {1} | {2}' -f $_.ProcessId, $_.CreationDate, $cl
  }
