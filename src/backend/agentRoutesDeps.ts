/**
 * What a Forge window hands its `/agent/*` server: the host's own inbox, the
 * sidebar behind it, and the optional capabilities that decide which routes
 * exist. Split out of `agentRoutes.ts` because that file is the router, and a
 * contract that grows a field every time a cross-window action lands was
 * pushing it past the `max-lines` gate the router needed room under.
 *
 * The optional fields are the route gate, and they are the reason this file
 * exists as a contract rather than as inline parameters: a capability that is
 * absent makes its route answer 404 before the token is even checked
 * (`agentKnownRoutes.ts`), so a caller cannot probe which features a window has.
 * Every one of them is supplied in production by `agentRouteDeps.ts`, and the
 * contract test `AgentRoutesProductionRoutes.test.ts` is what says a route can
 * never be advertised with no handler behind it.
 */
import type { BusPaths } from '../agentBus/agentBus';
import type {
  AgentInbox,
  ChatTargetResult,
  ChatTargetSelection,
  ForgeSteerResult,
} from '../agentBus/agentInbox';
import type { BusReadResult, ChatsReport, PeerViewResult } from './agentChatReadRoute';
import type { AgentSender, AgentSenderMetadata } from '../agentLinks/chatAgentLinks';
import type { InboundAgentSelection, InboundAgentTarget } from '../agentLinks/inboundAgentRouting';
import { PendingAgentReplies, type PendingAgentReply } from '../agentLinks/pendingAgentReplies';
import type { RemoteSessionActionResult } from '../remote/RemoteSessionBridge';
import type { AgentNotifyResult } from './agentNotifyRoute';

/** What a relay, an agent relay and a steer all report: an exchange accepted,
 *  how it was delivered, and `note` for a steer that withdrew an earlier
 *  request from the same chat (audit F2: every agent steer answered
 *  `no relay available to deliver to "<agent>"` because no window supplied a
 *  steer handler at all). */
export type AgentRelayResult =
  | { ok: true; exchangeId?: string; deliveredTo?: string; note?: string }
  | { ok: false; error: string };

type ReloadPreparation =
  | { ok: true; workspaceFolderName: string }
  | { ok: false; status: number; error: string };

