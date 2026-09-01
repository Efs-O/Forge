/**
 * `update_plan` — the agent's own task ledger.
 *
 * Everything else that survives a compaction survives as *prose a model wrote*,
 * which a resumed agent cannot tell apart from a claim, so it re-verifies. This
 * is the exception: the plan is conversation state, re-injected verbatim every
 * round and never summarized, so a compaction cannot cost more than one stale
 * item. See docs/plans/COMPACTION_STATE_LEDGER_PLAN.md.
 *
 * The tool does not own the state. `ModelTurn` does, via the `setPlan` closure
 * on `ToolHandlerContext` — the same shape `recordFileDiff` already uses to let
 * a tool result reach the live conversation without giving `ToolDispatch` a
 * session store.
 */

import { z } from 'zod';
import type { RegisteredTool } from './ToolRegistry';
import {
  PLAN_ITEM_MAX_CHARS,
  PLAN_MAX_ITEMS,
  planItemSchema,
  type PlanItem,
} from '../sidebar/sessionTypes';

const argsSchema = z
  .object({
    items: z.array(planItemSchema).min(1).max(PLAN_MAX_ITEMS),
  })
  .strict();

/**
 * One line per item, with the status leading so it survives a skim.
 *
 * Deterministic in `items` alone. It used to append the plan's age
 * ("updated about 2 min ago"), which meant the model-facing prompt changed on
 * its own as the clock ran -- including BETWEEN ROUNDS OF ONE TURN, since this
 * is re-rendered every round. That dropped the KV cache hit to zero mid-turn
 * for no reason a user could see. `updatedAt` stays on `ConversationPlan` for
 * the webview; it just never reaches the model.
 * See docs/plans/PROMPT_PREFIX_STABILITY_PLAN.md.
 */
export function renderPlan(items: readonly PlanItem[]): string {
  const marks: Record<PlanItem['status'], string> = {
    done: '[x] done',
    active: '[>] in progress',
    pending: '[ ] pending',
  };
  const lines = items.map((item) => `- ${marks[item.status]}: ${item.text}`);
  return `**Task plan (recorded by Forge):**\n${lines.join('\n')}`;
}

/**
 * How to treat a plan, delivered WITH the plan.
 *
 * These rules lived in the workspace's FORGE.md, which means they sat in the
 * system prompt of every request — 378 tokens on every conversation, including
 * the majority that never record a plan at all. They are only ever actionable
 * when a plan exists, so they ride along with it.
 *
 * The tail, specifically, and never a conditional block at the head: making
 * system-prompt content appear when `update_plan` first fires would invalidate
 * the whole KV cache mid-conversation, which is the failure
 * docs/plans/PROMPT_PREFIX_STABILITY_PLAN.md measured at 4971 re-evaluated
 * tokens for a single changed line. `renderUserTerminalCommands` in
 * turnContext.ts already pairs its guidance with its data the same way.
 *
 * Deterministic and constant, so it costs no cache churn between rounds.
 */
export const PLAN_GUIDANCE =
  'The plan above is the authoritative specification for this work. ' +
  'Conversation summaries, tool-limit continuations, and test failures are ' +
  'navigation aids only — they do not replace its invariants or acceptance ' +
  'criteria. Re-read it after any compaction or forced continuation and before ' +
  'declaring the work done. Do not let the shape of existing code override an ' +
  'explicit plan constraint: when the plan calls for a different lifetime, ' +
  'ordering, error boundary, or ownership model, restructure the code and test ' +
  'that distinction directly. A green test suite is necessary but is not proof ' +
  'of conformance — check every requirement and edge case against a test or a ' +
  'named manual step, including the failure paths that are easy to omit when ' +
  'following the happy path.';

export function makeUpdatePlanTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'update_plan',
        description:
          'Record the task plan for this conversation. Send the COMPLETE list every time — it replaces the previous one. ' +
          'Mark an item done as soon as you finish it: this ledger is the only record that survives a context compaction, ' +
          'so an unmarked item is work a resumed turn will do again.',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              minItems: 1,
              maxItems: PLAN_MAX_ITEMS,
              description: 'The complete task list, in order. Replaces any previous plan.',
              items: {
                type: 'object',
                properties: {
                  text: {
                    type: 'string',
                    minLength: 1,
                    maxLength: PLAN_ITEM_MAX_CHARS,
                    description: 'What the task is, in one short line.',
                  },
                  status: {
                    type: 'string',
                    enum: ['pending', 'active', 'done'],
                    description: 'Exactly one item should be "active" at a time.',
                  },
                },
                required: ['text', 'status'],
                additionalProperties: false,
              },
            },
          },
          required: ['items'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    // Writes no file and spawns nothing, so a confirmation gate would only tax
    // the one habit this feature depends on the model keeping up.
    autoApprove: true,
    handler: async (args, context) => {
      const parsed = argsSchema.safeParse(args);
      if (!parsed.success) {
        // Name the limit rather than echoing a Zod dump: the model has to be
        // able to retry correctly, or the round is simply lost.
        return (
          `Error: update_plan rejected. Send 1-${PLAN_MAX_ITEMS} items, each with a "text" of ` +
          `1-${PLAN_ITEM_MAX_CHARS} characters and a "status" of pending, active, or done, and no other fields.`
        );
      }
      if (!context?.setPlan) {
        return 'Error: update_plan is unavailable outside a conversation turn.';
      }
      context.setPlan(parsed.data.items);
      const done = parsed.data.items.filter((i) => i.status === 'done').length;
      return `Plan recorded: ${parsed.data.items.length} items, ${done} done.`;
    },
  };
}

/**
 * Belt-and-braces bound on what the plan can cost the prompt. 20 items x 200
 * chars cannot reach this, so in practice it never truncates — it exists so
 * that a plan loaded from a corrupted session cannot grow the context either.
 */
export const PLAN_RENDER_MAX_CHARS = 1500;
