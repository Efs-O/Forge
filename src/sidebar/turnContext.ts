/**
 * Layer C — volatile turn context.
 *
 * Everything Forge tells the model about *right now* rather than about the
 * task: which file the editor is on, and what the task plan currently says.
 * Both change often, and both used to live near the head of the prompt — the
 * active file inside the system message, the plan folded into the FIRST user
 * message. Either one changing dropped llama-server's KV cache hit to zero and
 * forced a full re-evaluation of the whole conversation behind it.
 *
 * Measured on b10430 at a 4.9K prompt (Qwen3.8-27B, GPU, idle machine): an
 * append-only turn re-evaluated 21 tokens in 618 ms; changing one line inside
 * the system prompt re-evaluated 4971 tokens in 7605 ms. Same conversation,
 * 12x the prompt cost, cache hit exactly zero, because the divergence was at
 * the head. Reproduced on gemma-4-E2B (CPU) at 17x.
 *
 * There is no server-side escape hatch: `--cache-reuse` would shift KV across
 * a localized edit, but llama.cpp disables it for both sliding-window (gemma)
 * and hybrid/recurrent (Qwen3.8) architectures, which is everything Forge
 * targets locally. See docs/plans/PROMPT_PREFIX_STABILITY_PLAN.md.
 *
 * So it moves to the tail. Not to a message of its own, though — see
 * `foldInto` below for why that shape is not available to us.
 */

import type { ChatMessage } from '../llm/types';
import type { ConversationPlan } from './sessionTypes';
import { PLAN_RENDER_MAX_CHARS, renderPlan } from '../tools/planTools';

const OPEN = '[Forge turn context]';
const CLOSE = '[/Forge turn context]';

export interface TurnContextState {
  /** Absolute path of the active editor, if any. */
  activeFile?: string | undefined;
  plan?: ConversationPlan | undefined;
}

/**
 * Delimited so the model can tell Forge-generated state from something the
 * user typed. Deterministic in its inputs — nothing here reads the clock, or
 * the prompt would change on its own between rounds of a single turn.
 */
function renderTurnContext(state: TurnContextState): string | undefined {
  const parts: string[] = [];
  if (state.activeFile) parts.push(`Active file: ${state.activeFile}`);
  if (state.plan && state.plan.items.length > 0) {
    parts.push(renderPlan(state.plan.items).slice(0, PLAN_RENDER_MAX_CHARS));
  }
  if (parts.length === 0) return undefined;
  return `${OPEN}\n${parts.join('\n\n')}\n${CLOSE}`;
}

/**
 * Prepends `block` to the LAST user message.
 *
 * Not a standalone message at the tail, however much the cache would prefer
 * one: a `user` turn sitting between an assistant's `tool_calls` and the
 * continuation is precisely the shape strict chat templates (gemma among them)
 * reject, and on a tool round the tail is always a `tool` message. Folding into
 * an existing user turn keeps the alternation the templates demand.
 *
 * On round 8 of a turn that target is the request that opened the turn — still
 * some way from the tail, but everything before it survives, which is the
 * entire point. The accepted cost is that an `update_plan` mid-turn
 * invalidates that turn's own tool rounds; it no longer invalidates the
 * conversation.
 */
function foldInto(messages: ChatMessage[], index: number, block: string): ChatMessage[] {
  const target = messages[index];
  if (!target) return messages;

  // Attachment-bearing prompts use content parts. Keep the block in the same
  // user turn rather than beside it, for the alternation reason above.
  const merged: ChatMessage = Array.isArray(target.content)
    ? { ...target, content: [{ type: 'text', text: `${block}\n\n` }, ...target.content] }
    : { ...target, content: `${block}\n\n${target.content ?? ''}` };

  return [...messages.slice(0, index), merged, ...messages.slice(index + 1)];
}

/**
 * Returns the model-facing copy with current editor and task state folded in.
 * `messages` is never mutated — `conv.messages` stays the raw transcript for
 * the sidebar, persistence, and exact recovery.
 *
 * Rebuilt from live state on every round, so it is never stale within a turn
 * and never accumulates duplicates.
 */
export function injectTurnContext(messages: ChatMessage[], state: TurnContextState): ChatMessage[] {
  const block = renderTurnContext(state);
  if (!block) return messages;

  let last = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      last = i;
      break;
    }
  }
  if (last !== -1) return foldInto(messages, last, block);

  // Nothing to fold into — a resumed conversation whose window holds only
  // system and assistant turns. A standalone message is the only option left;
  // it goes after the system messages, where the old plan block went, because
  // appending it after an assistant turn is the alternation failure again.
  const head = messages.findIndex((m) => m.role !== 'system');
  const standalone: ChatMessage = { role: 'user', content: block, internal: true };
  if (head === -1) return [...messages, standalone];
  return [...messages.slice(0, head), standalone, ...messages.slice(head)];
}

export { OPEN as TURN_CONTEXT_OPEN, CLOSE as TURN_CONTEXT_CLOSE };
