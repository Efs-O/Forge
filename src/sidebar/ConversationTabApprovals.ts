import type { ConversationTabsDeps } from './ConversationTabs';
import { resetChatApprovals } from './chatApprovalRules';
import { clearConversationHostApprovals } from '../tools/fetchHostApprovals';

/** Reset an open or archived conversation by id, then persist its new state. */
export async function resetConversationTabApprovals(
  deps: Pick<ConversationTabsDeps, 'getSidebar' | 'persistSession' | 'archivedSessions'>,
  id: string,
): Promise<boolean> {
  const sidebar = deps.getSidebar();
  const conversation =
    sidebar.conversations.find((item) => item.id === id) ??
    sidebar.history.find((item) => item.id === id);
  if (conversation) {
    resetChatApprovals(conversation);
    return (await deps.persistSession()) !== false;
  }
  const stored = deps.archivedSessions?.read(id);
  if (!stored || !deps.archivedSessions) return false;
  stored.approval_rules = [];
  clearConversationHostApprovals(id);
  deps.archivedSessions.put(stored);
  return true;
}
