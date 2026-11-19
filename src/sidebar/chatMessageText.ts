import { displayTitle, isUntitled } from './conversationTitle';

const DEFAULT_CHAT_TITLE_LENGTH = 40;
const MESSAGE_TRAILER =
  '(Reply with message_chat to "{id}" if you need to; no need to just acknowledge.)';
const LEGACY_MESSAGE_TRAILER =
  '(Answer with message_chat to {id} only if a reply is needed; do not reply just to acknowledge.)';

export type ChatMessageMirrorStatus = 'tell' | 'turn' | 'unconfirmed' | 'steer' | undefined;

/** A compact title for chat-to-chat messages and their Telegram mirror. */
export function shortChatTitle(title: string, max = DEFAULT_CHAT_TITLE_LENGTH): string {
  let short = title
    .trim()
    .replace(/^(Claude|Codex|Copilot): /u, '')
    .trim();
  if (isUntitled(short)) return 'new chat';

  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : DEFAULT_CHAT_TITLE_LENGTH;
  const sentenceEnd = short.indexOf('. ');
  if (sentenceEnd >= 4 && sentenceEnd <= limit) short = short.slice(0, sentenceEnd).trim();
  else if (short.length > limit) short = `${short.slice(0, limit - 1)}…`;

  return short || 'new chat';
}

/** Quote a title for a human-readable tool result without JSON escape slashes. */
export function quoteTitle(title: string): string {
  return `"${title.replace(/"/gu, "'")}"`;
}

/** The message body persisted in the receiving chat's transcript. */
export function formatChatMessage(senderTitle: string, senderId: string, body: string): string {
  const title = shortChatTitle(senderTitle);
  return `📨 Message from ${title} (id ${senderId}):\n${body}\n\n${MESSAGE_TRAILER.replace('{id}', senderId)}`;
}

/** Parse current and persisted legacy message_chat transcript entries. */
export function parseChatMessage(
  content: string,
): { fromTitle: string; fromId: string; body: string } | undefined {
  const headerEnd = content.indexOf('\n');
  if (headerEnd < 0) return undefined;
  const header = content.slice(0, headerEnd);
  const bodyStart = headerEnd + 1;

  const current = /^📨 Message from (.+) \(id (.+)\):$/u.exec(header);
  if (current) {
    const fromId = current[2]!;
    const trailer = `\n\n${MESSAGE_TRAILER.replace('{id}', fromId)}`;
    const trailerStart = content.lastIndexOf(trailer);
    if (trailerStart < bodyStart || trailerStart + trailer.length !== content.length)
      return undefined;
    return {
      fromTitle: shortChatTitle(current[1]!),
      fromId,
      body: content.slice(bodyStart, trailerStart),
    };
  }

  const legacy = /^\[message_chat from #\d+ (".+") \(id (.+)\)\]$/u.exec(header);
  if (!legacy) return undefined;

  let legacyTitle: unknown;
  try {
    legacyTitle = JSON.parse(legacy[1]!);
  } catch {
    return undefined;
  }
  if (typeof legacyTitle !== 'string') return undefined;

  const fromId = legacy[2]!;
  const trailer = `\n\n${LEGACY_MESSAGE_TRAILER.replace('{id}', JSON.stringify(fromId))}`;
  const trailerStart = content.lastIndexOf(trailer);
  if (trailerStart < bodyStart || trailerStart + trailer.length !== content.length)
    return undefined;
  return {
    fromTitle: shortChatTitle(legacyTitle),
    fromId,
    body: content.slice(bodyStart, trailerStart),
  };
}

/** The slice of a conversation this projection reads: enough to name it and scan its transcript. */
export interface MessagedChatSource {
  id: string;
  title: string;
  messages: readonly { role: string; content: unknown }[];
}

/** A messaged chat, as the tab meta and the header chip carry it. */
export interface MessagedChatRef {
  id: string;
  title: string;
}

/** The two transcript markers a `message_chat` tell arrives as (current and persisted legacy). */
const CHAT_TELL_MARKERS = ['📨 Message from ', '[message_chat from #'] as const;

/**
 * Consecutive tells can be persisted as ONE user message joined by a blank line
 * (`groupTellBatches`, `src/sidebar/undeliveredTells.ts`), so a merged batch is
 * cut back apart at each boundary a real trailer leaves behind before parsing.
 */
const CHAT_TELL_BOUNDARY = /(?<=\.\))\n\n(?=📨 Message from |\[message_chat from #)/u;

/** Resolve a persisted id prefix to the one open chat it can only have meant. */
function resolveMessagedChat(
  conversations: readonly MessagedChatSource[],
  receiverId: string,
  fromId: string,
): MessagedChatSource | undefined {
  const prefix = fromId.toLowerCase();
  let match: MessagedChatSource | undefined;
  for (const conversation of conversations) {
    if (conversation.id === receiverId) continue;
    if (!conversation.id.toLowerCase().startsWith(prefix)) continue;
    // Two open chats share the prefix, so it names neither of them.
    if (match) return undefined;
    match = conversation;
  }
  return match;
}

/**
 * Which open chats talk to each other through `message_chat`, for the "Forge"
 * chip in the chat header. A chat's messaged chats are the other OPEN chats
 * whose transcripts carry a message between the two, so the chip vanishes when
 * either side closes and nothing is stored: it is recomputed per tab projection.
 * After `/compact` the transcript no longer holds the messages, and the chip
 * goes with them (accepted limit).
 *
 * Each list is in `conversations` order without duplicates, and a chat is never
 * in its own list. A conversation with no messaged chat has no entry at all.
 */
export function messagedChatsByConversation(
  conversations: readonly MessagedChatSource[],
): Map<string, MessagedChatRef[]> {
  const peers = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    if (a === b) return;
    const forward = peers.get(a) ?? new Set<string>();
    forward.add(b);
    peers.set(a, forward);
    const backward = peers.get(b) ?? new Set<string>();
    backward.add(a);
    peers.set(b, backward);
  };
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      if (message.role !== 'user') continue;
      const content = message.content;
      if (typeof content !== 'string') continue;
      if (!CHAT_TELL_MARKERS.some((marker) => content.includes(marker))) continue;
      for (const segment of content.split(CHAT_TELL_BOUNDARY)) {
        const parsed = parseChatMessage(segment);
        if (!parsed) continue;
        const peer = resolveMessagedChat(conversations, conversation.id, parsed.fromId);
        if (peer) link(conversation.id, peer.id);
      }
    }
  }
  const out = new Map<string, MessagedChatRef[]>();
  for (const conversation of conversations) {
    const ids = peers.get(conversation.id);
    if (!ids?.size) continue;
    out.set(
      conversation.id,
      conversations
        .filter((other) => ids.has(other.id))
        .map((other) => ({ id: other.id, title: displayTitle(other.title) })),
    );
  }
  return out;
}

/** Format the chat-to-chat activity line shown in the Telegram mirror. */
export function formatChatMirrorLine(
  direction: 'in' | 'out',
  otherTitle: string,
  status: ChatMessageMirrorStatus,
  body: string,
): string {
  const title = shortChatTitle(otherTitle);
  const label = direction === 'in' ? `📨 ${title} → this chat` : `📤 this chat → ${title}`;
  const statusText =
    status === 'tell'
      ? 'busy · queued, not processed yet'
      : status === 'turn'
        ? 'idle · started a turn'
        : status === 'unconfirmed'
          ? 'not confirmed yet'
          : status === 'steer'
            ? 'steering · interrupts its turn if it is generating'
            : undefined;
  return `${label}${statusText ? `  (${statusText})` : ''}\n${body}`;
}
