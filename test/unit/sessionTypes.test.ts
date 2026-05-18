import type { Memento } from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  createDefaultSession,
  deriveTitle,
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

  it('slimPersistMessages keeps only user/assistant string content', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [] as never },
      { role: 'tool', content: 'x', tool_call_id: '1', name: 't' },
      { role: 'assistant', content: 'bye', reasoning: 'thoughts' },
    ];
    expect(slimPersistMessages(messages)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'bye', reasoning: 'thoughts' },
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
