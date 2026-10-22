import { CONVERSATION_BUSY_ERROR } from '../sidebar/SendPipeline';
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
          { agent: next.sessionTarget, message: next.text },
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
    try {
      const attachmentStore = deps.attachmentStore();
      const attachments = next.attachments?.length
        ? await attachmentStore?.load(next.attachments)
        : undefined;
      if (next.attachments?.length && !attachments) {
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
        if (
          !(await persistResult(() =>
            deps.store.finish(next.id, 'completed', {
              finalText: outcome.finalText,
              notification: notification ?? 'Forge request completed.',
              ...(notification ? { announceConversationId: next.conversationId } : {}),
            }),
          ))
        )
          return;
      } else if (outcome.kind === 'cancelled' || outcome.kind === 'interrupted') {
        progressOutcome = 'cancelled';
        if (
          !(await persistResult(() =>
            deps.store.finish(next.id, 'cancelled', {
              ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
              notification: outcome.finalText || 'Forge request cancelled.',
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
        if (
          !(await persistResult(() =>
            deps.store.finish(next.id, 'failed', {
              error: outcome.error,
              ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
              notification: `Forge request failed: ${outcome.error}`,
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
        await deps.progress.finish(conversationId, progressTerminalText(progressOutcome));
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

function progressTerminalText(outcome: ProgressOutcome): string {
  if (outcome === 'completed') return 'Forge: completed.';
  if (outcome === 'cancelled') return 'Forge: cancelled.';
  if (outcome === 'queued') return 'Forge: queued.';
  return 'Forge: failed.';
}

function formatBudget(budget: { used: number; max: number } | undefined): string {
  return budget && budget.max > 0 ? `${budget.used}/${budget.max}` : 'unavailable';
}
