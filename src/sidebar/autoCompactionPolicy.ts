import type { ConversationRuntime } from './sessionTypes';
import type { HostToWebview } from './messageBridge';
import type { RequestChainContext, RequestChainLifecycle } from './RequestChainLifecycle';
import type { ContextThresholdAction } from './ContextBudgetPublisher';
import {
  MAX_CONSECUTIVE_AUTO_CONTINUES,
  RESUME_PROMPT,
  type CompactionOutcome,
} from './CompactionService';

export interface AddressedAutoCompactDeps {
  post: (message: HostToWebview) => void;
  requestChains: Pick<RequestChainLifecycle, 'setStage'>;
  compact: (conversationId: string) => Promise<CompactionOutcome>;
  incompleteTurnReason: (conversationId: string) => string | undefined;
  resumeEnabled: () => boolean;
}

/** Compact and decide whether the managed request chain should continue. */
export async function runAddressedAutoCompact(
  deps: AddressedAutoCompactDeps,
  conv: ConversationRuntime,
  chain: RequestChainContext,
): Promise<ContextThresholdAction | undefined> {
  const reason = deps.incompleteTurnReason(conv.id);
  deps.requestChains.setStage(chain, 'compacting');
  const outcome = await deps.compact(conv.id);
  if (outcome !== 'compacted' || !deps.resumeEnabled()) return undefined;
  if (chain.autoContinueCount >= MAX_CONSECUTIVE_AUTO_CONTINUES) {
    deps.post({
      type: 'notice',
      message:
        'Forge: compacted again without finishing. Stopping here so this does not loop — send a prompt to continue.',
      conversationId: conv.id,
    });
    return undefined;
  }
  chain.autoContinueCount += 1;
  deps.post({
    type: 'notice',
    message: reason
      ? `Context compacted mid-task (${reason}). Resuming.`
      : 'Context compacted. Continuing the active task.',
    conversationId: conv.id,
  });
  return { kind: 'continue', text: RESUME_PROMPT, options: { internal: true } };
}
