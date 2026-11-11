import type { AgentKind, AgentLink, AgentSender, AgentSenderMetadata } from './chatAgentLinks';
import {
  addChatForSession,
  agentDisplayName,
  chatsForSession,
  findSessionChatIn,
  get,
  link,
  touch,
} from './chatAgentLinks';
import type { SidebarRuntime, ConversationRuntime } from '../sidebar/sessionTypes';
import { isUntitled } from '../sidebar/conversationTitle';

/**
 * Where an inbound `forge.sh` message lands, and which link it uses.
 *
 * One agent session may now be linked to several Forge chats
 * (docs/plans/V1_FINISH_PLAN.md lane 4 phase 5), so this file decides between
 * chats rather than between "linked" and "not linked":
 * - `say` with no `--to` goes to the chat the session last addressed.
 * - `--to <id>` is legal for any chat already linked to this session, and for
 *   an open chat that holds no link of this kind (that one gets linked). A chat
 *   whose link of this kind names a different session is still refused.
 * - `--new` adds a chat to the set instead of moving the link, so the chat the
 *   session was addressing keeps its link and stays reachable with `--to`.
 *
 * The index in `chatAgentLinks.ts` is process-wide, so the current chat may
 * belong to another window: every choice here is proven against this window's
 * own chat list, and the newest chat this window holds is used when the current
 * one is not here.
 */
export interface InboundAgentSelection {
  conversationId?: string;
  runningConversationId?: string;
  newChat?: boolean;
}

export interface InboundAgentTarget {
  conversationId: string;
  title: string;
  sender: AgentSenderMetadata;
  link: AgentLink;
  /**
   * The chat this session was addressing when it asked for a new one. It keeps
   * its link, so the notice is written on it and `--to` still reaches it.
   */
  alsoLinkedFrom?: { conversationId: string; title: string };
}

/** The one wording for a requested chat id this window does not hold (say, status, view, stop). */
export function chatNotOpenHereMessage(conversationId: string): string {
  return `Forge chat "${conversationId}" is not open in this window. If it is open in another Forge window, send from a session linked there.`;
}

/** A requested chat id that this VS Code window does not currently hold. */
export class InboundAgentChatNotOpenError extends Error {
  constructor(readonly conversationId: string) {
    super(chatNotOpenHereMessage(conversationId));
  }
}

export interface InboundAgentRoutingDeps {
  sidebar: SidebarRuntime;
  sender: AgentSender;
  selection: InboundAgentSelection;
  workspaceRoot?: string;
  createChat(): ConversationRuntime | undefined;
  restoreChat(id: string): ConversationRuntime | undefined;
  persist(): void;
}

function conversations(sidebar: SidebarRuntime): ConversationRuntime[] {
  return [...sidebar.conversations, ...sidebar.history];
}

function byId(sidebar: SidebarRuntime, id: string): ConversationRuntime | undefined {
  return conversations(sidebar).find((conversation) => conversation.id === id);
}

function requireChat(chat: ConversationRuntime | undefined, label: string): ConversationRuntime {
  if (!chat) throw new Error(`Forge could not open ${label}.`);
  return chat;
}

function createInboundLink(sender: AgentSender, cwd: string | undefined): AgentLink {
  if (!cwd) throw new Error('An open workspace folder is required to link this inbound session.');
  const now = Date.now();
  return {
    ...sender,
    cwd,
    title: `${agentDisplayName(sender.kind)} session ${sender.sessionId.slice(0, 8)}`,
    linkedAt: now,
    lastUsedAt: now,
    origin: 'first-inbound',
  };
}

function linkNewSender(
  sender: AgentSender,
  chat: ConversationRuntime,
  cwd: string | undefined,
): AgentLink {
  return link(chat, createInboundLink(sender, cwd));
}

