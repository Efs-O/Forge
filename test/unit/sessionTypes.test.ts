import type { Memento } from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  chatMessagesFromSlim,
  createDefaultSession,
  deriveTitle,
  displayPersistMessages,
  historyMetasFromSession,
  HISTORY_KEY_LEGACY,
  loadSidebarSession,
  runtimeToPersisted,
  SESSION_KEY_V1,
  sidebarSessionPersistedSchema,
  slimPersistMessages,
  upsertHistoryConversation,
} from '../../src/sidebar/sessionTypes';
import type { ChatMessage } from '../../src/llm/types';

function makeMemento(store: Record<string, unknown>): Memento {
  return {
    get: <T>(key: string, defaultValue?: T) => {
      const v = store[key];
      return v !== undefined ? (v as T) : defaultValue;
    },
    keys: () => [],
    update: (key: string, value: unknown) => {
      if (value === undefined) delete store[key];
      else store[key] = value;
    },
    setKeysForSync: () => {},
  } as unknown as Memento;
}

describe('sessionTypes', () => {
  it('deriveTitle truncates long first lines', () => {
    expect(deriveTitle('hello')).toBe('hello');
    const long = 'x'.repeat(60);
    expect(deriveTitle(long)).toMatch(/…$/);
    expect(deriveTitle(long).length).toBeLessThanOrEqual(49);
  });

  it('sidebarSessionPersistedSchema rejects invalid payloads', () => {
    expect(sidebarSessionPersistedSchema.safeParse(null).success).toBe(false);
    expect(sidebarSessionPersistedSchema.safeParse({}).success).toBe(false);
  });

  const toolCall = {
    id: 'call_1',
    type: 'function' as const,
    function: { name: 'ask_local_agent', arguments: '{}' },
  };

  // Tool activity used to be dropped at write time, so a reloaded conversation
  // showed no trace that the agent had called anything at all.
  it('slimPersistMessages retains tool_calls turns and tool results', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'ignored' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', content: 'result', tool_call_id: 'call_1', name: 'ask_local_agent' },
      { role: 'assistant', content: 'bye', reasoning: 'thoughts' },
    ];
    expect(slimPersistMessages(messages)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', content: 'result', tool_call_id: 'call_1', name: 'ask_local_agent' },
      { role: 'assistant', content: 'bye', reasoning: 'thoughts' },
    ]);
  });

  it('slimPersistMessages drops system and contentless turns with no tool_calls', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: null, tool_calls: [] },
    ];
    expect(slimPersistMessages(messages)).toEqual([]);
  });

  it('displayPersistMessages drops tool results and contentless tool-call turns', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', content: 'result', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'bye' },
    ];
    expect(displayPersistMessages(messages)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'bye' },
    ]);
  });

  // Each round of a multi-round turn owns a reasoning bubble. Dropping the
  // reasoning-bearing tool-call turns collapsed them all to the final round's
  // the moment the turn ended and SESSION_SYNC rebuilt the transcript.
  it('displayPersistMessages keeps a reasoning-only tool-call turn as an empty-content row', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [toolCall], reasoning: 'round 1 thinking' },
      { role: 'tool', content: 'result', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'done', reasoning: 'round 2 thinking' },
    ];
    expect(displayPersistMessages(messages)).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', reasoning: 'round 1 thinking' },
      { role: 'assistant', content: 'done', reasoning: 'round 2 thinking' },
    ]);
  });

  it('displayPersistMessages never emits null content to the webview', () => {
    const rows = displayPersistMessages([
      { role: 'assistant', content: null, tool_calls: [toolCall], reasoning: 'r' },
    ]);
    expect(rows.every((r) => typeof r.content === 'string')).toBe(true);
  });

  it('chatMessagesFromSlim restores tool fields for the agent loop', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', content: 'result', tool_call_id: 'call_1', name: 'ask_local_agent' },
    ];
    expect(chatMessagesFromSlim(slimPersistMessages(messages))).toEqual(messages);
  });

  it('round-trips the compaction window through persistence', () => {
    const s = createDefaultSession();
    s.conversations[0]!.messages.push(
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    );
    s.conversations[0]!.compaction = { summary: 'earlier work', fromIndex: 2 };

    const persisted = runtimeToPersisted(s);
    expect(persisted.conversations[0]!.compaction).toEqual({
      summary: 'earlier work',
      fromIndex: 2,
    });
    expect(sidebarSessionPersistedSchema.safeParse(persisted).success).toBe(true);

    const store: Record<string, unknown> = { [SESSION_KEY_V1]: persisted };
    const restored = loadSidebarSession(makeMemento(store));
    expect(restored.conversations[0]!.compaction).toEqual({
      summary: 'earlier work',
      fromIndex: 2,
    });
    // The transcript itself must come back whole — compaction is not a deletion.
    expect(restored.conversations[0]!.messages).toHaveLength(2);
  });

  // Records written before the schema widened must still load.
  it('sidebarSessionPersistedSchema accepts pre-migration records', () => {
    const legacy = {
      activeConversationId: 'c1',
      conversations: [
        {
          id: 'c1',
          title: 'Chat',
          createdAt: 1,
          updatedAt: 2,
          messages: [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'yo', reasoning: 'r' },
          ],
        },
      ],
    };
    const parsed = sidebarSessionPersistedSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(chatMessagesFromSlim(parsed.data!.conversations[0]!.messages)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo', reasoning: 'r' },
    ]);
  });

  it('runtimeToPersisted round-trips slim messages', () => {
    const s = createDefaultSession();
    s.conversations[0].messages.push(
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b', reasoning: 'c' },
    );
    const parsed = sidebarSessionPersistedSchema.parse(runtimeToPersisted(s));
    expect(parsed.conversations[0].messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b', reasoning: 'c' },
    ]);
  });

  it('persists external CLI sessions with their Forge conversation', () => {
    const session = createDefaultSession();
    session.conversations[0].cli_sessions = {
      'claude-code': 'claude-session',
      codex: 'codex-thread',
    };
    const persisted = sidebarSessionPersistedSchema.parse(runtimeToPersisted(session));
    const store: Record<string, unknown> = { [SESSION_KEY_V1]: persisted };
    const loaded = loadSidebarSession(makeMemento(store));
    expect(loaded.conversations[0].cli_sessions).toEqual(session.conversations[0].cli_sessions);
  });

  it('runtimeToPersisted includes archived history conversations', () => {
    const s = createDefaultSession();
    s.conversations[0].messages.push(
      { role: 'user', content: 'open chat' },
      { role: 'assistant', content: 'still open' },
    );
    upsertHistoryConversation(s, {
      id: 'archived-1',
      title: 'Archived chat',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { role: 'user', content: 'old prompt' },
        { role: 'assistant', content: 'old answer' },
      ],
    });

    const parsed = sidebarSessionPersistedSchema.parse(runtimeToPersisted(s));
    expect(parsed.history).toHaveLength(1);
    expect(parsed.history?.[0]?.messages).toEqual([
      { role: 'user', content: 'old prompt' },
      { role: 'assistant', content: 'old answer' },
    ]);
  });

  it('historyMetasFromSession hides reopened conversations', () => {
    const s = createDefaultSession();
    const archived = {
      id: 'conv-1',
      title: 'Previous chat',
      createdAt: 1,
      updatedAt: 3,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'world' },
      ] satisfies ChatMessage[],
    };

    upsertHistoryConversation(s, archived);
    expect(historyMetasFromSession(s)).toHaveLength(1);

    s.conversations.push({ ...archived, messages: [...archived.messages] });
    expect(historyMetasFromSession(s)).toHaveLength(0);
  });

  it('loadSidebarSession migrates legacy slim history into v1', () => {
    const slim = [{ role: 'assistant' as const, content: 'hello from disk' }];
    const store: Record<string, unknown> = {
      [HISTORY_KEY_LEGACY]: slim,
    };
    loadSidebarSession(makeMemento(store));

    expect(store[HISTORY_KEY_LEGACY]).toBeUndefined();
    expect(store[SESSION_KEY_V1]).toBeDefined();

    const parsed = sidebarSessionPersistedSchema.parse(store[SESSION_KEY_V1]);
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0].messages).toContainEqual({
      role: 'assistant',
      content: 'hello from disk',
    });
  });

  it('invalid v1 without legacy returns fresh default-shaped session', () => {
    const store: Record<string, unknown> = {
      [SESSION_KEY_V1]: { bad: true },
    };
    const rt = loadSidebarSession(makeMemento(store));
    expect(rt.conversations).toHaveLength(1);
    expect(rt.activeConversationId).toBe(rt.conversations[0].id);
  });
});
