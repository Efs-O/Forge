import { CONVERSATION_BUSY_ERROR } from '../sidebar/SendPipeline';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { getLogger } from '../util/logger';
import type { RemoteAgentProgress } from './RemoteAgentProgress';
import type { RemoteAttachmentStore } from './RemoteAttachmentStore';
import type { RemoteAuth } from './RemoteAuth';
import type { RemoteOutboxDelivery } from './RemoteOutboxDelivery';
import { withConversationIdentity } from './RemoteReplyIdentity';
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
}

/** Execute one transport's durable queue until it is empty, locked, or stopped. */
export async function drainRemoteQueue(
  conversationId: string,
  deps: RemoteQueueDrainDeps,
): Promise<void> {
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
      await deps.store.requeue(next.id);
      return;
    }
    if (!(await deps.auth.canDeliver(next.channel, next.chatId))) {
      await deps.store.requeue(next.id);
      return;
    }

    deps.activeConversations.add(conversationId);
    log.info(
      `[remote:${next.channel}] request ${next.id} starting on ${next.conversationId}` +
        `${next.priority === 'steer' ? ' (steer)' : ''}; context=${formatBudget(
          deps.host.contextBudget?.(next.conversationId),
        )}`,
    );
    const progressId = await deps.channel
      .sendProgress?.(next.chatId, 'Forge: working…', { signal: deps.signal })
      .catch(() => undefined);
    if (progressId) deps.progress.begin(conversationId, next.chatId, progressId);
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
        await deps.store.finish(next.id, 'completed', {
          finalText: outcome.finalText,
          notification: notification ?? 'Forge request completed.',
          ...(notification ? { announceConversationId: next.conversationId } : {}),
        });
      } else if (outcome.kind === 'cancelled' || outcome.kind === 'interrupted') {
        progressOutcome = 'cancelled';
        await deps.store.finish(next.id, 'cancelled', {
          ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
          notification: outcome.finalText || 'Forge request cancelled.',
        });
      } else if (outcome.error === CONVERSATION_BUSY_ERROR) {
        progressOutcome = 'queued';
        await deps.store.requeue(next.id);
        await delay(250, deps.signal);
        continue;
      } else {
        await deps.store.finish(next.id, 'failed', {
          error: outcome.error,
          ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
          notification: `Forge request failed: ${outcome.error}`,
        });
      }
    } catch (err) {
      progressOutcome = 'failed';
      const error = err instanceof Error ? err.message : String(err);
      await deps.store.finish(next.id, 'failed', {
        error,
        notification: `Forge request failed: ${error}`,
      });
    } finally {
      if (progressId) {
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
