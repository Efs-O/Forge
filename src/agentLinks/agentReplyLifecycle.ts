import * as fs from 'fs';
import * as path from 'path';
import type { BusTurnEnd } from '../agentBus/agentInbox';
import { processIsAlive } from '../agentBus/windowEndpoints';
import { EXCHANGES_LOG_NAME, appendEvent, type ExchangeLogPaths } from '../agentMesh/exchangeLog';
import { retainVerdict, verdictEventId } from '../agentMesh/verdictArtifact';
import { writeFileAtomicSync } from '../util/atomicWrite';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { PendingAgentReply, PendingAgentReplies } from './pendingAgentReplies';
import type { AskAgentRuntime } from './askAgentService';
import { deliverAgentReply } from './askAgentService';
import { agentDisplayName } from './chatAgentLinks';

/** The exchange log and its lock, beside the bus folder `root` names. */
function busLogPaths(root: string): ExchangeLogPaths {
  return {
    log: path.join(root, EXCHANGES_LOG_NAME),
    lock: path.join(root, 'exchanges.lock'),
  };
}

export async function recordAcceptedInboundReply(
  root: string,
  record: PendingAgentReply,
): Promise<void> {
  await appendEvent(busLogPaths(root), {
    eventId: record.exchangeId,
    ts: record.createdAt,
    exchangeId: record.exchangeId,
    workspace: record.workspace,
    conversation: record.conversationId,
    from: record.sender.kind,
    senderSessionId: record.sender.sessionId,
    type: 'message',
    state: 'accepted',
  });
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
  const logPaths = busLogPaths(options.root);
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
        facade.emitHostActivity?.({
          conversationId: record.conversationId,
          text: `Forge reply was not seen live by ${agentDisplayName(record.sender.kind)} (${record.sender.title}); it is available with forge.sh read-verdict.`,
        });
      } else {
        facade.emitHostActivity?.({
          conversationId: record.conversationId,
          text: `✓ delivered to ${agentDisplayName(record.sender.kind)} (${record.sender.title})`,
        });
      }
      await appendEvent(logPaths, {
        eventId: verdictEventId(record.exchangeId),
        ts: Date.now(),
        exchangeId: record.exchangeId,
        workspace: record.workspace,
        conversation: record.conversationId,
        from: record.sender.kind,
        type: 'verdict',
        // Audit F8: this said `completed` whatever the turn actually did, so a
        // turn the user stopped read back as finished work. `cancelled` is the
        // state the delivery machine has for it (deliveryState.ts), and it is a
        // legal step from `accepted` and from `started`. A failed turn keeps
        // `completed` because the machine has no `failed` state and
        // `accepted -> crashed` is not a legal transition, so its detail is
        // what tells the reader the truth.
        state: end.kind === 'completed' || end.kind === 'failed' ? 'completed' : 'cancelled',
        detail:
          end.kind === 'completed'
            ? delivered
              ? 'reply delivered to the live sender session'
              : 'sender was not live; answer retained for read-verdict'
            : end.kind === 'failed'
              ? `turn failed (${end.error ?? 'no error given'}); ${
                  delivered ? 'delivered to the live sender session' : 'retained for read-verdict'
                }`
              : `turn ${end.kind} before answering; ${
                  delivered
                    ? 'notice delivered to the live sender session'
                    : 'retained for read-verdict'
                }`,
      });
      options.pending.remove(record.exchangeId);
    },
    onAgentTurnCancelled: async (turn: {
      pendingReplyId?: string;
      targetConversationId?: string;
      sender?: { kind: 'claude' | 'codex' | 'copilot'; sessionId: string; title: string };
    }) => {
      if (!turn.pendingReplyId) return;
      // The record goes first: it is what recovery would otherwise replay as a
      // reply still owed to a message that is no longer queued.
      options.pending.remove(turn.pendingReplyId);
      // Audit F8: a message withdrawn with `forge.sh cancel` left its exchange
      // at `accepted` forever and said nothing about the withdrawal, so a reader
      // could not tell withdrawn work from work still waiting in a chat that
      // had nothing waiting.
      if (!turn.sender || !turn.targetConversationId) return;
      try {
        await appendEvent(logPaths, {
          eventId: `cancelled-${turn.pendingReplyId}`,
          ts: Date.now(),
          exchangeId: turn.pendingReplyId,
          workspace: options.workspaceRoot,
          conversation: turn.targetConversationId,
          from: turn.sender.kind,
          senderSessionId: turn.sender.sessionId,
          type: 'message',
          state: 'cancelled',
          detail: 'withdrawn by the sender with forge.sh cancel before it started',
        });
      } catch (error) {
        // The message is already withdrawn; a log failure cannot undo it and
        // must not hold up the queue that is moving on without it.
        options.showWarning(
          `Withdrawn reply ${turn.pendingReplyId} could not be recorded: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
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
