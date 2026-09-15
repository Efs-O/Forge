/**
 * Compaction between two rounds of a running turn.
 *
 * The post-turn trigger (`ContextBudgetPublisher.evaluateThresholds`) never sees
 * a long turn's growth: one turn can start at 60% and exhaust the window before
 * it ends, and the user got a failed turn, a "send a new instruction", and then
 * an automatic resume contradicting both. See docs/plans/MID_TURN_COMPACTION_PLAN.md.
 */

import type { ForgeConfig } from '../config/types';
import type { ConversationRuntime } from './sessionTypes';
import type { CompactionOutcome } from './CompactionService';
import { DEFAULT_AUTO_COMPACT_AT } from './ContextBudgetPublisher';
import { getLogger } from '../util/logger';

const log = getLogger();

/**
 * Appended after a mid-turn compaction. The compacted window ends on the
 * summary's assistant half whenever no tail was retained — and mid-turn one
 * almost never is — which llama-server would continue as a prefill. Neutral on
 * purpose, like RESUME_PROMPT: the task state lives in the compacted context.
 */
export const MID_TURN_RESUME_NUDGE =
  'Forge: the context was compacted mid-task to make room. Continue the active task from the compacted context.';

export interface MidTurnCompactionDeps {
  getConfig: () => ForgeConfig;
  /** Measured usage and per-slot window — the numbers the post-turn trigger reads. */
  snapshot: (conv: ConversationRuntime) => { used: number; max: number };
  compact: (conversationId: string) => Promise<CompactionOutcome>;
}

/** Resolves true only when the conversation was compacted. */
export async function compactMidTurn(
  deps: MidTurnCompactionDeps,
  conv: ConversationRuntime,
  request: { exhausted: boolean },
): Promise<boolean> {
  const auto = deps.getConfig().auto_compact;
  // `resume: false` opts out of Forge continuing a task on its own after a
  // compaction, which is exactly what compacting mid-turn does.
  if (auto?.enabled !== true || auto.resume === false) return false;
  if (!request.exhausted) {
    const { used, max } = deps.snapshot(conv);
    if (max <= 0 || used / max < (auto.at ?? DEFAULT_AUTO_COMPACT_AT)) return false;
    log.info(`[auto-compact] mid-turn at ${Math.round((used / max) * 100)}% — compacting`);
  } else {
    log.info('[auto-compact] next round cannot fit — compacting mid-turn');
  }
  if ((await deps.compact(conv.id)) !== 'compacted') return false;
  conv.messages.push({ role: 'user', content: MID_TURN_RESUME_NUDGE, internal: true });
  return true;
}
