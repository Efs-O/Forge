import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteRequestRecord } from './types';
import type { RemoteRequestStore } from './RemoteRequestStore';

/**
 * The two literal halves of the label, shared by the composer and the stripper
 * so the pair cannot drift. Neither contains a regex metacharacter.
 */
const LABEL = 'Chat: ';
const ID_SEPARATOR = ' · ID: ';

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
  return `${LABEL}${conversation.title}${ID_SEPARATOR}${shortId(conversation.id)}\n\n${finalText}`;
}

function shortId(id: string): string {
  return id.length > 7 ? `${id.slice(0, 3)}…${id.slice(-3)}` : id;
}

/**
 * The label as a pattern. `String.raw` so the newline escapes stay escapes: a
 * plain template would put real newlines in the regex source, which behaves the
 * same and reads like a bug.
 */
const IDENTITY_HEADER = new RegExp(String.raw`^${LABEL}[^\n]*${ID_SEPARATOR}[^\n]*\n\n`);

/**
 * Removes the label again, for a channel where it carries nothing.
 *
 * Written, it is a navigation aid: which conversation an answer belongs to and
 * its id, said once per chat. SPOKEN it is the opposite -- a conversation title
 * is derived from the sender's own first prompt, so the audio opened by reading
 * their own question back to them, then a shortened id letter by letter, before
 * any of the answer arrived.
 */
export function stripConversationIdentity(text: string): string {
  return text.replace(IDENTITY_HEADER, '');
}
