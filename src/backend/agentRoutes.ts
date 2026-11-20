import * as fs from 'fs';
import type * as http from 'http';
import * as path from 'path';
import { MAX_INBOUND_CHARS, forgeInboundPrompt } from '../agentBus/busContent';
import type { AgentInbox, InboxMessageOptions } from '../agentBus/agentInbox';
import { sendJson, sendText, bearerTokenMatches } from './controlHttp';
import { formatWhoText } from './agentWhoText';
import { handleAgentFileRoute } from './agentFileRoute';
import { handleVerdictAck, handleVerdictRead } from './agentVerdictRoute';
import { handleAgentReplyRoute } from './agentReplyRoute';
import { handleAgentChatReadRoute } from './agentChatReadRoute';
import { isKnownAgentRoute } from './agentKnownRoutes';
import {
  AgentRouteHttpError as HttpError,
  readAgentRouteFields as readFields,
  requireText,
  type AgentRouteFields as Fields,
} from './agentRouteFields';
import {
  parseAgentMessageOptions,
  parseFromConversation,
  parseOriginConversation,
} from './agentMessageOptions';
import { getLogger } from '../util/logger';
import { dispatchAgentRelay } from './agentRelayDispatch';
import { isClaudeSessionId } from '../agentBus/claudeReopen';
import { handleAgentRemoteSessionRoute } from './agentRemoteSessionRoute';
import { handleAgentNotifyRoute } from './agentNotifyRoute';
import { isPathInside } from '../util/pathContainment';
import { AgentWindowEndpointRegistry } from './agentWindowEndpointRegistry';
import { admitInboundMessage } from './agentInboundAdmission';
import type { AgentRoutesDeps } from './agentRoutesDeps';
import {
  parseAgentSender,
  parseOptionalAgentSender,
  validateBusSenderName,
} from './agentSenderParsing';

