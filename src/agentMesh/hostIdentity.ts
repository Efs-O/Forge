import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { isProcessAlive } from '../util/processLiveness';

/**
 * Host identity for the agent mesh (AGENT_MESH_PLAN M1/M2).
 *
 * "Forge" is not one process: every VS Code window runs its own extension host
 * and all of them share `~/.forge/agent-bus/`. A durable record (an ownership
 * entry, a creation claim, the exchanges lock) names the host that wrote it as
 * `{pid, startedAt}`. A record is stale *only* when that host is proven dead —
 * the pid is gone, or the pid is alive but its OS start time no longer matches
 * (the pid was recycled). **Age alone never makes a record stale**, so a slow
 * but live holder is never raced into a duplicate.
 *
 * `startedAt` is the OS process start time in epoch milliseconds, so it is
 * comparable across hosts and across the two places it is read (the host that
 * wrote the record, and the host that later checks it).
 */

export interface HostId {
  pid: number;
  /** OS process start time, epoch ms. The PID-reuse guard. */
  startedAt: number;
}

/**
 * How close two OS start-time readings of the SAME live process may be and
 * still count as that process. Windows reports start times with ~15 ms jitter
 * between reads; a recycled pid is a brand-new process whose start time is
 * seconds to hours later, so a few seconds of tolerance separates the two
 * cleanly without ever mistaking a live process for a dead one.
 */
export const START_TIME_TOLERANCE_MS = 2_000;

/** Injectable for tests; production reads the OS. */
export interface HostLivenessDeps {
  /** Is this pid a live process? (process.kill(pid,0) semantics.) */
  isAlive?: (pid: number) => boolean;
  /** The OS start time (epoch ms) of a live pid, or undefined if unknown. */
  processStartMs?: (pid: number) => number | undefined;
  /** The pid of the calling host. */
  selfPid?: number;
  /**
   * Is the host named by `recorded` still the one that wrote it? Defaults to
   * {@link isHostAlive}. Injectable so tests can model "another window alive"
   * without real pids.
   */
  isHostAlive?: (recorded: HostId) => boolean;
}

/**
 * The OS start time of `pid` in epoch milliseconds, or undefined if it cannot
 * be determined. POSIX reads /proc; Windows asks PowerShell (a short,
 * synchronous, profile-less call — only used at lock acquisition and startup
 * recovery, never in a hot loop).
 */
export function osProcessStartMs(pid: number): number | undefined {
  if (process.platform === 'win32') return windowsProcessStartMs(pid);
  return posixProcessStartMs(pid);
}

function posixProcessStartMs(pid: number): number | undefined {
  let stat: string;
  let btime = 0;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const btimeLine = fs
      .readFileSync('/proc/stat', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('btime '));
    if (btimeLine) btime = Number(btimeLine.split(/\s+/)[1]) || 0;
  } catch {
    // Without btime we cannot anchor ticks to epoch; report unknown.
    return undefined;
  }
  // Field 2 (comm) is parenthesised and may contain spaces/parens, so split
  // after the last ')'. starttime is field 22 → index 19 after the ')' split.
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const starttimeTicks = Number(fields[19]);
  if (!Number.isFinite(starttimeTicks)) return undefined;
  const HZ = 100; // sysconf(_SC_CLK_TCK) on Linux
  return btime * 1000 + (starttimeTicks * 1000) / HZ;
}

function windowsProcessStartMs(pid: number): number | undefined {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate`,
      ],
      { timeout: 5_000, encoding: 'utf8', windowsHide: true },
    ).trim();
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This process's OS start time, once read. It cannot change while the process
 * lives, and on Windows each read spawns PowerShell — once per lock taken,
 * before this cache. Only a successful read is kept.
 */
let ownStartMs: number | undefined;

/** The calling host's own identity. `startedAt` is its OS start time. */
export function getHostIdentity(deps: HostLivenessDeps = {}): HostId {
  const pid = deps.selfPid ?? process.pid;
  if (deps.processStartMs) return { pid, startedAt: deps.processStartMs(pid) ?? Date.now() };
  if (pid !== process.pid) return { pid, startedAt: osProcessStartMs(pid) ?? Date.now() };
  ownStartMs ??= osProcessStartMs(pid);
  return { pid, startedAt: ownStartMs ?? Date.now() };
}

/**
 * Is the host named by `recorded` still the one that wrote it?
 *
 * - pid dead → false (definitive).
 * - pid is this host → true (it is us, by definition alive).
 * - pid alive, start time known and within tolerance → true.
 * - pid alive, start time unknown → true (unprovable death is treated as
 *   alive: safe for ownership, and a lock holder we cannot prove dead is
 *   waited on rather than stolen — M1).
 */
export function isHostAlive(recorded: HostId, deps: HostLivenessDeps = {}): boolean {
  const isAlive = deps.isAlive ?? isProcessAlive;
  const startMs = deps.processStartMs ?? osProcessStartMs;
  const selfPid = deps.selfPid ?? process.pid;
  if (!isAlive(recorded.pid)) return false;
  if (recorded.pid === selfPid) return true;
  const live = startMs(recorded.pid);
  if (live === undefined) return true;
  return Math.abs(live - recorded.startedAt) <= START_TIME_TOLERANCE_MS;
}
