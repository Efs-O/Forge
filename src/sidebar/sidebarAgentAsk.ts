import { randomUUID } from 'crypto';
import { agentTargetCatalog, agentTargetIdentity } from '../agentLinks/agentTargets';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import { AgentLinksConfigSchema } from '../config/agentBusSchema';
import type { ForgeConfig } from '../config/types';
import {
  makeAskAgentHandler,
  type AskAgentRequest,
  type AskAgentResult,
} from '../agentLinks/askAgentService';
import { makeAskAgentRuntime } from '../agentLinks/askAgentRuntime';
import {
  renderAskAgentResult,
  renderAskQueued,
  renderAskReplyMessage,
  renderAskStarted,
  renderAskStillPending,
} from '../agentLinks/askAgentResult';
import {
  addPendingAgentAsk,
  BACKGROUND_ASK_LIMIT_MS,
  cancelPendingAgentAsks,
  formatAskAge,
  newExchangeId,
  pendingAgentAsksForAgent,
  removePendingAgentAsk,
  type PendingAgentAsk,
  type StartAgentAsk,
} from '../agentLinks/pendingAgentAsks';
import type { AgentLink } from '../agentLinks/chatAgentLinks';
import { logger } from '../util/logger';
import type { ChatMessageDelivery } from './backgroundExitNotice';
import { findConversation, type SidebarRuntime } from './sessionTypes';

