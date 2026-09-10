/**
 * Turning a remote command's argument into the thing it names.
 *
 * Split out of `RemoteCommandHandler` because these are pure resolvers: they
 * read the last pager selection and the host's conversation list and return an
 * id (or the sentence explaining why they could not), and touch no channel and
 * no host state. Owner of the argument→id rules for `/chat`, `/model` and
 * `/new <workspace>`, and of the miss messages that name the sanctioned list.
 */
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteInboundEvent } from './types';

/** The slice of `RemoteCommandContext` a resolver needs — deliberately narrow,
 *  so this module does not import back from the handler it was cut out of. */
export interface SelectionLookup {
  store: RemoteRequestStore;
  host: ForgeHostFacade;
}

type TextEvent = Extract<RemoteInboundEvent, { kind: 'text' }>;

/** A number read off the last `/chats`, `/models` or `/workspace` page. */
export function resolveSelection(
  context: SelectionLookup,
  event: TextEvent,
  kind: 'models' | 'conversations' | 'workspaces',
  argument: string,
): string | undefined {
  if (!/^\d+$/.test(argument)) return undefined;
  const selection = context.store.selection(event.channel, event.chatId, kind);
  const index = Number(argument) - 1;
  return selection && index >= 0 && index < selection.values.length
    ? selection.values[index]
    : undefined;
}

/**
 * A `/chat` argument: a pager number, a position in the newest-first list, or
 * a conversation title.
 *
 * The pager comes first because it preserves the exact list the person saw.
 * The number then falls back to the same order the pager uses, so `/chat 2`
 * works without having listed first.
 */
export function resolveConversationSelection(
  context: SelectionLookup,
  event: TextEvent,
  argument: string,
): string | undefined {
  const fromPager = resolveSelection(context, event, 'conversations', argument);
  if (fromPager) return fromPager;
  const conversations = recentConversations(context);
  if (!/^\d+$/.test(argument)) {
    // A title is what the person actually read off /chats — the list shows
    // names, not ids, so `/chat D` is the obvious thing to type and used to be
    // passed through as a literal id, which threw. Newest-first order settles a
    // duplicate title the same way the pager numbers one.
    const wanted = argument.trim().toLowerCase();
    return conversations.find((item) => item.title.trim().toLowerCase() === wanted)?.id;
  }
  const index = Number(argument) - 1;
  return index >= 0 && index < conversations.length ? conversations[index]!.id : undefined;
}

/** The /chats order, shared so a number and a title resolve off one list. */
function recentConversations(context: SelectionLookup) {
  return context.host
    .status()
    .conversations.slice()
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/** Why `/new <number>` found nothing: an expired list, an out-of-range number,
 *  or a genuinely unknown alias are three different fixes. */
export function numberedSelectionMiss(
  context: SelectionLookup,
  event: TextEvent,
  argument: string,
): string {
  if (!/^\d+$/.test(argument)) {
    // /new takes a WORKSPACE, so a conversation name lands here. Saying only
    // "not found" leaves the user re-typing the same wrong command; name the
    // one that does join an existing chat.
    return (
      `workspace “${argument}” was not found. Use /workspace to list workspaces, ` +
      'or /chat to join an existing conversation.'
    );
  }
  const selection = context.store.selection(event.channel, event.chatId, 'workspaces');
  if (!selection) return 'the workspace list expired; run /workspace again, then /new <number>';
  return `pick 1-${selection.values.length} from the last /workspace list`;
}

/** Conversation ids are UUIDs; a chat message wants the recognisable ends. */
export function shortId(id: string): string {
  return id.length > 7 ? `${id.slice(0, 3)}…${id.slice(-3)}` : id;
}
