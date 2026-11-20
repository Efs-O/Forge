import { ChildProcess, spawn } from 'child_process';
import { powershellScratch, type PowershellScratch } from './powershellScratchDir';
import { KEEPER_SCRIPT } from './windowsJobKeeperScript';

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
 *    PowerShell plus the `Add-Type` compile), and a grandchild created while it
 *    is still compiling escapes the job — Git Bash reaches its first fork 141 ms
 *    after a spawn. That is why a spawn path that can be stopped calls
 *    `warmWindowsJobKeeper` before it spawns: with the keeper already answering,
 *    the assignment lands about a millisecond after the spawn.
 *  - Nothing here dies hard. A missing PowerShell, a failed assignment or a
 *    keeper that exited mid-command leaves the old `taskkill` behaviour, which
 *    is what Windows users had before this module existed.
 *  - A stop is two calls, not one. `beginTreeStop` spends the token and leaves
 *    the job open so `taskkill /T` can still walk from a live parent; only
 *    `finishStoppedTree` closes it. Closing it first killed the parent instantly
 *    and orphaned exactly the grandchildren this module exists for (the first
 *    version of it, caught by `StopExecutionTree.test.ts` on 2026-11-14).
 */

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

/** PowerShell's `Add-Type` compiles the shim and leaves its sources, its
 *  command-line file and the compiled assembly in the process temp folder: five
 *  files per keeper, named like `cug3etsd.0.cs`. Left in the system temp they
 *  pile up there for the life of the machine, and they trip the test suite's
 *  temp guard — `StopExecutionNote.test.ts` failed on exactly those names. So
 *  the keeper compiles into a folder of its own under `~/.forge/job-keeper/`,
 *  in the spirit of `~/.forge/tool-usage/`: `powershellScratchDir` owns that
 *  folder and the day-old pruning. The folder is removed when the keeper exits
 *  — while it runs, the assembly inside is loaded and locked. */
function keeperScratch(): PowershellScratch {
  return powershellScratch('job-keeper');
}

const jobs = new Map<number, string>();
/** A stop has begun for this pid: the token is spent, so the child's own exit
 *  event can no longer release the job, and the keeper still holds it, because
 *  closing it now would kill the parent `taskkill /T` is about to walk. */
const stopping = new Map<number, string>();
let keeper: ChildProcess | undefined;
let nextToken = 1;
let reported = 0;
/** Whether the current keeper has printed `ready`, which is the only way to
 *  know a job can be created right now. Reset with every keeper. */
let keeperReady = false;
/** Callers waiting for the current keeper to become ready. */
const warmWaiters = new Set<() => void>();

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
 *  pays nothing for this. A later command starts a fresh one.
 *
 *  A pid in `stopping` counts as protected: `beginTreeStop` spends the token and
 *  deliberately leaves the job open, so retiring here could send `quit` while
 *  `taskkill /T` is still walking the tree. The keeper's `ReleaseAll` clears the
 *  kill flag before it closes each job, so the survivors this module exists to
 *  catch are let go — measured shape: an idle timer armed by an earlier release
 *  firing inside a later stop.
 *
 *  And when something is still held, the check is re-armed rather than dropped:
 *  this is the only timer, so a keeper whose one timer fired while a job was
 *  live would never retire and would hold its ~75 MB for the whole window. */
function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (!keeper) return;
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (jobs.size === 0 && stopping.size === 0) shutdownJobKeeper();
    else scheduleIdleShutdown();
  }, keeperIdleMs());
  idleTimer.unref?.();
}

/** The keeper's first line out is `ready`; after that every line is a report.
 *  A line from a keeper this module has already replaced is dropped.
 *  `forget()` runs on the child's `exit` event, so between a retire and that
 *  event the old process can still write, and its `ready` would mark the NEW
 *  keeper ready before the new one had compiled: the next command then spawns
 *  against a keeper that is ready on paper and not in fact, which is the leak
 *  the warm-up exists to prevent. Measured 2026-11-15 as a full-suite failure of
 *  the warm-up ceiling test — `expected 471 to be greater than or equal to
 *  2500`, the wait ending 2.5 s early because a dead keeper answered for the
 *  live one. */
function handleKeeperLine(from: ChildProcess, line: string): void {
  if (keeper !== from) return;
  if (line.trim() !== 'ready') {
    reportKeeperProblem(line);
    return;
  }
  keeperReady = true;
  for (const settle of [...warmWaiters]) settle();
}

