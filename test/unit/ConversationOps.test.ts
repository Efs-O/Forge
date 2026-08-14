import { describe, expect, it } from 'vitest';
import { opSetActiveConversationModel } from '../../src/sidebar/ConversationOps';
import type { SidebarRuntime } from '../../src/sidebar/sessionTypes';

function sidebar(): SidebarRuntime {
  return {
    activeConversationId: 'active',
    conversations: [
      {
        id: 'active',
        title: 'Active',
        createdAt: 1,
        updatedAt: 1,
        active_model: 'claude',
        messages: [],
      },
      {
        id: 'other',
        title: 'Other',
        createdAt: 1,
        updatedAt: 1,
        active_model: 'codex',
        messages: [],
      },
    ],
    history: [],
  };
}

describe('opSetActiveConversationModel', () => {
  it('replaces the model pinned to the active conversation only', () => {
    const state = sidebar();

    opSetActiveConversationModel(state, 'local-model');

    expect(state.conversations[0]?.active_model).toBe('local-model');
    expect(state.conversations[1]?.active_model).toBe('codex');
  });

  it('clears the active conversation override when no model is selected', () => {
    const state = sidebar();

    opSetActiveConversationModel(state, null);

    expect(state.conversations[0]).not.toHaveProperty('active_model');
  });
});
