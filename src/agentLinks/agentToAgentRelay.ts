import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  findBySession,
  agentDisplayName,
  agentKindSchema,
  type AgentSender,
} from './chatAgentLinks';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { appendEvent, EXCHANGES_LOG_NAME } from '../agentMesh/exchangeLog';
import { retainVerdict, verdictEventId } from '../agentMesh/verdictArtifact';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { getLogger } from '../util/logger';
import type { AskAgentRuntime } from './askAgentService';
import { deliverAgentReply } from './askAgentService';

const log = getLogger();

export function makeAgentToAgentRelay(
  getFacade: () => ForgeHostFacade,
  root: string,
  workspace: string,
  runtime: AskAgentRuntime,
) {
  return async (
    sender: AgentSender,
    target: string,
    message: string,
    originConversation?: string,
  ) => {
    const conversationId = findBySession(sender.sessionId);
    if (!conversationId)
      return {
        ok: false as const,
        error: 'You are not linked to a Forge chat; message Forge with say first.',
      };
    const facade = getFacade();
    const ownerLink = facade.getAgentLink(conversationId, sender.kind);
    if (!ownerLink || ownerLink.sessionId !== sender.sessionId)
      return {
        ok: false as const,
        error: 'You are not linked to a Forge chat; message Forge with say first.',
      };
    const agent = agentKindSchema.parse(target);
    const chatTitle =
      facade.status().conversations.find((item) => item.id === conversationId)?.title ??
      conversationId;
    const exchangeId = randomUUID();
    const logPaths = {
      log: path.join(root, EXCHANGES_LOG_NAME),
      lock: path.join(root, 'exchanges.lock'),
    };
    fs.mkdirSync(root, { recursive: true });
    const common = {
      exchangeId,
      workspace,
      conversation: conversationId,
      from: sender.kind,
      senderSessionId: sender.sessionId,
      to: agent,
      type: 'relay',
    };
    try {
      await appendEvent(logPaths, {
        ...common,
        eventId: exchangeId,
        ts: Date.now(),
        state: 'created',
        ...(originConversation ? { originConversation } : {}),
      });
      await appendEvent(logPaths, {
        ...common,
        eventId: `accepted-${exchangeId}`,
        ts: Date.now(),
        state: 'accepted',
      });
      void completeRelay({
        facade,
        runtime,
        conversationId,
        chatTitle,
        sender,
        target: agent,
        message,
        exchangeId,
        root,
        workspace,
        logPaths,
        common,
      }).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        log.error(`Agent relay ${exchangeId} recovery failed: ${detail}`);
        facade.showConversationNotice(conversationId, `Agent relay failed: ${detail}`);
      });
      return {
        ok: true as const,
        exchangeId,
        deliveredTo: `${agentDisplayName(agent)} link in chat ${conversationId}`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await appendEvent(logPaths, {
        ...common,
        eventId: `rejected-${exchangeId}`,
        ts: Date.now(),
        state: 'rejected',
        detail,
      });
      return { ok: false as const, error: detail };
    }
  };
}

async function completeRelay(options: {
  facade: ForgeHostFacade;
  runtime: AskAgentRuntime;
  conversationId: string;
  chatTitle: string;
  sender: AgentSender;
  target: AgentSender['kind'];
  message: string;
  exchangeId: string;
  root: string;
  workspace: string;
  logPaths: { log: string; lock: string };
  common: {
    exchangeId: string;
    workspace: string;
    conversation: string;
    from: string;
    senderSessionId: string;
    to: string;
    type: string;
  };
}): Promise<void> {
  const name = agentDisplayName(options.target);
  try {
    await appendEvent(options.logPaths, {
      ...options.common,
      eventId: `started-${options.exchangeId}`,
      ts: Date.now(),
      state: 'started',
    });
    const result = await options.facade.askAgent(
      options.conversationId,
      { agent: options.target, message: options.message },
      new AbortController().signal,
    );
    if (result.status !== 'completed' || !result.finalText.trim())
      throw new Error(result.error ?? `${name} completed without an answer.`);
    const answer = result.finalText.trim();
    const source = path.join(options.root, 'outbox', `${options.exchangeId}.verdict.md.tmp`);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    writeFileAtomicSync(source, `${answer}\n`);
    retainVerdict(options.root, source, options.exchangeId);
    const senderLink = options.facade.getAgentLink(options.conversationId, options.sender.kind);
    let delivered = false;
    if (senderLink?.sessionId === options.sender.sessionId) {
      try {
        delivered = await deliverAgentReply(
          options.runtime,
          options.sender.kind,
          senderLink,
          `Forge (chat "${options.chatTitle}") replied:\n\n${answer}`,
          new AbortController().signal,
        );
      } catch (error) {
        options.facade.showConversationNotice(
          options.conversationId,
          `Could not deliver ${name}'s reply live: ${error instanceof Error ? error.message : String(error)}. It is available with forge.sh read-verdict ${options.exchangeId}.`,
        );
      }
    }
    if (!delivered)
      options.facade.showConversationNotice(
        options.conversationId,
        `${name} replied; the answer was not seen live and is available with forge.sh read-verdict ${options.exchangeId}.`,
      );
    await appendEvent(options.logPaths, {
      ...options.common,
      eventId: verdictEventId(options.exchangeId),
      ts: Date.now(),
      type: 'verdict',
      state: 'completed',
      detail: delivered
        ? 'answer delivered live and retained as verdict'
        : 'answer retained as verdict',
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await appendEvent(options.logPaths, {
      ...options.common,
      eventId: `crashed-${options.exchangeId}`,
      ts: Date.now(),
      state: 'crashed',
      detail,
    });
    options.facade.showConversationNotice(
      options.conversationId,
      `${name} relay failed: ${detail}`,
    );
  }
}