export function createSidebarAgentAsk(options: {
  getConfig: () => ForgeConfig;
  getSidebar: () => SidebarRuntime;
  checkpoints: CheckpointStack;
  workspaceRoot?: string;
  persist(): void;
  /** Pending asks pin their chat until the background reply settles. */
  onPendingChanged?: (conversationId: string) => void;
  /** The `message_chat` path: a tell when the chat is busy, else a visible turn. */
  deliver: (text: string, conversationId: string) => Promise<ChatMessageDelivery>;
}) {
  const controllers = new Map<string, AbortController>();
  const makeHandler = (waitLimitMs?: number) =>
    makeAskAgentHandler({
      getConfig: options.getConfig,
      runtime: makeAskAgentRuntime({
        getConfig: options.getConfig,
        ...(waitLimitMs ? { waitLimitMs } : {}),
      }),
      getLinkConfig: () => AgentLinksConfigSchema.parse(options.getConfig().agent_links),
    });
  // The remote ask blocks its caller, so it keeps the default limits.
  const handler = makeHandler();
  const backgroundHandler = makeHandler(BACKGROUND_ASK_LIMIT_MS);

  const deliverReply = (entry: PendingAgentAsk, result: AskAgentResult): void => {
    const where = `ask ${entry.exchangeId} in ${entry.conversationId}`;
    // Stop and close abort the ask; a reply then must not start a new turn.
    if (entry.controller.signal.aborted || result.status === 'cancelled') {
      logger.info(`[ask-agent] ${where} was cancelled; no reply delivered`);
      return;
    }
    // Open chats only: `findConversation` also matches archived ones.
    if (!options.getSidebar().conversations.some((c) => c.id === entry.conversationId)) {
      logger.info(`[ask-agent] dropped the reply to ${where}: the chat is no longer open`);
      return;
    }
    void options
      .deliver(renderAskReplyMessage(entry.exchangeId, result), entry.conversationId)
      .then(
        (delivery) => {
          if (delivery.kind === 'refused')
            logger.warn(`[ask-agent] the reply to ${where} was refused: ${delivery.error}`);
        },
        (err: unknown) => logger.warn(`[ask-agent] the reply to ${where} failed: ${String(err)}`),
      );
  };

  const runEntry = async (
    entry: PendingAgentAsk,
    conversation: NonNullable<ReturnType<typeof findConversation>>,
    queued: boolean,
  ): Promise<string> => {
    if (entry.controller.signal.aborted) {
      removePendingAgentAsk(entry);
      const next = pendingAgentAsksForAgent(entry.conversationId, entry.agent)[0];
      if (next) void runEntry(next, conversation, true);
      options.onPendingChanged?.(entry.conversationId);
      return renderAskAgentResult({
        agent: entry.agent,
        status: 'cancelled',
        finalText: '',
        sessionTitle: '',
        subject: '',
        live: false,
      });
    }
    // Starting now: from here the notice reports it as running, aged from its start.
    if (queued) {
      delete entry.queuedAfterExchangeId;
      entry.startedAt = Date.now();
    }
    let started = false;
    let markStarted!: () => void;
    const startedSignal = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const checkpoint = options.checkpoints.beginTurn(
      `agent-ask-${entry.exchangeId}`,
      entry.conversationId,
    );
    const run = (async (): Promise<AskAgentResult> => {
      try {
        return await backgroundHandler(entry.request, {
          conversation,
          checkpoint,
          signal: entry.controller.signal,
          workspaceRoot: options.workspaceRoot ?? '',
          persistConversation: options.persist,
          onStarted: () => {
            started = true;
            markStarted();
          },
        });
      } catch (err) {
        return {
          agent: entry.agent,
          status: 'failed',
          finalText: '',
          sessionTitle: '',
          subject: '',
          live: false,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        options.checkpoints.commitTurn(checkpoint);
        removePendingAgentAsk(entry);
        options.onPendingChanged?.(entry.conversationId);
        options.persist();
      }
    })();
    void run.then((result) => {
      if (started || queued) deliverReply(entry, result);
      const next = pendingAgentAsksForAgent(entry.conversationId, entry.agent)[0];
      if (next) void runEntry(next, conversation, true);
    });
    const early = await Promise.race([
      startedSignal.then(() => undefined),
      run.then((result) => (started ? undefined : result)),
    ]);
    return queued
      ? renderAskQueued(entry.agent, entry.exchangeId, entry.queuedAfterExchangeId ?? '')
      : early
        ? renderAskAgentResult(early)
        : renderAskStarted(entry.agent, entry.exchangeId);
  };

  const start: StartAgentAsk = async (conversationId, request) => {
    const conversation = findConversation(options.getSidebar(), conversationId);
    if (!conversation) return 'Error: ask_agent: this chat is not available in this window.';
    const message = request.message.trim();
    const queuedRequest = { ...request, message };
    let targetIdentity: string | undefined;
    if (request.targetId) {
      try {
        const selected = agentTargetCatalog.pin(
          queuedRequest,
          conversationId,
          options.workspaceRoot ?? '',
          request.targetId,
        );
        if (selected.agent !== request.agent)
          return 'Error: CLI target belongs to a different agent; nothing was sent.';
        targetIdentity = agentTargetIdentity(selected);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const queue = pendingAgentAsksForAgent(conversationId, request.agent);
    const busy = queue.find(
      (entry) => entry.message === message && entry.targetIdentity === targetIdentity,
    );
    if (busy)
      return renderAskStillPending(
        request.agent,
        busy.exchangeId,
        formatAskAge(busy.startedAt, Date.now()),
      );
    const tail = queue[queue.length - 1];
    const entry: PendingAgentAsk = {
      exchangeId: newExchangeId(),
      conversationId,
      agent: request.agent,
      message,
      request: queuedRequest,
      ...(targetIdentity ? { targetIdentity } : {}),
      startedAt: Date.now(),
      controller: new AbortController(),
      ...(tail ? { queuedAfterExchangeId: tail.exchangeId } : {}),
    };
    addPendingAgentAsk(entry);
    options.onPendingChanged?.(conversationId);
    return tail
      ? renderAskQueued(request.agent, entry.exchangeId, tail.exchangeId)
      : runEntry(entry, conversation, false);
  };

  return {
    start,
    cancel: (conversationId: string) => {
      controllers.get(conversationId)?.abort();
      cancelPendingAgentAsks(conversationId);
    },
    async ask(
      conversationId: string,
      request: AskAgentRequest,
      signal: AbortSignal,
      onSessionLinked?: (link: AgentLink) => void,
      onAccepted?: (link: AgentLink) => void,
    ): Promise<AskAgentResult> {
      const conversation = findConversation(options.getSidebar(), conversationId);
      if (!conversation) throw new Error('The bound chat is not available in this window.');
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal.addEventListener('abort', abort, { once: true });
      controllers.set(conversationId, controller);
      const checkpoint = options.checkpoints.beginTurn(
        `remote-agent-${randomUUID()}`,
        conversationId,
      );
      try {
        return await handler(request, {
          conversation,
          checkpoint,
          signal: controller.signal,
          workspaceRoot: options.workspaceRoot ?? '',
          persistConversation: options.persist,
          ...(onSessionLinked ? { onSessionLinked } : {}),
          ...(onAccepted ? { onAccepted } : {}),
        });
      } finally {
        options.checkpoints.commitTurn(checkpoint);
        if (controllers.get(conversationId) === controller) controllers.delete(conversationId);
        signal.removeEventListener('abort', abort);
        options.persist();
      }
    },
  };
}
