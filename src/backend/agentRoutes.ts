import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';
import { timingSafeEqual } from 'crypto';
import { BUS_ID_PATTERN, writeReply, type BusPaths } from '../agentBus/agentBus';
import { MAX_INBOUND_CHARS, forgeInboundPrompt } from '../agentBus/busContent';
import type {
  AgentInbox,
  ChatTargetResult,
  ChatTargetSelection,
  ForgeSteerResult,
  InboxMessageOptions,
} from '../agentBus/agentInbox';
import { sendJson, sendText } from './controlHttp';
import { handleAgentFileRoute } from './agentFileRoute';
import { handleVerdictAck, handleVerdictRead } from './agentVerdictRoute';
import {
  AgentRouteHttpError as HttpError,
  readAgentRouteFields as readFields,
  type AgentRouteFields as Fields,
} from './agentRouteFields';
import { parseAgentMessageOptions, parseOriginConversation } from './agentMessageOptions';
import { dispatchAgentRelay } from './agentRelayDispatch';
import { handleAgentRemoteSessionRoute } from './agentRemoteSessionRoute';
import type { RemoteSessionActionResult } from '../remote/RemoteSessionBridge';
import type { AgentSender } from '../agentLinks/chatAgentLinks';
import { isPathInside } from '../util/pathContainment';
import type { InboundAgentSelection, InboundAgentTarget } from '../agentLinks/inboundAgentRouting';
import { PendingAgentReplies } from '../agentLinks/pendingAgentReplies';
import { AgentWindowEndpointRegistry } from './agentWindowEndpointRegistry';
import { admitInboundMessage } from './agentInboundAdmission';
import { parseAgentSender, parseOptionalAgentSender } from './agentSenderParsing';
import type { PendingAgentReply } from '../agentLinks/pendingAgentReplies';

/** An answer may be longer than a new message: it is what Forge asked for. */
const MAX_REPLY_CHARS = 32_000;
const FROM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

type BusReadResult = { ok: true; text: string } | { ok: false; status: 400 | 404; error: string };

export interface AgentRoutesDeps {
  paths: () => BusPaths;
  inbox: Pick<AgentInbox, 'accept' | 'cancel'>;
  /** Only the focused Forge window may claim the shared client endpoint. */
  isFocused?: () => boolean;
  /** Injected by tests; production mints one per activation. */
  token?: string;
  windowId?: string;
  holdsLink?: (sender: AgentSender) => boolean;
  resolveInboundAgent?: (
    sender: AgentSender,
    selection: InboundAgentSelection,
  ) => Promise<InboundAgentTarget>;
  showMovedNotice?: (conversationId: string, message: string) => void;
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
  ) => Promise<
    { ok: true; exchangeId: string; deliveredTo?: string } | { ok: false; error: string }
  >;
  relayAgent?: (
    sender: AgentSender,
    to: string,
    text: string,
    originConversation?: string,
  ) => Promise<
    { ok: true; exchangeId?: string; deliveredTo?: string } | { ok: false; error: string }
  >;
  /**
   * A `priority=steer` message to another named recipient interrupts its
   * active turn and runs the steer next. Absent ⇒ it is an ordinary relay.
   */
  steer?: (
    from: string,
    to: string,
    text: string,
  ) => Promise<
    { ok: true; exchangeId: string; deliveredTo?: string } | { ok: false; error: string }
  >;
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
  /** Interrupt Forge's addressed chat and report whether it was streaming. */
  interruptForge?: (from: string, conversationId: string | undefined) => Promise<ForgeSteerResult>;
  /** Cancel Forge's addressed running turn, without queuing another turn. */
  stopForge?: (
    from: string,
    conversationId: string | undefined,
  ) => Promise<
    | { ok: true; conversationId: string; title: string }
    | { ok: false; status: 400 | 409; error: string }
  >;
  /** Resolve the Forge chat that will receive an accepted agent message. */
  resolveChatTarget?: (from: string, selection: ChatTargetSelection) => ChatTargetResult;
  /**
   * `forge.sh who` — read-only projection of agent sessions linked to chats.
   * Absent ⇒ `GET /agent/who` is 404.
   */
  who?: () => Promise<unknown> | unknown;
  /** Read-only view of the sender's chat; absent means the route is 404. */
  status?: (from: string) => BusReadResult | Promise<BusReadResult>;
  view?: (from: string, count: string | undefined) => BusReadResult | Promise<BusReadResult>;
  /** Direct, model-free delivery of a workspace file to the sender's bound chat. */
  sendFile?: (
    from: string,
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
}

