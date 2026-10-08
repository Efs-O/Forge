import * as fs from 'fs';
import * as path from 'path';
import type { BusTurnEnd } from '../agentBus/agentInbox';
import { processIsAlive } from '../agentBus/windowEndpoints';
import { EXCHANGES_LOG_NAME, appendEvent } from '../agentMesh/exchangeLog';
import { retainVerdict, verdictEventId } from '../agentMesh/verdictArtifact';
import { writeFileAtomicSync } from '../util/atomicWrite';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { PendingAgentReply, PendingAgentReplies } from './pendingAgentReplies';
import type { AskAgentRuntime } from './askAgentService';
import { deliverAgentReply } from './askAgentService';
import { agentDisplayName } from './chatAgentLinks';

export async function recordAcceptedInboundReply(
  root: string,
  record: PendingAgentReply,
): Promise<void> {
  await appendEvent(
    {
      log: path.join(root, EXCHANGES_LOG_NAME),
      lock: path.join(root, 'exchanges.lock'),
    },
    {
      eventId: record.exchangeId,
      ts: record.createdAt,
      exchangeId: record.exchangeId,
      workspace: record.workspace,
      conversation: record.conversationId,
      from: record.sender.kind,
      senderSessionId: record.sender.sessionId,
      type: 'message',
      state: 'accepted',
    },
  );
}

export function makeAgentReplyLifecycle(options: {
  root: string;
  workspaceRoot: string;
  pending: PendingAgentReplies;
  runtime: AskAgentRuntime;
  getFacade(): ForgeHostFacade;
  isOwnerAlive?: (pid: number) => boolean;
  showWarning: (message: string) => void;
}) {
  const handlers = {
    onAgentTurnStarted: (turn: {
      pendingReplyId?: string;
      targetConversationId?: string;
      sender?: { kind: 'claude' | 'codex' | 'copilot'; title: string };
    }) => {
      if (!turn.pendingReplyId || !turn.sender || !turn.targetConversationId) return;
      options.pending.markRunning(turn.pendingReplyId);
      const facade = options.getFacade();
      const title = facade
        .status()
        .conversations.find((item) => item.id === turn.targetConversationId)?.title;
      if (!title)
        throw new Error(`Chat ${turn.targetConversationId} disappeared before its turn started.`);
      facade.showConversationNotice(
        turn.targetConversationId,
        `✓ delivered to ${agentDisplayName(turn.sender.kind)} · ${turn.sender.title}`,
      );
    },
    onAgentTurnFinished: async (
      turn: {
        pendingReplyId?: string;
        targetConversationId?: string;
        sender?: { kind: 'claude' | 'codex' | 'copilot'; sessionId: string; title: string };
      },
      end: BusTurnEnd,
    ) => {
      if (!turn.pendingReplyId || !turn.sender || !turn.targetConversationId) return;
      const facade = options.getFacade();
      const chatTitle = facade
        .status()
        .conversations.find((item) => item.id === turn.targetConversationId)?.title;
      if (!chatTitle)
        throw new Error(`Chat ${turn.targetConversationId} disappeared before its reply finished.`);
      const finalText = end.finalText?.trim() ? end.finalText : undefined;
      const missingCompletedAnswer = end.kind === 'completed' && !finalText;
      const text =
        finalText ??
        (end.kind === 'completed'
          ? `Forge (chat "${chatTitle}") finished without a final answer.`
          : `Forge ${end.kind}: ${end.error ?? 'no final answer'}`);
      const record = options.pending.markFinished(turn.pendingReplyId, { kind: end.kind, text });
      const linked = facade.getAgentLink(record.conversationId, record.sender.kind);
      const logPaths = {
        log: path.join(options.root, EXCHANGES_LOG_NAME),
        lock: path.join(options.root, 'exchanges.lock'),
      };
      let delivered = false;
      if (linked?.sessionId === record.sender.sessionId) {
        try {
          delivered = await deliverAgentReply(
            options.runtime,
            record.sender.kind,
            linked,
            missingCompletedAnswer ? text : `Forge (chat "${chatTitle}") replied:\n\n${text}`,
            new AbortController().signal,
          );
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          facade.showConversationNotice(record.conversationId, `✗ ${why}`);
        }
      }
      if (!delivered) {
        const source = path.join(options.root, 'outbox', `${record.exchangeId}-reply.md.tmp`);
        fs.mkdirSync(path.dirname(source), { recursive: true });
        writeFileAtomicSync(source, `${text}\n`);
        retainVerdict(options.root, source, record.exchangeId);
        facade.showConversationNotice(
          record.conversationId,
          'Forge reply was not seen live; it is available with forge.sh read-verdict.',
        );
      }
      await appendEvent(logPaths, {
        eventId: verdictEventId(record.exchangeId),
        ts: Date.now(),
        exchangeId: record.exchangeId,
        workspace: record.workspace,
        conversation: record.conversationId,
        from: record.sender.kind,
        type: 'verdict',
        state: 'completed',
        detail: delivered
          ? 'reply delivered to the live sender session'
          : 'sender was not live; answer retained for read-verdict',
      });
      options.pending.remove(record.exchangeId);
    },
    onAgentTurnCancelled: (turn: { pendingReplyId?: string }) => {
      if (turn.pendingReplyId) options.pending.remove(turn.pendingReplyId);
    },
  };
  return {
    ...handlers,
    recover: async (): Promise<void> => {
      for (const record of options.pending.list().sort((a, b) => a.createdAt - b.createdAt)) {
        if (record.workspace !== options.workspaceRoot) continue;
        try {
          const facade = options.getFacade();
          const known = facade
            .status()
            .conversations.some((item) => item.id === record.conversationId);
          if (!known)
            throw new Error(`Chat "${record.conversationId}" is not known in this window.`);
          if (options.pending.expired(record)) {
            facade.showConversationNotice(
              record.conversationId,
              `Pending reply for ${agentDisplayName(record.sender.kind)} session "${record.sender.title}" expired after 24 hours.`,
            );
            options.pending.remove(record.exchangeId);
            continue;
          }
          if ((options.isOwnerAlive ?? processIsAlive)(record.ownerPid)) continue;
          await facade.restoreConversation(record.conversationId, { activate: false });
          const recovered =
            record.state === 'finished'
              ? record
              : options.pending.markFinished(record.exchangeId, {
                  kind: 'failed',
                  text: 'Forge restarted before answering.',
                });
          await handlers.onAgentTurnFinished(
            {
              pendingReplyId: recovered.exchangeId,
              targetConversationId: recovered.conversationId,
              sender: recovered.sender,
            },
            {
              kind: recovered.outcome?.kind ?? 'failed',
              ...(recovered.outcome?.text ? { finalText: recovered.outcome.text } : {}),
            },
          );
        } catch (error) {
          options.showWarning(
            `Forge could not recover pending reply ${record.exchangeId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
  };
}
