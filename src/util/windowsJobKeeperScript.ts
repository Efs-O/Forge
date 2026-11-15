/**
 * The keeper, in PowerShell for the same reason `windowsFileHolders.ts` uses it:
 * PowerShell is on every Windows install, and `Add-Type` compiles the P/Invoke
 * shim in-process, so Forge ships no native binary and no build step.
 *
 * Protocol, one line per command on stdin:
 *   `job <token> <pid>`  — create a job, put that pid in it, keep the handle.
 *   `kill <token>`       — close it with the kill flag still set.
 *   `release <token>`    — clear the flag, then close.
 *   `quit`               — release everything and exit.
 * A problem is one line on stdout carrying the Win32 code, because "the job was
 * not created" is otherwise invisible and the only symptom is an orphan that
 * outlived its stop. Reports go to stdout, not stderr: PowerShell serialises a
 * redirected stderr as a CLIXML stream whose `#< CLIXML` banner arrives first, so
 * a report read from stderr is half banner and half answer. The caller acts on a
 * line only when it starts with `err`, so the warm-up echo below is ignored.
 *
 * The first line out is `ready`, written once the C# compile is finished and the
 * read loop is about to start. It is the only way a caller can tell that a job
 * can be created right now: the compile costs about 270 ms, and a command spawned
 * during it cannot join a job that does not exist yet, so it escapes the stop.
 * `warmWindowsJobKeeper` waits for this line before a spawn.
 */
export const KEEPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ForgeJobKeeper {
  const int ExtendedLimitInformation = 9;
  // KILL_ON_JOB_CLOSE is only valid through JobObjectExtendedLimitInformation:
  // the same call with JobObjectBasicLimitInformation answers
  // ERROR_INVALID_PARAMETER (87), measured here.
  const int KillOnJobClose = 0x00002000;
  const int ProcessSetQuota = 0x00000100;
  const int ProcessTerminate = 0x00000010;
  // Measured here: AssignProcessToJobObject rejects a handle opened with only
  // the documented PROCESS_SET_QUOTA | PROCESS_TERMINATE (ERROR_ACCESS_DENIED,
  // 5) and accepts a full-rights one, even for a process that already sits in
  // another job. So the full-rights handle is what the assignment asks for, and
  // the documented minimum stays as the fallback for a process this one cannot
  // open fully (a protected or elevated process).
  const int ProcessAllAccess = 0x1F0FFF;

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

  // The second member is IO_COUNTERS (six 64-bit counters), not IO_STATUS_BLOCK:
  // measured here, the kernel rejects a 112-byte struct for this class with
  // ERROR_BAD_LENGTH (24) and accepts this 144-byte one.
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

  static string Create(string token, int pid) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return "err " + token + " create=" + Marshal.GetLastWin32Error();
    if (!SetFlags(job, KillOnJobClose)) {
      int code = Marshal.GetLastWin32Error();
      CloseHandle(job);
      return "err " + token + " limit=" + code;
    }
    IntPtr process = OpenProcess(ProcessAllAccess, false, pid);
    int rights = ProcessAllAccess;
    if (process == IntPtr.Zero) {
      process = OpenProcess(ProcessSetQuota | ProcessTerminate, false, pid);
      rights = ProcessSetQuota | ProcessTerminate;
    }
    if (process == IntPtr.Zero) {
      int code = Marshal.GetLastWin32Error();
      CloseHandle(job);
      return "err " + token + " open=" + code;
    }
    bool assigned = AssignProcessToJobObject(job, process);
    int assignCode = assigned ? 0 : Marshal.GetLastWin32Error();
    CloseHandle(process);
    if (!assigned) {
      CloseHandle(job);
      return "err " + token + " assign=" + assignCode + " rights=0x" + rights.ToString("X");
    }
    Jobs[token] = job;
    return null;
  }

  static void Close(string token, bool withKill) {
    IntPtr job;
    if (!Jobs.TryGetValue(token, out job)) return;
    Jobs.Remove(token);
    if (!withKill) SetFlags(job, 0);
    CloseHandle(job);
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

  public static void ReleaseAll() {
    foreach (KeyValuePair<string, IntPtr> entry in
      new List<KeyValuePair<string, IntPtr>>(Jobs)) Close(entry.Key, false);
  }
}
'@
# Pay the first-call cost of the P/Invoke path before saying ready. Measured
# 2026-11-15: against a keeper that had only just printed ready, the first job
# line it ever handled lost the race against Git Bash's forker - the grandchild
# was created 49 ms after the request, so it joined no job and outlived the
# stop (1 of 10 tries in isolation, clean on the 9 that followed). Create a job
# for the keeper's own pid and release it without the kill flag, so nothing is
# signalled and the real first command finds the path already warm. Handle is
# the only public entry point, and the loop below uses that same one.
$warm = [ForgeJobKeeper]::Handle('job warm ' + $PID)
[ForgeJobKeeper]::Handle('release warm') | Out-Null
if ($warm) { [Console]::Out.WriteLine('warm ' + $warm) }
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq 'quit') { break }
  $reply = [ForgeJobKeeper]::Handle($line)
  if ($reply) { [Console]::Out.WriteLine($reply) }
}
[ForgeJobKeeper]::ReleaseAll()
`;
