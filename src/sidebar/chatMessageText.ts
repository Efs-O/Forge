import { isUntitled } from './conversationTitle';

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
      ? 'busy · reads it mid-turn'
      : status === 'turn'
        ? 'idle · started a turn'
        : status === 'unconfirmed'
          ? 'not confirmed yet'
          : status === 'steer'
            ? 'steering · interrupts its turn'
            : undefined;
  return `${label}${statusText ? `  (${statusText})` : ''}\n${body}`;
}
