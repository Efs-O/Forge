import { describe, expect, it } from 'vitest';
import {
  availableStates,
  broadcastAddress,
  formatWakeInfo,
  parseWakeInfo,
  parseWakeTime,
  type WakeInfo,
} from '../../src/system/wakeInfo';

// Captured verbatim from the machine this was built against, so the parser is
// tested against what powercfg actually prints rather than what it ought to.
const POWERCFG_A = `The following sleep states are available on this system:
    Standby (S3)
    Hibernate

The following sleep states are not available on this system:
    Standby (S1)
\tThe system firmware does not support this standby state.

    Standby (S0 Low Power Idle)
\tThe system firmware does not support this standby state.

    Hybrid Sleep
\tThe hypervisor does not support this standby state.
`;

describe('availableStates', () => {
  it('reads only the states above the "not available" heading', () => {
    expect(availableStates(POWERCFG_A)).toEqual(['Standby (S3)', 'Hibernate']);
  });

  it('returns nothing when no state is available', () => {
    const none = 'The following sleep states are not available on this system:\n    Standby (S3)\n';
    expect(availableStates(none)).toEqual([]);
  });
});

describe('broadcastAddress', () => {
  it('computes the subnet broadcast a magic packet must target', () => {
    expect(broadcastAddress('192.168.1.70', 24)).toBe('192.168.1.255');
    expect(broadcastAddress('10.20.30.40', 16)).toBe('10.20.255.255');
  });

  // The shift that builds the mask overflows into the sign bit for short
  // prefixes unless every step is coerced back to unsigned.
  it('does not sign-overflow on a short prefix', () => {
    expect(broadcastAddress('10.0.0.1', 1)).toBe('127.255.255.255');
    expect(broadcastAddress('10.0.0.1', 0)).toBe('255.255.255.255');
  });

  it('rejects malformed input rather than guessing', () => {
    expect(broadcastAddress('192.168.1', 24)).toBeNull();
    expect(broadcastAddress('192.168.1.999', 24)).toBeNull();
    expect(broadcastAddress('192.168.1.1', 33)).toBeNull();
  });
});

describe('parseWakeInfo', () => {
  const payload = JSON.stringify({
    armed: 'Intel(R) Ethernet Connection (7) I219-V\nMicrosoft USB Dual Receiver Wireless Mouse',
    states: POWERCFG_A,
    adapters: [
      {
        name: 'Ethernet',
        description: 'Intel(R) Ethernet Connection (7) I219-V',
        mac: 'E0-D5-5E-73-F7-88',
        ip: '192.168.1.70',
        prefix: 24,
        magic: 'Enabled',
      },
    ],
    task: 'TaskName: \\ForgeWakeTimer\nNext Run Time: 08/09/2026 07:00:00\n',
  });

  it('matches the armed list against the adapter description, not its name', () => {
    const info = parseWakeInfo(payload, true);
    expect(info.adapters).toHaveLength(1);
    expect(info.adapters[0]!.wakeArmed).toBe(true);
    expect(info.adapters[0]!.broadcast).toBe('192.168.1.255');
    expect(info.adapters[0]!.magicPacketEnabled).toBe(true);
    expect(info.armedWake).toBe('08/09/2026 07:00:00');
  });

  // ConvertTo-Json collapses a one-element array to a bare object, which would
  // otherwise drop the only adapter on a single-NIC machine.
  it('accepts a lone adapter serialized as an object', () => {
    const single = JSON.stringify({
      armed: '',
      states: POWERCFG_A,
      adapters: { name: 'Wi-Fi', description: 'Some Radio', mac: 'AA-BB', ip: null, prefix: null },
      task: '',
    });
    expect(parseWakeInfo(single, null).adapters).toHaveLength(1);
  });

  it('reports no armed wake when schtasks found no task', () => {
    const noTask = JSON.stringify({ armed: '', states: '', adapters: [], task: '' });
    expect(parseWakeInfo(noTask, null).armedWake).toBeNull();
  });

  it('treats an N/A next run as no armed wake', () => {
    const na = JSON.stringify({
      armed: '',
      states: '',
      adapters: [],
      task: 'Next Run Time: N/A\n',
    });
    expect(parseWakeInfo(na, null).armedWake).toBeNull();
  });

  it('fails loudly rather than returning an empty report', () => {
    expect(() => parseWakeInfo('not json', null)).toThrow(/could not read/i);
  });

  it('carries the scheduled wakes through to the report', () => {
    const wakes = [{ hour: 6, minute: 0, days: 'daily' as const }];
    const info = parseWakeInfo(
      JSON.stringify({ armed: '', states: '', adapters: [], task: '' }),
      true,
      wakes,
    );
    expect(info.scheduledWakes).toEqual(wakes);
  });

  it('defaults scheduled wakes to null when not supplied', () => {
    const info = parseWakeInfo(
      JSON.stringify({ armed: '', states: '', adapters: [], task: '' }),
      true,
    );
    expect(info.scheduledWakes).toBeNull();
  });
});

