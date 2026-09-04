import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import {
  handleRemoteCommand,
  type RemoteCommandContext,
} from '../../src/remote/RemoteCommandHandler';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import type { RemoteInboundEvent } from '../../src/remote/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function requestStore(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-voice-toggle-'));
  tempDirs.push(directory);
  const store = new RemoteRequestStore(path.join(directory, 'state.json'));
  await store.load();
  return store;
}

function textEvent(text: string): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return {
    channel: 'fake',
    kind: 'text',
    providerMessageId: `message-${text}`,
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 1,
    text,
  };
}

const emptyHost = {
  status: () => ({
    conversations: [],
    requestChains: [],
    streamingConversationIds: [],
    pendingApproval: undefined,
  }),
} as unknown as ForgeHostFacade;

interface VoiceToggleState {
  on: boolean;
  setCalls: boolean[];
  setThrows?: Error;
}

function commandContext(
  channel: FakeRemoteChannel,
  store: RemoteRequestStore,
  voiceToggle?: { get: () => boolean; set: (on: boolean) => Promise<void> },
): RemoteCommandContext {
  return {
    channel,
    store,
    host: emptyHost,
    workspaceId: 'ws',
    signal: new AbortController().signal,
    inactivityTimeoutMinutes: 30,
    modelNames: [],
    workspaceAliases: {},
    ...(voiceToggle ? { voiceToggle } : {}),
  };
}

describe('/voice command', () => {
  it('turns spoken replies on and reports the new state', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const state: VoiceToggleState = { on: false, setCalls: [] };
    const ctx = commandContext(channel, store, {
      get: () => state.on,
      set: async (on) => {
        state.setCalls.push(on);
        state.on = on;
      },
    });

    await expect(handleRemoteCommand(textEvent('/voice on'), ctx, 'v-on')).resolves.toEqual({
      kind: 'handled',
    });
    expect(state.setCalls).toEqual([true]);
    expect(state.on).toBe(true);
    expect(channel.sent.at(-1)?.text).toContain('spoken replies ON');
    expect(channel.sent.at(-1)?.text).toContain('config.yaml');
  });

  it('turns spoken replies off and reports the new state', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const state: VoiceToggleState = { on: true, setCalls: [] };
    const ctx = commandContext(channel, store, {
      get: () => state.on,
      set: async (on) => {
        state.setCalls.push(on);
        state.on = on;
      },
    });

    await expect(handleRemoteCommand(textEvent('/voice off'), ctx, 'v-off')).resolves.toEqual({
      kind: 'handled',
    });
    expect(state.setCalls).toEqual([false]);
    expect(channel.sent.at(-1)?.text).toContain('spoken replies OFF');
  });

  it('bare /voice and /voice status report state without mutating', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const state: VoiceToggleState = { on: true, setCalls: [] };
    const ctx = commandContext(channel, store, {
      get: () => state.on,
      set: async (on) => {
        state.setCalls.push(on);
        state.on = on;
      },
    });

    await expect(handleRemoteCommand(textEvent('/voice'), ctx, 'v-bare')).resolves.toEqual({
      kind: 'handled',
    });
    await expect(handleRemoteCommand(textEvent('/voice status'), ctx, 'v-status')).resolves.toEqual({
      kind: 'handled',
    });
    expect(state.setCalls).toEqual([]);
    expect(channel.sent.at(-1)?.text).toContain('spoken replies ON');
  });

  it('rejects an unknown argument with usage', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const state: VoiceToggleState = { on: true, setCalls: [] };
    const ctx = commandContext(channel, store, {
      get: () => state.on,
      set: async (on) => {
        state.setCalls.push(on);
        state.on = on;
      },
    });

    await expect(
      handleRemoteCommand(textEvent('/voice maybe'), ctx, 'v-bogus'),
    ).resolves.toMatchObject({ kind: 'rejected', reason: 'usage: /voice on|off|status' });
    expect(state.setCalls).toEqual([]);
  });

  it('rejects with a clear reason when the toggle is unavailable', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = commandContext(channel, store);

    await expect(
      handleRemoteCommand(textEvent('/voice on'), ctx, 'v-none'),
    ).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'spoken replies are not available in this window',
    });
  });

  it('surfaces a set() failure as a rejected disposition', async () => {
    const store = await requestStore();
    const channel = new FakeRemoteChannel();
    const ctx = commandContext(channel, store, {
      get: () => false,
      set: async () => {
        throw new Error('disk full');
      },
    });

    await expect(
      handleRemoteCommand(textEvent('/voice on'), ctx, 'v-fail'),
    ).resolves.toMatchObject({
      kind: 'rejected',
      reason: 'could not update voice setting: disk full',
    });
  });
});
