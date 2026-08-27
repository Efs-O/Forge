/**
 * `update_plan` — the agent's own task ledger.
 *
 * Everything else that survives a compaction survives as *prose a model wrote*,
 * which a resumed agent cannot tell apart from a claim, so it re-verifies. This
 * is the exception: the plan is conversation state, re-injected verbatim every
 * round and never summarized, so a compaction cannot cost more than one stale
 * item. See COMPACTION_STATE_LEDGER_PLAN.md.
 *
 * The tool does not own the state. `ModelTurn` does, via the `setPlan` closure
 * on `ToolHandlerContext` — the same shape `recordFileDiff` already uses to let
 * a tool result reach the live conversation without giving `ToolDispatch` a
 * session store.
 */

import { z } from 'zod';
import type { RegisteredTool } from './ToolRegistry';
import type { ChatMessage } from '../llm/types';
import {
  PLAN_ITEM_MAX_CHARS,
  PLAN_MAX_ITEMS,
  planItemSchema,
  type ConversationPlan,
  type PlanItem,
} from '../sidebar/sessionTypes';

const argsSchema = z
  .object({
    items: z.array(planItemSchema).min(1).max(PLAN_MAX_ITEMS),
  })
  .strict();

/** One line per item, with the status leading so it survives a skim. */
export function renderPlan(items: readonly PlanItem[], updatedAt: number, now: number): string {
  const marks: Record<PlanItem['status'], string> = {
    done: '[x] done',
    active: '[>] in progress',
    pending: '[ ] pending',
  };
  const lines = items.map((item) => `- ${marks[item.status]}: ${item.text}`);
  return `**Task plan (recorded by Forge, ${describeAge(now - updatedAt)}):**\n${lines.join('\n')}`;
}

/**
 * Elapsed time, not a round count: `updatedAt` is epoch ms and there is no
 * round counter to read. A plan that has not moved in twenty minutes should say
 * so rather than looking as authoritative as one written this turn.
 */
function describeAge(elapsedMs: number): string {
  if (elapsedMs < 60_000) return 'updated just now';
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 60) return `updated about ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `updated about ${hours} h ago`;
}

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
const PLAN_RENDER_MAX_CHARS = 1500;

/**
 * Put the conversation's plan in front of the model, in the model-facing copy
 * only.
 *
 * Placed at the head rather than the tail: a `user` message injected between an
 * assistant's tool_calls and the model's continuation is exactly the shape
 * strict chat templates reject, and `applyCompactionWindow` already carries the
 * summary at the front for the same reason.
 *
 * It is FOLDED INTO the first user message wherever there is one, instead of
 * being inserted beside it. Templates that demand strict user/model alternation
 * (gemma among them) refuse two consecutive user turns, and after a compaction
 * the first non-system message is always the summary preamble — so inserting
 * would have produced that exact pair on every compacted conversation. A
 * standalone message is used only when nothing suitable is there to fold into.
 *
 * Rebuilt from live state every round, so it is never stale within a turn and
 * never accumulates duplicates.
 */
export function withPlan(
  messages: ChatMessage[],
  plan: ConversationPlan | undefined,
  now: number = Date.now(),
): ChatMessage[] {
  if (!plan || plan.items.length === 0) return messages;
  const rendered = renderPlan(plan.items, plan.updatedAt, now).slice(0, PLAN_RENDER_MAX_CHARS);
  const head = messages.findIndex((m) => m.role !== 'system');
  const target = head === -1 ? undefined : messages[head];

  if (target?.role === 'user' && typeof target.content === 'string') {
    const merged: ChatMessage = { ...target, content: `${rendered}\n\n${target.content}` };
    return [...messages.slice(0, head), merged, ...messages.slice(head + 1)];
  }
  if (target?.role === 'user' && Array.isArray(target.content)) {
    // Attachment-bearing prompts use content parts. Keep them in the same user
    // turn: inserting another user message recreates the strict-template
    // alternation failure this helper exists to prevent.
    const merged: ChatMessage = {
      ...target,
      content: [{ type: 'text', text: `${rendered}\n\n` }, ...target.content],
    };
    return [...messages.slice(0, head), merged, ...messages.slice(head + 1)];
  }

  const block: ChatMessage = { role: 'user', content: rendered, internal: true };
  if (head === -1) return [...messages, block];
  return [...messages.slice(0, head), block, ...messages.slice(head)];
}
