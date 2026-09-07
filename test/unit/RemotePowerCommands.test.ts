import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import {
  handleRemotePowerCommand,
  resetPendingSleeps,
} from '../../src/remote/RemotePowerCommands';
import type { PowerControl } from '../../src/system/PowerControl';
import type { WakeInfo } from '../../src/system/wakeInfo';
import type { ForgeHostFacade, ForgeHostStatus } from '../../src/sidebar/ForgeHostFacade';
import type { RemoteInboundEvent } from '../../src/remote/types';

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
  availableStates: ['Standby (S3)'],
  armedWake: null,
  wakeTimersAllowed: true,
};

const IDLE: ForgeHostStatus = {
  activeConversationId: 'c1',
  conversations: [],
  requestChains: [],
  streamingConversationIds: [],
};

function event(text: string): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return { kind: 'text', channel: 'fake', chatId: 'chat-a', text } as Extract<
    RemoteInboundEvent,
    { kind: 'text' }
  >;
}

function context(overrides: { status?: ForgeHostStatus } = {}) {
  const channel = new FakeRemoteChannel();
  const suspended: Array<{ hibernate?: boolean }> = [];
  const armed: Date[] = [];
  let cleared = 0;
  const power = {
    describeWake: async () => HEALTHY,
    suspend: async (options: { hibernate?: boolean } = {}) => {
      suspended.push(options);
      return { requested: 'sleep' as const, hibernationEnabled: false };
    },
    armWakeTimer: async (when: Date) => {
      armed.push(when);
      return when;
    },
    clearWakeTimer: async () => {
      cleared += 1;
      return true;
    },
  } as unknown as PowerControl;
  const host = { status: () => overrides.status ?? IDLE } as unknown as ForgeHostFacade;
  return {
    ctx: { channel, host, signal: new AbortController().signal, power },
    channel,
    suspended,
    armed,
    get cleared() {
      return cleared;
    },
  };
}

async function run(
  h: ReturnType<typeof context>,
  line: string,
): ReturnType<typeof handleRemotePowerCommand> {
  const [command, ...operands] = line.trim().split(/\s+/);
  return handleRemotePowerCommand(command, operands, event(line), h.ctx);
}

beforeEach(() => resetPendingSleeps());
afterEach(() => vi.useRealTimers());

describe('/sleep', () => {
  it('does not suspend on the first message', async () => {
    const h = context();
    const result = await run(h, '/sleep');

    expect(result).toEqual({ kind: 'handled' });
    expect(h.suspended).toHaveLength(0);
    expect(h.channel.sent.at(-1)!.text).toContain('/sleep confirm');
    // The magic-packet address travels with the warning: after this lands, it
    // is the only way back in.
    expect(h.channel.sent.at(-1)!.text).toContain('E0-D5-5E-73-F7-88');
  });

  it('suspends after the confirmation, once the reply has had time to leave', async () => {
    vi.useFakeTimers();
    const h = context();
    await run(h, '/sleep');
    await run(h, '/sleep confirm');

    expect(h.suspended).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.suspended).toEqual([{ hibernate: false }]);
  });

  it('refuses a confirmation with nothing pending', async () => {
    const h = context();
    const result = await run(h, '/sleep confirm');
    expect(result).toMatchObject({ kind: 'rejected' });
    expect(h.suspended).toHaveLength(0);
  });

  it('refuses while a turn is running, and names the override', async () => {
    const h = context({ status: { ...IDLE, streamingConversationIds: ['c1'] } });
    const result = await run(h, '/sleep');
    expect(result).toMatchObject({ kind: 'rejected' });
    expect((result as { reason: string }).reason).toContain('/sleep force');
  });

  it('force overrides a busy window', async () => {
    const h = context({ status: { ...IDLE, streamingConversationIds: ['c1'] } });
    expect(await run(h, '/sleep force')).toEqual({ kind: 'handled' });
  });

  it('arms the wake timer before suspending, not after', async () => {
    vi.useFakeTimers();
    const h = context();
    await run(h, '/sleep 8h');
    await run(h, '/sleep confirm');
    // After the suspend there is no "after": arming has to already have happened.
    expect(h.armed).toHaveLength(1);
    expect(h.suspended).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.suspended).toHaveLength(1);
  });

  // The command line is split on whitespace, so reading only the first token
  // would refuse two forms parseWakeTime accepts.
  it('accepts a multi-token wake time', async () => {
    const h = context();
    expect(await run(h, '/sleep 2026-12-24 07:00')).toEqual({ kind: 'handled' });
    expect(h.channel.sent.at(-1)!.text).toContain('will wake itself');

    const h2 = context();
    expect(await run(h2, '/sleep 45 minutes')).toEqual({ kind: 'handled' });
    expect(h2.channel.sent.at(-1)!.text).toContain('will wake itself');
  });

  it('rejects an unreadable wake time before offering to suspend', async () => {
    const h = context();
    const result = await run(h, '/sleep tomorrow');
    expect(result).toMatchObject({ kind: 'rejected' });
    // Nothing was armed and nothing is pending, so a later confirm cannot land.
    expect(h.armed).toHaveLength(0);
    expect(await run(h, '/sleep confirm')).toMatchObject({ kind: 'rejected' });
  });

  it('reads hibernate alongside a time in any order', async () => {
    vi.useFakeTimers();
    const h = context();
    await run(h, '/sleep hibernate 8h');
    await run(h, '/sleep confirm');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(h.armed).toHaveLength(1);
    expect(h.suspended).toEqual([{ hibernate: true }]);
  });
});

describe('/wake', () => {
  it('reports the magic-packet details and never claims to wake anything', async () => {
    const h = context();
    expect(await run(h, '/wake')).toEqual({ kind: 'handled' });
    const text = h.channel.sent.at(-1)!.text;
    expect(text).toContain('E0-D5-5E-73-F7-88');
    expect(text).toContain('Forge cannot wake this machine itself');
  });

  it('arms a time without suspending', async () => {
    const h = context();
    await run(h, '/wake 07:00');
    expect(h.armed).toHaveLength(1);
    expect(h.suspended).toHaveLength(0);
  });

  it('accepts a multi-token time', async () => {
    const h = context();
    await run(h, '/wake 2026-12-24 07:00');
    expect(h.armed).toHaveLength(1);
  });

  it('clears an armed wake', async () => {
    const h = context();
    await run(h, '/wake off');
    expect(h.cleared).toBe(1);
  });

  it('leaves every other command alone', async () => {
    const h = context();
    expect(await run(h, '/status')).toBeUndefined();
  });
});
