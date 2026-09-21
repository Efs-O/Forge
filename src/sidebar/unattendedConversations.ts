/**
 * Conversation-local unattended markers.
 *
 * A job owns its marker for exactly one turn. This is deliberately separate
 * from clanker mode: unattended work may bypass only its own non-dangerous
 * confirmations, while an attended conversation keeps its normal gate.
 */
export interface UnattendedConversationRegistry {
  mark(conversationId: string): { dispose(): void };
  has(conversationId: string): boolean;
}

const ids = new Set<string>();

/** Shared registry used by the turn services and the job runner. */
export const unattendedConversations: UnattendedConversationRegistry = {
  mark(conversationId): { dispose(): void } {
    ids.add(conversationId);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        ids.delete(conversationId);
      },
    };
  },

  has(conversationId): boolean {
    return ids.has(conversationId);
  },
};
