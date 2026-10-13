/**
 * `set_checkin` — the model sets its own elapsed-time check-in.
 *
 * A local model can read for an hour before writing anything. Forge's fixed
 * note (phase 1) guesses when that has gone on too long; this lets the model
 * make the estimate itself at the start of a task, and the note then holds it
 * to its own number instead of to Forge's guess.
 *
 * The tool owns no state. `ElapsedTimeNote` does, reached through the
 * `setCheckin` closure on `ToolHandlerContext` — the same shape `update_plan`
 * uses for `setPlan`, so `ToolDispatch` never gains a session store and the
 * conversation's clock stays on the turn side. Always registered (see
 * `registerAllTools.ts`); `advertise` re-reads the `elapsed_time_note` block, so
 * adding or deleting it in a live config shows or hides the tool.
 */

import { z } from 'zod';
import type { RegisteredTool } from './ToolRegistry';
import { CHECKIN_STAGE_PHRASE, type CheckinStage } from '../agent/elapsedTimeNote';
import type { ForgeConfig } from '../config/types';

/** The floor is what makes "remind me every five minutes" impossible. */
export const MIN_CHECKIN_MINUTES = 10;
export const MAX_CHECKIN_MINUTES = 180;

/** Refusal when the turn has no note wired — a prompt run outside a chat. */
export const SET_CHECKIN_UNAVAILABLE = 'set_checkin is not available in this conversation.';

/** Kept in step with the note's own type, so the enum cannot drift from it. */
const stageSchema = z.enum(['writing', 'testing', 'done']) satisfies z.ZodType<CheckinStage>;

const argsSchema = z
  .object({
    minutes: z.number().int().min(MIN_CHECKIN_MINUTES).max(MAX_CHECKIN_MINUTES),
    by_then: stageSchema,
  })
  .strict();

/** The block is the switch: present turns the tool and the note on. */
export function setCheckinEnabled(config: ForgeConfig | undefined): boolean {
  return config?.elapsed_time_note !== undefined;
}

/** 24-hour local `HH:MM` — the format the result string promises. */
function clockTime(epochMs: number): string {
  return new Date(epochMs).toTimeString().slice(0, 5);
}

export function makeSetCheckinTool(deps: { getConfig: () => ForgeConfig }): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'set_checkin',
        // The only place the model learns of this tool: a rule in the system
        // prompt would tax every turn, including the ones that never set one.
        // Rewritten 2026-10-13 after the A/B run's model skipped the tool: it
        // read "Forge reminds you" as a courtesy to a watching user and
        // "estimate how long" as the whole task, so it saw no use for it. The
        // text now says what arrives, why it helps, and when to set it.
        description:
          'Call this first on any multi-step task, even when no one is watching. Pick a check-in about halfway through and say where you expect to be by then. If you are still reading or planning when that time passes, Forge sends a short message quoting your own estimate, so you notice you are overthinking and move on. Not a deadline: still verify, and never cut corners to beat the clock.',
        parameters: {
          type: 'object',
          properties: {
            minutes: {
              type: 'integer',
              minimum: MIN_CHECKIN_MINUTES,
              maximum: MAX_CHECKIN_MINUTES,
              description:
                'Minutes from now until the check-in: about half your estimate for the whole task. A check-in after the work is done does nothing.',
            },
            by_then: {
              type: 'string',
              enum: ['writing', 'testing', 'done'],
              // The enum values are the words themselves; the note expands
              // them into the phrase the model hears back.
              description: 'Where you expect to be at the check-in, not at the end.',
            },
          },
          required: ['minutes', 'by_then'],
          additionalProperties: false,
        },
      },
    },
    // Nothing outside Forge's memory changes, so no confirmation gate.
    permission: 'read',
    advertise: () => setCheckinEnabled(deps.getConfig()),
    handler: async (args, context) => {
      // A tool list from before the block was deleted can still carry the tool.
      if (!setCheckinEnabled(deps.getConfig())) {
        return 'Error: set_checkin is off (no elapsed_time_note in the config). Carry on without it.';
      }
      const parsed = argsSchema.safeParse(args);
      if (!parsed.success) {
        // Name the bounds rather than echoing a Zod dump: the model has to be
        // able to retry correctly, or the round is simply lost.
        return (
          `Error: set_checkin rejected. Send "minutes" as a whole number from ` +
          `${MIN_CHECKIN_MINUTES} to ${MAX_CHECKIN_MINUTES} and "by_then" as writing, testing ` +
          'or done, and no other fields.'
        );
      }
      const { minutes, by_then } = parsed.data;
      const due = context?.setCheckin?.(minutes, by_then);
      // Availability is only known at call time: the turn services reach the
      // note through a late getter, so a path without one gets this refusal.
      if (!due) throw new Error(SET_CHECKIN_UNAVAILABLE);
      return (
        `Check-in set: if you are still on this task in ${minutes} min (at ` +
        `${clockTime(due.dueAt)}), Forge will remind you that you expected to be ` +
        `${CHECKIN_STAGE_PHRASE[by_then]}. Not a deadline. Call set_checkin again to change it.`
      );
    },
  };
}
