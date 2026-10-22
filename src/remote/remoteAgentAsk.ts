import type { RemoteInboundEvent } from './types';

export type RemoteAgentKind = 'claude' | 'codex' | 'copilot';

interface PendingAgentAsk {
  messageId: string;
  kind: RemoteAgentKind;
  expiresAt: number;
}

const AGENT_KINDS = new Set<RemoteAgentKind>(['claude', 'codex', 'copilot']);
const ASK_TTL_MS = 10 * 60_000;

/** Parse the compact callback; this grammar is disjoint from every other family. */
export function parseTelegramAgentAskCallback(data: string): RemoteAgentKind | undefined {
  const match = /^a:(claude|codex|copilot)$/.exec(data);
  return match ? (match[1] as RemoteAgentKind) : undefined;
}

/** Per-chat, memory-only force-reply rendezvous for the linked-agent commands. */
export class RemoteAgentAsk {
  private readonly pending = new Map<string, PendingAgentAsk>();

  remember(chatId: string, messageId: string, kind: RemoteAgentKind, now = Date.now()): void {
    if (!AGENT_KINDS.has(kind) || !messageId) throw new Error('Forge agent ask is invalid.');
    this.pending.set(chatId, { messageId, kind, expiresAt: now + ASK_TTL_MS });
  }

  consume(
    event: Extract<RemoteInboundEvent, { kind: 'text' }>,
    now = Date.now(),
  ): Extract<RemoteInboundEvent, { kind: 'text' }> | undefined {
    if (!event.replyToMessageId || event.text.startsWith('/')) return undefined;
    const entry = this.pending.get(event.chatId);
    if (!entry || entry.messageId !== event.replyToMessageId) return undefined;
    this.pending.delete(event.chatId);
    if (entry.expiresAt <= now || !event.text.trim() || event.attachments?.length) return undefined;
    return { ...event, text: `/${entry.kind} ${event.text}` };
  }

  dispose(): void {
    this.pending.clear();
  }
}
