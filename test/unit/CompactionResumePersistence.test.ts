import { describe, expect, it } from 'vitest';
import { persistedToRuntime, runtimeToPersisted } from '../../src/sidebar/sessionPersistence';
import { compactionPersistedSchema } from '../../src/sidebar/compactionPersistedSchema';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';

describe('persisted compaction resume note', () => {
  it('round-trips the note and still parses older records without it', () => {
    const resumeNote = { generation: 2, usedTokens: 1_200, maxTokens: 8_192 };
    const conversation: ConversationRuntime = {
      id: 'resume',
      title: 'Resume',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      compaction: { summary: 'summary', fromIndex: 0, resumeNote },
    };
    const session: SidebarRuntime = {
      activeConversationId: conversation.id,
      conversations: [conversation],
      history: [],
    };

    const persisted = runtimeToPersisted(session).conversations[0]!;
    expect(compactionPersistedSchema.parse(persisted.compaction).resumeNote).toEqual(resumeNote);
    expect(persistedToRuntime(persisted).compaction?.resumeNote).toEqual(resumeNote);
    expect(compactionPersistedSchema.parse({ summary: 'legacy', fromIndex: 0 }).resumeNote).toBe(
      undefined,
    );
  });
});
