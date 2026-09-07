import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeGetPowerInfoTool,
  makeScheduleWakeTool,
  makeSleepComputerTool,
} from '../../src/tools/powerTools';
import { WakeTimersDisabledError, type PowerControl } from '../../src/system/PowerControl';
import type { WakeInfo } from '../../src/system/wakeInfo';

afterEach(() => {
  vi.useRealTimers();
});

const HEALTHY: WakeInfo = {
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
  availableStates: ['Standby (S3)', 'Hibernate'],
  armedWake: null,
  wakeTimersAllowed: true,
};

interface FakePower {
  control: PowerControl;
  suspended: Array<{ hibernate?: boolean }>;
  armed: Date[];
  cleared: number;
}

function fakePower(
  overrides: {
    info?: WakeInfo;
    armThrows?: Error;
    clearReturns?: boolean;
  } = {},
): FakePower {
  const suspended: Array<{ hibernate?: boolean }> = [];
  const armed: Date[] = [];
  let cleared = 0;
  const control = {
    describeWake: async () => overrides.info ?? HEALTHY,
    suspend: async (options: { hibernate?: boolean } = {}) => {
      suspended.push(options);
      return { requested: options.hibernate ? 'hibernate' : 'sleep', hibernationEnabled: true };
    },
    armWakeTimer: async (when: Date) => {
      if (overrides.armThrows) throw overrides.armThrows;
      armed.push(when);
      return when;
    },
    clearWakeTimer: async () => {
      cleared += 1;
      return overrides.clearReturns ?? true;
    },
  } as unknown as PowerControl;
  return {
    control,
    suspended,
    armed,
    get cleared() {
      return cleared;
    },
  };
}

describe('get_power_info', () => {
  it('reports the address a magic packet has to be sent to', async () => {
    const power = fakePower();
    const result = await makeGetPowerInfoTool(power.control).handler({});
    expect(String(result)).toContain('E0-D5-5E-73-F7-88');
    expect(String(result)).toContain('192.168.1.255');
  });

  it('is read-only and argument-free, so it needs no approval', () => {
    const tool = makeGetPowerInfoTool(fakePower().control);
    expect(tool.permission).toBe('read');
    expect(tool.autoApprove).toBe(true);
  });
});

describe('schedule_wake', () => {
  it('arms the requested time', async () => {
    const power = fakePower();
    const result = await makeScheduleWakeTool(power.control).handler({ when: '90m' });
    expect(power.armed).toHaveLength(1);
    expect(String(result)).toContain('will wake at');
  });

  it('clears an armed wake', async () => {
    const power = fakePower();
    const result = await makeScheduleWakeTool(power.control).handler({ clear: true });
    expect(power.cleared).toBe(1);
    expect(String(result)).toBe('Wake timer cleared.');
  });

  it('says so when there was nothing to clear', async () => {
    const power = fakePower({ clearReturns: false });
    const result = await makeScheduleWakeTool(power.control).handler({ clear: true });
    expect(String(result)).toBe('There was no wake timer armed.');
  });

  // A refusal that does not name the accepted forms teaches the model the
  // capability does not exist (CLAUDE.md, "Agent-Ergonomics Traps").
  it('names the accepted formats when it cannot read the time', async () => {
    const tool = makeScheduleWakeTool(fakePower().control);
    await expect(tool.handler({ when: 'tomorrow morning' })).rejects.toThrow(/07:00/);
    await expect(tool.handler({})).rejects.toThrow(/required unless/);
    expect(fakePower().armed).toHaveLength(0);
  });

  it('passes the wake-timers-disabled remedy through untouched', async () => {
    const power = fakePower({ armThrows: new WakeTimersDisabledError() });
    await expect(makeScheduleWakeTool(power.control).handler({ when: '8h' })).rejects.toThrow(
      /powercfg \/setacvalueindex/,
    );
  });
});

describe('sleep_computer', () => {
  it('is always dangerous, so clanker mode cannot suspend the machine unasked', () => {
    const tool = makeSleepComputerTool(fakePower().control);
    expect(tool.approval?.({})?.dangerous).toBe(true);
    expect(tool.autoApprove).toBeUndefined();
  });

  it('waits out the grace period before suspending', async () => {
    vi.useFakeTimers();
    const power = fakePower();
    const result = await makeSleepComputerTool(power.control).handler({ delay_seconds: 30 });

    // The reply has to reach the sidebar and any paired chat first; suspending
    // when the handler returns cuts the turn off mid-sentence.
    expect(power.suspended).toHaveLength(0);
    expect(String(result)).toContain('in 30 seconds');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(power.suspended).toEqual([{ hibernate: false }]);
  });

  it('clamps a delay past the ceiling instead of refusing the call', async () => {
    vi.useFakeTimers();
    const power = fakePower();
    const result = await makeSleepComputerTool(power.control).handler({ delay_seconds: 99_999 });
    expect(String(result)).toContain('in 600 seconds');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(power.suspended).toHaveLength(1);
  });

  it('honours hibernate', async () => {
    vi.useFakeTimers();
    const power = fakePower();
    await makeSleepComputerTool(power.control).handler({ hibernate: true, delay_seconds: 0 });
    expect(power.suspended).toEqual([{ hibernate: true }]);
  });

  // Preflighted, so a machine that cannot suspend says so in the tool result
  // rather than appearing to succeed and then doing nothing.
  it('refuses when the machine reports no sleep states', async () => {
    const power = fakePower({ info: { ...HEALTHY, availableStates: [] } });
    await expect(makeSleepComputerTool(power.control).handler({})).rejects.toThrow(
      /no available sleep states/,
    );
    expect(power.suspended).toHaveLength(0);
  });

  it('warns that a sleep may become a hibernate when hibernation is enabled', async () => {
    vi.useFakeTimers();
    const power = fakePower();
    const result = await makeSleepComputerTool(power.control).handler({});
    expect(String(result)).toContain('may hibernate instead');
    // And it always says the machine cannot be woken from here.
    expect(String(result)).toContain('cannot wake it back up');
  });
});
