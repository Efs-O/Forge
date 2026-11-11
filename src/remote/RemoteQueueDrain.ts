import { CONVERSATION_BUSY_ERROR, CONVERSATION_GONE_ERROR } from '../sidebar/SendPipeline';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { getLogger } from '../util/logger';
import type { RemoteAgentProgress } from './RemoteAgentProgress';
import type { RemoteAttachmentStore } from './RemoteAttachmentStore';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteOutboxDelivery } from './RemoteOutboxDelivery';
import { withConversationIdentity } from './RemoteReplyIdentity';
import { settleRemoteClaim } from './remoteClaimSettle';
import { openProgressBubble } from './remoteProgressOpen';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel } from './types';
import { agentDisplayName } from '../agentLinks/chatAgentLinks';
import { abortableSleep } from '../util/abortableSleep';

const log = getLogger();
type ProgressOutcome = 'completed' | 'cancelled' | 'failed' | 'queued';

export interface RemoteQueueDrainDeps {
  signal: AbortSignal;
  channel: RemoteChannel;
  store: RemoteRequestStore;
  auth: RemoteAuth;
  host: ForgeHostFacade;
  workspaceName?: string | undefined;
  progress: RemoteAgentProgress;
  outbox: RemoteOutboxDelivery;
  activeConversations: Set<string>;
  attachmentStore: () => RemoteAttachmentStore | undefined;
  isBusy: (conversationId: string) => boolean;
  onError?: (message: string) => void;
}