describe('parseWakeTime', () => {
  const now = new Date(2026, 8, 7, 22, 30, 0);

  it('reads durations', () => {
    expect(parseWakeTime('8h', now)).toEqual(new Date(2026, 8, 8, 6, 30, 0));
    expect(parseWakeTime('90m', now)).toEqual(new Date(2026, 8, 8, 0, 0, 0));
    expect(parseWakeTime('45 minutes', now)).toEqual(new Date(2026, 8, 7, 23, 15, 0));
  });

  it('rolls a clock time past midnight to tomorrow', () => {
    expect(parseWakeTime('07:00', now)).toEqual(new Date(2026, 8, 8, 7, 0, 0, 0));
  });

  it('keeps a clock time still ahead today', () => {
    expect(parseWakeTime('23:15', now)).toEqual(new Date(2026, 8, 7, 23, 15, 0, 0));
  });

  it('reads an explicit stamp', () => {
    expect(parseWakeTime('2026-09-09 06:15', now)).toEqual(new Date(2026, 8, 9, 6, 15, 0, 0));
  });

  // A misparsed wake time is a machine that never comes back, so anything
  // unrecognised must be refused rather than approximated.
  it('refuses what it cannot read', () => {
    expect(parseWakeTime('', now)).toBeUndefined();
    expect(parseWakeTime('tomorrow morning', now)).toBeUndefined();
    expect(parseWakeTime('25:00', now)).toBeUndefined();
    expect(parseWakeTime('07:60', now)).toBeUndefined();
    expect(parseWakeTime('0h', now)).toBeUndefined();
    expect(parseWakeTime('400h', now)).toBeUndefined();
  });
});

describe('formatWakeInfo', () => {
  const base: WakeInfo = {
    adapters: [
      {
        name: 'Ethernet',
        description: 'Intel(R) Ethernet Connection (7) I219-V',
        macAddress: 'E0-D5-5E-73-F7-88',
        ipAddress: '192.168.1.70',
        broadcast: '192.168.1.255',
        wakeArmed: true,
        magicPacketEnabled: true,
      },
    ],
    availableStates: ['Standby (S3)'],
    armedWake: null,
    wakeTimersAllowed: true,
    scheduledWakes: null,
  };

  it('leads with the details a WoL app needs', () => {
    const text = formatWakeInfo(base);
    expect(text).toContain('E0-D5-5E-73-F7-88');
    expect(text).toContain('192.168.1.255');
    expect(text).toContain('UDP port 9');
  });

  // The single most misunderstood point, so it is stated on every report rather
  // than only when something is misconfigured.
  it('always says Forge cannot wake the machine itself', () => {
    expect(formatWakeInfo(base)).toContain('Forge cannot wake this machine itself');
    expect(formatWakeInfo({ ...base, adapters: [] })).toContain(
      'Forge cannot wake this machine itself',
    );
  });

  it('shouts when nothing can receive a magic packet', () => {
    const text = formatWakeInfo({
      ...base,
      adapters: [{ ...base.adapters[0]!, wakeArmed: false, magicPacketEnabled: false }],
    });
    expect(text).toContain('Wake armed: NO');
    expect(text).toContain('Magic pkt:  DISABLED');
  });

  it('names a disabled wake-timer policy', () => {
    expect(formatWakeInfo({ ...base, wakeTimersAllowed: false })).toContain(
      'DISABLED on the active power scheme',
    );
  });

  it('shows the recurring schedule when present', () => {
    const text = formatWakeInfo({
      ...base,
      scheduledWakes: [{ hour: 6, minute: 0, days: 'daily' }],
    });
    expect(text).toContain('Scheduled:    06:00 (daily)');
  });

  it('shows multiple recurring wakes', () => {
    const text = formatWakeInfo({
      ...base,
      scheduledWakes: [
        { hour: 6, minute: 0, days: 'daily' },
        { hour: 9, minute: 30, days: ['Mon', 'Wed', 'Fri'] },
      ],
    });
    expect(text).toContain('06:00 (daily)');
    expect(text).toContain('09:30 (Mon, Wed, Fri)');
  });

  it('shows none when no scheduled task exists', () => {
    expect(formatWakeInfo(base)).toContain('Scheduled:    none');
  });
});
