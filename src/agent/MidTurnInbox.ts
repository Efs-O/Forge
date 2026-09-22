/**
 * Volatile, conversation-scoped messages waiting for the next tool-round gap.
 * The sidebar and remote transports share this owner; neither surface keeps a
 * second copy of a tell that could be delivered out of order.
 */

export interface MidTurnTell {
  id: string;
  text: string;
}

export class MidTurnInbox {
  private readonly pending = new Map<string, MidTurnTell[]>();

  add(conversationId: string, tell: MidTurnTell): void {
    const current = this.pending.get(conversationId);
    if (current) current.push({ ...tell });
    else this.pending.set(conversationId, [{ ...tell }]);
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
