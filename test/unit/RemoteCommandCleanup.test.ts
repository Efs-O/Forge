import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { RemoteAuth } from '../../src/remote/RemoteAuth';
import { RemoteController } from '../../src/remote/RemoteController';
import { RemoteRequestStore } from '../../src/remote/RemoteRequestStore';
import {
  buildRemoteControllerOptions,
  type RemoteControllerOptions,
} from '../../src/remote/remoteControllerOptions';
import type { RemoteInboundEvent } from '../../src/remote/types';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ForgeConfig } from '../../src/config/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const directory of tempDirs.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

class MemorySecrets {
  readonly values = new Map<string, string>();
  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

async function store(): Promise<RemoteRequestStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cleanup-test-'));
  tempDirs.push(directory);
  const result = new RemoteRequestStore(path.join(directory, 'state.json'));
  await result.load();
  return result;
}

/** A schema-valid config whose only variable is the cleanup delay. */
function configWith(delay: number): ForgeConfig {
  return ForgeConfigSchema.parse({
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
    remote: { enabled: true, telegram: { enabled: true }, delete_command_messages_after: delay },
  });
}

function host(overrides: Partial<ForgeHostFacade> = {}): ForgeHostFacade {
  return {
    createConversation: async () => ({ id: 'c1', title: 'Remote', activeModel: 'local', archived: false }),
    restoreConversation: async () => undefined,
    send: async () => ({ kind: 'completed' as const, finalText: 'ok' }),
    cancel: async () => undefined,
    addApprovalSink: () => ({ dispose: () => undefined }),
    addQuestionSink: () => ({ dispose: () => undefined }),
    answerQuestion: () => false,
    setClankerMode: () => undefined,
    status: () => ({
      activeConversationId: '',
      conversations: [],
      requestChains: [],
      streamingConversationIds: [],
      pendingApproval: undefined,
    }),
    ...overrides,
  } as unknown as ForgeHostFacade;
}

function textEvent(
  text: string,
  overrides: Partial<Extract<RemoteInboundEvent, { kind: 'text' }>> = {},
): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return {
    channel: 'fake',
    kind: 'text',
    providerMessageId: 'msg-1',
    senderId: 'owner',
    chatId: 'chat',
    chatType: 'private',
    receivedAt: 1,
    text,
    ...overrides,
  };
}

interface Harness {
  channel: FakeRemoteChannel;
  controller: RemoteController;
  onError: ReturnType<typeof vi.fn>;
}

async function buildController(
  deleteCommandMessagesAfter: number | undefined,
  hostOverrides: Partial<ForgeHostFacade> = {},
  optionsOverrides: Partial<RemoteControllerOptions> = {},
): Promise<Harness> {
  const channel = new FakeRemoteChannel();
  // Enroll the owner directly (no TOTP), so the session gate is `authorized`.
  const secrets = new MemorySecrets();
  secrets.values.set('forge.remote.fake.ownerId', 'owner');
  const auth = new RemoteAuth(secrets as unknown as vscode.SecretStorage);
  const requestStore = await store();
  const onError = vi.fn();
  const controller = new RemoteController(channel, requestStore, auth, host(hostOverrides), {
    workspaceId: 'workspace',
    queueLimit: 5,
    maxMessageChars: 12_000,
    rateLimitPerMinute: 60,
    onError,
    ...(deleteCommandMessagesAfter === undefined
      ? {}
      : { deleteCommandMessagesAfter }),
    ...optionsOverrides,
  });
  await controller.start();
  return { channel, controller, onError };
}

