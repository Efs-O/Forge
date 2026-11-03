import type * as http from 'http';
import type { AgentSender } from '../agentLinks/chatAgentLinks';
import { sendJson, sendText } from './controlHttp';
import { AgentRouteHttpError as HttpError } from './agentRouteFields';
import { parseOptionalReadSender, validateBusSenderName } from './agentSenderParsing';

/** What the two read-only GET routes answer: the text the caller asked for, or
 *  a 400/404 with the reason. Owned here now, because the routes that produce it
 *  live here; `agentRoutes.ts` imports it for its dependency signatures. */
export type BusReadResult =
  | { ok: true; text: string }
  | { ok: false; status: 400 | 404; error: string };

export interface AgentChatReadRouteDeps {
  validateFrom?: (
    from: string,
  ) =>
    | { ok: true }
    | { ok: false; error: string }
    | Promise<{ ok: true } | { ok: false; error: string }>;
  /** Read-only view of the sender's chat; absent means the route is 404. */
  status?: (from: string, sender?: AgentSender) => BusReadResult | Promise<BusReadResult>;
  view?: (
    from: string,
    count: string | undefined,
    sender?: AgentSender,
  ) => BusReadResult | Promise<BusReadResult>;
}

/**
 * `GET /agent/status` and `GET /agent/view` — the two routes that read the
 * sender's own chat and touch no other route's state.
 *
 * Split out of `agentRoutes.ts` because that file had reached the 500-line
 * `max-lines` gate (`max-lines` in `.eslintrc.json`) and the cross-window chat
 * needs room to add its routes there. A pure move: same checks, same answers,
 * no new route, and the tests that cover both routes still call them through
 * `agentRoutes` rather than this file directly.
 *
 * The sender is checked in two steps because they answer different questions:
 * `validateBusSenderName` says the `from` is a shape this server can attribute
 * at all, and `validateFrom` says it is a sender this window's config allows.
 * A read sender is parsed from the query first, so a caller that arrives with a
 * verified session identity is judged as that identity, not as a bare name.
 */
export async function handleAgentChatReadRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  route: '/agent/status' | '/agent/view',
  deps: AgentChatReadRouteDeps,
): Promise<void> {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
  const from = (url.searchParams.get('from') ?? '').trim();
  const name = validateBusSenderName(from);
  if (!name.ok) return sendJson(res, 400, { error: name.error });
  let readSender: AgentSender | undefined;
  try {
    readSender = parseOptionalReadSender(from, url.searchParams);
  } catch (error) {
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
    throw error;
  }
  const sender = await deps.validateFrom?.(from);
  if (sender && !sender.ok) return sendJson(res, 400, { error: sender.error });
  const result =
    route === '/agent/status'
      ? await deps.status?.(from, readSender)
      : await deps.view?.(from, url.searchParams.get('count') ?? undefined, readSender);
  if (!result) return sendJson(res, 404, { error: `no route for GET ${route}` });
  if (result.ok) return sendText(res, 200, result.text);
  return sendJson(res, result.status, { error: result.error });
}
