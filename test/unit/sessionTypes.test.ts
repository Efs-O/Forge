import type { Memento } from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  chatMessagesFromSlim,
  createDefaultSession,
  deriveTitle,
  displayTitle,
  displayPersistMessages,
  historyMetasFromSession,
  HISTORY_KEY_LEGACY,
  loadSidebarSession,
  runtimeToPersisted,
  SESSION_KEY_V1,
  sidebarSessionPersistedSchema,
  slimPersistMessages,
  UNTITLED_TITLE,
  isUntitled,
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

  it('deriveTitle falls back to the untitled placeholder on an empty line', () => {
    expect(deriveTitle('   ')).toBe(UNTITLED_TITLE);
  });

  it('treats both the current and the pre-0.13.21 placeholder as untitled', () => {
    // Sessions on disk still carry the old string; the rename box must go on
    // opening empty for them rather than pre-filling a placeholder as a name.
    expect(isUntitled('New chat')).toBe(true);
    expect(isUntitled('Chat')).toBe(true);
    expect(isUntitled('Chat about chat')).toBe(false);
    expect(isUntitled('fix the parser')).toBe(false);
  });

  it('displays a legacy placeholder as the current one, leaving real titles alone', () => {
    expect(displayTitle('Chat')).toBe(UNTITLED_TITLE);
    expect(displayTitle('fix the parser')).toBe('fix the parser');
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

  // A prompt sent WITH an attachment has array content. Keying the text
  // extraction off `role === 'tool'` meant it failed the string test and the
  // whole turn was dropped, so a reload lost what the user actually asked.
  it('slimPersistMessages keeps the text of a user turn sent with an image', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this screenshot?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ];
    const slim = slimPersistMessages(messages);
    expect(slim).toHaveLength(1);
    expect(slim[0].content).toContain('what is in this screenshot?');
    expect(slim[0].content).not.toContain('base64');
    expect(slim[0].content).toContain('NOT');
  });

  // The pixels are never persisted, so a restored view_image result that still
  // reads as a plain success invites the model to describe what it cannot see.
  it('slimPersistMessages marks a restored image tool result as no longer visible', () => {
    const messages: ChatMessage[] = [
      {
        role: 'tool',
        content: [
          { type: 'text', text: 'Loaded image stills/s03.png (image/png, 1 bytes).' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } },
        ],
        tool_call_id: 'call_2',
        name: 'view_image',
      },
    ];
    const slim = slimPersistMessages(messages);
    expect(slim[0].content).toContain('Loaded image stills/s03.png');
    expect(slim[0].content).toContain('view_image again');
    expect(slim[0].content).not.toContain('base64');
  });

  it('slimPersistMessages drops system and contentless turns with no tool_calls', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: null, tool_calls: [] },
    ];
    expect(slimPersistMessages(messages)).toEqual([]);
  });

  it('displayPersistMessages restores completed tool rows without raw unbounded output', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', content: 'result', tool_call_id: 'call_1' },
      { role: 'assistant', content: 'bye' },
    ];
    expect(displayPersistMessages(messages)).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'tool',
        content: 'tool → result',
        toolName: 'tool',
        toolResult: 'result',
        toolResultTotal: 6,
      },
      { role: 'assistant', content: 'bye' },
    ]);
  });

  it('keeps internal prompts for the model but omits them from the sidebar', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'visible request' },
      { role: 'user', content: 'internal resume instruction', internal: true },
      { role: 'assistant', content: 'visible answer' },
    ];
    expect(displayPersistMessages(messages)).toEqual([
      { role: 'user', content: 'visible request' },
      { role: 'assistant', content: 'visible answer' },
    ]);
    expect(chatMessagesFromSlim(slimPersistMessages(messages))).toEqual(messages);
  });

  it('restores a completed tool row and its file preview after session sync or reload', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'update the file' },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'tool', content: 'Wrote src/app.ts', tool_call_id: 'call_1', name: 'write_file' },
      { role: 'assistant', content: 'Updated.' },
    ];
    const diffs = [
      {
        toolCallId: 'call_1',
        filePath: 'src/app.ts',
        hunks: [
          { oldStart: 1, newStart: 1, lines: [{ kind: 'added' as const, text: 'export {};' }] },
        ],
        isNew: false,
        isDeleted: false,
      },
    ];
    const session = createDefaultSession();
    session.conversations[0]!.messages = messages;
    session.conversations[0]!.displayDiffs = diffs;

    const persisted = runtimeToPersisted(session);
    const restored = loadSidebarSession(makeMemento({ [SESSION_KEY_V1]: persisted }));
    expect(
      displayPersistMessages(
        restored.conversations[0]!.messages,
        restored.conversations[0]!.displayDiffs,
      ),
    ).toEqual([
      { role: 'user', content: 'update the file' },
      {
        role: 'tool',
        content: 'write_file → Wrote src/app.ts',
        toolName: 'write_file',
        toolResult: 'Wrote src/app.ts',
        toolResultTotal: 16,
      },
      {
        role: 'diff',
        content: 'src/app.ts',
        diffHunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: 'added', text: 'export {};' }] }],
        diffIsNew: false,
        diffIsDeleted: false,
      },
      { role: 'assistant', content: 'Updated.' },
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
      {
        role: 'tool',
        content: 'tool → result',
        toolName: 'tool',
        toolResult: 'result',
        toolResultTotal: 6,
      },
      { role: 'assistant', content: '', reasoning: 'round 2 thinking' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('keeps final-round reasoning in a Thinking row instead of hiding it behind the answer', () => {
    expect(
      displayPersistMessages([
        {
          role: 'assistant',
          content: 'Finished the update.',
          reasoning: 'Checking the result first.',
        },
      ]),
    ).toEqual([
      { role: 'assistant', content: '', reasoning: 'Checking the result first.' },
      { role: 'assistant', content: 'Finished the update.' },
    ]);
  });

  it('keeps commentary from a reasoning turn that also called a tool', () => {
    expect(
      displayPersistMessages([
        {
          role: 'assistant',
          content: 'Now the docs — index.html control grids and README.',
          reasoning: 'Checking what remains.',
          tool_calls: [toolCall],
        },
      ]),
    ).toEqual([
      { role: 'assistant', content: '', reasoning: 'Checking what remains.' },
      {
        role: 'assistant',
        content: 'Now the docs — index.html control grids and README.',
      },
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

  it('closes an in-flight tool call as unknown when a session reloads', () => {
    const session = createDefaultSession();
    session.conversations[0]!.messages.push(
      { role: 'user', content: 'run the test' },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
    );
    const store: Record<string, unknown> = { [SESSION_KEY_V1]: runtimeToPersisted(session) };

    const restored = loadSidebarSession(makeMemento(store));
    expect(restored.conversations[0]!.messages).toEqual([
      { role: 'user', content: 'run the test' },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      {
        role: 'tool',
        content: expect.stringContaining('result is unknown'),
        tool_call_id: 'call_1',
        name: 'ask_local_agent',
      },
    ]);
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

  it('round-trips structured replacement context without aliasing its arrays', () => {
    const session = createDefaultSession();
    session.conversations[0]!.compaction = {
      summary: 'Goal: finish. Next: test.',
      fromIndex: 4,
      generation: 2,
      userMessages: ['original request', 'later decision'],
      recordedActions: [
        {
          kind: 'command',
          key: 'command:npm run ci',
          outcome: 'ok',
          line: '- ran `npm run ci` → exit 0',
        },
      ],
      repoState: '\n\nWORKING TREE: clean',
    };

    const persisted = runtimeToPersisted(session);
    const restored = loadSidebarSession(makeMemento({ [SESSION_KEY_V1]: persisted }));
    expect(restored.conversations[0]!.compaction).toEqual(session.conversations[0]!.compaction);
    expect(restored.conversations[0]!.compaction?.userMessages).not.toBe(
      persisted.conversations[0]!.compaction?.userMessages,
    );
    expect(restored.conversations[0]!.compaction?.recordedActions).not.toBe(
      persisted.conversations[0]!.compaction?.recordedActions,
    );
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

  it('persists active time and provider token totals', () => {
    const session = createDefaultSession();
    const conv = session.conversations[0];
    conv.active_time_ms = 3_661_000;
    conv.input_tokens = 12_400;
    conv.output_tokens = 2_000;
    conv.last_input_tokens = 2_800;
    conv.last_output_tokens = 450;
    conv.model_request_count = 4;

    const loaded = loadSidebarSession(
      makeMemento({ [SESSION_KEY_V1]: runtimeToPersisted(session) }),
    );

    expect(loaded.conversations[0]).toMatchObject({
      active_time_ms: 3_661_000,
      input_tokens: 12_400,
      output_tokens: 2_000,
      last_input_tokens: 2_800,
      last_output_tokens: 450,
      model_request_count: 4,
    });
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
