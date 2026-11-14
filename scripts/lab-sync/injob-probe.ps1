# Is this process already in a job object? (Decides whether AssignProcessToJobObject
# can nest it: a job created before Windows 8 semantics refuses nesting.)
param([string]$Pids = '')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class InJob {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);
  public static string Check(int pid) {
    IntPtr process = OpenProcess(0x0400 | 0x1000, false, pid);
    if (process == IntPtr.Zero) return pid + " open=" + Marshal.GetLastWin32Error();
    bool inJob = false;
    bool ok = IsProcessInJob(process, IntPtr.Zero, out inJob);
    int err = ok ? 0 : Marshal.GetLastWin32Error();
    CloseHandle(process);
    return pid + " ok=" + ok + " err=" + err + " inJob=" + inJob;
  }
}
'@
foreach ($part in $Pids -split ',') {
  $id = 0
  if ([int]::TryParse($part.Trim(), [ref] $id)) { Write-Output ([InJob]::Check($id)) }
}
Write-Output ("self " + (Get-Process -Id $PID).ProcessName)
Write-Output ([InJob]::Check($PID))

# Walk the ancestor chain: the interesting answer is which ancestor is in a job.
$cur = [int]$PID
for ($i = 0; $i -lt 12; $i++) {
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" | Select-Object -First 1
  if (-not $info) { Write-Output "chain: pid=$cur gone"; break }
  Write-Output ("chain " + $info.Name + " " + ([InJob]::Check($cur)))
  $parent = [int]$info.ParentProcessId
  if ($parent -le 0 -or $parent -eq $cur) { break }
  $cur = $parent
}
