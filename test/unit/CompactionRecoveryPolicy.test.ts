import { describe, expect, it, vi } from 'vitest';
import { runCompaction, type CompactionDeps } from '../../src/sidebar/CompactionService';
import { runAddressedAutoCompact } from '../../src/sidebar/autoCompactionPolicy';
import { compactMidTurn } from '../../src/sidebar/midTurnCompaction';
import type { ChatMessage } from '../../src/llm/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { RequestChainContext } from '../../src/sidebar/RequestChainLifecycle';

const successfulSummary =
  `Goal: complete the request.\n\nState: recorded. Next: continue. ` + 'detail. '.repeat(40);

function setup() {
  const conversation: ConversationRuntime = {
    id: 'recovery',
    title: 'recovery',
    messages: [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'first response' },
      { role: 'user', content: 'current request' },
      { role: 'assistant', content: 'work in progress' },
    ] satisfies ChatMessage[],
    createdAt: 0,
    updatedAt: 0,
  };
  let calls = 0;
  const deps: CompactionDeps = {
    post: vi.fn(),
    getConversation: (id) => (id === conversation.id ? conversation : undefined),
    persistSession: vi.fn(),
    postSessionSync: vi.fn(),
    invalidateExactTokenBudget: vi.fn(),
    postTokenBudget: vi.fn(),
    isStreaming: () => false,
    beginCompaction: () => () => undefined,
    runPromptToMarkdown: async () => {
      if (++calls === 1) throw new Error('provider hiccup');
      return successfulSummary;
    },
  };
  return { conversation, calls: () => calls, compact: (midTurn: boolean) =>
    runCompaction(deps, conversation.id, { auto: true, trigger: 'auto', midTurn }) };
}

describe('automatic recovery paths after one failed compaction', () => {
  it('allows a transient failure to recover during a later mid-turn check', async () => {
    const h = setup();
    await expect(h.compact(true)).resolves.toBe('failed');
    await expect(
      compactMidTurn(
        {
          getConfig: () => ({ auto_compact: { enabled: true, resume: true } }) as never,
          snapshot: () => ({ used: 90, max: 100 }),
          compact: () => h.compact(true),
        },
        h.conversation,
        { exhausted: false },
      ),
    ).resolves.toBe(true);
    expect(h.calls()).toBe(2);
  });

  it('allows post-turn compaction to recover after one failure', async () => {
    const h = setup();
    await expect(h.compact(false)).resolves.toBe('failed');
    const chain = {
      conversationId: h.conversation.id,
      userIntentEpoch: 1,
      reservation: { conversationId: h.conversation.id, token: 'owner' },
      autoContinueCount: 0,
    } satisfies RequestChainContext;
    await expect(
      runAddressedAutoCompact(
        {
          post: vi.fn(),
          requestChains: { setStage: vi.fn() },
          compact: () => h.compact(false),
          incompleteTurnReason: () => undefined,
          resumeEnabled: () => true,
        },
        h.conversation,
        chain,
      ),
    ).resolves.toMatchObject({ kind: 'continue' });
    expect(h.calls()).toBe(2);
  });

  it('allows context-exhaustion rescue to recover after one failure', async () => {
    const h = setup();
    await expect(h.compact(true)).resolves.toBe('failed');
    await expect(
      compactMidTurn(
        {
          getConfig: () => ({ auto_compact: { enabled: true, resume: true } }) as never,
          snapshot: () => ({ used: 0, max: 100 }),
          compact: () => h.compact(true),
        },
        h.conversation,
        { exhausted: true },
      ),
    ).resolves.toBe(true);
    expect(h.calls()).toBe(2);
  });
});
