import { ChildProcess, spawn } from 'child_process';

/**
 * Windows job objects, so stopping a Forge-owned command takes its whole tree.
 *
 * `taskkill /PID <pid> /T /F` walks the kernel's parent links, and MSYS2 breaks
 * them: Git Bash's `fork()` runs a short-lived forker that creates the real
 * child and exits, so the child's recorded parent is a dead pid. Measured on
 * this machine (lab BUG-27): stopping a background `sleep 90 && echo late`
 * killed the recorded launcher, its conhost and the real bash, and `taskkill`
 * reported success — while `sleep.exe` was still running with `ppid` pointing
 * at a forker that no longer existed, so a repeat `taskkill /T` answered
 * "process not found" and the orphan slept out its ninety seconds.
 *
 * A job object does not care about parent links: every process created by a
 * member joins the job, and closing the last handle with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` set asks the kernel to terminate every
 * process still in it. The handle has to be held by a process that outlives the
 * spawn, so this module keeps one PowerShell per extension host, already
 * started, that creates the jobs and answers two commands per process: `kill`
 * (stop: survivors die) and `release` (the command exited on its own: survivors
 * live, which is what `explorer.exe <thing>` detached launches depend on).
 *
 * Two limits worth knowing:
 *  - The keeper starts lazily and costs about 270 ms cold (measured: 126 ms for
 *    PowerShell plus the `Add-Type` compile). A grandchild created inside that
 *    window escapes the job — measured, Git Bash reaches its first fork 141 ms
 *    after the spawn, so the first protected command in a window is not
 *    covered. Every later one is, because the assignment then lands about a
 *    millisecond after the spawn.
 *  - Nothing here dies hard. A missing PowerShell, a failed assignment or a
 *    keeper that exited mid-command leaves the old `taskkill` behaviour, which
 *    is what Windows users had before this module existed.
 */

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
 * a report read from stderr is half banner and half answer.
 */
const KEEPER_SCRIPT = String.raw`
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
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq 'quit') { break }
  $reply = [ForgeJobKeeper]::Handle($line)
  if (reply) { [Console]::Out.WriteLine($reply) }
}
[ForgeJobKeeper]::ReleaseAll()
`;

/**
 * Test and diagnostic seam: point it at a JS file and that file becomes the
 * keeper, so the protocol is testable on Linux and macOS, where GitHub CI runs.
 */
const KEEPER_COMMAND_ENV = 'FORGE_JOB_KEEPER_CMD';

function keeperCommand(): { file: string; args: string[] } | undefined {
  const override = process.env[KEEPER_COMMAND_ENV];
  if (override) return { file: process.execPath, args: [override] };
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(KEEPER_SCRIPT, 'utf16le').toString('base64'),
      ],
    };
  }
  return undefined;
}

const jobs = new Map<number, string>();
let keeper: ChildProcess | undefined;
let nextToken = 1;
let reported = 0;

/** How long the keeper stays up with nothing left to hold: long enough to cover
 *  two commands in a row, short enough that a window not running background
 *  work does not carry the ~75 MB PowerShell process forever. Measured here: a
 *  keeper with one job holds a 75 MB working set. */
const KEEPER_IDLE_MS = 120_000;
/** Test seam: the same timer with a short window, so the retire path is covered. */
function keeperIdleMs(): number {
  const override = Number(process.env.FORGE_JOB_KEEPER_IDLE_MS);
  return Number.isFinite(override) && override > 0 ? override : KEEPER_IDLE_MS;
}
let idleTimer: ReturnType<typeof setTimeout> | undefined;

/** The keeper's reports are the only evidence a job was never created. */
function reportKeeperProblem(line: string): void {
  if (reported >= 5) return;
  reported += 1;
  const text = line.trim().slice(0, 240);
  if (!text) return;
  if (!text.startsWith('err')) return; // the keeper's own echo, not a problem
  void import('../util/logger')
    .then(({ getLogger }) => getLogger().warn(`[windows-job] keeper ${text}`))
    .catch(() => {
      /* No channel and no report: the kill still had its taskkill fallback. */
    });
}

/** Retire the keeper once nothing is protected any more, so an idle window
 *  pays nothing for this. A later command starts a fresh one. */
function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (!keeper) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (jobs.size === 0) shutdownJobKeeper();
  }, keeperIdleMs());
  idleTimer.unref?.();
}

function ensureKeeper(): ChildProcess | undefined {
  if (keeper && keeper.stdin && !keeper.stdin.destroyed) return keeper;
  const command = keeperCommand();
  if (!command) return undefined;
  let child: ChildProcess;
  try {
    child = spawn(command.file, command.args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      shell: false,
    });
  } catch {
    return undefined;
  }
  keeper = child;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  child.stdin?.on('error', () => {
    /* EPIPE after the keeper died: the next protect() starts a fresh one. */
  });
  child.stdout?.setEncoding('utf8');
  let pending = '';
  child.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) reportKeeperProblem(line);
  });
  const forget = (): void => {
    if (keeper !== child) return;
    keeper = undefined;
    // The handles died with the keeper, so these pids have no job to close.
    jobs.clear();
  };
  child.once('error', forget);
  child.once('exit', forget);
  // Never hold the extension host open for a helper that only holds handles.
  child.unref();
  return child;
}

function send(keeperProcess: ChildProcess, line: string): void {
  try {
    keeperProcess.stdin?.write(`${line}\n`);
  } catch {
    /* The keeper is gone; forget() has already cleared the map. */
  }
}

/**
 * Put a freshly spawned child in its own killable job. Fire-and-forget on
 * purpose: no spawn path may wait on the keeper, and a job that never arrives
 * costs only the fallback `taskkill` already provides.
 */
export function protectProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (pid === undefined || jobs.has(pid)) return;
  if (!keeperCommand()) return;
  // A child that is already gone — a stubbed spawn in a test, a command that
  // failed to start — needs no job, and asking for one would start a PowerShell
  // to be told the pid is not there. EPERM means it is there and merely not
  // ours to signal, so only ESRCH declines.
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
  }
  const target = ensureKeeper();
  if (!target) return;
  const token = String(nextToken++);
  jobs.set(pid, token);
  send(target, `job ${token} ${pid}`);
  // The command finished by itself: whatever it left behind is its own business
  // again, exactly as before this module. A stop goes through sweepProtectedTree
  // instead, which is written first and removes the token, so this never runs.
  const release = (): void => releaseProtectedTree(pid);
  proc.once('exit', release);
  proc.once('error', release);
}

/** Stop semantics: close the job with the kill flag set, so survivors die. */
export function sweepProtectedTree(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  const token = jobs.get(pid);
  if (token === undefined) return false;
  jobs.delete(pid);
  const target = keeper;
  if (target) send(target, `kill ${token}`);
  scheduleIdleShutdown();
  return true;
}

/** Normal-exit semantics: drop the kill flag, then close. */
export function releaseProtectedTree(pid: number | undefined): void {
  if (pid === undefined) return;
  const token = jobs.get(pid);
  if (token === undefined) return;
  jobs.delete(pid);
  const target = keeper;
  if (target) send(target, `release ${token}`);
  scheduleIdleShutdown();
}

/** Release every job and let the keeper exit. Used on shutdown, by tests, and
 *  by the idle timer once nothing is protected. */
export function shutdownJobKeeper(): void {
  const target = keeper;
  jobs.clear();
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  if (!target) return;
  send(target, 'quit');
  try {
    target.stdin?.end();
  } catch {
    /* Already closed. */
  }
}

/** What this module currently has a job for. Test seam. */
export function protectedPids(): number[] {
  return [...jobs.keys()];
}
