/**
 * The wire shape of a persisted `CompactionState`.
 *
 * Split out of `sessionTypes.ts` on the concern boundary it already crossed:
 * every bound in here is owned by a compaction module (`compactionTypes`,
 * `compactionLastReply`, `compactionUserContext`), so the schema kept dragging
 * three compaction imports into the session-persistence file. Session shape and
 * compaction shape change for different reasons and by different edits.
 */

import { z } from 'zod';
import {
  COMPACTION_REPO_STATE_MAX_CHARS,
  RECORDED_ACTION_KEY_MAX_CHARS,
  RECORDED_ACTION_LINE_MAX_CHARS,
  RECORDED_ACTION_MAX_ITEMS,
} from './compactionTypes';
import { LAST_REPLY_MAX_CHARS } from './compactionLastReply';
import { USER_CONTEXT_MAX_MESSAGES, USER_CONTEXT_MESSAGE_MAX_CHARS } from './compactionUserContext';

const recordedActionSchema = z
  .object({
    kind: z.enum(['file', 'command']),
    key: z.string().min(1).max(RECORDED_ACTION_KEY_MAX_CHARS),
    outcome: z.enum(['ok', 'failed', 'unknown']),
    line: z.string().min(1).max(RECORDED_ACTION_LINE_MAX_CHARS),
    durableEvidence: z.boolean().optional(),
  })
  .strict();

/** How many recorded actions the ledger cap dropped, per kind. */
const omittedActionsSchema = z
  .object({ file: z.number().int().min(0), command: z.number().int().min(0) })
  .strict();

/**
 * `.strict()` on purpose: a field added to `CompactionState` without a row here
 * does not degrade quietly — it fails the parse and drops the whole compaction
 * on reload, restoring an uncompacted window.
 */
export const compactionPersistedSchema = z
  .object({
    summary: z.string().min(1),
    fromIndex: z.number().int().min(0),
    generation: z.number().int().min(1).optional(),
    userMessages: z
      .array(
        z
          .string()
          .min(1)
          .max(USER_CONTEXT_MESSAGE_MAX_CHARS + 40),
      )
      .max(USER_CONTEXT_MAX_MESSAGES)
      .optional(),
    recordedActions: z.array(recordedActionSchema).max(RECORDED_ACTION_MAX_ITEMS).optional(),
    repoState: z.string().max(COMPACTION_REPO_STATE_MAX_CHARS).optional(),
    // Optional, so conversations saved before these fields still parse.
    omittedActions: omittedActionsSchema.optional(),
    lastReplyFollowedByTools: z.boolean().optional(),
    lastReply: z
      .string()
      .min(1)
      .max(LAST_REPLY_MAX_CHARS + 20)
      .optional(),
  })
  .strict();
