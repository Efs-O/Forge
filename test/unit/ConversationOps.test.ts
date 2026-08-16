import { describe, expect, it } from 'vitest';
import {
  opClearMessages,
  opNewConversation,
  opSetActiveConversationModel,
} from '../../src/sidebar/ConversationOps';
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

describe('opNewConversation', () => {
  it('pins the supplied default so the tab cannot drift to another tab model', () => {
    const state = sidebar();

    const result = opNewConversation(state, 'codex');

    expect(result.atCap).toBe(false);
    if (result.atCap) return;
    const created = result.sidebar.conversations.find((c) => c.id === result.newId);
    expect(created?.active_model).toBe('codex');
  });

  it('leaves the tab unpinned when there is no default model', () => {
    const state = sidebar();

    const result = opNewConversation(state, null);

    expect(result.atCap).toBe(false);
    if (result.atCap) return;
    const created = result.sidebar.conversations.find((c) => c.id === result.newId);
    expect(created).not.toHaveProperty('active_model');
  });
});

describe('opClearMessages', () => {
  it('keeps the pinned model so a cleared tab does not fall back to the global', () => {
    const state = sidebar();
    const conv = state.conversations[0]!;
    conv.messages = [{ role: 'user', content: 'hi' }];

    opClearMessages(conv);

    expect(conv.messages).toEqual([]);
    expect(conv.active_model).toBe('claude');
  });
});
