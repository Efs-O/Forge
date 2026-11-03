import type { AgentSender } from '../agentLinks/chatAgentLinks';
import { AgentRouteHttpError } from './agentRouteFields';
import type { AgentRelayResult, AgentRoutesDeps } from './agentRoutes';

/** The kinds a `to` can name that Forge has a session link for. */
const AGENT_TARGETS = ['claude', 'codex', 'copilot'];

/**
 * Which relay a `to` that is not Forge goes through (M6/§4: the host delivers
 * it, the model never decides). An agent kind is reached through the sender's
 * session links, so a sender that has one goes by `relayAgent`; a bare sender
 * name has no session and no links and falls back to the plain `relay`
 * dependency (the deprecated config-pin path), which production does not
 * install — so it is refused rather than delivered to whichever session came to
 * hand.
 *
 * A steer is stricter, and needs the verified `AgentSender` for a reason: it
 * withdraws the in-flight request of one particular chat, and only the session
 * id says which chat. A bare name has no chat, so there is nothing to withdraw
 * and no link to run its text on; steering Forge itself is a different path
 * (`to=forge`, handled by `interruptForge` before dispatch) and never arrives
 * here.
 */
export async function dispatchAgentRelay(input: {
  sender?: AgentSender;
  from: string;
  to: string;
  text: string;
  isSteer: boolean;
  originConversation?: string;
  deps: Pick<AgentRoutesDeps, 'relay' | 'steer' | 'relayAgent'>;
}): Promise<AgentRelayResult> {
  const unavailable = new AgentRouteHttpError(
    400,
    `no relay available to deliver to "${input.to}"`,
  );
  const agentTarget = AGENT_TARGETS.includes(input.to);
  if (input.isSteer) {
    if (!agentTarget || !input.sender || !input.deps.steer) throw unavailable;
    return input.deps.steer(input.sender, input.to, input.text);
  }
  if (agentTarget && input.sender) {
    if (!input.deps.relayAgent) throw unavailable;
    return input.deps.relayAgent(input.sender, input.to, input.text, input.originConversation);
  }
  if (!input.deps.relay) throw unavailable;
  return input.deps.relay(input.from, input.to, input.text, input.originConversation);
}