/** Execute one transport's durable queue until it is empty, locked, or stopped. */
export async function drainRemoteQueue(
  conversationId: string,
  deps: RemoteQueueDrainDeps,
): Promise<void> {
  const persistResult = (write: () => Promise<void>): Promise<boolean> =>
    settleRemoteClaim(write, deps.signal, (message) => {
      log.warn(message);
      deps.onError?.(message);
    });
  while (!deps.signal.aborted) {
    if (deps.isBusy(conversationId)) {
      await abortableSleep(250, deps.signal);
      continue;
    }
    const first = deps.store.queued(conversationId, deps.channel.name)[0];
    if (!first) return;
    if (!(await deps.auth.canDeliver(first.channel, first.chatId))) return;
    const next = await deps.store.claimNext(conversationId, deps.channel.name);
    if (!next) {
      if (deps.store.queued(conversationId, deps.channel.name).length === 0) return;
      await abortableSleep(250, deps.signal);
      continue;
    }
    await deps.channel.retireQueuedReceipt?.(next.id);
    if (deps.signal.aborted) {
      await persistResult(() => deps.store.requeue(next.id));
      return;
    }
    if (!(await deps.auth.canDeliver(next.channel, next.chatId))) {
      await persistResult(() => deps.store.requeue(next.id));
      return;
    }

    deps.activeConversations.add(conversationId);
    log.info(
      `[remote:${next.channel}] request ${next.id} starting on ${next.conversationId}` +
        `${next.priority === 'steer' ? ' (steer)' : ''}; context=${formatBudget(
          deps.host.contextBudget?.(next.conversationId),
        )}`,
    );
    if (next.sessionTarget) {
      const name = agentDisplayName(next.sessionTarget);
      const linkedBefore = deps.host.getAgentLink(next.conversationId, next.sessionTarget);
      const chatTitle =
        deps.host.status().conversations.find((item) => item.id === next.conversationId)?.title ??
        next.conversationId;
      const sessionTitle = linkedBefore?.title ?? `Forge · ${chatTitle}`;
      try {
        let linkedSessionWrite: Promise<void> | undefined;
        let acceptanceNotice: Promise<unknown> | undefined;
        const result = await deps.host.askAgent(
          next.conversationId,
          {
            agent: next.sessionTarget,
            message: next.text,
            origin: { kind: 'owner', channel: 'telegram' },
          },
          deps.signal,
          (link) => {
            linkedSessionWrite = deps.store.setAgentSession(next.id, link.sessionId);
            void linkedSessionWrite.catch((error: unknown) => {
              const message = `Remote exchange ${next.id} could not persist its linked session: ${String(error)}`;
              if (deps.onError) deps.onError(message);
              else log.error(message);
            });
          },
          () => {
            acceptanceNotice = deps.channel
              .send(next.chatId, `✓ ${name} received it`, { signal: deps.signal })
              .catch((error: unknown) => {
                const message = `Remote exchange ${next.id} receipt could not be sent: ${String(error)}`;
                try {
                  if (deps.onError) deps.onError(message);
                  else log.error(message);
                } catch (reportError) {
                  log.error(`${message}; error reporter failed: ${String(reportError)}`);
                }
              });
          },
        );
        await linkedSessionWrite;
        await acceptanceNotice;
        const answerText = result.status === 'completed' ? result.finalText.trim() : '';
        if (!answerText)
          await deps.channel.send(
            next.chatId,
            `✗ ${result.error ?? 'The linked session returned no answer.'}`.slice(0, 3_500),
            { signal: deps.signal },
          );
        if (
          !(await persistResult(() =>
            deps.store.finish(next.id, answerText ? 'completed' : 'failed', {
              finalText: answerText,
              ...(!answerText
                ? { error: result.error ?? 'The linked session returned no answer.' }
                : {}),
              notification: answerText
                ? `${name} (${result.sessionTitle || sessionTitle}) says: ${answerText}`
                : `${name} could not answer: ${result.error ?? 'The linked session returned no answer.'}`,
            }),
          ))
        )
          return;
      } catch (err) {
        if (deps.signal.aborted) return;
        const error = err instanceof Error ? err.message : String(err);
        await deps.channel.send(next.chatId, `✗ ${error.slice(0, 3_500)}`, { signal: deps.signal });
        if (
          !(await persistResult(() =>
            deps.store.finish(next.id, 'failed', {
              error,
              notification: `${name} could not answer: ${error}`,
            }),
          ))
        )
          return;
      } finally {
        deps.activeConversations.delete(conversationId);
      }
      deps.outbox.kick();
      continue;
    }
    // Always a plain status message edited in place. Opening checks auth again
    // after the request claim so a lock in that small window sends no bubble.
    const bubble = await openProgressBubble(
      deps.channel,
      next.chatId,
      'Forge: working…',
      deps.signal,
      () => deps.auth.canDeliver(next.channel, next.chatId),
    );
    if (bubble.kind === 'plain') {
      deps.progress.begin(conversationId, next.chatId, bubble.messageId, 'remote');
      if (bubble.error)
        deps.onError?.(`Forge remote progress could not fully open: ${bubble.error}`);
    } else if (bubble.error) {
      // Only a real fault is worth a warning. A transport that offers no
      // progress affordance at all is normal (and was silent before this
      // phase), so reporting it per request would flood the log.
      deps.onError?.(`Forge remote progress could not be opened: ${bubble.error}`);
    }
    let progressOutcome: ProgressOutcome = 'failed';
    let replyIds: ReadonlySet<string> | undefined;
    try {
      const attachmentStore = deps.attachmentStore();
      const promptAttachments = next.attachments?.filter(
        (attachment) => !attachment.mediaType.startsWith('audio/'),
      );
      const attachments = promptAttachments?.length
        ? await attachmentStore?.load(promptAttachments)
        : undefined;
      if (promptAttachments?.length && !attachments) {
        throw new Error('remote attachment sidecar is unavailable');
      }
      const outcome = await deps.host.send(conversationId, next.text, attachments, {
        remoteRequestId: next.id,
      });
      if (outcome.kind === 'completed') {
        progressOutcome = 'completed';
        const notification = withConversationIdentity(
          deps.store,
          deps.host,
          next,
          outcome.finalText,
        );
        // This turn's speed line, taken here rather than earlier: the answer is
        // delivered by this path only when no mirrored echo took it, and the
        // ledger hands a line out once so it cannot land on both.
        const speedLine = deps.host.takeTurnSpeedLine?.(conversationId);
        const telegramReply =
          next.channel === 'telegram' && bubble.kind !== 'declined' && notification
            ? deps.outbox.prepareTelegramReply(
                notification,
                speedLine,
                await deps.progress.telegramReplyTargets(conversationId),
              )
            : undefined;
        if (
          !(await persistResult(() =>
            deps.store.finish(next.id, 'completed', {
              finalText: outcome.finalText,
              notification: notification ?? 'Forge request completed.',
              ...(notification ? { announceConversationId: next.conversationId } : {}),
              ...(speedLine ? { speedLine } : {}),
              ...(telegramReply ? { telegramReply } : {}),
            }),
          ))
        )
          return;
        if (telegramReply)
          replyIds = new Set(telegramReply.flatMap((part) => part.messageId ?? []));
      } else if (outcome.kind === 'cancelled' || outcome.kind === 'interrupted') {
        progressOutcome = 'cancelled';
        if (
          !(await persistResult(() =>
            deps.store.finish(next.id, 'cancelled', {
              ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
              notification: [
                'Forge: request cancelled.',
                ...(deps.workspaceName ? [`Workspace: ${deps.workspaceName}`] : []),
                `Original request: ${next.text.replace(/\s+/g, ' ').trim().slice(0, 160)}`,
                ...(outcome.finalText ? ['', outcome.finalText] : []),
              ].join('\n'),
            }),
          ))
        )
          return;
      } else if (outcome.error === CONVERSATION_BUSY_ERROR) {
        progressOutcome = 'queued';
        if (!(await persistResult(() => deps.store.requeue(next.id)))) return;
        await abortableSleep(250, deps.signal);
        continue;
      } else {
        // A bound chat that has been closed is the one failure a phone owner can
        // act on but cannot diagnose: the sidebar's wording names "the queued
        // conversation", which is nothing on a handset, and the only useful
        // answer there is what to send next. The stored `error` keeps the
        // sidebar sentence, so the two surfaces do not disagree about what
        // happened — only the reply that has to be acted on is rewritten. Every
        // transport gets the same hint: `/new` and `/chats` are commands of the
        // remote surface, not of Telegram.
        const gone = outcome.error === CONVERSATION_GONE_ERROR;
        if (
          !(await persistResult(() =>
            deps.store.finish(next.id, 'failed', {
              error: outcome.error,
              ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
              notification: gone
                ? 'Forge: the chat this Telegram chat was bound to is closed. Send /new for a new chat, or /chats to pick an open one.'
                : `Forge request failed: ${outcome.error}`,
            }),
          ))
        )
          return;
      }
    } catch (err) {
      progressOutcome = 'failed';
      const error = err instanceof Error ? err.message : String(err);
      if (
        !(await persistResult(() =>
          deps.store.finish(next.id, 'failed', {
            error,
            notification: `Forge request failed: ${error}`,
          }),
        ))
      )
        return;
    } finally {
      if (bubble.kind !== 'declined') {
        // The outbox owns reply bubbles. Any leftover progress is cleaned up
        // after the delivery attempt.
        const delivered = await deps.outbox.flush(next.chatId);
        await deps.progress.finish(
          conversationId,
          replyIds ? undefined : progressTerminalText(progressOutcome, delivered),
          replyIds,
        );
      }
      deps.activeConversations.delete(conversationId);
      log.info(
        `[remote:${next.channel}] request ${next.id} ${progressOutcome}; context=${formatBudget(
          deps.host.contextBudget?.(next.conversationId),
        )}`,
      );
    }
    deps.outbox.kick();
  }
}

/**
 * What the working line becomes at the end of a turn.
 *
 * Nothing, when the answer has landed for a completed request: the reply is
 * already its own message on screen, so an outcome line would be a second
 * message saying nothing, deleted ten seconds later for the owner's scroll.
 * `failed`, `cancelled` and `queued` keep theirs, and so does a completed
 * request whose answer could not be delivered — there the line is the only
 * signal that the turn is over.
 */
function progressTerminalText(outcome: ProgressOutcome, delivered: boolean): string | undefined {
  if (outcome === 'completed') return delivered ? undefined : 'Forge: completed.';
  if (outcome === 'cancelled') return 'Forge: cancelled.';
  if (outcome === 'queued') return 'Forge: queued.';
  return 'Forge: failed.';
}

function formatBudget(budget: { used: number; max: number } | undefined): string {
  return budget && budget.max > 0 ? `${budget.used}/${budget.max}` : 'unavailable';
}
