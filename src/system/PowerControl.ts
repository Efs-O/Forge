/**
 * Suspending this machine, arming the RTC to bring it back, and reporting what
 * would be needed to wake it from outside.
 *
 * Sole owner of every power-state command Forge issues. Nothing else spawns
 * `powercfg`, `schtasks`, or `rundll32 powrprof`.
 *
 * The load-bearing fact this module exists to make explicit: **once the machine
 * is asleep, no software on it can wake it.** In S3 only two things still have
 * power — the network card, listening for a magic packet, and the RTC, counting
 * down a wake timer. The extension host is frozen with the CPU off, so a remote
 * `/wake` command cannot be served by definition. `armWakeTimer` and
 * `describeWake` are the two honest answers to "wake it from my phone": schedule
 * the return in advance, or send a magic packet from a device that is awake.
 */

import * as child_process from 'child_process';
import * as os from 'os';
import { spawnAndWait } from '../util/processSpawn';
import { availableStates, parseWakeInfo, type WakeInfo } from './wakeInfo';
import {
  oneShotTaskXml,
  parseScheduledWakes,
  scheduledWakeTaskXml,
  type RecurringWake,
} from './wakeTaskXml';

const POWERCFG_TIMEOUT_MS = 10_000;
const SCHTASKS_TIMEOUT_MS = 10_000;
const SUSPEND_TIMEOUT_MS = 20_000;

/** One-shot task name. Fixed, so arming twice replaces rather than accumulates. */
export const WAKE_TASK_NAME = 'ForgeWakeTimer';

/**
 * Recurring task name. Written only by the job scheduler; distinct from the
 * one-shot so a manual `/sleep 09:00` cannot overwrite a job's 06:00 wake (G4).
 */
export const SCHEDULED_WAKE_TASK_NAME = 'ForgeScheduledWake';

/**
 * How long before a scheduled trigger the machine must be awake for the server
 * to be ready. Measured 2026-09-15: resident server healthy ~112 s after RTC
 * fire (upper bound, human round-trip dominates). 120 s covers the OS thaw +
 * network + process thaw with margin. A cold server (model not loaded) needs
 * far more; the scheduler must keep the server warm or raise this value.
 */
export const WAKE_LEAD_MS = 120_000;

/** The `sleep_if_idle` window: `WAKE_LEAD_MS` + 5 min of grace. */
export const SLEEP_IF_IDLE_WINDOW_MS = WAKE_LEAD_MS + 5 * 60_000;

export interface SleepIfIdleInput {
  /** Milliseconds since the machine resumed from sleep. */
  msSinceResume: number;
  /** Milliseconds since the last keyboard/mouse input (from `idleSinceResume`). */
  msSinceInput: number;
  /** The `busyReason` result: `undefined` when idle, a string when busy. */
  busy: string | undefined;
}

/**
 * Pure decision: should the machine suspend again after a scheduled wake?
 * All three conditions must hold (D6):
 * 1. We are still within the lead-time window (the resume was recent).
 * 2. No input has occurred since the resume (the user has not come back).
 * 3. Nothing is busy (no turn, no request, no approval).
 */
export function shouldSleepIfIdle(input: SleepIfIdleInput): boolean {
  const { msSinceResume, msSinceInput, busy } = input;
  if (busy !== undefined) return false;
  if (msSinceResume > SLEEP_IF_IDLE_WINDOW_MS) return false;
  // No input since resume: the last input predates the resume.
  if (msSinceInput < msSinceResume) return false;
  return true;
}

export interface SuspendResult {
  /** What was requested. The OS is not obliged to honour `sleep` — see below. */
  requested: 'sleep' | 'hibernate';
  /**
   * True when hibernation is enabled on this machine, in which case
   * `SetSuspendState` may hibernate even though sleep was asked for. Reported
   * rather than hidden: claiming S3 when the box may have gone to S4 changes
   * whether Wake-on-LAN will work.
   */
  hibernationEnabled: boolean;
}

