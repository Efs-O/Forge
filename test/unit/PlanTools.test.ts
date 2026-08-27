import type { Memento } from 'vscode';
import { describe, expect, it } from 'vitest';
import { makeUpdatePlanTool, renderPlan, withPlan } from '../../src/tools/planTools';
import {
  loadSidebarSession,
  runtimeToPersisted,
  saveSidebarSession,
  SESSION_KEY_V1,
  type ConversationPlan,
  type PlanItem,
  type SidebarRuntime,
} from '../../src/sidebar/sessionTypes';
import type { ChatMessage } from '../../src/llm/types';
import type { ToolHandlerContext } from '../../src/tools/ToolRegistry';

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

const ITEMS: PlanItem[] = [
  { text: 'write the ledger', status: 'done' },
  { text: 'wire the snapshot', status: 'active' },
  { text: 'add tests', status: 'pending' },
];

function context(): { ctx: ToolHandlerContext; written: PlanItem[][] } {
  const written: PlanItem[][] = [];
  return {
    written,
    ctx: {
      beforeMutate: () => undefined,
      setPlan: (items) => written.push(items),
    },
  };
}

describe('update_plan', () => {
  it('records a valid plan through the host-supplied callback', async () => {
    const tool = makeUpdatePlanTool();
    const { ctx, written } = context();
    const result = await tool.handler({ items: ITEMS }, ctx);
    expect(written).toEqual([ITEMS]);
    expect(result).toBe('Plan recorded: 3 items, 1 done.');
  });

  it('is auto-approved and read-permissioned, so marking work done is never gated', () => {
    const tool = makeUpdatePlanTool();
    expect(tool.autoApprove).toBe(true);
    expect(tool.permission).toBe('read');
    expect(tool.mutation).toBeUndefined();
  });

  it('rejects an over-long list and names the limit so the round is not lost', async () => {
    const tool = makeUpdatePlanTool();
    const { ctx, written } = context();
    const items = Array.from({ length: 21 }, (_, i) => ({
      text: `task ${i}`,
      status: 'pending' as const,
    }));
    const result = await tool.handler({ items }, ctx);
    expect(result).toContain('1-20 items');
    expect(written).toEqual([]);
  });

  it('rejects an over-long item text', async () => {
    const tool = makeUpdatePlanTool();
    const { ctx, written } = context();
    const result = await tool.handler(
      { items: [{ text: 'x'.repeat(201), status: 'pending' }] },
      ctx,
    );
    expect(result).toContain('1-200 characters');
    expect(written).toEqual([]);
  });

  it('rejects unknown fields rather than persisting them', async () => {
    const tool = makeUpdatePlanTool();
    const { ctx, written } = context();
    const result = await tool.handler(
      { items: [{ text: 'ok', status: 'pending', notes: 'x'.repeat(5000) }] },
      ctx,
    );
    expect(result).toContain('no other fields');
    expect(written).toEqual([]);
  });

  it('refuses rather than throwing when no conversation owns the call', async () => {
    const tool = makeUpdatePlanTool();
    const result = await tool.handler({ items: ITEMS }, { beforeMutate: () => undefined });
    expect(result).toContain('unavailable outside a conversation turn');
  });
});

describe('renderPlan', () => {
  it('reports elapsed time, not a round count', () => {
    const now = 1_000_000_000;
    expect(renderPlan(ITEMS, now, now)).toContain('updated just now');
    expect(renderPlan(ITEMS, now - 6 * 60_000, now)).toContain('updated about 6 min ago');
    expect(renderPlan(ITEMS, now - 3 * 3_600_000, now)).toContain('updated about 3 h ago');
  });

  it('marks each status distinctly', () => {
    const text = renderPlan(ITEMS, 0, 0);
    expect(text).toContain('- [x] done: write the ledger');
    expect(text).toContain('- [>] in progress: wire the snapshot');
    expect(text).toContain('- [ ] pending: add tests');
  });
});

