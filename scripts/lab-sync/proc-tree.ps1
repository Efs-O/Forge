# Print a process snapshot for BUG-27 forensics: pid, ppid, name, start time, command line.
# Usage: proc-tree.ps1 -Names sleep,bash   (or -Pids 1234,5678)
param(
  [string]$Names = '',
  [string]$Pids = '',
  [int]$Width = 200
)

$all = Get-CimInstance Win32_Process
if ($Names -ne '') {
  $wanted = $Names -split ',' | ForEach-Object { "$_.exe" }
  $all = $all | Where-Object { $wanted -contains $_.Name }
}
if ($Pids -ne '') {
  $ids = $Pids -split ',' | ForEach-Object { [int]$_ }
  $all = $all | Where-Object { $ids -contains $_.ProcessId }
}
foreach ($p in $all) {
  $cmd = if ($p.CommandLine) { ($p.CommandLine -replace '\s+', ' ') } else { '' }
  if ($cmd.Length -gt $Width) { $cmd = $cmd.Substring(0, $Width) }
  Write-Output ('{0} pid={1} ppid={2} started={3} cmd={4}' -f $p.Name, $p.ProcessId, $p.ParentProcessId, $p.CreationDate, $cmd)
}