function ensureKeeper(): ChildProcess | undefined {
  // A keeper whose stdin has ended was told to quit: it is still the recorded
  // child until its `exit` event lands, and writing to it now loses that command
  // — the job is registered, but the keeper never hears about it. Spawn afresh
  // instead of waiting for the event to arrive.
  if (keeper && keeper.stdin && !keeper.stdin.destroyed && !keeper.stdin.writableEnded) {
    return keeper;
  }
  const command = keeperCommand();
  if (!command) return undefined;
  let child: ChildProcess;
  const keeperTemp = keeperScratch();
  try {
    child = spawn(command.file, command.args, {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...keeperTemp.env },
    });
  } catch {
    keeperTemp.dispose();
    return undefined;
  }
  keeper = child;
  keeperReady = false;
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
    for (const line of lines) handleKeeperLine(child, line);
  });
  const forget = (): void => {
    // The keeper is out, so the assembly it had loaded is unlocked and its
    // compile folder can go. Idempotent, because both `error` and `exit` land.
    keeperTemp.dispose();
    if (keeper !== child) return;
    keeper = undefined;
    keeperReady = false;
    // Nobody is waiting on a keeper that is gone; the next protect() starts one.
    for (const settle of [...warmWaiters]) settle();
    // The handles died with the keeper, so these pids have no job to close.
    jobs.clear();
    stopping.clear();
  };
  child.once('error', forget);
  child.once('exit', forget);
  // Never hold the extension host open for a helper that only holds handles.
  child.unref();
  // Arm the idle check now, not at the first release: a keeper that is warmed
  // and then never given a job would otherwise hold its ~75 MB for the whole
  // window, because only a finish or a release used to arm the check. A job that
  // arrives later keeps it alive — the check re-arms while anything is held.
  scheduleIdleShutdown();
  return child;
}

function send(keeperProcess: ChildProcess, line: string): void {
  try {
    keeperProcess.stdin?.write(`${line}\n`);
  } catch {
    /* The keeper is gone; forget() has already cleared the map. */
  }
}

/** How long a caller will wait for a cold keeper before spawning anyway. The
 *  cold start measured here is 274 ms (PowerShell 126 ms plus the C# compile),
 *  so this ceiling is a broken-keeper guard, not a normal path. */
const KEEPER_WARM_CEILING_MS = 3_000;

/**
 * Ask for the job-keeping helper and resolve once it can actually create a job.
 *
 * A caller that spawns a command it may later have to stop awaits this BEFORE
 * the spawn, because of a measured race: the helper costs about 274 ms the first
 * time, and Git Bash reaches its first fork 141 ms after a spawn. A command
 * started while the helper is still compiling has no job to join, so its
 * children outlive the stop — measured on 2026-11-14 in a freshly opened window,
 * where the first background `sleep 150 && echo late` leaked its sleep and the
 * second one in the same window did not.
 *
 * It never blocks a command indefinitely: past `KEEPER_WARM_CEILING_MS` it
 * resolves anyway, and the stop keeps its `taskkill` fallback.
 */
export async function warmWindowsJobKeeper(): Promise<void> {
  if (!keeperCommand()) return;
  const target = ensureKeeper();
  if (!target || keeperReady) return;
  await new Promise<void>((resolve) => {
    const settle = (): void => {
      clearTimeout(ceiling);
      warmWaiters.delete(settle);
      resolve();
    };
    const ceiling = setTimeout(settle, KEEPER_WARM_CEILING_MS);
    ceiling.unref?.();
    warmWaiters.add(settle);
  });
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
  // again, exactly as before this module. A stop spends the token first, in
  // `beginTreeStop`, so this release never runs for a stopped command.
  const release = (): void => releaseProtectedTree(pid);
  proc.once('exit', release);
  proc.once('error', release);
}

/** First half of a stop: spend the token, so the child's own `exit` event can
 *  no longer release the job, and leave the job OPEN. The caller runs
 *  `taskkill /T /F` next and that walk starts from the recorded parent; closing
 *  the job here terminates that parent instantly, and the grandchildren whose
 *  forker already exited are unreachable by parent link — the exact bug this
 *  module was written for. */
export function beginTreeStop(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  const token = jobs.get(pid);
  if (token === undefined) return false;
  jobs.delete(pid);
  stopping.set(pid, token);
  // Nothing may retire the keeper mid-stop: `jobs` is empty for the whole span
  // between the two halves, and an idle timer armed by an earlier release can
  // fire inside it. `finishStoppedTree` re-arms the check.
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  return true;
}

/** Second half: close the job with the kill flag set, so whatever the tree walk
 *  could not reach dies with it. False when there is nothing to close — no job,
 *  or a keeper that died and took the handles with it. */
export function finishStoppedTree(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  const token = stopping.get(pid);
  if (token === undefined) return false;
  stopping.delete(pid);
  const target = keeper;
  if (target) send(target, `kill ${token}`);
  scheduleIdleShutdown();
  return true;
}

/** Both halves in one call, for a caller that kills with no tree walk of its
 *  own and so has no live parent to lose. */
export function sweepProtectedTree(pid: number | undefined): boolean {
  if (!beginTreeStop(pid)) return false;
  finishStoppedTree(pid);
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
  stopping.clear();
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

/** Whether the current keeper can create a job right now. Test seam. */
export function keeperIsReady(): boolean {
  return keeperReady;
}

/** Every pid this module still has a job handle for, stopping included, so a
 *  test that leaves a half-stop behind can still close it out. Test seam. */
export function protectedPids(): number[] {
  return [...new Set([...jobs.keys(), ...stopping.keys()])];
}
