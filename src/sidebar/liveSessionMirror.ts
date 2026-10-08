import type { ChatMessage, ToolCall } from '../llm/types';
import type { AgentProgressEvent } from './AgentProgress';
import { agentKindSchema, agentDisplayName } from '../agentLinks/chatAgentLinks';

const TOOL = 'ask_agent';

/**
 * Mirror every `ask_agent` exchange of one tool round to the remote
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
    const details = argumentsOf(call.function.arguments);
    const agent = agentKindSchema.safeParse(details['agent']);
    if (!text || !agent.success) continue;
    const name = agentDisplayName(agent.data);
    const session = new RegExp(`\\*\\*Asked ${name} \\((.+)\\):\\*\\*`, 'u').exec(text)?.[1];
    const title = session ?? `${name} session`;
    const message = typeof details['message'] === 'string' ? details['message'] : '';
    const firstLines = message.trim().split(/\r?\n/u).slice(0, 3).join('\n');
    emit({ conversationId, kind: 'narration', text: `→ ${name} (${title}): ${firstLines}` });
    const answer = new RegExp(`\\*\\*${name} says:\\*\\*\\s*([\\s\\S]*)`, 'u')
      .exec(text)?.[1]
      ?.trim();
    if (!answer || text.startsWith('Error:')) {
      const reason = text.replace(/^Error:\s*/u, '').slice(0, 3000);
      emit({ conversationId, kind: 'narration', text: `✗ ${reason}` });
      continue;
    }
    emit({ conversationId, kind: 'narration', text: `✓ ${name} received it` });
    emit({ conversationId, kind: 'narration', text: `${name} (${title}) says: ${answer}` });
  }
}

function argumentsOf(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  return {};
}