function powershellPath(): string {
  return process.platform === 'win32'
    ? `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell';
}

/** `-NoProfile` always: a user profile that prints a banner corrupts every parse. */
async function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  const result = await spawnAndWait(
    powershellPath(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    os.tmpdir(),
    timeoutMs,
  );
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? 'no output';
    throw new Error(detail);
  }
  return result.stdout;
}

export class PowerControlUnsupportedError extends Error {
  constructor() {
    super('Forge power control is Windows-only; this host is not Windows.');
    this.name = 'PowerControlUnsupportedError';
  }
}

/** Refusal with the exact remedy attached, per CLAUDE.md's alternative rule. */
export class WakeTimersDisabledError extends Error {
  constructor() {
    super(
      'Wake timers are disabled on the active power scheme, so a scheduled wake would ' +
        'never fire. Enable them with:\n' +
        '  powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1\n' +
        '  powercfg /setactive SCHEME_CURRENT',
    );
    this.name = 'WakeTimersDisabledError';
  }
}

/**
 * Module-level state for `holdAwake`. `PowerControl` is stateless per
 * instance, but the power request is per-process: one child holds the
 * `SYSTEM_REQUIRED` request for the whole extension host, and multiple holders
 * reference-count onto it.
 */
interface HoldChild {
  stdin: { end(): void };
  kill(): void;
}

type SpawnHoldChild = (script: string) => HoldChild;

export interface HoldHandle {
  dispose(): void;
}

export interface HoldManager {
  hold(): HoldHandle;
}

/**
 * Reference-counted holder for a `SYSTEM_REQUIRED` power request. Multiple
 * holders share one child; the last `dispose()` closes the child's stdin so it
 * exits and the request drops. The spawner is injected so the reference-count
 * logic is testable without launching PowerShell or depending on the platform.
 */
export function createHoldManager(spawner: SpawnHoldChild): HoldManager {
  let refCount = 0;
  let child: HoldChild | null = null;
  return {
    hold(): HoldHandle {
      refCount += 1;
      if (child === null) child = spawner(holdAwakeScript());
      let disposed = false;
      return {
        dispose(): void {
          if (disposed) return;
          disposed = true;
          refCount -= 1;
          if (refCount <= 0 && child) {
            child.stdin.end();
            child = null;
            refCount = 0;
          }
        },
      };
    },
  };
}

/**
 * The real spawner: a PowerShell child that P/Invokes
 * `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` and then blocks
 * reading stdin. When `dispose()` closes stdin the read returns EOF, the child
 * exits, and the request drops. If the extension host dies the child's stdin
 * closes too, so the request can never outlive Forge.
 */
function defaultHoldSpawner(script: string): HoldChild {
  const proc = child_process.spawn(
    powershellPath(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  return {
    stdin: { end: () => proc.stdin?.end() },
    kill: () => proc.kill(),
  };
}

// Process-wide manager: the power request is per-process, not per-instance.
const holdManager = createHoldManager(defaultHoldSpawner);

function holdAwakeScript(): string {
  return [
    'Add-Type -MemberDefinition @"',
    '[DllImport("kernel32.dll", SetLastError=true)]',
    'public static extern uint SetThreadExecutionState(uint esFlags);',
    '"@ -Name PowerState -Namespace Forge;',
    '$ES_CONTINUOUS = [uint32]0x80000000',
    '$ES_SYSTEM_REQUIRED = [uint32]0x00000001',
    '[Forge.PowerState]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null',
    '$reader = [System.IO.StreamReader]::new([System.Console]::OpenStandardInput())',
    'while ($null -ne $reader.ReadLine()) { }',
  ].join('\n');
}

export class PowerControl {
  private assertWindows(): void {
    if (process.platform !== 'win32') throw new PowerControlUnsupportedError();
  }

  /**
   * Suspend the machine.
   *
   * `SetSuspendState(bHibernate, bForce, bWakeupEventsDisabled)` is P/Invoked
   * rather than shelled through `rundll32 powrprof.dll,SetSuspendState 0,1,0`,
   * whose positional arguments are widely misdocumented and which ignores the
   * hibernate flag on some builds. `bWakeupEventsDisabled` is FALSE — passing
   * TRUE would disarm the very wake sources this module exists to arm.
   */
  async suspend(options: { hibernate?: boolean } = {}): Promise<SuspendResult> {
    this.assertWindows();
    const hibernate = options.hibernate === true;
    const hibernationEnabled = await this.hibernationEnabled();
    const script = [
      'Add-Type -MemberDefinition @"',
      '[DllImport("powrprof.dll", SetLastError = true)]',
      'public static extern bool SetSuspendState(bool hibernate, bool force, bool wakeupEventsDisabled);',
      '"@ -Name PowerState -Namespace Forge;',
      `[Forge.PowerState]::SetSuspendState($${hibernate ? 'true' : 'false'}, $false, $false)`,
    ].join('\n');
    // Fire-and-forget by design: the call does not return until the machine
    // resumes, so awaiting it would hang the turn across the whole sleep.
    void runPowerShell(script, SUSPEND_TIMEOUT_MS).catch(() => undefined);
    return { requested: hibernate ? 'hibernate' : 'sleep', hibernationEnabled };
  }

  /**
   * Register a one-shot task that wakes the machine at `when`.
   *
   * Registered from XML rather than `schtasks /create /sc once`, because
   * `WakeToRun` has no flag form — it exists only in the task XML. The task
   * itself does nothing (`cmd /c exit`); waking the machine to run it IS the
   * effect.
   */
  async armWakeTimer(when: Date): Promise<Date> {
    this.assertWindows();
    if ((await this.wakeTimersAllowed()) === false) throw new WakeTimersDisabledError();
    if (when.getTime() <= Date.now()) {
      throw new Error('Forge: a wake time must be in the future.');
    }
    const xml = oneShotTaskXml(when);
    // Written via PowerShell rather than a temp file we manage: schtasks
    // requires a UTF-16 XML file, and letting PowerShell own both the encoding
    // and the cleanup keeps the failure modes in one place.
    const script = [
      `$path = Join-Path $env:TEMP 'forge-wake-task.xml'`,
      `Set-Content -LiteralPath $path -Encoding Unicode -Value @'`,
      xml,
      `'@`,
      `try {`,
      `  schtasks /create /tn "${WAKE_TASK_NAME}" /xml $path /f | Out-Null`,
      `  if ($LASTEXITCODE -ne 0) { throw "schtasks exited $LASTEXITCODE" }`,
      `} finally { Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue }`,
    ].join('\n');
    await runPowerShell(script, SCHTASKS_TIMEOUT_MS);
    return when;
  }

  /** Removes the armed wake. True when one was there to remove. */
  async clearWakeTimer(): Promise<boolean> {
    this.assertWindows();
    const result = await spawnAndWait(
      `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\schtasks.exe`,
      ['/delete', '/tn', WAKE_TASK_NAME, '/f'],
      os.tmpdir(),
      SCHTASKS_TIMEOUT_MS,
    );
    return result.exitCode === 0;
  }

  /**
   * Register (or replace) the recurring task `ForgeScheduledWake` with one
   * `CalendarTrigger` per distinct wake time. Windows repeats each wake without
   * Forge (fixes G1 and G2). An empty list deletes the task, so disabling jobs
   * cannot leave a stale task that wakes the machine (G4).
   */
  async setScheduledWakes(wakes: readonly RecurringWake[]): Promise<void> {
    this.assertWindows();
    if (wakes.length === 0) {
      await this.deleteScheduledWakes();
      return;
    }
    if ((await this.wakeTimersAllowed()) === false) throw new WakeTimersDisabledError();
    const xml = scheduledWakeTaskXml(wakes);
    const script = [
      `$path = Join-Path $env:TEMP 'forge-scheduled-wake-task.xml'`,
      `Set-Content -LiteralPath $path -Encoding Unicode -Value @'`,
      xml,
      `'@`,
      `try {`,
      `  schtasks /create /tn "${SCHEDULED_WAKE_TASK_NAME}" /xml $path /f | Out-Null`,
      `  if ($LASTEXITCODE -ne 0) { throw "schtasks exited $LASTEXITCODE" }`,
      `} finally { Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue }`,
    ].join('\n');
    await runPowerShell(script, SCHTASKS_TIMEOUT_MS);
  }

  /**
   * Read the recurring wake schedule from `ForgeScheduledWake`. Returns `null`
   * when the task does not exist, so `/wake` and `get_power_info` can report
   * the schedule next to the one-shot armed wake.
   */
  async readScheduledWakes(): Promise<RecurringWake[] | null> {
    this.assertWindows();
    const result = await spawnAndWait(
      `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\schtasks.exe`,
      ['/query', '/tn', SCHEDULED_WAKE_TASK_NAME, '/xml'],
      os.tmpdir(),
      SCHTASKS_TIMEOUT_MS,
    );
    if (result.exitCode !== 0) return null;
    return parseScheduledWakes(result.stdout);
  }

  private async deleteScheduledWakes(): Promise<void> {
    await spawnAndWait(
      `${process.env['SystemRoot'] ?? 'C:\\Windows'}\\System32\\schtasks.exe`,
      ['/delete', '/tn', SCHEDULED_WAKE_TASK_NAME, '/f'],
      os.tmpdir(),
      SCHTASKS_TIMEOUT_MS,
    );
  }

  /**
   * Hold a `SYSTEM_REQUIRED` power request so the machine does not re-sleep
   * after a wake (G3). Reference-counted: multiple holders share one child.
   * `dispose()` closes the child's stdin; the child exits and the request
   * drops. If the extension host dies, the child's stdin closes too, so the
   * request can never outlive Forge.
   */
  holdAwake(_reason: string): HoldHandle {
    this.assertWindows();
    return holdManager.hold();
  }

  /**
   * Milliseconds since the last keyboard/mouse input, or `null` if the probe
   * failed. Feeds the `sleep_if_idle` decision: a wake that sees no input and
   * nothing busy may suspend again instead of sitting at the logon screen.
   */
  async idleSinceResume(): Promise<number | null> {
    this.assertWindows();
    try {
      const script = [
        'Add-Type -MemberDefinition @"',
        '[StructLayout(LayoutKind.Sequential)]',
        'public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
        '[DllImport("user32.dll")]',
        'public static extern bool GetLastInputInfo(ref LASTINPUTINFO lii);',
        '"@ -Name LastInput -Namespace Forge;',
        '$lii = New-Object Forge.LASTINPUTINFO',
        '$lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]([Forge.LASTINPUTINFO]))',
        '[Forge.LastInput]::GetLastInputInfo([ref]$lii) | Out-Null',
        'Write-Host ([System.Environment]::TickCount - $lii.dwTime)',
      ].join('\n');
      const out = (await runPowerShell(script, POWERCFG_TIMEOUT_MS)).trim();
      const ms = Number.parseInt(out, 10);
      return Number.isFinite(ms) && ms >= 0 ? ms : null;
    } catch {
      return null;
    }
  }

  /**
   * Everything needed to wake this machine from outside it: which adapters can
   * do it, the MAC to address the magic packet to, and the broadcast to send it
   * on.
   */
  async describeWake(): Promise<WakeInfo> {
    this.assertWindows();
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
$armed = (powercfg /devicequery wake_armed) -join "\`n"
$states = (powercfg /a) -join "\`n"
$adapters = @()
foreach ($a in (Get-NetAdapter | Where-Object { $_.Status -eq 'Up' })) {
  $ip = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue | Select-Object -First 1
  $magic = Get-NetAdapterAdvancedProperty -Name $a.Name -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'Wake on Magic Packet' } | Select-Object -First 1
  $adapters += [pscustomobject]@{
    name = $a.Name
    description = $a.InterfaceDescription
    mac = $a.MacAddress
    ip = $(if ($ip) { $ip.IPAddress } else { $null })
    prefix = $(if ($ip) { $ip.PrefixLength } else { $null })
    magic = $(if ($magic) { $magic.DisplayValue } else { $null })
  }
}
$task = schtasks /query /tn "${WAKE_TASK_NAME}" /fo LIST 2>$null | Out-String
$scheduledTask = schtasks /query /tn "${SCHEDULED_WAKE_TASK_NAME}" /xml 2>$null | Out-String
[pscustomobject]@{ armed = $armed; states = $states; adapters = $adapters; task = $task; scheduledTask = $scheduledTask } |
  ConvertTo-Json -Depth 5 -Compress
