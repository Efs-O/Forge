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
 *
 * The tool list reads the same pin, so the tips that move into a tool's
 * description and the table that does not renew together, on one window move.
 */

import { z } from 'zod';

import type { ConversationRuntime } from './sessionTypes';
import { compactionWindowStart } from './compactionWindow';
import { codingTipsPinSchema } from './pinSchemas';
import { loadCodingTips } from '../llm/codingTips';
import { splitToolTips, withToolTips } from '../llm/toolTips';
import type { ToolDefinition } from '../llm/types';

export type CodingTipsPin = z.infer<typeof codingTipsPinSchema>;

type TipsPinConversation = Pick<ConversationRuntime, 'compaction'> & {
  codingTipsPin?: CodingTipsPin;
};

/**
 * Called once per ROUND, from both `ModelTurn.ts`'s message preparation and its
 * tool-list builder: compaction can move the window mid-turn, and the request
 * that follows it must carry the renewed block rather than the stale one. The
 * tool list is built before the messages (`ToolCallingLoop.ts`), so this is what
 * creates the pin on a chat's first request. Mutates `conv`'s pin; the caller's
 * normal persist writes it. Returns the pinned block text ('' when there is none).
 */
export function ensureCodingTipsPin(
  conv: TipsPinConversation,
  workspaceRoot: string | undefined,
): string {
  const current = loadCodingTips(workspaceRoot)?.text ?? '';
  const windowStart = compactionWindowStart(conv.compaction);
  const pin = conv.codingTipsPin;
  if (!pin || pin.windowStart !== windowStart) {
    conv.codingTipsPin = { text: current, windowStart };
    return current;
  }
  return pin.text;
}

/**
 * What the system prompt must render: the pinned block, minus the rows that
 * belong inside a tool's description instead (`src/llm/toolTips.ts`).
 */
export function pinCodingTips(
  conv: TipsPinConversation,
  workspaceRoot: string | undefined,
): string | undefined {
  return splitToolTips(ensureCodingTipsPin(conv, workspaceRoot)).table || undefined;
}

/**
 * The advertised tools, with each one's tips appended to its description. Reads
 * the same pin as `pinCodingTips`, so tools and table renew together.
 */
export function withPinnedToolTips(
  conv: TipsPinConversation,
  workspaceRoot: string | undefined,
  defs: ToolDefinition[],
): ToolDefinition[] {
  return withToolTips(defs, splitToolTips(ensureCodingTipsPin(conv, workspaceRoot)).byTool);
}