/**
 * The path with symlinks resolved, or as given when it cannot be resolved
 * (missing, unreadable): the caller then has only the lexical comparison. Not
 * thrown, because a 500 here would make forge.sh skip this window entirely,
 * link holder included.
 */
function realOrSelf(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

function requireText(fields: Fields, max: number): string {
  const text = typeof fields['text'] === 'string' ? fields['text'] : undefined;
  if (!text || !text.trim()) throw new HttpError(400, 'text is required');
  if (text.length > max)
    throw new HttpError(400, `text is ${text.length} chars; the limit is ${max}`);
  return text;
}

export class AgentRoutes {
  readonly token: string;
  readonly windowId: string;
  private readonly endpoints: AgentWindowEndpointRegistry;

  constructor(private readonly deps: AgentRoutesDeps) {
    this.endpoints = new AgentWindowEndpointRegistry(
      deps.paths,
      () => deps.isFocused?.() ?? true,
      deps.token,
      deps.windowId,
    );
    this.token = this.endpoints.token;
    this.windowId = this.endpoints.windowId;
  }

  onListening(url: string): void {
    this.endpoints.onListening(url);
  }

  setEnabled(on: boolean): void {
    this.endpoints.setEnabled(on);
  }

  /** Reclaim the client endpoint when this VS Code window gains focus. */
  claim(): void {
    this.endpoints.claim();
  }

  dispose(): void {
    this.endpoints.dispose();
  }

  /**
   * How closely this window's workspace contains the sender's folder: its
   * root's length, or 0. forge.sh sends an unlinked session to the window with
   * the longest match before falling back to the focused one, so a new chat
   * opens in the sender's repo, not whichever window was clicked last.
   * Compared as written and resolved: a shell reports its folder through
   * symlinks resolved (macOS `/var` is `/private/var`), the workspace may not.
   */
  private cwdMatch(cwd: string | null): number {
    const root = this.deps.workspaceRoot;
    if (!cwd || !root || !path.isAbsolute(cwd)) return 0;
    const inside = isPathInside(root, cwd) || isPathInside(realOrSelf(root), realOrSelf(cwd));
    return inside ? path.resolve(root).length : 0;
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;
    const known =
      route === '/agent/message' ||
      route === '/agent/holds-link' ||
      route === '/agent/reply' ||
      route === '/agent/cancel' ||
      (route === '/agent/stop' && !!this.deps.stopForge) ||
      (route === '/agent/who' && !!this.deps.who) ||
      (route === '/agent/status' && !!this.deps.status) ||
      (route === '/agent/view' && !!this.deps.view) ||
      (route === '/agent/send-file' && !!this.deps.sendFile && !!this.deps.validateAgentSender) ||
      ((route === '/agent/remote-ask' || route === '/agent/remote-notify') &&
        !!this.deps.remoteSession) ||
      ((route === '/agent/read-verdict' || route === '/agent/ack-verdict') &&
        !!this.deps.validateFrom);
    if (!this.endpoints.isEnabled() || !known) {
      return sendJson(res, 404, { error: `no route for ${req.method ?? 'GET'} ${route}` });
    }
    if (!this.authorized(req.headers.authorization)) {
      return sendJson(res, 401, {
        error:
          'missing or stale token: read it from endpoint.json (it changes when Forge restarts)',
      });
    }
    if (route === '/agent/holds-link') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
      try {
        const sender = parseAgentSender({
          kind: url.searchParams.get('kind'),
          sessionId: url.searchParams.get('sessionId'),
        });
        return sendJson(res, 200, {
          holdsLink: this.deps.holdsLink?.(sender) === true,
          cwdMatch: this.cwdMatch(url.searchParams.get('cwd')),
        });
      } catch (error) {
        if (error instanceof HttpError)
          return sendJson(res, error.status, { error: error.message });
        throw error;
      }
    }
    // §11: the one GET route. Read-only: it returns the participant projection
    // and touches no other route's state.
    if (route === '/agent/who') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
      const participants = await this.deps.who?.();
      return sendJson(res, 200, { participants });
    }
    if (route === '/agent/status' || route === '/agent/view') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
      const from = (url.searchParams.get('from') ?? '').trim();
      if (!FROM_PATTERN.test(from)) {
        return sendJson(res, 400, {
          error: 'from must be 1-40 chars: letters, digits, space . _ -',
        });
      }
      const sender = await this.deps.validateFrom?.(from);
      if (sender && !sender.ok) return sendJson(res, 400, { error: sender.error });
      const result =
        route === '/agent/status'
          ? await this.deps.status?.(from)
          : await this.deps.view?.(from, url.searchParams.get('count') ?? undefined);
      if (!result) return sendJson(res, 404, { error: `no route for GET ${route}` });
      if (result.ok) return sendText(res, 200, result.text);
      return sendJson(res, result.status, { error: result.error });
    }
    if (route === '/agent/read-verdict') {
      return handleVerdictRead(req, res, url, this.deps);
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
    try {
      const fields = await readFields(req, url);
      if (route === '/agent/ack-verdict') {
        return handleVerdictAck(res, url, fields, this.deps);
      }
      if (route === '/agent/send-file') {
        if (url.searchParams.size > 0)
          throw new HttpError(400, 'send-file fields must be in the request body');
        const { validateAgentSender, sendFile } = this.deps;
        if (!validateAgentSender || !sendFile) {
          return sendJson(res, 404, { error: 'no route for POST /agent/send-file' });
        }
        const result = await handleAgentFileRoute(fields, {
          validateSender: (from, sender) =>
            from === sender.kind
              ? validateAgentSender(sender)
              : { ok: false, error: 'sender kind must match from' },
          sendFile,
        });
        return sendJson(res, result.status, result.body);
      }
      if (route === '/agent/remote-ask' || route === '/agent/remote-notify') {
        const result = await handleAgentRemoteSessionRoute(
          fields,
          route === '/agent/remote-ask' ? 'ask' : 'notify',
          { dispatch: this.deps.remoteSession! },
        );
        return result.kind === 'asked'
          ? sendText(res, 200, result.questionId)
          : sendJson(res, 200, { queued: true });
      }
      if (route === '/agent/reply') {
        const id = typeof fields['id'] === 'string' ? fields['id'] : '';
        if (!BUS_ID_PATTERN.test(id)) throw new HttpError(400, 'id must be the question id');
        writeReply(this.deps.paths(), id, requireText(fields, MAX_REPLY_CHARS));
        return sendJson(res, 200, { delivered: true });
      }
      const from = (typeof fields['from'] === 'string' ? fields['from'] : '').trim();
      if (!FROM_PATTERN.test(from)) {
        throw new HttpError(400, 'from must be 1-40 chars: letters, digits, space . _ -');
      }
      const declaredSender = parseOptionalAgentSender(fields['sender']);
      if (declaredSender && declaredSender.kind !== from)
        throw new HttpError(400, 'sender.kind must match from');
      // M6/§4: an unknown or forged sender is rejected with the live list.
      const sender = declaredSender ? undefined : await this.deps.validateFrom?.(from);
      if (sender && !sender.ok) throw new HttpError(400, sender.error);
      if (route === '/agent/cancel') {
        const id = (typeof fields['id'] === 'string' ? fields['id'] : '').trim();
        if (!id) throw new HttpError(400, 'id is required: a queued message id, or all');
        const cancelled = this.deps.inbox.cancel(from, id);
        if (cancelled === 0) {
          throw new HttpError(
            404,
            id === 'all'
              ? `no queued messages from "${from}"`
              : `no queued message ${id} from "${from}": unknown, already started, or not yours`,
          );
        }
        return sendJson(res, 200, { cancelled });
      }
      if (route === '/agent/stop') {
        const options = parseAgentMessageOptions({ conversation_id: fields['conversation_id'] });
        const result = await this.deps.stopForge!(from, options.conversationId);
        return result.ok
          ? sendJson(res, 200, {
              stopped: true,
              conversationId: result.conversationId,
              title: result.title,
            })
          : sendJson(res, result.status, { error: result.error });
      }
      // M6: an inbound message addressed to another agent (to != forge) is
      // relayed by the host through the recipient's adapter, with zero Forge
      // model turns. The model never decides whether to relay. A non-Forge `to`
      // with no relay installed is rejected, not silently delivered to the
      // Forge inbox (which would treat a message meant for another agent as a
      // prompt for itself).
      const to = (typeof fields['to'] === 'string' ? fields['to'] : '').trim();
      if (fields['origin_conversation'] !== undefined && (!to || to.toLowerCase() === 'forge')) {
        throw new HttpError(
          400,
          'origin_conversation requires a relay recipient (to other than forge)',
        );
      }
      if (to && to.toLowerCase() !== 'forge') {
        if (fields['conversation_id'] !== undefined || fields['to_running'] !== undefined) {
          throw new HttpError(400, 'Forge chat targeting requires to=forge');
        }
        const text = requireText(fields, MAX_INBOUND_CHARS);
        // F-06: a `priority=steer` message interrupts the recipient's active
        // turn and runs the steer next, instead of queuing behind it.
        const isSteer =
          (typeof fields['priority'] === 'string' ? fields['priority'] : '')
            .trim()
            .toLowerCase() === 'steer';
        if (isSteer && fields['origin_conversation'] !== undefined) {
          throw new HttpError(400, 'origin_conversation is only valid for relay sends');
        }
        const relayOrigin = isSteer ? undefined : parseOriginConversation(fields);
        const result = await dispatchAgentRelay({
          ...(declaredSender ? { sender: declaredSender } : {}),
          from,
          to,
          text,
          isSteer,
          ...(relayOrigin ? { originConversation: relayOrigin } : {}),
          deps: this.deps,
        });
        if (!result.ok) throw new HttpError(400, result.error);
        return sendJson(res, 202, {
          relayed: true,
          ...(result.exchangeId ? { exchangeId: result.exchangeId } : {}),
          ...(!isSteer
            ? {
                message:
                  `Sent as exchange ${result.exchangeId}. The verdict wakes the sending Forge chat ` +
                  'when it is open (when the send came from a Forge chat). Use `wait` and then ' +
                  '`read-verdict` for the full response.',
              }
            : {}),
          ...(result.deliveredTo ? { delivered_to: result.deliveredTo } : {}),
        });
      }
      const text = requireText(fields, MAX_INBOUND_CHARS);
      const steerForge =
        (typeof fields['priority'] === 'string' ? fields['priority'] : '').trim().toLowerCase() ===
          'steer' && !!this.deps.interruptForge;
      const admission = await admitInboundMessage({
        from,
        ...(declaredSender ? { sender: declaredSender } : {}),
        messageOptions: this.messageOptions(fields),
        deps: this.deps,
      });
      const options = admission.messageOptions;
      const target = admission.target;
      const pendingReplyId = admission.pendingReplyId;
      const queuedBehindRunningTurn = admission.queuedBehindRunningTurn ?? false;
      let accepted: ReturnType<AgentInbox['accept']>;
      try {
        accepted = this.deps.inbox.accept(
          forgeInboundPrompt(from, text, options.sender),
          from,
          steerForge,
          options,
        );
      } catch (error) {
        if (pendingReplyId) this.deps.pendingReplies?.remove(pendingReplyId);
        throw error;
      }
      if (accepted === undefined) {
        if (pendingReplyId) this.deps.pendingReplies?.remove(pendingReplyId);
        throw new HttpError(429, 'Forge has too many unread agent messages');
      }
      const { position: queued, id } = accepted;
      if (steerForge) {
        const outcome = (await this.deps.interruptForge?.(from, target?.conversationId)) ?? {
          steered: false as const,
          reason: 'no Forge turn was stopped',
        };
        return sendJson(res, 202, { queued, id, ...outcome });
      }
      return sendJson(res, 202, {
        queued,
        id,
        ...(target ? { conversationId: target.conversationId, title: target.title } : {}),
        ...(pendingReplyId ? { exchangeId: pendingReplyId } : {}),
        ...(pendingReplyId && target
          ? {
              receipt: `Forge received your message (chat "${target.title}")${queuedBehindRunningTurn ? ' — queued behind the running turn' : ''}`,
            }
          : {}),
      });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      throw err;
    }
  }

  private messageOptions(fields: Fields): InboxMessageOptions {
    const parsed = parseAgentMessageOptions(fields);
    const validModels = [...(this.deps.configuredModels?.() ?? [])];
    if (parsed.model && !validModels.includes(parsed.model)) {
      throw new HttpError(
        400,
        `model: unknown model "${parsed.model}"; valid models: ${validModels.join(', ') || '(none configured)'}`,
      );
    }
    return parsed;
  }

  private authorized(header: string | undefined): boolean {
    const given = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(this.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }
}
