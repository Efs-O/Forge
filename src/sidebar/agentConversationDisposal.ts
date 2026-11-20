import type { CliSessionRegistry } from '../agents/CliSessionRegistry';
import { clearConversationHostApprovals } from '../tools/fetchHostApprovals';
import { clearConversationExfilState } from '../tools/exfilTaint';
import { clearConversationFileReads } from '../agent/fileChangeReminder';
import type { ToolApprovalService } from './ToolApprovalService';
import { clearChatRules } from './chatApprovalRules';
import type { LiveStreamMeter } from './LiveStreamMeter';
import type { SessionTimer } from './SessionTimer';
import type { ConversationRuntime } from './sessionTypes';

/** Dispose state whose lifetime is one conversation runtime. */
export function disposeAgentConversation(
  id: string,
  deps: {
    approvals: Pick<ToolApprovalService, 'cancelConversation' | 'clearConversationState'>;
    lookup: (id: string) => ConversationRuntime | undefined;
    sessionTimer: Pick<SessionTimer, 'disposeConversation'>;
    streamMeter: Pick<LiveStreamMeter, 'reset'>;
    cliSessions: Pick<CliSessionRegistry, 'disposeConversation'>;
  },
): Promise<void> {
  deps.approvals.cancelConversation(id);
  deps.approvals.clearConversationState(id);
  // The secret flag, the approved hosts and phase 4's untrusted-content flag are
  // chat-scoped like the chat itself: a new chat asks again, and a flag outliving
  // its chat would gate the next one for a page it never read.
  clearConversationHostApprovals(id);
  clearConversationExfilState(id);
  // What this chat had read, for the file-change reminder, is chat-scoped the same
  // way: a new chat has read nothing, and a record outliving its chat would blame
  // the next one's writer for a read it never made.
  clearConversationFileReads(id);
  const conversation = deps.lookup(id);
  if (conversation) {
    // Session-only: the peer's last-writer hint must not survive this runtime's disposal.
    delete conversation.latestPeerWriter;
    // The chat's approval rules are chat-scoped like the hosts it approved: a
    // deleted chat takes its record with it, and a rule outliving its chat would
    // answer a card for a chat that never earned it.
    clearChatRules(conversation);
    deps.sessionTimer.disposeConversation(conversation);
  }
  deps.streamMeter.reset(id);
  return deps.cliSessions.disposeConversation(id);
}
