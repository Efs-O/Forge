import type { ConversationRuntime } from './sessionTypes';
import type { CompactionDeps, CompactionOptions, CompactionOutcome } from './CompactionService';
import { getLogger } from '../util/logger';

const log = getLogger();

/**
 * The conversation's user-message count at its last failed automatic attempt.
 * Manual and remote requests remain available while the automatic path is held.
 */
const failedAutoAt = new WeakMap<ConversationRuntime, number>();

function userMessageCount(conv: ConversationRuntime): number {
  return conv.messages.filter((message) => message.role === 'user' && message.internal !== true)
    .length;
}

export async function runCompactionWithPolicy(
  deps: CompactionDeps,
  conversationId: string,
  options: CompactionOptions,
  compactOnce: (
    deps: CompactionDeps,
    conversationId: string,
    options: CompactionOptions,
  ) => Promise<CompactionOutcome>,
): Promise<CompactionOutcome> {
  const conv = deps.getConversation(conversationId);
  if (!options.auto || !conv) return compactOnce(deps, conversationId, options);
  const at = userMessageCount(conv);
  if (failedAutoAt.get(conv) === at) {
    log.info('[auto-compact] skipped — the last attempt failed and no new user message since');
    return 'skipped';
  }
  let outcome: CompactionOutcome = 'failed';
  try {
    outcome = await compactOnce(deps, conversationId, options);
    return outcome;
  } finally {
    if (outcome === 'failed') failedAutoAt.set(conv, at);
    else failedAutoAt.delete(conv);
  }
}
