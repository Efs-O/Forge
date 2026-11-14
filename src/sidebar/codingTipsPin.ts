/**
 * Keeps a chat's system prompt byte-identical when the tips table is edited.
 *
 * The tips block sits in the system prompt, at the head of the KV prefix — the
 * same position, and for the same reason, that made FORGE.md's live reload cost
 * 200K-token chats 46-115 s per edit (docs/reports/STRATA_FORGE_PERF_AUDIT_2026-
 * 10-27.md). The tips table is the one instruction file an agent EDITS during a
 * turn: recording a mistake is its whole purpose. Without a pin, that edit
 * rewrites the prompt head on the next tool round of the same turn.
 *
 * So a chat pins the block it first rendered and keeps it until compaction moves
 * the window start, which is the boundary `forgeInstructionsPin.ts` uses for the
 * same reason. A tip recorded mid-chat therefore reaches the model at the next
 * compaction or in a new chat, not immediately — accepted deliberately: the
 * alternative is a cold prefill every time an agent records something.
 */

import { z } from 'zod';

import type { ConversationRuntime } from './sessionTypes';
import { compactionWindowStart } from './compactionWindow';
import { codingTipsPinSchema } from './pinSchemas';
import { loadCodingTips } from '../llm/codingTips';

export type CodingTipsPin = z.infer<typeof codingTipsPinSchema>;

/**
 * Called once per ROUND, from `ModelTurn.ts`'s message preparation: compaction can
 * move the window mid-turn, and the request that follows it must carry the renewed
 * block rather than the stale one. Mutates `conv`'s pin; the caller's normal persist
 * writes it. Returns what the system prompt must render.
 */
export function pinCodingTips(
  conv: Pick<ConversationRuntime, 'compaction'> & { codingTipsPin?: CodingTipsPin },
  workspaceRoot: string | undefined,
): string | undefined {
  const current = loadCodingTips(workspaceRoot)?.text ?? '';
  const windowStart = compactionWindowStart(conv.compaction);
  const pin = conv.codingTipsPin;
  if (!pin || pin.windowStart !== windowStart) {
    conv.codingTipsPin = { text: current, windowStart };
    return current || undefined;
  }
  return pin.text || undefined;
}