export interface AgentRoutesDeps {
  paths: () => BusPaths;
  inbox: Pick<AgentInbox, 'accept' | 'cancel' | 'release'>;
  /** Only the focused Forge window may claim the shared client endpoint. */
  isFocused?: () => boolean;
  /** Injected by tests; production mints one per activation. */
  token?: string;
  windowId?: string;
  holdsLink?: (sender: AgentSender) => boolean;
  holdsChat?: (conversationId: string) => boolean;
  resolveInboundAgent?: (
    sender: AgentSender,
    selection: InboundAgentSelection,
  ) => Promise<InboundAgentTarget>;
  showAlsoLinkedNotice?: (conversationId: string, message: string) => void;
  pendingReplies?: PendingAgentReplies;
  workspaceRoot?: string;
  recordPendingAccepted?: (record: PendingAgentReply) => Promise<void>;
  isChatBusy?: (conversationId: string) => boolean;
  /**
   * Relay for non-agent senders that name a recipient. Agent senders use their
   * session links through `relayAgent`. Absent ⇒ a non-Forge `to` is rejected.
   */
  relay?: (
    from: string,
    to: string,
    text: string,
    originConversation?: string,
  ) => Promise<AgentRelayResult>;
  relayAgent?: (
    sender: AgentSender,
    to: string,
    text: string,
    originConversation?: string,
  ) => Promise<AgentRelayResult>;
  /**
   * A `priority=steer` message to another agent session: withdraw the request
   * this chat has already put to that agent and run this text as the next
   * relay. It takes the verified `AgentSender` like `relayAgent` does — the
   * chat whose link is steered is found through the session id, not through a
   * name. Absent ⇒ a steer to an agent is refused, not queued behind the very
   * request it was meant to replace.
   */
  steer?: (sender: AgentSender, to: string, text: string) => Promise<AgentRelayResult>;
  /**
   * Validate a non-agent sender name against the configured sender set.
   * Agent identities are validated by session id in `validateAgentSender`.
   */
  validateFrom?: (
    from: string,
  ) =>
    | { ok: true }
    | { ok: false; error: string }
    | Promise<{ ok: true } | { ok: false; error: string }>;
  validateAgentSender?: (sender: AgentSender) => { ok: true } | { ok: false; error: string };
  /** Interrupt Forge's addressed chat and report whether it was streaming. A
   *  window that will not interrupt answers `blocked`, and the route takes its
   *  own message back out of the inbox rather than queueing into a turn the
   *  owner has not answered. It carries the chain the sender read
   *  (`expectedEpoch`) so the post-accept backstop compares against the same
   *  epoch the pre-accept guard did. */
  interruptForge?: (
    from: string,
    conversationId: string | undefined,
    expectedEpoch?: number,
  ) => Promise<ForgeSteerResult>;
  /**
   * Why a `priority=steer` message must not be queued at all, as the sentence the
   * sender reads, or nothing when it may proceed. Asked BEFORE `inbox.accept`,
   * because accepting can start the drain in the same tick and a message taken
   * back afterwards may already have become the turn it meant to replace. It
   * takes the chain the sender saw (`expectedEpoch`) so a steer written against
   * one turn cannot interrupt the work the owner asked for since.
   */
  steerGuard?: (
    conversationId: string | undefined,
    title: string | undefined,
    expectedEpoch?: number,
  ) => string | undefined | Promise<string | undefined>;
  /** Cancel Forge's addressed running turn, without queuing another turn. */
  stopForge?: (
    from: string,
    conversationId: string | undefined,
  ) => Promise<
    | { ok: true; conversationId: string; title: string }
    | { ok: false; status: 404 | 409; error: string }
  >;
  /** Resolve an open chat in this window and decide whether reload may proceed. */
  prepareReload?: (
    from: string,
    conversationId: string,
    force: boolean,
  ) => ReloadPreparation | Promise<ReloadPreparation>;
  /** Runs only after the HTTP response has finished, since the command closes this window. */
  reloadWindow?: () => Promise<void>;
  /** Persist a Claude session id before a reload is scheduled. */
  rememberClaudeReopen?: (sessionId: string) => Promise<void>;
  /** Resolve the Forge chat that will receive an accepted agent message. */
  resolveChatTarget?: (from: string, selection: ChatTargetSelection) => ChatTargetResult;
  /** Record a peer chat writer on the accepted destination conversation. */
  recordPeerWriter?: (conversationId: string, writer: { id: string; title: string }) => void;
  /**
   * `forge.sh who` — read-only projection of agent sessions linked to chats.
   * Absent ⇒ `GET /agent/who` is 404.
   */
  who?: () => Promise<unknown> | unknown;
  /** Read-only view of the sender's chat; absent means the route is 404.
   *  `conversationId` is a chat named by `--to`; the dependency answers whether
   *  this window's links allow this sender to read it. */
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
  /** `GET /agent/chats` — this window's chat list for a peer window. Registered
   *  only when supplied, so a window without it answers 404, as every optional
   *  route does. */
  chats?: (windowId: string) => ChatsReport | Promise<ChatsReport>;
  /** `GET /agent/peer-view` — one chat's transcript for a peer window, which
   *  names the chat by id because an id is the only handle a window has of a
   *  neighbour's chat. Absent means the route is 404. */
  peerView?: (
    conversationId: string,
    count: number,
    windowId: string,
  ) => PeerViewResult | Promise<PeerViewResult>;
  /** Direct, model-free delivery of a workspace file to a chat this sender's
   *  session is linked to. The verified sender comes in because the chat is
   *  chosen by id, and only the session id says whether that id is this
   *  sender's chat and not another session's that happens to be linked too. */
  sendFile?: (
    from: string,
    sender: AgentSender,
    conversationId: string,
    workspaceRelativePath: string,
    caption: string,
  ) => Promise<
    { kind: 'sent' } | { kind: 'refused'; error: string } | { kind: 'unknown'; error: string }
  >;
  remoteSession?: (
    from: string,
    sessionId: string,
    id: string,
    action: 'ask' | 'notify',
    text: string,
  ) => Promise<RemoteSessionActionResult>;
  /** Queues a Telegram message to the owner through the job outbox (`forge.sh notify`). */
  notifyOwner?: (from: string, text: string) => Promise<AgentNotifyResult>;
  /** Valid model ids for an inbound message, `model@profile` forms included. */
  configuredModels?: () => readonly string[];
  /**
   * Why a `--new` message could not open a chat, as counts per reason; EMPTY
   * when one can be opened. Asked BEFORE the message is accepted, because the
   * 202 is the last thing the caller can see: without the pre-flight an
   * undeliverable `--new` is accepted, then silently dropped in `drain()`.
   * Absent ⇒ no pre-flight (the failure is only reported afterwards).
   */
  chatCapBlockers?: (options?: { activate?: boolean }) => string[];
  /**
   * `--new`: open, pin, arm Clanker, and name the chat now, so the 202 can name the chat its
   * message will run in, and a pin that fails can be answered 409 with that
   * chat's id while nothing is queued. Absent ⇒ the chat is opened later, inside
   * `drain()`, and the 202 names nothing.
   */
  openBusChat?: (options: {
    sender: string;
    model?: string;
    title?: string;
  }) => Promise<{ ok: true; id: string; title: string } | { ok: false; id: string; error: string }>;
  /** Arm Clanker and announce it for a chat a `--new` opened through the
   *  agent-link path, which opens the chat in the sidebar and so skips
   *  `openBusChat` above. */
  armBusChat?: (conversationId: string, sender: string) => void;
  /**
   * Can this sender's own session be handed Forge's answer the moment the turn
   * ends? It decides the footer of an inbound prompt: a sender whose session
   * lives on another machine is told to read the verdict instead of being
   * promised a delivery nothing will make (fresh-install finding 7). Absent or
   * unanswered means deliverable, so a window that does not check keeps today's
   * promise.
   */
  senderIsLive?: (sender: AgentSenderMetadata) => boolean;
}