describe('RemoteController command auto-cleanup', () => {
  it('deletes a handled command after the configured delay', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(5);
    try {
      const disposition = await controller.handle(textEvent('/clanker off'));
      expect(disposition).toEqual({ kind: 'handled' });
      // Before the delay elapses, nothing is deleted.
      await vi.advanceTimersByTimeAsync(4_999);
      expect(channel.deleted).toEqual([]);
      // At the delay, the owner's original command message is deleted.
      await vi.advanceTimersByTimeAsync(1);
      expect(channel.deleted).toEqual([{ chatId: 'chat', messageId: 'msg-1' }]);
      // The reply is sent, not deleted: only the owner's command message goes.
      expect(channel.sent.some((m) => m.text.startsWith('Forge: clanker mode OFF'))).toBe(true);
    } finally {
      await controller.stop();
    }
  });

  it('deletes a rejected command (bad argument) after the delay', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(5);
    try {
      const disposition = await controller.handle(textEvent('/clanker bogus'));
      expect(disposition).toMatchObject({ kind: 'rejected' });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(channel.deleted).toEqual([{ chatId: 'chat', messageId: 'msg-1' }]);
    } finally {
      await controller.stop();
    }
  });

  it('deletes an unknown slash command (handler rejects it) after the delay', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(5);
    try {
      const disposition = await controller.handle(textEvent('/definitely-not-a-command'));
      expect(disposition).toMatchObject({ kind: 'rejected' });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(channel.deleted).toEqual([{ chatId: 'chat', messageId: 'msg-1' }]);
    } finally {
      await controller.stop();
    }
  });

  it('deletes the inline /lock command after the delay', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(5);
    try {
      const disposition = await controller.handle(textEvent('/lock'));
      expect(disposition).toEqual({ kind: 'handled' });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(channel.deleted).toEqual([{ chatId: 'chat', messageId: 'msg-1' }]);
    } finally {
      await controller.stop();
    }
  });

  it('does not delete when the delay is 0 (disabled)', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(0);
    try {
      const disposition = await controller.handle(textEvent('/clanker off'));
      expect(disposition).toEqual({ kind: 'handled' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(channel.deleted).toEqual([]);
    } finally {
      await controller.stop();
    }
  });

  it('never deletes a normal (non-command) message', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(5);
    try {
      const disposition = await controller.handle(textEvent('just a normal prompt'));
      // A normal message is admitted as a prompt, not a command.
      expect(['accepted', 'queued']).toContain(disposition.kind);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(channel.deleted).toEqual([]);
    } finally {
      await controller.stop();
    }
  });

  it('does not schedule a delete for a command that failed to process', async () => {
    vi.useFakeTimers();
    // host.status() throws, so /status rejects the command handler. The throw
    // propagates out of handle() (the poll loop turns it into a `retry`), and
    // because it happens before scheduleCommandCleanup is reached, no delete is
    // armed for a command that was never processed.
    const { channel, controller } = await buildController(5, {
      status: () => {
        throw new Error('status unavailable');
      },
    });
    try {
      await expect(controller.handle(textEvent('/status'))).rejects.toThrow('status unavailable');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(channel.deleted).toEqual([]);
    } finally {
      await controller.stop();
    }
  });

  it('reports a delete failure via onError without changing the disposition', async () => {
    vi.useFakeTimers();
    const { channel, controller, onError } = await buildController(5);
    channel.deleteMessage = async () => {
      throw new Error('delete failed');
    };
    try {
      const disposition = await controller.handle(textEvent('/clanker off'));
      expect(disposition).toEqual({ kind: 'handled' });
      await vi.advanceTimersByTimeAsync(5_000);
      // The delete rejection is handled in a microtask; flush it before asserting.
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toContain('command auto-delete failed');
    } finally {
      await controller.stop();
    }
  });

  it('a throwing onError does not escape the timer as an unhandled rejection', async () => {
    vi.useFakeTimers();
    // A broken reporter: the delete fails AND onError itself throws. Neither
    // may escape the timer as an unhandled rejection.
    const { channel, controller } = await buildController(5, {}, {
      onError: () => {
        throw new Error('reporter is broken');
      },
    });
    channel.deleteMessage = async () => {
      throw new Error('delete failed');
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const disposition = await controller.handle(textEvent('/clanker off'));
      expect(disposition).toEqual({ kind: 'handled' });
      // Let the timer fire and the detached async work settle.
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);
      // The delete was attempted; the command disposition was unaffected.
      expect(channel.deleted).toEqual([]);
      // And nothing escaped the timer as an unhandled rejection.
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await controller.stop();
    }
  });

  it('does not schedule a delete for a pre-execution length rejection', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(5);
    try {
      // maxMessageChars is 12_000; an over-long command is rejected before it
      // reaches the command handler, so no cleanup may be armed.
      const disposition = await controller.handle(textEvent('/clanker ' + 'x'.repeat(12_001)));
      expect(disposition).toMatchObject({ kind: 'rejected' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(channel.deleted).toEqual([]);
    } finally {
      await controller.stop();
    }
  });

  it('issues at most one delete for duplicate delivery of the same command', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(5);
    try {
      await controller.handle(textEvent('/clanker off'));
      // The same update is redelivered (same providerMessageId).
      await controller.handle(textEvent('/clanker off'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(channel.deleted).toEqual([{ chatId: 'chat', messageId: 'msg-1' }]);
    } finally {
      await controller.stop();
    }
  });

  it('stop() before expiry cancels a pending delete', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(5);
    await controller.handle(textEvent('/clanker off'));
    await controller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(channel.deleted).toEqual([]);
  });

  it('does not schedule a delete for a retry-producing command', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(5);
    try {
      // A bound conversation whose durable admission fails: /resume routes
      // through admitRemotePrompt, which returns `retry` when enqueue throws.
      await controller['store'].setBinding({
        channel: 'fake',
        chatId: 'chat',
        workspaceId: 'workspace',
        conversationId: 'c1',
      });
      vi.spyOn(controller['store'], 'enqueue').mockRejectedValue(new Error('disk full'));
      const disposition = await controller.handle(textEvent('/resume'));
      expect(disposition).toMatchObject({ kind: 'retry' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(channel.deleted).toEqual([]);
    } finally {
      await controller.stop();
    }
  });

  it('does not schedule a delete for a /steer prompt', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(5);
    try {
      // /steer is prompt admission, not a command: isRemoteCommand is false for
      // it, so it takes the admitRemoteText path and never reaches the cleanup
      // scheduler. Its disposition is accepted/queued, not handled/rejected.
      const disposition = await controller.handle(textEvent('/steer do the thing'));
      expect(['accepted', 'queued']).toContain(disposition.kind);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(channel.deleted).toEqual([]);
    } finally {
      await controller.stop();
    }
  });

  it('does not schedule a delete for selection or approval actions', async () => {
    vi.useFakeTimers();
    const { channel, controller } = await buildController(5);
    try {
      // Both return before the command branch: selection via the pager, action
      // via the stale-approval guard. Neither path may arm a delete.
      const selection = await controller.handle({
        channel: 'fake',
        kind: 'selection',
        providerMessageId: 'sel-1',
        senderId: 'owner',
        chatId: 'chat',
        chatType: 'private',
        receivedAt: 1,
        selectionKind: 'models',
        selectionToken: 'abcdefghijklmnop',
        action: 'show',
        messageId: 'm1',
      });
      expect(selection.kind).toBe('rejected');
      const action = await controller.handle({
        channel: 'fake',
        kind: 'action',
        providerMessageId: 'act-1',
        senderId: 'owner',
        chatId: 'chat',
        chatType: 'private',
        receivedAt: 1,
        action: 'approve',
        correlationId: 'no-such-gate',
      });
      expect(action.kind).toBe('rejected');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(channel.deleted).toEqual([]);
    } finally {
      await controller.stop();
    }
  });

  it('picks up a rebuilt option on config reload (5 -> 0 disables new commands)', async () => {
    vi.useFakeTimers();
    // The same deps bundle RemoteRuntime hands to the options builder; the
    // builder is the seam updateActiveOptions uses, so exercising it proves the
    // config->option mapping, not just a hand-built option object.
    const deps = {
      workspaceId: 'workspace',
      onError: () => undefined,
      voiceOutputEnabled: () => false,
      setVoiceOutput: async () => undefined,
      hasConfigPath: false,
      switchWorkspace: async () => undefined,
    };
    const { channel, controller } = await buildController(
      5,
      {},
      buildRemoteControllerOptions(configWith(5), deps),
    );
    try {
      // A command received before the reload is armed with the old delay and
      // still fires — that is expected. The point is that a command received
      // AFTER the reload reads the rebuilt option (0) and is not deleted.
      await controller.handle(textEvent('/clanker off'));
      // RemoteRuntime.updateActiveOptions does exactly this: rebuild options via
      // buildRemoteControllerOptions and hand them to the live controller. The
      // cleanup delay is read at schedule time, so a reload from 5 to 0 must stop
      // subsequent commands from being deleted without a window reload.
      controller.updateOptions(buildRemoteControllerOptions(configWith(0), deps));
      await controller.handle(textEvent('/clanker on', { providerMessageId: 'msg-2' }));
      await vi.advanceTimersByTimeAsync(60_000);
      // Only the pre-reload command (msg-1) was deleted; the post-reload one
      // (msg-2) was not, proving the active controller saw the rebuilt option.
      expect(channel.deleted).toEqual([{ chatId: 'chat', messageId: 'msg-1' }]);
    } finally {
      await controller.stop();
    }
  });
});
