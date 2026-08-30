import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteRequestRecord } from './types';
import type { RemoteRequestStore } from './RemoteRequestStore';

/** Compose the one-time remote-chat label before the final outbox mutation. */
export function withConversationIdentity(
  store: RemoteRequestStore,
  host: ForgeHostFacade,
  request: RemoteRequestRecord,
  finalText: string | undefined,
): string | undefined {
  if (!finalText) return undefined;
  const binding = store.binding(request.channel, request.chatId);
  if (!binding || binding.announcedConversationId === request.conversationId) return finalText;
  const conversation = host
    .status()
    .conversations.find((candidate) => candidate.id === request.conversationId);
  if (!conversation) return finalText;
  return `Chat: ${conversation.title} · ID: ${shortId(conversation.id)}\n\n${finalText}`;
}

function shortId(id: string): string {
  return id.length > 7 ? `${id.slice(0, 3)}…${id.slice(-3)}` : id;
}
