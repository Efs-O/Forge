import type { ConversationRuntime } from './sessionTypes';
import type { CompactionDeps, CompactionOptions, CompactionOutcome } from './CompactionService';
import type { CompactionFailureCategory } from './compactionFailure';
import { getLogger } from '../util/logger';
import { reportedContextTokens } from '../util/contextBudget';

const FIRST_TRANSIENT_RETRY_MS = 30_000;
const MAX_TRANSIENT_RETRY_MS = 5 * 60_000;
const CONTEXT_GROWTH_FRACTION = 0.02;
const MIN_CONTEXT_GROWTH_TOKENS = 1_024;

interface AutoFailureState {
  userMessageCount: number;
  failures: number;
  failureCategory: CompactionFailureCategory;
  failedAt: number;
  contextTokens: number;
  modelMaxTokens: number;
}

/** In-memory by design; a reload discards a stale hold and rechecks context. */
const autoFailures = new WeakMap<ConversationRuntime, AutoFailureState>();
const log = getLogger();

function userMessageCount(conv: ConversationRuntime): number {
  return conv.messages.filter((message) => message.role === 'user' && message.internal !== true)
    .length;
}

function contextGrowthThreshold(modelMaxTokens: number): number {
  return Math.max(MIN_CONTEXT_GROWTH_TOKENS, Math.ceil(modelMaxTokens * CONTEXT_GROWTH_FRACTION));
}

function retryDelay(failures: number): number {
  return Math.min(
    MAX_TRANSIENT_RETRY_MS,
    FIRST_TRANSIENT_RETRY_MS * 2 ** Math.min(failures - 1, 4),
  );
}

function mayRearm(
  state: AutoFailureState,
  contextTokens: number,
  modelMaxTokens: number,
  now: number,
): boolean {
  const grew =
    contextTokens - state.contextTokens >=
    contextGrowthThreshold(modelMaxTokens || state.modelMaxTokens);
  if (grew) return true;
  if (state.failureCategory !== 'model-error' && state.failureCategory !== 'unknown') return false;
  // One transient failure still gets an immediate second attempt.
  if (state.failures < 2) return true;
  return now - state.failedAt >= retryDelay(state.failures - 1);
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
  const now = Date.now();
  const contextTokens = reportedContextTokens(conv);
  const modelMaxTokens = deps.compactionMetrics?.(conv)?.max ?? 0;
  const saved = autoFailures.get(conv);
  if (saved && saved.userMessageCount !== at) autoFailures.delete(conv);
  const state = saved?.userMessageCount === at ? saved : undefined;
  if (options.auto && state && !mayRearm(state, contextTokens, modelMaxTokens, now)) {
    log.info(
      `[auto-compact] suppressed after ${state.failureCategory}; ` +
        `next transient retry after ${retryDelay(state.failures - 1)}ms or ${contextGrowthThreshold(modelMaxTokens || state.modelMaxTokens)} context tokens`,
    );
    return 'skipped';
  }

  let outcome: CompactionOutcome = 'failed';
  let failureCategory: CompactionFailureCategory = 'unknown';
  const attemptOptions: CompactionOptions = options.auto
    ? {
        ...options,
        onFailureCategory: (category) => {
          failureCategory = category;
        },
      }
    : options;
  try {
    outcome = await compactOnce(deps, conversationId, attemptOptions);
    return outcome;
  } finally {
    if (outcome === 'compacted') {
      // Manual and remote success also recover the automatic path.
      autoFailures.delete(conv);
    } else if (options.auto && outcome === 'failed') {
      autoFailures.set(conv, {
        userMessageCount: at,
        failures: (state?.failures ?? 0) + 1,
        failureCategory,
        failedAt: Date.now(),
        contextTokens: reportedContextTokens(conv),
        modelMaxTokens: deps.compactionMetrics?.(conv)?.max ?? modelMaxTokens,
      });
    }
  }
}
