import { describe, expect, it, vi } from 'vitest';
import { runAddressedAutoCompact } from '../../src/sidebar/autoCompactionPolicy';
import { MAX_CONSECUTIVE_AUTO_CONTINUES, RESUME_PROMPT } from '../../src/sidebar/CompactionService';
import type { RequestChainContext } from '../../src/sidebar/RequestChainLifecycle';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';

function chain(count = 0): RequestChainContext {
  return {
    conversationId: 'c1',
    userIntentEpoch: 1,
    reservation: { conversationId: 'c1', token: 'owner' },
    autoContinueCount: count,
  };
}

describe('runAddressedAutoCompact', () => {
  const conv = { id: 'c1' } as ConversationRuntime;

  it('returns an internal continuation and increments only its chain', async () => {
    const owner = chain();
    const setStage = vi.fn();
    const action = await runAddressedAutoCompact(
      {
        post: vi.fn(),
        requestChains: { setStage },
        compact: async () => 'compacted',
        incompleteTurnReason: () => 'output limit',
        resumeEnabled: () => true,
      },
      conv,
      owner,
    );
    expect(setStage).toHaveBeenCalledWith(owner, 'compacting');
    expect(owner.autoContinueCount).toBe(1);
    expect(action).toEqual({ kind: 'continue', text: RESUME_PROMPT, options: { internal: true } });
  });

  it('does not continue after failure or when resume is disabled', async () => {
    const base = {
      post: vi.fn(),
      requestChains: { setStage: vi.fn() },
      incompleteTurnReason: () => undefined,
      resumeEnabled: () => true,
    };
    await expect(
      runAddressedAutoCompact({ ...base, compact: async () => 'failed' }, conv, chain()),
    ).resolves.toBeUndefined();
    await expect(
      runAddressedAutoCompact(
        { ...base, compact: async () => 'compacted', resumeEnabled: () => false },
        conv,
        chain(),
      ),
    ).resolves.toBeUndefined();
  });

  it('enforces the continuation cap on the owning chain', async () => {
    const owner = chain(MAX_CONSECUTIVE_AUTO_CONTINUES);
    const action = await runAddressedAutoCompact(
      {
        post: vi.fn(),
        requestChains: { setStage: vi.fn() },
        compact: async () => 'compacted',
        incompleteTurnReason: () => undefined,
        resumeEnabled: () => true,
      },
      conv,
      owner,
    );
    expect(action).toBeUndefined();
    expect(owner.autoContinueCount).toBe(MAX_CONSECUTIVE_AUTO_CONTINUES);
  });
});
