import type * as http from 'http';
import type { AgentSender } from '../agentLinks/chatAgentLinks';
import type { ForgeExchange } from '../sidebar/sessionProjections';
import { sendJson, sendText } from './controlHttp';
import { AgentRouteHttpError as HttpError } from './agentRouteFields';
import { parseOptionalReadSender, validateBusSenderName } from './agentSenderParsing';
import { parseReadConversationId } from './agentMessageOptions';
import { MAX_VIEW_COUNT, parseViewCount } from '../remote/RemoteTranscriptView';

/** What the two read-only GET routes answer: the text the caller asked for, or
 *  a 400/404 with the reason. Owned here now, because the routes that produce it
 *  live here; `agentRoutes.ts` imports it for its dependency signatures. */
export type BusReadResult =
  | { ok: true; text: string }
  | { ok: false; status: 400 | 404; error: string };

/** One chat as `GET /agent/chats` reports it. No `#N`: tab numbers are
 *  window-local, so a peer addresses a chat by id and nothing else, and a peer
 *  that guessed a tab number would steer whoever happens to hold it. */
export interface ChatsReportChat {
  id: string;
  title: string;
  running: boolean;
  /** A chat in this window's history rather than an open tab. `view` can read
   *  it; `send` and `steer` must refuse it. */
  closed: boolean;
  /** The chat is sitting on a card the owner has to answer. A steer refuses
   *  while this is set, exactly as the local guard does. */
  awaitingApproval: boolean;
  /** The steer-loop epoch of the chain this chat holds, when it holds one: the
   *  number the cross-window steer guard compares against. */
  userIntentEpoch?: number;
  model?: string;
}

/** What `GET /agent/chats` answers: this window's identity, the models its own
 *  config offers, and every chat it holds or still remembers. */
export interface ChatsReport {
  windowId: string;
  workspace: string;
  models: string[];
  chats: ChatsReportChat[];
}

/** One chat's recent answers, as `GET /agent/peer-view` hands them to a window
 *  that cannot read the sidebar they came from. They travel raw on purpose: the
 *  sender renders them with the same function it renders its own chats with, so
 *  a supervisor sees one format whoever answered, and the two facts that decide
 *  the format — the list was cut, and a turn is still writing the last entry —
 *  travel with them rather than being guessed at the far end. */
export interface PeerViewReport {
  windowId: string;
  workspace: string;
  conversationId: string;
  title: string;
  /** A chat in this window's history rather than an open tab. Its transcript is
   *  still readable; its sender cannot be sent to or interrupted. */
  closed: boolean;
  streaming: boolean;
  clamped: boolean;
  exchanges: ForgeExchange[];
}

export type PeerViewResult =
  | { ok: true; report: PeerViewReport }
  | { ok: false; status: 404; error: string };

export interface AgentChatReadRouteDeps {
  validateFrom?: (
    from: string,
  ) =>
    | { ok: true }
    | { ok: false; error: string }
    | Promise<{ ok: true } | { ok: false; error: string }>;
  /** Read-only view of the sender's chat; absent means the route is 404.
   *  `conversationId` is a chat the caller named with `--to`: the dependency
   *  decides whether that chat belongs to this sender's session, because only
   *  it can see the window's links. */
  status?: (
    from: string,
    sender?: AgentSender,
    conversationId?: string,
  ) => BusReadResult | Promise<BusReadResult>;
  view?: (
    from: string,
    count: string | undefined,
    sender?: AgentSender,
    conversationId?: string,
  ) => BusReadResult | Promise<BusReadResult>;
  /** This window's chat list for a peer. It takes the caller's own window id so
   *  the report can name the window it came from: the id lives in the endpoint
   *  registry, which the dependency set was built before, so only the route can
   *  hand it down. Absent means the route is not registered here. */
  chats?: (windowId: string) => ChatsReport | Promise<ChatsReport>;
  /** One chat's transcript for a peer window, read by its id. The window answers
   *  whether the chat is one of its own — a peer has no session link to be
   *  checked against. Absent means the route is 404. */
  peerView?: (
    conversationId: string,
    count: number,
    windowId: string,
  ) => PeerViewResult | Promise<PeerViewResult>;
}

/**
 * `GET /agent/status` and `GET /agent/view` — the two routes that read the
 * sender's own chat and touch no other route's state — plus the two routes a
 * peer window answers on the bus token alone: `GET /agent/chats`, which lists
 * this window's chats so a neighbour can name one, and `GET /agent/peer-view`,
 * which hands back one chat's transcript.
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
 *
 * A `conversation_id` names a specific chat to read instead of the one this
 * session last addressed. The route only checks its shape and hands it down:
 * which chats a session may read is the window's answer, not this file's, and a
 * chat that is not linked to the caller's session comes back 404 naming it.
 */
export async function handleAgentChatReadRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  route: '/agent/status' | '/agent/view' | '/agent/chats' | '/agent/peer-view',
  deps: AgentChatReadRouteDeps,
  windowId: string,
): Promise<void> {
  if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
  // `/agent/chats` is answered before the sender is parsed. A peer needs this
  // window's chat ids before it can name a chat to any route, and the only
  // credential it holds is the bearer token `agentRoutes` has already checked.
  // The two read routes keep demanding a nameable sender, unchanged.
  if (route === '/agent/chats') {
    const report = await deps.chats?.(windowId);
    if (!report) return sendJson(res, 404, { error: `no route for GET ${route}` });
    return sendJson(res, 200, report);
  }
  // `/agent/peer-view` is token-only for the same reason `/agent/chats` is: the
  // caller is another Forge window, not a CLI session, so it has no sender name
  // for the read to be attributed to and no session link to check the chat
  // against. What it holds is the bus token, which is same-machine trust — the
  // stricter CLI rule that a `conversation_id` must belong to the caller's own
  // session is left exactly as it was, because it lives in `/agent/view`.
  if (route === '/agent/peer-view') {
    const rawId = url.searchParams.get('conversation_id');
    if (rawId === null)
      return sendJson(res, 400, { error: 'conversation_id is required: name the chat by its id' });
    let conversationId: string;
    try {
      const parsed = parseReadConversationId(rawId);
      if (parsed === undefined) throw new HttpError(400, 'conversation_id must not be empty');
      conversationId = parsed;
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      throw error;
    }
    const requested = parseViewCount(url.searchParams.get('count') ?? undefined);
    if (requested.kind === 'invalid')
      return sendJson(res, 400, { error: `count must be 1-${MAX_VIEW_COUNT}` });
    const result = await deps.peerView?.(conversationId, requested.count, windowId);
    if (!result) return sendJson(res, 404, { error: `no route for GET ${route}` });
    if (!result.ok) return sendJson(res, result.status, { error: result.error });
    return sendJson(res, 200, result.report);
  }
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
  let conversationId: string | undefined;
  try {
    conversationId = parseReadConversationId(url.searchParams.get('conversation_id'));
  } catch (error) {
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
    throw error;
  }
  const sender = await deps.validateFrom?.(from);
  if (sender && !sender.ok) return sendJson(res, 400, { error: sender.error });
  const result =
    route === '/agent/status'
      ? await deps.status?.(from, readSender, conversationId)
      : await deps.view?.(
          from,
          url.searchParams.get('count') ?? undefined,
          readSender,
          conversationId,
        );
  if (!result) return sendJson(res, 404, { error: `no route for GET ${route}` });
  if (result.ok) return sendText(res, 200, result.text);
  return sendJson(res, result.status, { error: result.error });
}
