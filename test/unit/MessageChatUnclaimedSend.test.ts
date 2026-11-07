/**
 * The unclaimed-send guard: one message per target chat that has not been seen to
 * start, so a supervisor cannot pay for the same report twice.
 *
 * Written against the cause read from source, not against the guess that came
 * first: a send into a chat that is already busy is admitted as a tell at once
 * (`deliverChatMessage`, `backgroundExitNotice.ts:179-181`), so only a send to an
 * **idle** chat can come back unconfirmed, and only when admission is held by
 * `agentLoop.waitForCancelledTurns()` (`SendPipeline.ts:145`,
 * `TurnLifecycle.ts:194-198`) — a cancellation settling in some other chat, not a
 * compaction. These tests therefore drive the guard through a delivery that is
 * held past the 20 s window on purpose, and then settle it late, which is the
 * fact the guard has to react to.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ForgeConversationSummary, ForgeHostStatus } from '../../src/sidebar/ForgeHostFacade';
import type { ChatMessageDelivery } from '../../src/sidebar/backgroundExitNotice';
import type { ForgeConfig } from '../../src/config/types';
import { makeMessageChatTool, type MessageChatSidebar } from '../../src/tools/messageChatTool';
import type { ToolHandlerContext } from '../../src/tools/ToolRegistry';

function conversation(
  id: string,
  title: string,
  activeModel: string | null = 'strata-flash',
): ForgeConversationSummary {
  return {
    id,
    title,
    activeModel,
    archived: false,
    updatedAt: 0,
    requestCount: 0,
    toolCallCount: 0,
    compactCount: 0,
    activeMs: 0,
  };
}

function hostStatus(): ForgeHostStatus {
  return {
    activeConversationId: 'sender',
    conversations: [
      conversation('sender', 'Sender'),
      conversation('running', 'Bug hunt'),
      conversation('idle', 'Release notes', null),
    ],
    requestChains: [],
    streamingConversationIds: ['running'],
  };
}

/** A sidebar whose delivery the test controls one call at a time, so a send can
 *  be left outstanding past the window and settled later on purpose — the real
 *  router resolves at admission, which may come long after the 20 s answer. */
function makeSidebar(status: ForgeHostStatus) {
  const emitHostActivity = vi.fn();
  const deliverChatMessage = vi.fn<
    (text: string, id: string, steer?: boolean) => Promise<ChatMessageDelivery>
  >();
  const sidebar: MessageChatSidebar & {
    deliverChatMessage: typeof deliverChatMessage;
    emitHostActivity: typeof emitHostActivity;
  } = {
    getHostFacade: () => ({
      status: () => status,
      emitHostActivity,
      chatCapBlockers: vi.fn(() => []),
      createConversation: vi.fn(async () => conversation('new-chat', 'Untitled chat')),
      setConversationModel: vi.fn(async (_id: string, _model: string | null) => {}),
      applyAutoTitle: vi.fn(() => false),
      recentExchanges: vi.fn((_id: string, _limit: number) => []),
      clankerMode: () => false,
    }),
    emitHostActivity,
    deliverChatMessage,
  };
  return sidebar;
}

function context(conversationId = 'sender'): ToolHandlerContext {
  return { beforeMutate: vi.fn(), conversationId };
}

function makeTool(
  options: { now?: () => number; config?: ForgeConfig } = {},
): { tool: ReturnType<typeof makeMessageChatTool>; sidebar: ReturnType<typeof makeSidebar> } {
  const sidebar = makeSidebar(hostStatus());
  const tool = makeMessageChatTool({
    getSidebar: () => sidebar,
    ...(options.now ? { now: options.now } : {}),
    ...(options.config ? { getConfig: () => options.config as ForgeConfig } : {}),
  });
  return { tool, sidebar };
}

/** A delivery that never settles on its own, so the 20 s window answers first. */
function heldDelivery(): { promise: Promise<ChatMessageDelivery>; settle: (value: ChatMessageDelivery) => void } {
  let settle!: (value: ChatMessageDelivery) => void;
  const promise = new Promise<ChatMessageDelivery>((resolvePromise) => {
    settle = resolvePromise;
  });
  return { promise, settle };
}

const SEND = { action: 'send', to: 'idle', message: 'report ready' };

