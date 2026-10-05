import type { AgentRouteFields } from './agentRouteFields';
import { AgentRouteHttpError } from './agentRouteFields';
import type { RemoteSessionActionResult } from '../remote/RemoteSessionBridge';

export async function handleAgentRemoteSessionRoute(
  fields: AgentRouteFields,
  action: 'ask' | 'notify',
  deps: {
    validateFrom: (
      from: string,
    ) =>
      | Promise<{ ok: true } | { ok: false; error: string }>
      | { ok: true }
      | { ok: false; error: string };
    dispatch: (
      from: string,
      id: string,
      action: 'ask' | 'notify',
      text: string,
    ) => Promise<RemoteSessionActionResult>;
  },
): Promise<RemoteSessionActionResult> {
  const from = fields['from'];
  const id = fields['exchange_id'];
  const text = fields['text'];
  if (typeof from !== 'string' || !['claude', 'codex', 'copilot'].includes(from)) {
    throw new AgentRouteHttpError(400, 'from must be claude, codex or copilot');
  }
  const sender = await deps.validateFrom(from);
  if (!sender.ok) throw new AgentRouteHttpError(400, sender.error);
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/u.test(id)) {
    throw new AgentRouteHttpError(400, 'exchange_id must be the remote request id');
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 4_000) {
    throw new AgentRouteHttpError(400, 'text must be 1-4000 characters');
  }
  const result = await deps.dispatch(from, id, action, text);
  if (result.kind === 'refused') throw new AgentRouteHttpError(409, result.error);
  return result;
}
