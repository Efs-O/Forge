/**
 * Volatile, conversation-scoped messages waiting for the next tool-round gap.
 * The sidebar and remote transports share this owner; neither surface keeps a
 * second copy of a tell that could be delivered out of order.
 */

import type { ChatMessage } from '../llm/types';

export interface MidTurnTell {
  id: string;
  text: string;
}

/**
 * What a drain at a tool-round gap returns: the messages to inject into the
 * transcript, plus an optional settle step that runs only after they have been
 * pushed and persisted. The remote transport settles the claimed request here
 * so the record is finished once the session is durable; the sidebar tells
 * carry no settle.
 */
export interface MidTurnDrainResult {
  messages: ChatMessage[];
  settle?: () => Promise<void>;
}

export class MidTurnInbox {
  private readonly pending = new Map<string, MidTurnTell[]>();
  private readonly listeners = new Map<string, Set<() => void>>();

  onAdded(conversationId: string, callback: () => void): () => void {
    const callbacks = this.listeners.get(conversationId) ?? new Set<() => void>();
    callbacks.add(callback);
    this.listeners.set(conversationId, callbacks);
    if ((this.pending.get(conversationId)?.length ?? 0) > 0) callback();
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) this.listeners.delete(conversationId);
    };
  }

  add(conversationId: string, tell: MidTurnTell): void {
    const current = this.pending.get(conversationId);
    if (current) current.push({ ...tell });
    else this.pending.set(conversationId, [{ ...tell }]);
    for (const listener of this.listeners.get(conversationId) ?? []) listener();
  }

  drain(conversationId: string): MidTurnTell[] {
    return this.take(conversationId);
  }

  takeUndelivered(conversationId: string): MidTurnTell[] {
    return this.take(conversationId);
  }

  private take(conversationId: string): MidTurnTell[] {
    const tells = this.pending.get(conversationId);
    if (!tells) return [];
    this.pending.delete(conversationId);
    return tells.map((tell) => ({ ...tell }));
  }
}
