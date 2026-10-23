import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobStore } from '../../src/jobs/JobStore';
import { JobSchema } from '../../src/jobs/jobSchema';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import { handleRemoteJobCommand } from '../../src/remote/RemoteJobCommands';
import { handleRemoteModelCommand } from '../../src/remote/remoteModelCommands';
import { handleRemoteSessionCommand } from '../../src/remote/RemoteSessionCommands';
import { telegramCloseButton } from '../../src/remote/TelegramHelpButtons';
import type { RemoteCommandContext } from '../../src/remote/RemoteCommandHandler';
import type { RemoteInboundEvent } from '../../src/remote/types';

// Every inline card command belongs in this CI-enforced test when a new one is added.
const closeRow = [{ text: '✕ Close', callbackData: 'h:x' }];
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function event(text: string): Extract<RemoteInboundEvent, { kind: 'text' }> {
  return {
    channel: 'telegram', kind: 'text', providerMessageId: text, senderId: '7', chatId: '9',
    chatType: 'private', receivedAt: 1, text,
  };
}

function lastButtons(channel: FakeRemoteChannel) {
  return channel.inlineKeyboards.at(-1)?.buttons ?? channel.inlineEdits.at(-1)?.buttons;
}

function expectClose(channel: FakeRemoteChannel): void {
  expect(lastButtons(channel)?.at(-1)).toEqual(closeRow);
}

describe('Telegram inline card Close row', () => {
  it('adds Close to every listed card and preserves it on in-place refreshes', async () => {
    const channel = new FakeRemoteChannel('telegram');
    channel.declareHtmlSupport();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-card-close-'));
    roots.push(root);
    const jobs = new JobStore(root);
    await jobs.saveJob(JobSchema.parse({
      version: 1, id: 'disk', name: 'Disk', enabled: true, wake: false,
      after: 'stay_awake', schedule: { kind: 'interval', minutes: 15 },
      check: { kind: 'disk_space', path: 'C:\\', min_free_gb: 10 },
      on_change: { kind: 'notify' }, action: null, created_at: 1, updated_at: 1,
    }));
    const context = {
      channel,
      signal: new AbortController().signal,
      store: {
        binding: () => ({ conversationId: 'c1' }),
        queued: () => [], outboxHealth: () => ({ pending: 0, abandoned: 0 }),
        requestHealthForConversation: () => ({ unknown: 0 }),
      },
      host: {
        status: () => ({
          conversations: [{ id: 'c1', title: 'Main', activeModel: 'local', requestCount: 0,
            toolCallCount: 0, compactCount: 0, activeMs: 0 }],
          requestChains: [], streamingConversationIds: [],
        }),
        contextBudget: () => ({ used: 31, max: 100 }),
        contextBreakdown: () => undefined,
        clankerMode: () => false,
        backendProcesses: () => [],
        getAgentLink: () => undefined,
      },
      workspaceId: 'workspace', inactivityTimeoutMinutes: 30, rateLimitPerMinute: 30,
      modelEntries: [], workspaceAliases: {},
    } as unknown as RemoteCommandContext;

    for (const [command, handler] of [
      ['/status', () => handleRemoteSessionCommand('/status', undefined, event('/status'), context)],
      ['/context', () => handleRemoteSessionCommand('/context', undefined, event('/context'), context)],
      ['/system', () => handleRemoteModelCommand('/system', undefined, event('/system'), context)],
      ['/agents', () => handleRemoteSessionCommand('/agents', undefined, event('/agents'), context)],
      ['/queue', () => handleRemoteSessionCommand('/queue', undefined, event('/queue'), context)],
    ] as const) {
      await handler();
      expectClose(channel);
      expect(channel.inlineKeyboards.at(-1)?.text ?? '').toBeTruthy();
      void command;
    }

    const sessionContext = { ...context, telegramEditMessageId: 'queue-card' };
    await handleRemoteSessionCommand('/queue', undefined, event('/queue'), sessionContext);
    expect(channel.inlineEdits.at(-1)?.buttons.at(-1)).toEqual(closeRow);
    await handleRemoteSessionCommand('/agents', undefined, event('/agents'), sessionContext);
    expect(channel.inlineEdits.at(-1)?.buttons.at(-1)).toEqual(closeRow);

    const jobContext = {
      channel, host: {} as never, signal: new AbortController().signal, store: jobs,
      jobsEnabled: true,
    };
    await handleRemoteJobCommand('/jobs', [], event('/jobs'), jobContext);
    expectClose(channel);
    await handleRemoteJobCommand('/jobs', [], event('/jobs'), {
      ...jobContext,
      telegramEditMessageId: 'jobs-card',
    });
    expect(channel.inlineEdits.at(-1)?.buttons.at(-1)).toEqual(closeRow);
    await handleRemoteJobCommand('/jobs', [], event('/jobs'), {
      ...jobContext,
      telegramJobTarget: { index: 0, hash: 'deadbeef', messageId: 'job-card', action: 'show' },
    });
    // The hash must identify the row rendered from this store.
    const { telegramJobHash } = await import('../../src/remote/TelegramJobButtons');
    await handleRemoteJobCommand('/jobs', [], event('/jobs'), {
      ...jobContext,
      telegramJobTarget: { index: 0, hash: telegramJobHash('disk'), messageId: 'job-card', action: 'show' },
    });
    expect(channel.inlineEdits.at(-1)?.buttons.at(-1)).toEqual(closeRow);

    expect(telegramCloseButton()).toEqual(closeRow[0]);
    const deleted: string[] = [];
    const { TelegramHelpMessages } = await import('../../src/remote/TelegramHelpMessages');
    const help = new TelegramHelpMessages({
      sendInlineKeyboard: async () => undefined,
      editInlineKeyboardMessage: async () => undefined,
      deleteMessage: async (_chatId, messageId) => { deleted.push(messageId); },
    });
    await expect(help.handleAction({
      channel: 'telegram', kind: 'help_action', providerMessageId: 'cb', senderId: '7', chatId: '9',
      chatType: 'private', receivedAt: 1, messageId: 'status-card', action: 'close',
    })).resolves.toEqual({ kind: 'handled' });
    expect(deleted).toEqual(['status-card']);
  });
});
