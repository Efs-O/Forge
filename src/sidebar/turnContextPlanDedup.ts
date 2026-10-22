import type { ChatMessage } from '../llm/types';
import {
  PLAN_GUIDANCE,
  PLAN_RENDER_HEADER,
  PLAN_RENDER_MAX_CHARS,
  PLAN_UNCHANGED_NOTE,
  isPlanFinished,
  renderPlan,
} from '../tools/planTools';
import type { ConversationPlan } from './sessionTypes';

export const TURN_CONTEXT_CLOSE = '[/Forge turn context]';

function fullPlanSection(context: string): string | undefined {
  const start = context.indexOf(PLAN_RENDER_HEADER);
  if (start < 0) return undefined;
  const close = context.indexOf(`\n${TURN_CONTEXT_CLOSE}`, start);
  return context.slice(start, close < 0 ? context.length : close);
}

/** True when the newest visible frozen plan section exactly matches this snapshot. */
export function shouldUsePlanUnchangedNote(
  messages: ChatMessage[],
  plan: ConversationPlan | undefined,
  windowStart: number,
): boolean {
  if (!plan || plan.items.length === 0 || isPlanFinished(plan.items)) return false;
  const section = `${renderPlan(plan.items).slice(0, PLAN_RENDER_MAX_CHARS)}\n\n${PLAN_GUIDANCE}`;
  for (let index = messages.length - 1; index >= windowStart; index -= 1) {
    const message = messages[index];
    const context = message?.role === 'user' ? message.turnContext : undefined;
    if (!context || !fullPlanSection(context)) continue;
    return context.includes(section);
  }
  return false;
}

/**
 * Repair the first visible plan marker whose full copy is behind the window.
 * The returned array is model-only; frozen history is never rewritten.
 */
export function expandOrphanPlanMarkers(
  messages: ChatMessage[],
  windowStart: number,
): ChatMessage[] {
  let visibleFullCopy = false;
  for (let index = Math.max(0, windowStart); index < messages.length; index += 1) {
    const message = messages[index];
    const context = message?.role === 'user' ? message.turnContext : undefined;
    if (!context) continue;
    if (fullPlanSection(context)) {
      visibleFullCopy = true;
      continue;
    }
    if (!context.includes(PLAN_UNCHANGED_NOTE) || visibleFullCopy) continue;

    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const previousMessage = messages[previous];
      const previousContext =
        previousMessage?.role === 'user' ? previousMessage.turnContext : undefined;
      const section = previousContext ? fullPlanSection(previousContext) : undefined;
      if (!section) continue;
      const copy = [...messages];
      copy[index] = {
        ...message,
        turnContext: context.replace(PLAN_UNCHANGED_NOTE, section),
      };
      return copy;
    }
    return messages;
  }
  return messages;
}
