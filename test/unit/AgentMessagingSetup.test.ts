import { describe, expect, it, vi } from 'vitest';
import {
  busModelIds,
  busMessageActivityText,
  interruptForgeForSender,
  resolveBusMessageTarget,
  steerBlockReason,
  stopForgeForSender,
  submitBusMessage,
} from '../../src/vscode/agentBusSubmission';
import { forgeInboundPrompt } from '../../src/agentBus/busContent';
import type { ForgeConfig } from '../../src/config/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';

describe('agent bus conversation targeting', () => {
  it('steers the active conversation for an agent sender', async () => {
    const interrupt = vi.fn(async () => {});
    const facade = {
      status: () => ({
        activeConversationId: 'visible',
        streamingConversationIds: ['visible'],
        requestChains: [],
        conversations: [
          { id: 'visible', title: 'Visible', updatedAt: 2 },
          { id: 'sender-chat', title: 'Codex: task', updatedAt: 1 },
        ],
      }),
      recentExchanges: () => [],
      interrupt,
    } as unknown as ForgeHostFacade;

    await expect(interruptForgeForSender(facade, 'codex')).resolves.toEqual({
      steered: true,
      conversationId: 'visible',
      title: 'Visible',
    });
    expect(interrupt).toHaveBeenCalledExactlyOnceWith('visible');
  });

  it('refuses a steer only for the chat the owner is being asked about', () => {
    const facade = {
      status: () => ({
        activeConversationId: 'visible',
        streamingConversationIds: ['visible'],
        requestChains: [{ conversationId: 'visible', userIntentEpoch: 4 }],
        conversations: [{ id: 'visible', title: 'Visible', updatedAt: 2 }],
        pendingApproval: {
          id: 'a1',
          toolName: 'shell',
          detail: '',
          dangerous: false,
          conversationId: 'other',
        },
      }),
    } as unknown as ForgeHostFacade;
    // A card in a different chat does not stop this one.
    expect(steerBlockReason(facade, 'visible', 'Visible', 4)).toBeUndefined();
    // A card with no chat attached blocks every chat in this window: reading
    // "no card anywhere" from a missing id is the wrong way to be wrong.
    const unowned = {
      status: () => ({
        activeConversationId: 'visible',
        streamingConversationIds: ['visible'],
        requestChains: [],
        conversations: [{ id: 'visible', title: 'Visible', updatedAt: 2 }],
        pendingApproval: { id: 'a1', toolName: 'shell', detail: '', dangerous: false },
      }),
    } as unknown as ForgeHostFacade;
    expect(steerBlockReason(unowned, 'visible', 'Visible')).toContain(
      "waiting for the owner's approval",
    );
  });

  it('refuses a steer written against a chain that has moved on', () => {
    const facade = {
      status: () => ({
        activeConversationId: 'visible',
        streamingConversationIds: ['visible'],
        requestChains: [{ conversationId: 'visible', userIntentEpoch: 9 }],
        conversations: [{ id: 'visible', title: 'Visible', updatedAt: 2 }],
      }),
    } as unknown as ForgeHostFacade;
    expect(steerBlockReason(facade, 'visible', 'Visible', 5)).toContain('different chain');
    expect(steerBlockReason(facade, 'visible', 'Visible', 9)).toBeUndefined();
    // A sender that read no epoch gets no verdict it cannot support.
    expect(steerBlockReason(facade, 'visible', 'Visible')).toBeUndefined();
  });

  it('reports that no turn was stopped when the sender conversation is idle', async () => {
    const interrupt = vi.fn(async () => {});
    const facade = {
      status: () => ({
        activeConversationId: 'visible',
        streamingConversationIds: [],
        requestChains: [],
        conversations: [{ id: 'visible', title: 'Visible', updatedAt: 2 }],
      }),
      recentExchanges: () => [],
      interrupt,
    } as unknown as ForgeHostFacade;

    await expect(interruptForgeForSender(facade, 'codex')).resolves.toMatchObject({
      steered: false,
      reason: expect.stringContaining('not streaming'),
    });
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('stops the explicitly resolved chat through cancel without interrupting it', async () => {
    const cancel = vi.fn(async () => {});
    const interrupt = vi.fn(async () => {});
    const facade = {
      status: () => ({
        activeConversationId: 'visible',
        streamingConversationIds: ['target-chat'],
        conversations: [
          { id: 'visible', title: 'Visible', updatedAt: 2 },
          { id: 'target-chat', title: 'Target', updatedAt: 1 },
        ],
      }),
      recentExchanges: () => [],
      cancel,
      interrupt,
    } as unknown as ForgeHostFacade;

    await expect(stopForgeForSender(facade, 'codex', 'target-chat')).resolves.toEqual({
      ok: true,
      conversationId: 'target-chat',
      title: 'Target',
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith('target-chat');
    expect(interrupt).not.toHaveBeenCalled();
  });

  // Audit F5: `POST /agent/stop` did not answer within the caller's 20-second
  // bound while a delegated Codex request was in flight, and the chat stayed
  // busy. `facade.cancel` awaits the turn *settling* — `TurnLifecycle.stopStreaming`
  // waits on the promise a turn resolves when it unwinds — so a tool that does
  // not honor its abort holds the HTTP response open with it. The abort itself
  // is synchronous, and it is the whole of what Stop can promise, so the route
  // answers once it is signalled and lets the turn unwind at its own speed.
  it('answers a stop once the abort is signalled, not once the turn unwinds', async () => {
    let settleTurn!: () => void;
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleTurn = resolve;
        }),
    );
    const facade = {
      status: () => ({
        activeConversationId: 'visible',
        streamingConversationIds: ['target-chat'],
        conversations: [
          { id: 'visible', title: 'Visible', updatedAt: 2 },
          { id: 'target-chat', title: 'Target', updatedAt: 1 },
        ],
      }),
      recentExchanges: () => [],
      cancel,
      interrupt: vi.fn(async () => {}),
    } as unknown as ForgeHostFacade;

    const startedAt = Date.now();
    const stop = stopForgeForSender(facade, 'codex', 'target-chat');
    const outcome = await Promise.race([
      stop,
      new Promise((resolve) => setTimeout(() => resolve('STILL WAITING'), 2_000)),
    ]);
    expect(outcome).not.toBe('STILL WAITING');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(cancel).toHaveBeenCalledExactlyOnceWith('target-chat');
    settleTurn();
    await expect(stop).resolves.toEqual({
      ok: true,
      conversationId: 'target-chat',
      title: 'Target',
    });
  });

  it.each([
    { options: { from: 'codex' }, conversationId: 'visible', creates: 0, restores: 0 },
    {
      options: { from: 'codex', newChat: true },
      conversationId: 'new-chat',
      creates: 1,
      restores: 0,
    },
  ])(
    'routes the bus message to $conversationId',
    async ({ options, conversationId, creates, restores }) => {
      const createConversation = vi.fn(async () => ({ id: 'new-chat' }) as never);
      const restoreConversation = vi.fn(async () => ({}) as never);
      const send = vi.fn(async () => ({ kind: 'completed' as const }));
      const facade = {
        status: () => ({
          activeConversationId: 'visible',
          conversations: [
            { id: 'visible', title: 'Visible', updatedAt: 2 },
            { id: 'sender-chat', title: 'Codex: task', updatedAt: 1 },
          ],
        }),
        recentExchanges: () => [],
        createConversation,
        restoreConversation,
        send,
      } as unknown as ForgeHostFacade;
      await expect(submitBusMessage(facade, 'hello', options)).resolves.toEqual({
        kind: 'completed',
      });
      expect(createConversation).toHaveBeenCalledTimes(creates);
      expect(restoreConversation).toHaveBeenCalledTimes(restores);
      if ('newChat' in options) expect(createConversation).toHaveBeenCalledWith({ activate: true });
      else expect(restoreConversation).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(conversationId, 'hello');
    },
  );

  it('mirrors an inbound agent message to the active host activity chat', async () => {
    const emitHostActivity = vi.fn();
    const facade = {
      status: () => ({
        activeConversationId: 'visible',
        conversations: [{ id: 'visible', title: 'Visible', updatedAt: 1 }],
      }),
      recentExchanges: () => [],
      restoreConversation: vi.fn(async () => ({}) as never),
      send: vi.fn(async () => ({ kind: 'completed' as const })),
      emitHostActivity,
    } as unknown as ForgeHostFacade;

    await submitBusMessage(facade, forgeInboundPrompt('codex', 'Please review the patch.'), {
      from: 'codex',
    });

    expect(emitHostActivity).toHaveBeenCalledWith({
      conversationId: 'visible',
      text: 'Forge: codex says:\n\nPlease review the patch.',
    });
  });

  it('uses the shared activity text for a sender message sent to an idle chat', async () => {
    const sender = {
      kind: 'codex' as const,
      sessionId: '00000000-0000-4000-8000-000000000081',
      title: 'Codex review',
    };
    const prompt = forgeInboundPrompt('codex', 'Review the diff.', sender);
    const emitHostActivity = vi.fn();
    const send = vi.fn(async () => ({ kind: 'completed' as const, finalText: 'looks good' }));
    const facade = {
      status: () => ({
        activeConversationId: 'visible',
        conversations: [{ id: 'visible', title: 'Visible', updatedAt: 1 }],
      }),
      recentExchanges: () => [],
      send,
      emitHostActivity,
    } as unknown as ForgeHostFacade;

    await submitBusMessage(facade, prompt, { from: 'codex', sender });

    expect(send).toHaveBeenCalledWith('visible', prompt, undefined, { sender });
    expect(emitHostActivity).toHaveBeenCalledWith({
      conversationId: 'visible',
      suppressProgress: true,
      text: busMessageActivityText(prompt, sender),
    });
    expect(busMessageActivityText(prompt, sender)).toBe(
      'Codex (Codex review) says: Review the diff.',
    );
  });
});

describe('a --new without --model uses the configured default', () => {
  const makeFacade = (activeModel: string | null) => {
    const setConversationModel = vi.fn(async () => {});
    // Like the real host, creating a chat activates it, on the stale default.
    let activeConversationId = 'visible';
    const facade = {
      status: () => ({
        activeConversationId,
        conversations: [
          { id: 'visible', title: 'Visible', activeModel },
          { id: 'new-chat', title: 'New', activeModel: 'stale-default' },
        ],
      }),
      recentExchanges: () => [],
      createConversation: vi.fn(async () => {
        activeConversationId = 'new-chat';
        return { id: 'new-chat', activeModel: 'configured-default' };
      }),
      restoreConversation: vi.fn(async () => ({})),
      setConversationModel,
      send: vi.fn(async () => ({ kind: 'completed' as const })),
    } as unknown as ForgeHostFacade;
    return { facade, setConversationModel };
  };

  it('keeps a --new chat on the configured default when no --model is given', async () => {
    const { facade, setConversationModel } = makeFacade('tensor-vision');
    await submitBusMessage(facade, 'hello', { from: 'codex', newChat: true });
    expect(setConversationModel).not.toHaveBeenCalled();
  });

  it('leaves a --new chat on the default when the active conversation has no model', async () => {
    const { facade, setConversationModel } = makeFacade(null);
    await submitBusMessage(facade, 'hello', { from: 'codex', newChat: true });
    expect(setConversationModel).not.toHaveBeenCalled();
  });

  it('an explicit --model overrides the configured default for the new chat', async () => {
    const { facade, setConversationModel } = makeFacade('tensor-vision');
    await submitBusMessage(facade, 'hello', {
      from: 'codex',
      newChat: true,
      model: 'chosen-model',
    });
    expect(setConversationModel).toHaveBeenCalledWith('new-chat', 'chosen-model');
  });

  it('two --new messages keep the configured default under the creation lock', async () => {
    let activeConversationId = 'visible';
    let created = 0;
    const models = new Map<string, string | null>([
      ['visible', 'tensor-vision'],
      ['gone', 'configured-default'],
    ]);
    const pinned: [string, string][] = [];
    const facade = {
      status: () => ({
        activeConversationId,
        conversations: [...models].map(([id, activeModel]) => ({
          id,
          title: id,
          updatedAt: 1,
          activeModel,
        })),
      }),
      recentExchanges: () => [],
      // Like the real host: creating activates a tab already pinned to the
      // configured default, and activation lands before the create resolves.
      createConversation: vi.fn(async () => {
        const id = `new-${++created}`;
        models.set(id, 'configured-default');
        activeConversationId = id;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { id } as never;
      }),
      setConversationModel: vi.fn(async (id: string, model: string) => {
        models.set(id, model);
        pinned.push([id, model]);
      }),
      send: vi.fn(async () => ({ kind: 'completed' as const })),
    } as unknown as ForgeHostFacade;
    await Promise.all([
      submitBusMessage(facade, 'a', { from: 'claude', newChat: true }),
      submitBusMessage(facade, 'b', { from: 'codex', newChat: true }),
    ]);
    expect(created).toBe(2); // two chats, not one chat twice
    expect(pinned).toEqual([]);
  });
});

describe('--unattended', () => {
  const makeFacade = (seen: boolean[]) =>
    ({
      status: () => ({ activeConversationId: 'visible', conversations: [{ id: 'visible', title: 'V' }] }),
      recentExchanges: () => [],
      restoreConversation: vi.fn(async () => ({})),
      send: vi.fn(async (id: string) => {
        seen.push(unattendedConversations.has(id));
        return { kind: 'completed' as const };
      }),
    }) as unknown as ForgeHostFacade;

  it('marks the chat unattended for exactly its own turn', async () => {
    const seen: boolean[] = [];
    await submitBusMessage(makeFacade(seen), 'audit', { from: 'codex', targetConversationId: 'visible', unattended: true });
    expect(unattendedConversations.has('visible')).toBe(false);
    await submitBusMessage(makeFacade(seen), 'hello', { from: 'codex', targetConversationId: 'visible' });
    expect(seen).toEqual([true, false]);
  });
});

describe('busModelIds', () => {
  it('accepts each model and every model@profile it offers', () => {
    const config = {
      models: [{ name: 'qwen', profiles: ['main'] }, { name: 'gemma' }],
      profiles: { main: {}, fast: {} },
    } as unknown as ForgeConfig;
    expect(busModelIds(config)).toEqual(['qwen', 'qwen@main', 'gemma', 'gemma@main', 'gemma@fast']);
  });

  it('accepts alias keys', () => {
    const config = {
      models: [{ name: 'qwen-vision' }],
      profiles: {},
      aliases: { qwen: 'qwen-vision' },
    } as unknown as ForgeConfig;
    expect(busModelIds(config)).toEqual(['qwen-vision', 'qwen']);
  });
});

describe('--to with an exchange id', () => {
  const facade = {
    status: () => ({
      activeConversationId: 'chat-1',
      streamingConversationIds: [],
      conversations: [{ id: 'chat-1', title: 'Claude: test', updatedAt: 1 }],
    }),
    recentExchanges: () => [],
  } as unknown as ForgeHostFacade;
  const ledger = (id: string): string | undefined => (id === 'ex-9' ? 'chat-1' : undefined);

  it('names the chat the exchange belongs to instead of "no longer open"', () => {
    expect(resolveBusMessageTarget(facade, 'claude', { conversationId: 'ex-9' }, ledger)).toEqual({
      ok: false,
      status: 404,
      error: '"ex-9" is an exchange id, not a chat id: its chat is --to chat-1',
    });
  });

  it('still says "no longer open" for an id the ledger does not know', () => {
    expect(resolveBusMessageTarget(facade, 'claude', { conversationId: 'gone' }, ledger)).toEqual({
      ok: false,
      status: 404,
      error: 'Forge chat "gone" is no longer open',
    });
  });
});
