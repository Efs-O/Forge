import type { ChatMessage, ToolCall } from '../llm/types';
import type { AgentProgressEvent } from './AgentProgress';

const TOOL = 'ask_live_session';

/**
 * Mirror every `ask_live_session` exchange of one tool round to the remote
 * progress channel, each as a message of its own.
 *
 * A mesh run is one long Forge turn whose substance, the answers Codex and
 * Claude give, lives in tool results, and remote surfaces never saw tool
 * results. A phone watching the run got the kickoff and nothing of the agents
 * talking. `narration` is the kind that arrives as its own message (see
 * AgentProgress), so each answer is one message: who was asked, about what,
 * and the whole result — including a failure, which is the one to act on.
 */
export function mirrorLiveSessionAnswers(
  conversationId: string,
  calls: readonly ToolCall[],
  messages: readonly ChatMessage[],
  emit: (event: AgentProgressEvent) => void,
): void {
  for (const call of calls) {
    if (call.function.name !== TOOL) continue;
    const result = messages.find((m) => m.role === 'tool' && m.tool_call_id === call.id);
    const text = typeof result?.content === 'string' ? result.content.trim() : '';
    if (!text) continue;
    emit({ conversationId, kind: 'narration', text: `${header(call)}\n\n${text}` });
  }
}

function header(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.function.arguments);
    if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
  } catch {
    // Arguments the tool itself refused; the result text says why.
  }
  const target = typeof args['target'] === 'string' ? args['target'] : 'live session';
  const subject = typeof args['subject'] === 'string' ? ` · ${args['subject']}` : '';
  return `🔁 Forge ↔ ${target}${subject}`;
}
