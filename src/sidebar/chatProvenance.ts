/** Shared title and sender-badge projection for panel rendering and host search. */
import type { TitleSource } from './conversationTitle';
import type { RemoteOriginChannel } from '../remote/remoteInboundSchema';

/** The agents the bus can start a chat, keyed by the name the bus writes. */
const KNOWN_AGENT_LABELS: ReadonlyMap<string, string> = new Map([
  ['claude', 'Claude'],
  ['codex', 'Codex'],
  ['copilot', 'Copilot'],
]);

/** A `<agent>: ` prefix that is the sender's name rather than part of the name. */
const AGENT_TITLE_PREFIX = /^(claude|codex|copilot):\s*/i;

/** The small outlined label beside a row: who this chat is answering, or `You`. */
export interface RowBadge {
  label: string;
  /**
   * `agent` takes the badge colour, `you` the quiet description colour. A chat
   * bound to a phone is `agent` too: the colour marks "this was not opened at
   * this machine", not "a model wrote it".
   */
  kind: 'agent' | 'you';
  /** The agent class the badge's colour comes from; absent for `You`. */
  agentClass?: string;
  /** Only where the label could be misread: a channel badge says what is bound, not how the chat began. */
  tooltip?: string;
}

/** The fields a row needs to name its sender — an open tab or a closed chat. */
export interface ChatProvenance {
  title: string;
  title_source?: TitleSource | undefined;
  origin_agent?: string | undefined;
  origin_channel?: RemoteOriginChannel;
}

/** A chat's title and label: the prefix an old bus chat was named with is not part of its name. */
export function chatRowView(item: ChatProvenance): { title: string; badge: RowBadge } {
  if (item.origin_agent) {
    const name = item.origin_agent.trim();
    const known = KNOWN_AGENT_LABELS.get(name.toLowerCase());
    // An unfamiliar bus peer keeps the name it sent. `You` would be a lie: a
    // person did not open this chat, and a silent badge would make it look like
    // the seven Claude chats beside it.
    return {
      title: item.title,
      badge: known
        ? { label: known, kind: 'agent', agentClass: `history-row-badge-${known.toLowerCase()}` }
        : { label: name, kind: 'agent' },
    };
  }
  const match = AGENT_TITLE_PREFIX.exec(item.title);
  const prefixLabel = match ? KNOWN_AGENT_LABELS.get(match[1]!.toLowerCase()) : undefined;
  // Chats written before `title_source` existed carry no field, and neither do
  // archive rows rebuilt from session logs — insisting on `prompt` there would
  // leave every old agent chat wearing the prefix this change exists to remove.
  // A name a person typed (`user`) or the retitle job gave (`auto`) is shown
  // exactly as written, prefix and all: nobody but a person chose that text.
  if (prefixLabel && match && item.title_source !== 'user' && item.title_source !== 'auto') {
    return {
      title: item.title.slice(match[0].length),
      badge: {
        label: prefixLabel,
        kind: 'agent',
        agentClass: `history-row-badge-${prefixLabel.toLowerCase()}`,
      },
    };
  }
  // A chat bound to a phone conversation is not `You` — nobody at this machine
  // opened it — and it is not an agent chat either, so it names the channel
  // rather than a model. The tooltip says what the badge actually means: a row
  // a person picked with `/chat` is bound too, so the badge may not claim the
  // phone started it. An unknown channel (`fake` is the test transport's) falls
  // through to `You`, because nothing here proves otherwise.
  if (item.origin_channel === 'telegram' || item.origin_channel === 'whatsapp') {
    const channel = item.origin_channel;
    const label = channel === 'telegram' ? 'Telegram' : 'WhatsApp';
    return {
      title: item.title,
      badge: {
        label,
        kind: 'agent',
        agentClass: `history-row-badge-${channel}`,
        tooltip: `Bound to a ${label} chat`,
      },
    };
  }
  return { title: item.title, badge: { label: 'You', kind: 'you' } };
}

/**
 * The rows that came in from a phone: the channel the remote store binds to a
 * conversation id, stamped onto the row that panel is about to draw. The
 * caller's reader may name any channel (`fake` is the test transport's); a
 * channel outside `RemoteOriginChannel` leaves its row exactly as it was, since
 * a badge that says the wrong thing is worse than a badge that is missing.
 */
export function withOriginChannel<T extends { id: string }>(
  rows: T[],
  originChannelOf?: (conversationId: string) => string | undefined,
): Array<T & { origin_channel?: RemoteOriginChannel }> {
  if (!originChannelOf) return rows;
  return rows.map((row): T & { origin_channel?: RemoteOriginChannel } => {
    const channel = originChannelOf(row.id);
    return channel === 'telegram' || channel === 'whatsapp'
      ? { ...row, origin_channel: channel }
      : row;
  });
}
