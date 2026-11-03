/** The asynchronous, persistence-checked archive boundary for idle chats. */
import type { HostToWebview } from './messageBridge';
import { opCloseConversation } from './ConversationOps';
import type { ConversationRetentionScheduler } from './ConversationRetentionScheduler';
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';

export interface ConversationTabRetentionDeps {
  getSidebar: () => SidebarRuntime;
  setSidebar: (next: SidebarRuntime) => void;
  persistSession: () => void | Promise<boolean>;
  persistSidebar: (next: SidebarRuntime) => Promise<boolean>;
  post: (message: HostToWebview) => void;
  isConversationEvictable: (id: string) => boolean;
  retention: Pick<ConversationRetentionScheduler, 'isExpired'>;
  refreshUi: (options?: { sessionPersisted?: boolean }) => void;
}

/** Revalidates after disk commit so a prompt, pin, draft report or new view wins a race. */
export async function archiveExpiredConversation(
  deps: ConversationTabRetentionDeps,
  id: string,
  expectedActivityAt: number,
  disposeEvictedConversation: (id: string, remaining: SidebarRuntime) => void,
): Promise<boolean> {
  const sidebar = deps.getSidebar();
  const conversation = sidebar.conversations.find((item) => item.id === id);
  if (!isEligible(deps, sidebar, conversation, id, expectedActivityAt)) return false;
  const closed = opCloseConversation(sidebar, id);
  if (!closed) return false;
  if (!(await deps.persistSidebar(closed.sidebar))) {
    deps.post({
      type: 'error',
      message: `Forge: Could not archive expired chat "${conversation.title}". It remains open.`,
    });
    return false;
  }

  const liveSidebar = deps.getSidebar();
  const liveConversation = liveSidebar.conversations.find((item) => item.id === id);
  if (
    liveSidebar !== sidebar ||
    !isEligible(deps, liveSidebar, liveConversation, id, expectedActivityAt)
  ) {
    if ((await deps.persistSession()) === false) {
      deps.post({
        type: 'error',
        message: `Forge: Chat "${conversation.title}" changed while its archive was saving. Its latest state could not be saved, so it remains open in memory.`,
      });
    } else {
      deps.post({
        type: 'error',
        message: `Forge: Chat "${conversation.title}" changed while its archive was saving. The archive was cancelled and the chat remains open.`,
      });
    }
    return false;
  }

  deps.setSidebar(closed.sidebar);
  disposeEvictedConversation(id, closed.sidebar);
  deps.refreshUi({ sessionPersisted: true });
  return true;
}

function isEligible(
  deps: ConversationTabRetentionDeps,
  sidebar: SidebarRuntime,
  conversation: ConversationRuntime | undefined,
  id: string,
  expectedActivityAt: number,
): conversation is ConversationRuntime {
  return Boolean(
    conversation &&
    id !== sidebar.activeConversationId &&
    conversation.keep_open !== true &&
    conversation.retention_activity_at === expectedActivityAt &&
    deps.retention.isExpired(conversation) &&
    deps.isConversationEvictable(id),
  );
}
