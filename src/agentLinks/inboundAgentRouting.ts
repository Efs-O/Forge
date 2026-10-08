import type { AgentKind, AgentLink, AgentSender, AgentSenderMetadata } from './chatAgentLinks';
import { agentDisplayName, findBySession, get, link, move } from './chatAgentLinks';
import type { SidebarRuntime, ConversationRuntime } from '../sidebar/sessionTypes';

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
  movedFrom?: { conversationId: string; title: string };
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
  sidebar: SidebarRuntime,
  cwd: string | undefined,
): AgentLink {
  return link(chat, createInboundLink(sender, cwd), conversations(sidebar));
}

function makeTarget(
  chat: ConversationRuntime,
  sender: AgentSender,
  linked: AgentLink,
  movedFrom?: { conversationId: string; title: string },
): InboundAgentTarget {
  return {
    conversationId: chat.id,
    title: chat.title,
    sender: { kind: sender.kind, sessionId: sender.sessionId, title: linked.title },
    link: linked,
    ...(movedFrom ? { movedFrom } : {}),
  };
}

export function resolveInboundAgentTarget(deps: InboundAgentRoutingDeps): InboundAgentTarget {
  const { sidebar, sender, selection } = deps;
  const all = conversations(sidebar);
  const ownerId = findBySession(sender.sessionId);
  const owner = ownerId ? all.find((chat) => chat.id === ownerId) : undefined;
  if (ownerId && !owner)
    throw new Error(`The linked chat "${ownerId}" for ${sender.kind} is unavailable.`);

  if (selection.newChat) {
    const old = owner;
    const chat = requireChat(deps.createChat(), 'a new chat');
    const linked = old
      ? move(old, chat, sender.kind, [...all, chat])
      : linkNewSender(sender, chat, sidebar, deps.workspaceRoot);
    deps.persist();
    return makeTarget(
      chat,
      sender,
      linked,
      old ? { conversationId: old.id, title: old.title } : undefined,
    );
  }

  const requestedId = selection.conversationId ?? selection.runningConversationId;
  if (requestedId) {
    const selected = byId(sidebar, requestedId);
    if (!selected) throw new Error(`Forge chat "${requestedId}" is no longer open.`);
    if (owner && owner.id !== selected.id)
      throw new Error(`This session is linked to chat "${owner.title}".`);
    const existing = get(selected, sender.kind);
    if (existing && existing.sessionId !== sender.sessionId)
      throw new Error(`Chat "${selected.title}" already links a different ${sender.kind} session.`);
    const chat = sidebar.conversations.some((item) => item.id === selected.id)
      ? selected
      : requireChat(deps.restoreChat(selected.id), `chat "${selected.title}"`);
    const linked = existing ?? linkNewSender(sender, chat, sidebar, deps.workspaceRoot);
    if (!existing) deps.persist();
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
    const linked = linkNewSender(sender, active, sidebar, deps.workspaceRoot);
    deps.persist();
    return makeTarget(active, sender, linked);
  }

  const chat = requireChat(deps.createChat(), 'a new chat for this session');
  const linked = linkNewSender(sender, chat, sidebar, deps.workspaceRoot);
  deps.persist();
  return makeTarget(chat, sender, linked);
}

export function formatMovedSessionNotice(
  kind: AgentKind,
  link: AgentLink,
  newTitle: string,
): string {
  return `${agentDisplayName(kind)} session "${link.title}" moved to chat "${newTitle}".`;
}