function makeTarget(
  chat: ConversationRuntime,
  sender: AgentSender,
  linked: AgentLink,
  alsoLinkedFrom?: { conversationId: string; title: string },
): InboundAgentTarget {
  return {
    conversationId: chat.id,
    title: chat.title,
    sender: { kind: sender.kind, sessionId: sender.sessionId, title: linked.title },
    link: linked,
    ...(alsoLinkedFrom ? { alsoLinkedFrom } : {}),
  };
}

export function resolveInboundAgentTarget(deps: InboundAgentRoutingDeps): InboundAgentTarget {
  const { sidebar, sender, selection } = deps;
  const all = conversations(sidebar);
  const ownedIds = chatsForSession(sender.sessionId);
  // Newest first, but only chats this window actually holds: the index is
  // shared across windows, so the session's current chat may live in another
  // one and this window must still be able to act on its own chat.
  const ownerId = findSessionChatIn(sender.sessionId, sender.kind, (id, kind) => {
    const chat = all.find((item) => item.id === id);
    return chat ? get(chat, kind) : undefined;
  });
  const owner = ownerId ? all.find((chat) => chat.id === ownerId) : undefined;

  if (ownedIds.length > 0 && !owner)
    throw new Error(`The linked chat "${ownedIds[0]}" for ${sender.kind} is unavailable.`);

  if (selection.newChat) {
    const chat = requireChat(deps.createChat(), 'a new chat');
    const linked = owner
      ? addChatForSession(owner, chat, sender.kind)
      : linkNewSender(sender, chat, deps.workspaceRoot);
    deps.persist();
    return makeTarget(
      chat,
      sender,
      linked,
      owner ? { conversationId: owner.id, title: owner.title } : undefined,
    );
  }

  const requestedId = selection.conversationId ?? selection.runningConversationId;
  if (requestedId) {
    const selected = byId(sidebar, requestedId);
    if (!selected) throw new InboundAgentChatNotOpenError(requestedId);
    const existing = get(selected, sender.kind);
    // The one thing still refused: this chat is somebody else's link of this
    // kind. Being linked to a different chat of the same session is not a
    // reason to refuse — that is the whole point of `--to` after `say --new`.
    if (existing && existing.sessionId !== sender.sessionId)
      throw new Error(`Chat "${selected.title}" already links a different ${sender.kind} session.`);
    const chat = sidebar.conversations.some((item) => item.id === selected.id)
      ? selected
      : requireChat(deps.restoreChat(selected.id), `chat "${selected.title}"`);
    const linked = existing
      ? touch(chat, sender.kind)
      : linkNewSender(sender, chat, deps.workspaceRoot);
    // Both paths changed this chat's link: `touch` makes it the chat the
    // session addresses next, and a fresh link has to be saved to survive.
    deps.persist();
    return makeTarget(chat, sender, linked);
  }

  if (owner) {
    const chat = sidebar.conversations.some((item) => item.id === owner.id)
      ? owner
      : requireChat(deps.restoreChat(owner.id), `chat "${owner.title}"`);
    const linked = get(chat, sender.kind);
    if (!linked || linked.sessionId !== sender.sessionId)
      throw new Error(`The link for ${sender.kind} session ${sender.sessionId} changed.`);
    return makeTarget(chat, sender, linked);
  }

  const active = byId(sidebar, sidebar.activeConversationId);
  if (!active) throw new Error('Forge has no active chat for this message.');
  if (!get(active, sender.kind)) {
    const linked = linkNewSender(sender, active, deps.workspaceRoot);
    deps.persist();
    return makeTarget(active, sender, linked);
  }

  const chat = requireChat(deps.createChat(), 'a new chat for this session');
  const linked = linkNewSender(sender, chat, deps.workspaceRoot);
  deps.persist();
  return makeTarget(chat, sender, linked);
}

export function formatAlsoLinkedNotice(kind: AgentKind, link: AgentLink, newTitle: string): string {
  // A chat opened for this message is still untitled here: its first prompt names it later.
  const destination = isUntitled(newTitle) ? 'a new chat' : `chat "${newTitle}"`;
  return `${agentDisplayName(kind)} session "${link.title}" started ${destination} as well; this chat keeps its link and stays reachable with --to.`;
}
