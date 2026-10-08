import type { AgentSender } from '../agentLinks/chatAgentLinks';
import { AgentRouteHttpError } from './agentRouteFields';
import type { AgentRoutesDeps } from './agentRoutes';

export async function dispatchAgentRelay(input: {
  sender?: AgentSender;
  from: string;
  to: string;
  text: string;
  isSteer: boolean;
  originConversation?: string;
  deps: Pick<AgentRoutesDeps, 'relay' | 'steer' | 'relayAgent'>;
}) {
  const agentRelay =
    !!input.sender && ['claude', 'codex', 'copilot'].includes(input.to) && !input.isSteer;
  const available = agentRelay
    ? input.deps.relayAgent
    : input.isSteer
      ? input.deps.steer
      : input.deps.relay;
  if (!available)
    throw new AgentRouteHttpError(400, `no relay available to deliver to "${input.to}"`);
  if (agentRelay)
    return input.deps.relayAgent!(input.sender!, input.to, input.text, input.originConversation);
  if (input.isSteer && input.deps.steer) return input.deps.steer(input.from, input.to, input.text);
  return input.deps.relay!(input.from, input.to, input.text, input.originConversation);
}
