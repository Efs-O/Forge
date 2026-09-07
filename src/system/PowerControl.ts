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

import * as os from 'os';
import { spawnAndWait } from '../util/processSpawn';
import { availableStates, parseWakeInfo, type WakeInfo } from './wakeInfo';

const POWERCFG_TIMEOUT_MS = 10_000;
const SCHTASKS_TIMEOUT_MS = 10_000;
const SUSPEND_TIMEOUT_MS = 20_000;

/** One-shot task name. Fixed, so arming twice replaces rather than accumulates. */
export const WAKE_TASK_NAME = 'ForgeWakeTimer';

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
    const xml = wakeTaskXml(when);
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
[pscustomobject]@{ armed = $armed; states = $states; adapters = $adapters; task = $task } |
  ConvertTo-Json -Depth 5 -Compress
`;
    const raw = await runPowerShell(script, POWERCFG_TIMEOUT_MS);
    return parseWakeInfo(raw, await this.wakeTimersAllowed());
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

/** Local time, no timezone suffix: Task Scheduler reads `StartBoundary` as local. */
function localIso(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
  );
}

function wakeTaskXml(when: Date): string {
  // `Command` is a no-op on purpose: the wake is the point, not the task. The
  // task deletes itself 1 minute after expiry so repeated /sleep calls do not
  // leave a trail of dead entries in Task Scheduler.
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Forge one-shot wake timer. Wakes this machine so Forge and its remote transports come back online.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${localIso(when)}</StartBoundary>
      <EndBoundary>${localIso(new Date(when.getTime() + 60_000))}</EndBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <WakeToRun>true</WakeToRun>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DeleteExpiredTaskAfter>PT1M</DeleteExpiredTaskAfter>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT1M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c exit</Arguments>
    </Exec>
  </Actions>
</Task>`;
}
