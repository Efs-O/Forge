import { describe, expect, it } from 'vitest';
import { createConversationEvictionSignals } from '../../src/sidebar/conversationEvictionSignals';
import { evictionBlockers, isConversationEvictable } from '../../src/sidebar/evictionGate';

function signalReader(state: {
  streaming?: Set<string>;
  chains?: string[];
  workers?: { id: string; opened_by?: string }[];
}) {
  const streaming = state.streaming ?? new Set<string>();
  const chains = state.chains ?? [];
  const workers = state.workers ?? [];
  return createConversationEvictionSignals({
    isStreaming: (id) => streaming.has(id),
    isConversationQueued: () => false,
    isConversationDrafted: () => false,
    remoteEvictionBlocks: () => false,
    pendingApprovalConversationIds: () => new Set(),
    pendingQuestionConversationIds: () => new Set(),
    hasPendingQuestion: () => false,
    requestChainConversations: () => chains.map((conversationId) => ({ conversationId })),
    openConversations: () => workers,
    isUnattended: () => false,
  });
}

describe('worker chat eviction signal', () => {
  it('pins an opener while its open worker is streaming with the new label', () => {
    const read = signalReader({
      streaming: new Set(['worker']),
      workers: [{ id: 'worker', opened_by: 'opener' }],
    });
    const signals = read('opener');

    expect(signals.workerChatActive).toBe(true);
    expect(isConversationEvictable(signals)).toBe(false);
    expect(evictionBlockers(signals)).toContain('waiting on a worker chat it opened');
  });

  it('pins an opener while its worker holds a request chain, then releases it when idle', () => {
    const worker = { id: 'worker', opened_by: 'opener' };
    const pending = signalReader({ chains: ['worker'], workers: [worker] })('opener');
    const idle = signalReader({ workers: [worker] })('opener');

    expect(pending.workerChatActive).toBe(true);
    expect(isConversationEvictable(pending)).toBe(false);
    expect(idle.workerChatActive).toBe(false);
    expect(isConversationEvictable(idle)).toBe(true);
  });
});
