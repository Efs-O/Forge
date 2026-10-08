import { agentSenderSchema, type AgentSender } from '../agentLinks/chatAgentLinks';
import { AgentRouteHttpError } from './agentRouteFields';

export function parseOptionalAgentSender(raw: unknown): AgentSender | undefined {
  if (raw === undefined) return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new AgentRouteHttpError(400, 'sender must be a JSON {kind, sessionId} object');
    }
  }
  const parsed = agentSenderSchema.safeParse(value);
  if (!parsed.success)
    throw new AgentRouteHttpError(
      400,
      `sender: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  return parsed.data;
}

export function parseAgentSender(raw: unknown): AgentSender {
  const parsed = agentSenderSchema.safeParse(raw);
  if (!parsed.success)
    throw new AgentRouteHttpError(
      400,
      `kind and sessionId are required: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  return parsed.data;
}
