import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn() },
  window: {
    createOutputChannel: () => ({
      appendLine: () => undefined,
      clear: () => undefined,
      show: () => undefined,
      dispose: () => undefined,
    }),
  },
}));

import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { ForgeHostFacade, ForgeConversationSummary } from '../../src/sidebar/ForgeHostFacade';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import { ToolApprovalService } from '../../src/sidebar/ToolApprovalService';
import { chatClankerRecords } from '../../src/sidebar/chatClanker';
import { armBusChat, openBusChat, submitBusMessage } from '../../src/vscode/agentBusSubmission';

function summary(id: string, clanker = false): ForgeConversationSummary {
  return {
    id,
    title: id,
    activeModel: null,
    archived: false,
    updatedAt: 0,
    requestCount: 0,
    toolCallCount: 0,
    compactCount: 0,
    activeMs: 0,
    clanker,
  };
}

function fixture() {
  const chats = new Map<string, ConversationRuntime>();
  const posted: HostToWebview[] = [];
  const notices: Array<{ id: string; message: string }> = [];
  const order: string[] = [];
  const approvals = new ToolApprovalService(
    (message) => posted.push(message),
    () => undefined,
    undefined,
    undefined,
    chatClankerRecords((id) => chats.get(id)),
  );
  let nextId = 0;
  const setConversationModel = vi.fn(async () => {
    order.push('pin');
  });
  const send = vi.fn(async (id: string) => {
    order.push('send');
    return approvals.request('write_file', 'workspace-external write', false, id).then((result) => {
      expect(result).toBe('approved');
      return { kind: 'completed' as const };
    });
  });
  const facade = {
    createConversation: vi.fn(async () => {
      const id = `bus-${++nextId}`;
      chats.set(id, {
        id,
        title: id,
        createdAt: 0,
        updatedAt: 0,
        messages: [],
      } as ConversationRuntime);
      order.push('create');
      return summary(id);
    }),
    setConversationModel,
    setClankerMode: vi.fn((id: string, enabled: boolean) => {
      order.push('arm');
      approvals.setClankerMode(id, enabled);
    }),
    showConversationNotice: vi.fn((id: string, message: string) => {
      order.push('notice');
      notices.push({ id, message });
    }),
    restoreConversation: vi.fn(async (id: string) => summary(id, chats.get(id)?.clanker === true)),
    send,
    status: vi.fn(() => ({
      activeConversationId: `bus-${nextId}`,
      conversations: [...chats.keys()].map((id) => summary(id, chats.get(id)?.clanker === true)),
      requestChains: [],
      streamingConversationIds: [],
      modelDemandConversationIds: [],
    })),
  } as unknown as ForgeHostFacade;
  return { facade, chats, posted, notices, order, setConversationModel, send };
}

const notice = (sender: string) =>
  `Clanker is on: ${sender} started this chat over the agent bus. Clanker still asks you before destructive actions, Forge guard files, skill writes, and a secret read followed by egress. Turn it off with /clanker.`;

describe('bus-opened Clanker chats', () => {
  it.each(['claude', 'codex'])('arms a --new chat from %s before its first turn', async (sender) => {
    const state = fixture();

    await submitBusMessage(state.facade, 'first prompt', {
      newChat: true,
      from: sender,
      model: 'qwen',
    });

    const chat = state.chats.get('bus-1');
    expect(chat?.clanker).toBe(true);
    expect(state.notices[0]?.id).toBe('bus-1');
    expect(state.notices[0]?.message).toBe(notice(sender));
    expect(state.posted).toContainEqual({
      type: 'clankerChanged',
      enabled: true,
      conversationId: 'bus-1',
    });
    expect(state.order).toEqual(['create', 'pin', 'arm', 'notice', 'send']);
    expect(state.posted.some((message) => message.type === 'confirmRequest')).toBe(false);
  });

  it('does not change Clanker when a bus message targets an existing chat', async () => {
    const state = fixture();
    state.chats.set('off', {
      id: 'off',
      title: 'off',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
      clanker: false,
    } as ConversationRuntime);
    state.chats.set('on', {
      id: 'on',
      title: 'on',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
      clanker: true,
    } as ConversationRuntime);
    state.send.mockImplementation(async () => ({ kind: 'completed' as const }));

    await submitBusMessage(state.facade, 'follow up', {
      from: 'claude',
      targetConversationId: 'off',
    });
    await submitBusMessage(state.facade, 'follow up', {
      from: 'claude',
      targetConversationId: 'on',
    });

    expect(state.chats.get('off')?.clanker).toBe(false);
    expect(state.chats.get('on')?.clanker).toBe(true);
    expect(state.facade.setClankerMode).not.toHaveBeenCalled();
    expect(state.notices).toEqual([]);
  });

  it('does not arm or announce a chat when pinning its model fails', async () => {
    const state = fixture();
    state.setConversationModel.mockRejectedValueOnce(new Error('pin failed'));

    await expect(openBusChat(state.facade, { sender: 'claude', model: 'missing' })).resolves.toEqual({
      ok: false,
      id: 'bus-1',
      error: 'pin failed',
    });

    expect(state.chats.get('bus-1')?.clanker).toBeUndefined();
    expect(state.facade.setClankerMode).not.toHaveBeenCalled();
    expect(state.notices).toEqual([]);
  });

  it('arms Clanker and announces it when armBusChat runs on its own', async () => {
    // A `--new` from a linked session opens its chat through the agent-link path
    // and calls nothing but this, so the arm and the notice must come from here.
    const state = fixture();
    const created = await state.facade.createConversation({ activate: true });

    armBusChat(state.facade, created.id, 'codex');

    expect(state.chats.get(created.id)?.clanker).toBe(true);
    expect(state.facade.setClankerMode).toHaveBeenCalledWith(created.id, true);
    expect(state.notices[0]?.id).toBe(created.id);
    expect(state.notices[0]?.message).toBe(notice('codex'));
    expect(state.posted).toContainEqual({
      type: 'clankerChanged',
      enabled: true,
      conversationId: created.id,
    });
  });
});