`;
    const raw = await runPowerShell(script, POWERCFG_TIMEOUT_MS);
    let scheduledWakes: RecurringWake[] | null = null;
    try {
      const parsed = JSON.parse(raw.trim()) as { scheduledTask?: unknown };
      if (typeof parsed.scheduledTask === 'string' && parsed.scheduledTask.trim()) {
        scheduledWakes = parseScheduledWakes(parsed.scheduledTask);
      }
    } catch {
      // Malformed JSON: parseWakeInfo below throws with a clear message.
    }
    return parseWakeInfo(raw, await this.wakeTimersAllowed(), scheduledWakes);
  }

  private async hibernationEnabled(): Promise<boolean> {
    try {
      const out = await runPowerShell('(powercfg /a) -join "`n"', POWERCFG_TIMEOUT_MS);
      return availableStates(out).some((state) => /hibernate/i.test(state));
    } catch {
      return false;
    }
  }

  /** Null when the setting could not be read, which is not the same as false. */
  private async wakeTimersAllowed(): Promise<boolean | null> {
    try {
      const out = await runPowerShell(
        '(powercfg /q SCHEME_CURRENT SUB_SLEEP RTCWAKE) -join "`n"',
        POWERCFG_TIMEOUT_MS,
      );
      const ac = /Current AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(out);
      if (!ac) return null;
      return Number.parseInt(ac[1]!, 16) !== 0;
    } catch {
      return null;
    }
  }
}