const log = getLogger();

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
    const known = isKnownAgentRoute(route, this.deps);
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
        const rawConversationId = url.searchParams.get('conversation_id');
        const conversationId =
          rawConversationId === null
            ? undefined
            : parseAgentMessageOptions({ conversation_id: rawConversationId }).conversationId;
        if (rawConversationId !== null && conversationId === undefined) {
          throw new HttpError(400, 'conversation_id is required: name the chat by its id');
        }
        return sendJson(res, 200, {
          holdsLink: this.deps.holdsLink?.(sender) === true,
          cwdMatch: this.cwdMatch(url.searchParams.get('cwd')),
          ...(conversationId === undefined
            ? {}
            : { holdsChat: this.deps.holdsChat?.(conversationId) === true }),
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
      if (url.searchParams.get('format') === 'text') {
        return sendText(res, 200, formatWhoText(participants));
      }
      return sendJson(res, 200, { participants });
    }
    if (
      route === '/agent/status' ||
      route === '/agent/view' ||
      route === '/agent/chats' ||
      route === '/agent/peer-view'
    ) {
      return handleAgentChatReadRoute(req, res, url, route, this.deps, this.windowId);
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
        const result = handleAgentReplyRoute({ fields, paths: this.deps.paths() });
        return sendJson(res, result.status, result.body);
      }
      const from = (typeof fields['from'] === 'string' ? fields['from'] : '').trim();
      const name = validateBusSenderName(from);
      if (!name.ok) throw new HttpError(400, name.error);
      const declaredSender = parseOptionalAgentSender(fields['sender']);
      if (declaredSender && declaredSender.kind !== from)
        throw new HttpError(400, 'sender.kind must match from');
      // M6/§4: an unknown or forged sender is rejected with the live list.
      const sender = declaredSender ? undefined : await this.deps.validateFrom?.(from);
      if (sender && !sender.ok) throw new HttpError(400, sender.error);
      if (route === '/agent/notify') {
        const result = await handleAgentNotifyRoute(from, fields, this.deps.notifyOwner!);
        return sendText(res, result.status, result.text);
      }

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
      if (route === '/agent/reload') {
        const rawConversationId = fields['conversation_id'];
        if (typeof rawConversationId !== 'string') {
          throw new HttpError(400, 'conversation_id is required: name the chat by its id');
        }
        const options = parseAgentMessageOptions({ conversation_id: rawConversationId });
        if (options.conversationId === undefined) {
          throw new HttpError(400, 'conversation_id is required: name the chat by its id');
        }
        const rawForce = fields['force'];
        if (rawForce !== undefined && rawForce !== 'true') {
          throw new HttpError(400, 'force must be true when supplied');
        }
        const rawClaudeSessionId = fields['reopen_claude_session'];
        if (rawClaudeSessionId !== undefined && !isClaudeSessionId(rawClaudeSessionId)) {
          throw new HttpError(
            400,
            'reopen_claude_session must be a Claude Code session id (a UUID)',
          );
        }
        const result = await this.deps.prepareReload!(
          from,
          options.conversationId,
          rawForce === 'true',
        );
        if (!result.ok) return sendText(res, result.status, result.error);
        if (rawClaudeSessionId !== undefined) {
          try {
            if (!this.deps.rememberClaudeReopen) {
              throw new Error('rememberClaudeReopen is not wired');
            }
            await this.deps.rememberClaudeReopen(rawClaudeSessionId);
          } catch (error) {
            log.error('[agentRoutes] Could not persist the pending Claude reopen request', error);
            return sendText(
              res,
              500,
              `Could not remember Claude Code session ${rawClaudeSessionId} for reload.`,
            );
          }
        }
        const message = rawClaudeSessionId
          ? `Reloading the window for "${result.workspaceFolderName}". Claude session ${rawClaudeSessionId} reopens there after the reload; it stays idle until a message wakes it. Run who or status in a few seconds to see it back.`
          : `Reloading the window for "${result.workspaceFolderName}". ` +
            'Run who or status in a few seconds to see it back.';
        res.once('finish', () => {
          void this.deps.reloadWindow!().catch((error: unknown) => {
            log.error(`[agentRoutes] window reload failed: ${String(error)}`);
          });
        });
        return sendText(res, 200, message);
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
          ...(result.note ? { note: result.note } : {}),
        });
      }
      const text = requireText(fields, MAX_INBOUND_CHARS);
      const steerForge =
        (typeof fields['priority'] === 'string' ? fields['priority'] : '').trim().toLowerCase() ===
        'steer';
      // A window that cannot interrupt cannot steer. Said here, before anything
      // is queued, because the answer it would otherwise give is the one a plain
      // send gives — "queued" — and the sender would report an interruption that
      // nothing here was ever going to make.
      if (steerForge && !this.deps.interruptForge)
        throw new HttpError(409, 'this window cannot steer a Forge chat. Nothing was queued.');
      const steerEpochField =
        typeof fields['steer_epoch'] === 'string' ? fields['steer_epoch'].trim() : '';
      if (steerForge && steerEpochField !== '' && !Number.isInteger(Number(steerEpochField)))
        throw new HttpError(400, 'steer_epoch must be an integer when it is sent');
      const fromConversation = parseFromConversation(fields);
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
      // A steer is refused before anything is queued, and its last check runs
      // AFTER admission with the queue holding the message unstarted until it
      // passes: `accept` can start the drain in the same tick, so a message
      // cancelled after the answer came back is not reliably withdrawn — it may
      // already be the turn this one meant to replace. `steer_epoch` is the
      // chain the sender read, so a steer written against a turn that has since
      // been followed by the owner's own message is refused rather than
      // interrupting the newer work. A steer whose chat cannot be named, or
      // with no guard to check it against, is refused here while nothing is
      // queued: after acceptance no answer could honestly say "nothing was
      // queued".
      let expectedEpoch: number | undefined;
      if (steerForge) {
        expectedEpoch = steerEpochField === '' ? undefined : Number(steerEpochField);
        if (target === undefined || this.deps.steerGuard === undefined)
          throw new HttpError(
            409,
            'this window cannot say which chat a steer would reach. Nothing was queued.',
          );
        const refusal = await this.deps.steerGuard(
          target.conversationId,
          target.title,
          expectedEpoch,
        );
        if (refusal) {
          if (pendingReplyId) this.deps.pendingReplies?.remove(pendingReplyId);
          throw new HttpError(409, `${refusal}. Nothing was queued.`);
        }
      }
      let accepted: ReturnType<AgentInbox['accept']>;
      try {
        accepted = this.deps.inbox.accept(
          forgeInboundPrompt(
            from,
            text,
            options.sender,
            // Only a sender whose session this window can reach live is promised
            // an automatic answer; the rest are pointed at `read-verdict`.
            options.sender ? (this.deps.senderIsLive?.(options.sender) ?? true) : true,
          ),
          from,
          steerForge,
          steerForge ? { ...options, hold: true } : options,
        );
      } catch (error) {
        if (pendingReplyId) this.deps.pendingReplies?.remove(pendingReplyId);
        throw error;
      }
      if (accepted === undefined) {
        if (pendingReplyId) this.deps.pendingReplies?.remove(pendingReplyId);
        // A `--new` opened its chat before the inbox was asked, so the refusal
        // has to name what it left behind: an empty chat nobody told the owner
        // about is a tab they cannot find, and a retry opens a second one.
        throw new HttpError(
          429,
          `Forge has too many unread agent messages${
            target
              ? `. The new chat "${target.title}" (${target.conversationId}) is open and empty; close it, or clear the inbox and send again`
              : ''
          }.`,
        );
      }
      const { position: queued, id } = accepted;
      if (fromConversation && target) {
        this.deps.recordPeerWriter?.(target.conversationId, { id: fromConversation, title: from });
      }
      if (steerForge) {
        let outcome: Awaited<ReturnType<NonNullable<typeof this.deps.interruptForge>>>;
        try {
          // The backstop carries the epoch the sender read: a chain that moved
          // between the guard and here is caught while the held message has
          // still never run, so taking it back is a guaranteed withdrawal.
          outcome = (await this.deps.interruptForge?.(
            from,
            target?.conversationId,
            expectedEpoch,
          )) ?? { steered: false as const, reason: 'no Forge turn was stopped' };
        } catch (error) {
          this.deps.inbox.cancel(from, id);
          if (pendingReplyId) this.deps.pendingReplies?.remove(pendingReplyId);
          throw error;
        }
        // Nothing was interrupted, so this message does not belong in the
        // inbox either: it would land in front of a turn the owner has not
        // answered. The queue never started it, so taking it back is certain.
        if (!outcome.steered && outcome.blocked) {
          this.deps.inbox.cancel(from, id);
          if (pendingReplyId) this.deps.pendingReplies?.remove(pendingReplyId);
          throw new HttpError(409, `${outcome.reason}. Nothing was queued.`);
        }
        // The last guard has passed: the held message may now start, in the
        // lane the interrupted turn is freeing.
        this.deps.inbox.release(id);
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
    return bearerTokenMatches(header, this.token);
  }
}
