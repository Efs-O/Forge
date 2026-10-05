import { CONVERSATION_BUSY_ERROR } from '../sidebar/SendPipeline';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { getLogger } from '../util/logger';
import type { RemoteAgentProgress } from './RemoteAgentProgress';
import type { RemoteAttachmentStore } from './RemoteAttachmentStore';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteOutboxDelivery } from './RemoteOutboxDelivery';
import { withConversationIdentity } from './RemoteReplyIdentity';
import { settleRemoteClaim } from './remoteClaimSettle';
import { openProgressBubble } from './telegramRichDraft';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel } from './types';

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
      await delay(250, deps.signal);
      continue;
    }
    const first = deps.store.queued(conversationId, deps.channel.name)[0];
    if (!first) return;
    if (!(await deps.auth.canDeliver(first.channel, first.chatId))) return;
    const next = await deps.store.claimNext(conversationId, deps.channel.name);
    if (!next) {
      if (deps.store.queued(conversationId, deps.channel.name).length === 0) return;
      await delay(250, deps.signal);
      continue;
    }
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
    // Rich draft where the transport has one, plain bubble otherwise. The
    // shared helper is what keeps the two openers' fallback rule identical: a
    // definitive refusal retries this turn on the plain path, an ambiguous one
    // stops rather than risk a second progress bubble next to a live preview.
    const bubble = await openProgressBubble(
      deps.channel,
      next.chatId,
      'Forge: working…',
      deps.signal,
    );
    if (bubble.kind === 'draft') {
      deps.progress.begin(
        conversationId,
        next.chatId,
        `draft-${bubble.draftId}`,
        'remote',
        bubble.draftId,
      );
    } else if (bubble.kind === 'plain') {
      deps.progress.begin(conversationId, next.chatId, bubble.messageId);
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
        await delay(250, deps.signal);
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

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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
