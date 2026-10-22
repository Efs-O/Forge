import type { ChatMessage } from '../llm/types';
import {
  PLAN_GUIDANCE,
  PLAN_RENDER_MAX_CHARS,
  PLAN_UNCHANGED_NOTE,
  renderPlan,
} from '../tools/planTools';
import type { ConversationPlan } from './sessionTypes';

function fullPlanSection(context: string): string | undefined {
  const header = '**Task plan (recorded by Forge):**';
  const start = context.indexOf(header);
  const guidance = context.lastIndexOf(`\n\n${PLAN_GUIDANCE}`);
  if (start < 0 || guidance < start) return undefined;
  return context.slice(start, guidance + 2 + PLAN_GUIDANCE.length);
}

/** True when the newest visible frozen plan section exactly matches this snapshot. */
export function shouldUsePlanUnchangedNote(
  messages: ChatMessage[],
  plan: ConversationPlan | undefined,
  windowStart: number,
): boolean {
  if (!plan || plan.items.length === 0) return false;
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