describe('withPlan', () => {
  const plan: ConversationPlan = { items: ITEMS, updatedAt: 0 };

  it('leaves the messages untouched when there is no plan', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(withPlan(messages, undefined)).toBe(messages);
    expect(withPlan(messages, { items: [], updatedAt: 0 })).toBe(messages);
  });

  it('goes at the head, never between tool calls and their results', () => {
    // A user message landing after an assistant's tool_calls is the shape
    // strict chat templates reject.
    const messages: ChatMessage[] = [
      { role: 'system', content: 'you are forge' },
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: null, tool_calls: [] },
      { role: 'tool', content: 'done', tool_call_id: 'a' },
    ];
    const out = withPlan(messages, plan, 0);
    expect(out).toHaveLength(4);
    expect(out[0]?.role).toBe('system');
    expect(out[1]?.content).toContain('Task plan (recorded by Forge');
    expect(out[1]?.content).toContain('do it');
    expect(out[3]?.role).toBe('tool');
  });

  it('never creates two consecutive user turns, which strict templates refuse', () => {
    // After a compaction the first non-system message is always the summary
    // preamble, so inserting beside it would produce that pair every time.
    const messages: ChatMessage[] = [
      { role: 'system', content: 'you are forge' },
      { role: 'user', content: 'Conversation summary. Use this as the working context.' },
      { role: 'assistant', content: 'Goal: ship it. Next: continue.' },
    ];
    const out = withPlan(messages, plan, 0);
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant']);
    expect(out[1]?.content).toContain('Task plan');
    expect(out[1]?.content).toContain('Conversation summary');
    // The caller's own message object must not be mutated — only the
    // model-facing copy changes.
    expect(messages[1]?.content).toBe('Conversation summary. Use this as the working context.');
  });

  it('folds into the first user message when there is no system message', () => {
    const out = withPlan([{ role: 'user', content: 'do it' }], plan, 0);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toContain('Task plan');
    expect(out[0]?.content).toContain('do it');
  });

  it('folds into an attachment-bearing user message without adding a second user turn', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this screenshot.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      },
    ];

    const out = withPlan(messages, plan, 0);
    expect(out.map((m) => m.role)).toEqual(['system', 'user']);
    expect(Array.isArray(out[1]?.content)).toBe(true);
    const content = out[1]?.content;
    expect(Array.isArray(content) && content[0]).toEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining('Task plan') }),
    );
    expect(Array.isArray(content) && content[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc' },
    });
  });

  it('stands alone only when there is nothing to fold into', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'assistant', content: 'resuming' },
    ];
    const out = withPlan(messages, plan, 0);
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(out[1]?.internal).toBe(true);
  });

  it('emits exactly one plan block per call, however often it runs', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ];
    const once = withPlan(messages, plan, 0);
    const twice = withPlan(messages, plan, 0);
    expect(once.filter((m) => String(m.content).includes('Task plan'))).toHaveLength(1);
    expect(twice).toHaveLength(once.length);
  });
});

describe('plan persistence', () => {
  function session(plan?: ConversationPlan): SidebarRuntime {
    const conversation = {
      id: 'c1',
      title: 'Chat',
      createdAt: 1,
      updatedAt: 2,
      messages: [] as ChatMessage[],
      ...(plan ? { plan } : {}),
    };
    return {
      activeConversationId: 'c1',
      conversations: [conversation],
      history: [{ ...conversation, id: 'h1' }],
    } as SidebarRuntime;
  }

  it('round-trips through save and load, for history as well as live tabs', () => {
    // runtimeToPersisted maps conversations and history separately; a field
    // added to only one is silently dropped from archived chats.
    const store: Record<string, unknown> = {};
    const memento = makeMemento(store);
    saveSidebarSession(memento, session({ items: ITEMS, updatedAt: 1234 }));

    const loaded = loadSidebarSession(memento);
    expect(loaded.conversations[0]?.plan).toEqual({ items: ITEMS, updatedAt: 1234 });
    expect(loaded.history[0]?.plan).toEqual({ items: ITEMS, updatedAt: 1234 });
  });

  it('omits the field entirely when no plan exists', () => {
    const persisted = runtimeToPersisted(session());
    expect(persisted.conversations[0]).not.toHaveProperty('plan');
  });

  it('still loads a session recorded before plans existed', () => {
    const store: Record<string, unknown> = {
      [SESSION_KEY_V1]: {
        activeConversationId: 'c1',
        conversations: [
          { id: 'c1', title: 'Chat', createdAt: 1, updatedAt: 2, messages: [] },
        ],
      },
    };
    const loaded = loadSidebarSession(makeMemento(store));
    expect(loaded.conversations[0]?.plan).toBeUndefined();
  });

  it('drops a corrupted over-limit plan rather than re-injecting it every round', () => {
    const store: Record<string, unknown> = {
      [SESSION_KEY_V1]: {
        activeConversationId: 'c1',
        conversations: [
          {
            id: 'c1',
            title: 'Chat',
            createdAt: 1,
            updatedAt: 2,
            messages: [],
            plan: {
              items: Array.from({ length: 500 }, () => ({ text: 'x'.repeat(400), status: 'done' })),
              updatedAt: 1,
            },
          },
        ],
      },
    };
    const loaded = loadSidebarSession(makeMemento(store));
    expect(loaded.conversations[0]?.plan).toBeUndefined();
  });
});
