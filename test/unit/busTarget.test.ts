import { describe, expect, it } from 'vitest';
import { forgeInboundPrompt } from '../../src/agentBus/busContent';
import { busTargetConversation, senderConversation } from '../../src/agentBus/busTarget';
import type { ForgeConversationSummary } from '../../src/sidebar/ForgeHostFacade';
import type { ForgeExchange } from '../../src/sidebar/sessionProjections';
import { appendUserPrompt } from '../../src/sidebar/transcriptMutations';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

const conv = (
  id: string,
  updatedAt: number,
  extra: Partial<ForgeConversationSummary> = {},
): ForgeConversationSummary => ({
  id,
  title: 'Untitled chat',
  activeModel: null,
  archived: false,
  updatedAt,
  requestCount: 0,
  toolCallCount: 0,
  ...extra,
});

const said = (from: string): ForgeExchange => ({
  prompt: forgeInboundPrompt(from, 'push main'),
  answer: 'done',
});

describe('busTargetConversation', () => {
  const byId: Record<string, ForgeExchange[]> = {
    release: [said('codex')],
    older: [said('codex')],
    mine: [{ prompt: 'hello', answer: 'hi' }],
    closed: [said('claude')],
  };
  const exchanges = (id: string) => byId[id] ?? [];
  const status = {
    activeConversationId: 'mine',
    conversations: [
      conv('older', 1),
      conv('release', 3),
      conv('mine', 5),
      conv('closed', 9, { archived: true }),
    ],
  };

  it('follows the sender to its latest chat, not the active tab', () => {
    expect(busTargetConversation('codex', status, exchanges)).toBe('release');
    expect(busTargetConversation('Codex', status, exchanges)).toBe('release');
  });

  it('falls back to the active chat for a new sender or no sender', () => {
    expect(busTargetConversation('gemini', status, exchanges)).toBe('mine');
    expect(busTargetConversation(undefined, status, exchanges)).toBe('mine');
  });

  it('never routes into a closed (archived) tab', () => {
    expect(busTargetConversation('claude', status, exchanges)).toBe('mine');
  });

  it('recognises a sender-started chat by title after compaction', () => {
    const compacted = {
      ...status,
      conversations: [...status.conversations, conv('compacted', 4, { title: 'codex: push' })],
    };
    expect(busTargetConversation('codex', compacted, exchanges)).toBe('compacted');
  });
});

describe('senderConversation', () => {
  const status = {
    activeConversationId: 'mine',
    conversations: [conv('mine', 5), conv('closed', 9, { archived: true })],
  };
  const exchanges = (id: string) => (id === 'closed' ? [said('claude')] : []);

  it('returns undefined instead of the active chat when the sender has no chat', () => {
    expect(senderConversation('claude', status, () => [])).toBeUndefined();
  });

  it('skips an archived chat that holds the sender prompt', () => {
    expect(senderConversation('claude', status, exchanges)).toBeUndefined();
  });

  it('matches the sender title prefix', () => {
    const titled = { ...status, conversations: [...status.conversations, conv('title', 10, { title: 'claude: task' })] };
    expect(senderConversation('claude', titled, () => [])).toBe('title');
  });

  it('matches case-insensitively', () => {
    const titled = { ...status, conversations: [conv('title', 10, { title: 'Claude: task' })] };
    expect(senderConversation('cLaUdE', titled, () => [])).toBe('title');
  });
});

describe('bus-started chat titles', () => {
  it('names the chat from the message, not the sender header', () => {
    const c = { messages: [], title: 'Untitled chat' } as unknown as ConversationRuntime;
    appendUserPrompt(c, forgeInboundPrompt('codex', '\nRetry the v0.16.34 push now.\nMore.'));
    expect(c.title).toBe('codex: Retry the v0.16.34 push now.');
  });

  it('leaves a typed prompt titled by its first line', () => {
    const c = { messages: [], title: 'Untitled chat' } as unknown as ConversationRuntime;
    appendUserPrompt(c, 'fix the build\nplease');
    expect(c.title).toBe('fix the build');
  });
});
