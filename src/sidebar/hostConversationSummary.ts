/**
 * The one projection from a stored conversation to the summary a host caller
 * sees (`ForgeConversationSummary` in `ForgeHostFacade.ts`).
 *
 * Split out because `ForgeHostFacade.ts` sits at its 500-line stop and this is
 * field-by-field projection with no behaviour: the facade keeps the behaviour.
 *
 * `titleSource` is part of the summary because the daily retitle job runs
 * outside the sidebar and a summary is the only view of a chat it has: which
 * chats may be renamed is decided from this field
 * (`src/jobs/retitleCandidates.ts`).
 */
import type { ConversationRuntime } from './sessionTypes';
import type { ForgeConversationSummary } from './ForgeHostFacade';

export function summarizeConversation(
  conv: ConversationRuntime,
  archived: boolean,
  activeMs: number,
): ForgeConversationSummary {
  return {
    id: conv.id,
    title: conv.title,
    ...(conv.title_source ? { titleSource: conv.title_source } : {}),
    activeModel: conv.active_model ?? null,
    archived,
    updatedAt: conv.updatedAt,
    requestCount: conv.model_request_count ?? 0,
    toolCallCount: conv.tool_call_count ?? 0,
    compactCount: conv.compaction?.generation ?? 0,
    activeMs,
    clanker: conv.clanker === true,
  };
}
