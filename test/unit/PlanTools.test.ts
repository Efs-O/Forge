import type { Memento } from 'vscode';
import { describe, expect, it } from 'vitest';
import { makeUpdatePlanTool, renderPlan } from '../../src/tools/planTools';
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
  it('is a pure function of the items, so the clock cannot move the prompt', () => {
    // The age suffix used to be re-rendered every tool round. A turn that
    // crossed a minute boundary rewrote the prompt head mid-turn and dropped
    // the KV cache hit to zero for no reason the user could see.
    expect(renderPlan(ITEMS)).toBe(renderPlan(ITEMS));
    expect(renderPlan(ITEMS)).not.toMatch(/ago|just now|updated/);
  });

  it('marks each status distinctly', () => {
    const text = renderPlan(ITEMS);
    expect(text).toContain('- [x] done: write the ledger');
    expect(text).toContain('- [>] in progress: wire the snapshot');
    expect(text).toContain('- [ ] pending: add tests');
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