describe('message_chat refuses to send the same message twice while the first is unclaimed', () => {
  it('refuses a second send to a chat whose first send has not started, and sends nothing', async () => {
    vi.useFakeTimers();
    try {
      const { tool, sidebar } = makeTool();
      sidebar.deliverChatMessage.mockReturnValue(heldDelivery().promise);
      const first = tool.handler(SEND, context());
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await first).toContain('its turn had not started after 20 s');

      const second = String(await tool.handler(SEND, context()));
      expect(second).toContain('Error: the earlier send has not started yet');
      expect(second).toContain('"Release notes"');
      expect(second).toContain('Do not send it again');
      // A refusal sends nothing and counts against nothing: the guard sits ahead
      // of both the delivery and the counters, so a refused retry is free.
      expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the next send through once the first one is admitted late', async () => {
    vi.useFakeTimers();
    try {
      const { tool, sidebar } = makeTool();
      const { promise, settle } = heldDelivery();
      sidebar.deliverChatMessage.mockReturnValueOnce(promise);
      const first = tool.handler(SEND, context());
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await first).toContain('it may still start');

      // The turn really did start, later than the window guessed: that fact, not
      // the clock, is what releases the guard.
      settle({ kind: 'turn' });
      await vi.advanceTimersByTimeAsync(0);
      sidebar.deliverChatMessage.mockResolvedValueOnce({ kind: 'turn' });
      const second = await tool.handler(
        { action: 'send', to: 'idle', message: 'and here is the diff' },
        context(),
      );
      expect(second).toBe('Delivered to #3 "Release notes" (idle): a turn started there.');
      expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a retry when the outstanding send turns out to have been refused', async () => {
    vi.useFakeTimers();
    try {
      const { tool, sidebar } = makeTool();
      const { promise, settle } = heldDelivery();
      sidebar.deliverChatMessage.mockReturnValueOnce(promise);
      const first = tool.handler(SEND, context());
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await first).toContain('it may still start');

      settle({ kind: 'refused', error: 'the turn ended as cancelled' });
      await vi.advanceTimersByTimeAsync(0);
      sidebar.deliverChatMessage.mockResolvedValueOnce({ kind: 'turn' });
      const retry = await tool.handler(SEND, context());
      expect(retry).toContain('a turn started there');
      expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('expires the mark with the hour, so a stuck attempt cannot block a chat forever', async () => {
    vi.useFakeTimers();
    try {
      let clock = 1_000_000;
      const { tool, sidebar } = makeTool({ now: () => clock });
      sidebar.deliverChatMessage.mockReturnValueOnce(heldDelivery().promise);
      const first = tool.handler(SEND, context());
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await first).toContain('it may still start');

      const refused = await tool.handler(SEND, context());
      expect(refused).toContain('the earlier send has not started yet');

      clock += 60 * 60 * 1000 + 1;
      sidebar.deliverChatMessage.mockResolvedValueOnce({ kind: 'turn' });
      const later = await tool.handler(SEND, context());
      expect(later).toContain('a turn started there');
      // Two calls, not three: the refused attempt in the middle delivered
      // nothing, which is the whole point of putting the guard ahead of the send.
      expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks only the chat still holding the message, not every chat', async () => {
    vi.useFakeTimers();
    try {
      const { tool, sidebar } = makeTool();
      sidebar.deliverChatMessage.mockReturnValueOnce(heldDelivery().promise);
      const first = tool.handler(SEND, context());
      await vi.advanceTimersByTimeAsync(20_000);
      await first;

      sidebar.deliverChatMessage.mockResolvedValueOnce({ kind: 'tell' });
      const other = await tool.handler(
        { action: 'send', to: 'running', message: 'lane 5 here' },
        context(),
      );
      expect(other).toContain('Queued for #2 "Bug hunt" (running): not processed yet');

      sidebar.deliverChatMessage.mockReturnValueOnce(heldDelivery().promise);
      const same = await tool.handler(SEND, context());
      expect(same).toContain('the earlier send has not started yet');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a steer to a chat that still holds an unconfirmed send', async () => {
    vi.useFakeTimers();
    try {
      const config = {
        permissions: { chats: { new_chat: false, steer: true, new_chats_per_hour: 2 } },
      } as unknown as ForgeConfig;
      const { tool, sidebar } = makeTool({ config });
      sidebar.deliverChatMessage.mockReturnValueOnce(heldDelivery().promise);
      const first = tool.handler(SEND, context());
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await first).toContain('it may still start');

      const steered = await tool.handler(
        { action: 'steer', to: 'idle', message: 'stop and read this instead' },
        context(),
      );
      expect(steered).toContain('the earlier send has not started yet');
      expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
