import type { ConversationRuntime } from './sessionTypes';
import type { CompactionDeps, CompactionOptions, CompactionOutcome } from './CompactionService';
import { getLogger } from '../util/logger';

const log = getLogger();

const MAX_AUTO_FAILURES_PER_USER_TURN = 2;

interface AutoFailureState {
  userMessageCount: number;
  failures: number;
}

/** Bounds retries for a visible-user turn while letting a transient failure recover. */
const autoFailures = new WeakMap<ConversationRuntime, AutoFailureState>();

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
  if (!conv) return compactOnce(deps, conversationId, options);
  const at = userMessageCount(conv);
  const state = autoFailures.get(conv);
  const current = state?.userMessageCount === at ? state : { userMessageCount: at, failures: 0 };
  if (state && state.userMessageCount !== at) autoFailures.delete(conv);
  if (options.auto && current.failures >= MAX_AUTO_FAILURES_PER_USER_TURN) {
    log.info('[auto-compact] skipped — the bounded failure limit was reached for this user turn');
    return 'skipped';
  }
  let outcome: CompactionOutcome = 'failed';
  try {
    outcome = await compactOnce(deps, conversationId, options);
    return outcome;
  } finally {
    if (outcome === 'compacted') {
      autoFailures.delete(conv);
    } else if (options.auto && outcome === 'failed') {
      autoFailures.set(conv, {
        userMessageCount: at,
        failures: current.failures + 1,
      });
    }
  }
}
