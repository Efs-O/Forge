/**
 * Reading and presenting this machine's wake configuration.
 *
 * The pure half of `PowerControl`: parsing what `powercfg`, `Get-NetAdapter`
 * and `schtasks` said, and rendering it for a human. Split from the class so
 * every branch here is testable against captured output — no extension host, no
 * admin rights, and no actually suspending the developer's machine.
 */

export interface WakeAdapter {
  name: string;
  description: string;
  macAddress: string;
  ipAddress: string | null;
  /** Subnet broadcast address — what a WoL app sends the magic packet to. */
  broadcast: string | null;
  /** True when `powercfg /devicequery wake_armed` lists this adapter. */
  wakeArmed: boolean;
  /** The driver's own "Wake on Magic Packet" advanced property. */
  magicPacketEnabled: boolean | null;
}

export interface WakeInfo {
  adapters: WakeAdapter[];
  /** Sleep states `powercfg /a` reports as available (e.g. `Standby (S3)`). */
  availableStates: string[];
  /** The armed one-shot wake, as an ISO-ish local timestamp, when one exists. */
  armedWake: string | null;
  /**
   * Whether the active power scheme permits wake timers at all. When false,
   * `armWakeTimer` refuses instead of registering a task that will not fire.
   */
  wakeTimersAllowed: boolean | null;
}

/** The `Standby (S3)` / `Hibernate` lines above the "not available" heading. */
export function availableStates(powercfgOutput: string): string[] {
  const [availableBlock] = powercfgOutput.split(/The following sleep states are not available/i);
  return (availableBlock ?? '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^The following/i.test(line));
}

/** IPv4 subnet broadcast — the address a WoL app must target. */
export function broadcastAddress(ip: string, prefixLength: number): string | null {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return null;
  }
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) return null;
  // >>> 0 throughout: a /0 or /1 mask overflows into the sign bit otherwise.
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const broadcast = (address | (~mask >>> 0)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (broadcast >>> shift) & 0xff).join('.');
}

interface RawAdapter {
  name?: unknown;
  description?: unknown;
  mac?: unknown;
  ip?: unknown;
  prefix?: unknown;
  magic?: unknown;
}

export function parseWakeInfo(json: string, wakeTimersAllowed: boolean | null): WakeInfo {
  let parsed: {
    armed?: unknown;
    states?: unknown;
    adapters?: unknown;
    task?: unknown;
  };
  try {
    parsed = JSON.parse(json.trim()) as typeof parsed;
  } catch {
    throw new Error(`Forge: could not read the machine's wake configuration — ${json.trim()}`);
  }
  const armedText = typeof parsed.armed === 'string' ? parsed.armed : '';
  const statesText = typeof parsed.states === 'string' ? parsed.states : '';
  // ConvertTo-Json collapses a one-element array to a bare object.
  const rawAdapters: RawAdapter[] = Array.isArray(parsed.adapters)
    ? (parsed.adapters as RawAdapter[])
    : parsed.adapters
      ? [parsed.adapters as RawAdapter]
      : [];

  const adapters = rawAdapters.map((entry): WakeAdapter => {
    const description = typeof entry.description === 'string' ? entry.description : '';
    const ip = typeof entry.ip === 'string' ? entry.ip : null;
    const prefix = typeof entry.prefix === 'number' ? entry.prefix : null;
    const magic = typeof entry.magic === 'string' ? entry.magic : null;
    return {
      name: typeof entry.name === 'string' ? entry.name : '',
      description,
      macAddress: typeof entry.mac === 'string' ? entry.mac : '',
      ipAddress: ip,
      broadcast: ip && prefix !== null ? broadcastAddress(ip, prefix) : null,
      // powercfg prints the adapter's *description*, not its connection name.
      wakeArmed: description.length > 0 && armedText.includes(description),
      magicPacketEnabled: magic === null ? null : /enabled/i.test(magic),
    };
  });

  const taskText = typeof parsed.task === 'string' ? parsed.task : '';
  const nextRun = /Next Run Time:\s*(.+)/i.exec(taskText)?.[1]?.trim();

  return {
    adapters,
    availableStates: availableStates(statesText),
    armedWake: nextRun && !/^N\/A/i.test(nextRun) ? nextRun : null,
    wakeTimersAllowed,
  };
}

/**
 * Parse `/sleep 8h`, `/wake 07:00`, `/wake 2026-09-08 07:00`.
 *
 * A bare `HH:MM` means the next occurrence of that clock time — today if it is
 * still ahead, tomorrow otherwise. Returns undefined for anything unrecognised
 * rather than guessing: a misparsed wake time is a machine that stays asleep.
 */
export function parseWakeTime(input: string, now: Date = new Date()): Date | undefined {
  const text = input.trim().toLowerCase();
  if (!text) return undefined;

  const duration = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/.exec(text);
  if (duration) {
    const amount = Number(duration[1]);
    if (!Number.isFinite(amount) || amount <= 0) return undefined;
    const minutes = /^m/.test(duration[2]!) ? amount : amount * 60;
    // 14 days: past that the one-shot task is more likely a typo than a plan.
    if (minutes > 60 * 24 * 14) return undefined;
    return new Date(now.getTime() + minutes * 60_000);
  }

  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return undefined;
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target;
  }

  const stamp = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(text);
  if (stamp) {
    const target = new Date(
      Number(stamp[1]),
      Number(stamp[2]) - 1,
      Number(stamp[3]),
      Number(stamp[4]),
      Number(stamp[5]),
      0,
      0,
    );
    return Number.isNaN(target.getTime()) ? undefined : target;
  }
  return undefined;
}

/** Human-readable `WakeInfo`, shared by `/wake`, `/system` and `get_power_info`. */
export function formatWakeInfo(info: WakeInfo): string {
  const lines: string[] = [];
  lines.push('Waking this machine from outside');
  lines.push('');
  if (info.adapters.length === 0) {
    lines.push('No network adapter is up, so Wake-on-LAN has nothing to listen on.');
  }
  for (const adapter of info.adapters) {
    lines.push(`${adapter.name} — ${adapter.description}`);
    lines.push(`  MAC:        ${adapter.macAddress}`);
    if (adapter.ipAddress) lines.push(`  IP:         ${adapter.ipAddress}`);
    if (adapter.broadcast) lines.push(`  Broadcast:  ${adapter.broadcast}   (UDP port 9)`);
    lines.push(`  Wake armed: ${adapter.wakeArmed ? 'yes' : 'NO'}`);
    lines.push(
      `  Magic pkt:  ${
        adapter.magicPacketEnabled === null
          ? 'unknown'
          : adapter.magicPacketEnabled
            ? 'enabled'
            : 'DISABLED'
      }`,
    );
    lines.push('');
  }
  lines.push(`Sleep states: ${info.availableStates.join(', ') || 'none reported'}`);
  lines.push(
    `Wake timers:  ${
      info.wakeTimersAllowed === null
        ? 'unknown'
        : info.wakeTimersAllowed
          ? 'allowed'
          : 'DISABLED on the active power scheme'
    }`,
  );
  lines.push(`Armed wake:   ${info.armedWake ?? 'none'}`);
  lines.push('');
  // Said plainly every time, because it is the thing people expect to be false.
  lines.push(
    'Forge cannot wake this machine itself: once it sleeps, nothing on it is running. ' +
      'Send a magic packet to the MAC above from a device that is awake on the same ' +
      'network, or arm a wake timer in advance with /wake <time>.',
  );
  return lines.join('\n');
}
