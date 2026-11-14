# Diagnostic copy of the keeper in src/util/windowsJobKeeper.ts: answers the
# stdin protocol on stdout so a probe can see the Win32 code when an assign fails.
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ForgeJobKeeper {
  const int ExtendedLimitInformation = 9;
  const int KillOnJobClose = 0x00002000;
  const int ProcessSetQuota = 0x00000100;
  const int ProcessTerminate = 0x00000010;
  const int ProcessQueryInformation = 0x0400;

  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public int LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public int ActiveProcessLimit;
    public UIntPtr Affinity;
    public int PriorityClass;
    public int SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits BasicInformation;
    public IoCounters IoInformation;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(int access, bool inherit, int pid);

  static readonly Dictionary<string, IntPtr> Jobs = new Dictionary<string, IntPtr>();

  static bool SetFlags(IntPtr job, int flags) {
    ExtendedLimits info = new ExtendedLimits();
    info.BasicInformation.LimitFlags = flags;
    return SetInformationJobObject(job, ExtendedLimitInformation, ref info,
      Marshal.SizeOf(typeof(ExtendedLimits)));
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

  static string Create(string token, int pid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return "err " + token + " create=" + Marshal.GetLastWin32Error();
    if (!SetFlags(job, KillOnJobClose)) {
      int code = Marshal.GetLastWin32Error();
      CloseHandle(job);
      return "err " + token + " limit=" + code;
    }
    IntPtr process = OpenProcess(ProcessSetQuota | ProcessTerminate | ProcessQueryInformation, false, pid);
    if (process == IntPtr.Zero) {
      int code = Marshal.GetLastWin32Error();
      CloseHandle(job);
      return "err " + token + " open=" + code;
    }
    bool preInJob = false;
    bool inJobQuery = IsProcessInJob(process, IntPtr.Zero, out preInJob);
    int queryErr = preInJob ? 0 : Marshal.GetLastWin32Error();
    bool assigned = AssignProcessToJobObject(job, process);
    int assignCode = Marshal.GetLastWin32Error();
    bool inJob = false;
    IsProcessInJob(process, IntPtr.Zero, out inJob);
    CloseHandle(process);
    if (!assigned) {
      CloseHandle(job);
      return "err " + token + " assign=" + assignCode + " inJobQuery=" + inJobQuery +
        "/" + queryErr + " alreadyInJob=" + preInJob + " nowInJob=" + inJob;
    }
    Jobs[token] = job;
    return "ok " + token;
  }

  static void Close(string token, bool withKill) {
    IntPtr job;
    if (!Jobs.TryGetValue(token, out job)) { Console.Out.WriteLine("miss " + token); return; }
    Jobs.Remove(token);
    if (!withKill) SetFlags(job, 0);
    CloseHandle(job);
    Console.Out.WriteLine("closed " + token + " withKill=" + withKill);
  }

  public static string Handle(string line) {
    if (string.IsNullOrEmpty(line)) return null;
    string[] parts = line.Trim().Split(' ');
    try {
      if (parts.Length == 3 && parts[0] == "job") return Create(parts[1], int.Parse(parts[2]));
      if (parts.Length == 2 && parts[0] == "kill") { Close(parts[1], true); return null; }
      if (parts.Length == 2 && parts[0] == "release") { Close(parts[1], false); return null; }
    } catch (Exception e) {
      return "err " + parts[0] + " " + e.GetType().Name;
    }
    return "err protocol " + parts[0];
  }

  public static string TryAssign(string token, int pid, int access) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return "create=" + Marshal.GetLastWin32Error();
    if (!SetFlags(job, KillOnJobClose)) {
      int code = Marshal.GetLastWin32Error();
      CloseHandle(job);
      return "limit=" + code;
    }
    IntPtr process = OpenProcess(access, false, pid);
    if (process == IntPtr.Zero) {
      int code = Marshal.GetLastWin32Error();
      CloseHandle(job);
      return "access=0x" + access.ToString("X") + " open=" + code;
    }
    bool assigned = AssignProcessToJobObject(job, process);
    int assignCode = assigned ? 0 : Marshal.GetLastWin32Error();
    CloseHandle(process);
    if (assigned) { Jobs[token] = job; return "access=0x" + access.ToString("X") + " ASSIGNED"; }
    CloseHandle(job);
    return "access=0x" + access.ToString("X") + " assign=" + assignCode;
  }

  public static string SelfInJob(int pid) {
    IntPtr process = OpenProcess(ProcessQueryInformation, false, pid);
    if (process == IntPtr.Zero) return "open=" + Marshal.GetLastWin32Error();
    bool inJob = false;
    bool ok = IsProcessInJob(process, IntPtr.Zero, out inJob);
    CloseHandle(process);
    return "pid=" + pid + " ok=" + ok + " inJob=" + inJob;
  }

  public static void ReleaseAll() {
    foreach (KeyValuePair<string, IntPtr> entry in
      new List<KeyValuePair<string, IntPtr>>(Jobs)) Close(entry.Key, false);
  }
}
'@
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq 'quit') { break }
  if ($line.Trim() -eq 'self') {
    $selfPid = [System.Diagnostics.Process]::GetCurrentProcess().Id
    [Console]::Out.WriteLine('self ' + [ForgeJobKeeper]::SelfInJob($selfPid))
    continue
  }
  if ($line.Trim() -eq 'own') {
    $start = New-Object System.Diagnostics.ProcessStartInfo 'ping.exe', '-n 20 127.0.0.1'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $own = [System.Diagnostics.Process]::Start($start)
    [Console]::Out.WriteLine('own ' + [ForgeJobKeeper]::TryAssign('own', $own.Id, 0x110))
    $own.WaitForExit(100) | Out-Null
    if (-not $own.HasExited) { $own.Kill() }
    continue
  }
  if ($line.Trim().StartsWith('try ')) {
    $bits = $line.Trim().Split(' ')
    [Console]::Out.WriteLine([ForgeJobKeeper]::TryAssign($bits[1], [int]$bits[2], [Convert]::ToInt32($bits[3], 16)))
    continue
  }
  $reply = [ForgeJobKeeper]::Handle($line)
  if ($reply) { [Console]::Out.WriteLine($reply) }
}
[ForgeJobKeeper]::ReleaseAll()
Write-Output 'keeper-exited'
