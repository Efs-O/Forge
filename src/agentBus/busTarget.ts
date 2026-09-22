import type { ForgeHostStatus } from '../sidebar/ForgeHostFacade';
import type { ForgeExchange } from '../sidebar/sessionProjections';
import { parseForgeInboundPrompt } from './busContent';

/** How many recent exchanges per conversation are searched for the sender. */
export const BUS_TARGET_SCAN = 200;

/**
 * The chat a bus message without `--new` belongs in
 * (docs/plans/AGENT_BUS_CHAT_AFFINITY_PLAN.md): the most recently updated open
 * conversation already holding a prompt from `from`, else the active one.
 *
 * "The active tab" alone sent a sender's follow-up wherever the user happened
 * to be looking — after a reload or another sender's `--new`, a different chat.
 * Derived from the conversations on every call, so nothing is stored and a
 * reload cannot lose it. A prompt counts once answered (`recentExchanges`).
 * Archived (closed) tabs are skipped: closing one is the user saying stop
 * routing there.
 */
export function busTargetConversation(
  from: string | undefined,
  status: Pick<ForgeHostStatus, 'activeConversationId' | 'conversations'>,
  exchanges: (conversationId: string) => ForgeExchange[],
): string {
  if (!from) return status.activeConversationId;
  const sender = from.trim().toLowerCase();
  const candidates = status.conversations
    .filter((conv) => !conv.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const conv of candidates) {
    // The title covers a chat the sender started whose early prompts a
    // compaction has since folded into a summary.
    const fromSender =
      conv.title.toLowerCase().startsWith(`${sender}: `) ||
      exchanges(conv.id).some(
        (exchange) => parseForgeInboundPrompt(exchange.prompt)?.from.toLowerCase() === sender,
      );
    if (fromSender) return conv.id;
  }
  return status.activeConversationId;
}
