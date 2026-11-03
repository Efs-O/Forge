import { agentSenderSchema, type AgentSender } from '../agentLinks/chatAgentLinks';
import { AgentRouteHttpError } from './agentRouteFields';

/**
 * The shape of a plain bus sender name — `forge.sh say <name>`, and the `from`
 * every route takes. One owner for the check every `from`-bearing route already
 * makes, so a route that needs nothing more than a well-formed name cannot be
 * gated on an optional dependency it does not use (the 0.17.86 verdict-route
 * 404: `read-verdict`/`ack-verdict` were registered only when `validateFrom`
 * was supplied, and production never supplied it).
 */
export const BUS_SENDER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/u;

/** The one answer a `from` can get from this check: well-formed, or the same
 *  wording every route has always used for a name that is not. */
export function validateBusSenderName(from: string): { ok: true } | { ok: false; error: string } {
  return BUS_SENDER_NAME.test(from)
    ? { ok: true }
    : { ok: false, error: 'from must be 1-40 chars: letters, digits, space . _ -' };
}

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

export function parseOptionalReadSender(
  from: string,
  params: URLSearchParams,
): AgentSender | undefined {
  if (!params.has('kind') && !params.has('sessionId')) return undefined;
  const sender = parseOptionalAgentSender({
    kind: params.get('kind') ?? undefined,
    sessionId: params.get('sessionId') ?? undefined,
  });
  if (sender && sender.kind !== from.toLowerCase()) {
    throw new AgentRouteHttpError(400, 'sender kind must match from');
  }
  return sender;
}
