import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ForgeConfig } from '../config/types';
import type { CompactionEvent } from '../sidebar/CompactionService';
import { RemoteAuth } from './RemoteAuth';
import { RemoteController } from './RemoteController';
import { buildVoiceBridge, type VoiceBridgeBundle } from './RemoteVoiceBridge';
import { buildSpeechDelivery, type RemoteSpeechDelivery } from './RemoteSpeechDelivery';
import { RemoteRequestStore } from './RemoteRequestStore';
import { RemoteContactStore } from './RemoteContactStore';
import { ContactInstructionsLoader } from './ContactInstructionsLoader';
import { TelegramContactService } from './TelegramContactService';
import { RemoteLeaseError, RemoteTransportLease } from './RemoteTransportLease';
import { clearOwnReloadReservation, reservedForAnotherWorkspace } from './remoteReloadReservation';
import type { RemoteChannel, RemoteRuntimeOptions } from './types';
import { RemoteAuditLog } from './RemoteAuditLog';
import { subscribeHostToRemote, type HostSubscriptions } from './remoteHostSubscriptions';
import { JobOutboxWatcher } from './JobOutboxWatcher';
import { deliverOwnerNotification } from './ownerNotification';
import { defaultOutboxDir } from '../jobs/JobOutbox';
import { getLogger } from '../util/logger';
import {
  buildRemoteControllerOptions,
  type RemoteControllerOptionsDeps,
} from './remoteControllerOptions';

export interface ActiveTransport {
  channel: RemoteChannel;
  controller: RemoteController;
  lease: RemoteTransportLease;
  subscriptions: HostSubscriptions;
  voice?: VoiceBridgeBundle | undefined;
  speech?: RemoteSpeechDelivery | undefined;
  contactService?: TelegramContactService | undefined;
  /**
   * Drains the jobs outbox to the owner chat (B.4). Present only when
   * `jobs.enabled`: this window holds the Telegram lease, so it is the one
   * whose sink can reach the owner's phone, and it is the one that delivers
   * what the scheduler window wrote.
   */
  jobOutboxWatcher?: JobOutboxWatcher | undefined;
  /** Aborted on stop, so voice work in flight does not outlive the transport. */
  abort: AbortController;
}

/**
 * How long a window keeps trying for the transport lease when a chat has been
 * handed to it. It has to outlast the 20 s stale horizon, because the window
 * that released the lease may still be shutting down, and because a cold VS
 * Code window on a project this machine has not opened recently reached its
 * remote endpoint 11.7 s after it opened — 73 s after the other window asked
 * for it in the worst case measured 2026-10-29 (`docs/reports/
 * WORKSPACE_SWITCH_PHASE0_TIMINGS.md`), which is also where the rollback delay
 * comes from. Giving up earlier would strand a chat whose window is merely
 * slow, and two windows that both give up leave nothing serving the phone.
 */
export const TAKEOVER_CLAIM_DEADLINE_MS = 90_000;

/**
 * How long an ordinary start waits for the lease when no chat is waiting for
 * this window: one retry, because the holder is serving the phone right now and
 * a longer wait would only stall this window's own lifecycle chain — activation
 * awaits `applyConfig`, so a window with nothing to claim must fail fast, the
 * way it always did, and be retried by `RemoteWindowWatch` if the lease comes
 * free later.
 */
export const TAKEOVER_RACE_DEADLINE_MS = 2_000;

const TAKEOVER_RETRY_MS = 2_000;

/** The last lease refusal, handed on unchanged. A second window has always
 *  seen this text in its start failure, and phase 2 must not give it a new
 *  wording along with the new behaviour: what changed is that `takeOver` now
 *  **throws** it instead of returning quietly after five attempts.
 */
function lastTakeoverFailure(last: unknown): RemoteLeaseError {
  if (last instanceof RemoteLeaseError) return last;
  return new RemoteLeaseError(
    `Forge could not take over the transports: ${last instanceof Error ? last.message : String(last ?? 'no attempt was made')}`,
  );
}

/**
 * Owns the lifecycle of running transports: lease acquisition, channel
 * construction, voice/speech wiring, controller startup and teardown. The
 * runtime keeps the reads (pairing, status, validation), the lifecycle
 * *serialization* (the lifecycleTail promise chain), and the config-write +
 * handoff machinery; this class owns the active map and the start/stop
 * mechanics. The controller-options deps bundle is built once by the runtime
 * and handed in here, so its callbacks close over live runtime state rather
 * than a config snapshot.
 */
export class RemoteTransportManager {
  private readonly active = new Map<string, ActiveTransport>();
  /** Used only by RemoteTransportLease.acquire; kept here so the runtime need not thread it. */
  private readonly instanceId = randomUUID();

  constructor(
    private readonly options: RemoteRuntimeOptions,
    private readonly store: RemoteRequestStore,
    private readonly auth: RemoteAuth,
    private readonly audit: RemoteAuditLog,
    private readonly deps: RemoteControllerOptionsDeps,
    private readonly onCompaction: (event: CompactionEvent, controller: RemoteController) => void,
    private readonly onBeforeConversationNotify: (
      controller: RemoteController,
      conversationId: string,
    ) => Promise<void>,
    private readonly onTransportStopped: (controller: RemoteController) => void,
    private readonly notifyStatus: () => void,
  ) {}

  get(name: string): ActiveTransport | undefined {
    return this.active.get(name);
  }

  /** Sorted, so two reads of an unchanged set compare equal. */
  names(): string[] {
    return [...this.active.keys()].sort();
  }

  values(): IterableIterator<ActiveTransport> {
    return this.active.values();
  }

  has(name: string): boolean {
    return this.active.has(name);
  }

  async startTransport(channelName: 'telegram' | 'whatsapp', config: ForgeConfig): Promise<void> {
    if (config.remote?.enabled !== true || config.remote[channelName].enabled !== true) return;
    const factory = this.options.channelFactories?.[channelName];
    if (!factory) {
      this.options.notifyLocal(
        `Forge remote ${channelName} is enabled but its transport is unavailable.`,
      );
      return;
    }
    const leaseDirectory = path.join(this.options.storageDirectory, 'remote-leases');
    const reservation = await reservedForAnotherWorkspace(
      leaseDirectory,
      channelName,
      this.options.workspaceId,
    );
    if (reservation) {
      throw new RemoteLeaseError(
        `Forge lease "${channelName}" is held for a window that is reloading (until ${new Date(reservation.expiresAt).toISOString()}).`,
      );
    }
    await this.store.reconcileDeadClaims();
    const lease = await RemoteTransportLease.acquire({
      directory: leaseDirectory,
      key: channelName,
      workspaceId: this.options.workspaceId,
      instanceId: this.instanceId,
      onLost: (message) => {
        this.options.notifyLocal(message);
        void this.stopTransport(channelName).catch((err) =>
          this.options.notifyLocal(
            `Forge remote ${channelName} shutdown failed: ${(err as Error).message}`,
          ),
        );
      },
    });
    await clearOwnReloadReservation(leaseDirectory, channelName, this.options.workspaceId).catch(
      (err: unknown) => {
        getLogger().warn(
          `[remote] could not clear the Telegram reload reservation: ${String(err)}`,
        );
      },
    );
    this.store.setClaimOwner(channelName, lease.claimIdentity());
    let voice: VoiceBridgeBundle | undefined;
    const abort = new AbortController();
    try {
      const channel = await factory({
        getCursor: (key) => this.store.cursor(key),
        setCursor: (key, value) => this.store.setCursor(key, value),
      });
      voice = buildVoiceBridge(channel, config, undefined, {
        confirmServerStart: this.options.confirmWhisperServerStart,
        signal: abort.signal,
      });
      const speech = buildSpeechDelivery(channel, config, abort.signal, this.options.notifyLocal);
      const contactService =
        channelName === 'telegram' && config.remote?.contacts.enabled === true
          ? new TelegramContactService(
              channel,
              this.auth,
              new RemoteContactStore(this.store),
              this.options.host,
              new ContactInstructionsLoader(this.deps.workspaceRoot),
              this.audit,
              this.options.notifyLocal,
              undefined,
              { webEnabled: config.remote.contacts.web.enabled },
            )
          : undefined;
      const controller = new RemoteController(
        channel,
        this.store,
        this.auth,
        this.options.host,
        buildRemoteControllerOptions(config, this.deps),
        this.audit,
        voice,
        speech,
        contactService,
      );
      // The channel reports queued acknowledgements and transient notices; the
      // controller owns their deletion timers and delay policy.
      channel.setEphemeralMessageHandler?.((chatId, messageIds, kind) =>
        controller.armEphemeralMessage(chatId, messageIds, kind),
      );
      const subscriptions = subscribeHostToRemote(this.options.host, controller, {
        onCompaction: (event) => this.onCompaction(event, controller),
        onActivityError: (message) =>
          this.options.notifyLocal(`Forge remote activity notification failed: ${message}`),
        onBeforeConversationNotify: (ctrl, conversationId) =>
          this.onBeforeConversationNotify(ctrl, conversationId),
      });
      try {
        // Subscribe before channel startup: an automatic compaction can
        // complete while a transport is activating. Controller.start() starts
        // the durable outbox, which flushes anything queued here.
        await controller.start();
        // After start: a request a reload interrupted is answered over this channel.
        contactService
          ?.recoverInterrupted()
          .catch((err: Error) =>
            this.options.notifyLocal(`Forge contact recovery failed: ${err.message}`),
          );
        // The jobs outbox is drained by whoever holds the Telegram lease, not
        // by the scheduler window (whose sink cannot reach the owner's phone).
        // Gated on `jobs.enabled` so a jobs-less config adds no watcher.
        const jobOutboxWatcher =
          channelName === 'telegram' && config.jobs?.enabled === true
            ? new JobOutboxWatcher({
                outboxDir: defaultOutboxDir(),
                deliver: (text) =>
                  deliverOwnerNotification(channel, this.auth, this.store, controller.outbox, text),
                onError: (message) => this.options.notifyLocal(message),
              })
            : undefined;
        jobOutboxWatcher?.start();
        this.active.set(channelName, {
          channel,
          controller,
          lease,
          subscriptions,
          abort,
          ...(voice ? { voice } : {}),
          ...(speech ? { speech } : {}),
          ...(contactService ? { contactService } : {}),
          ...(jobOutboxWatcher ? { jobOutboxWatcher } : {}),
        });
        this.notifyStatus();
      } catch (err) {
        subscriptions.dispose();
        this.onTransportStopped(controller);
        abort.abort();
        // start() arms the recovery timer and the approval/question sinks
        // before the channel starts, so a failed channel leaves them running.
        // stop() also disposes the contact service.
        await controller
          .stop()
          .catch((stopErr: Error) =>
            this.options.notifyLocal(
              `Forge remote ${channelName} cleanup failed: ${stopErr.message}`,
            ),
          );
        await voice?.dispose();
        throw err;
      }
    } catch (err) {
      abort.abort();
      this.store.setClaimOwner(channelName, undefined);
      await lease.release();
      throw err;
    }
  }

  /** Starts every configured transport, or none: a partial start is stopped again. */
  async startAll(config: ForgeConfig): Promise<void> {
    try {
      for (const channelName of ['telegram', 'whatsapp'] as const) {
        await this.startTransport(channelName, config);
      }
    } catch (err) {
      await this.stopActive();
      throw err;
    }
  }

  /**
   * Take the lease and start every configured transport, retrying until
   * `deadlineMs` passes, then **throwing** the last lease refusal instead of
   * returning quietly — a caller that cannot tell success from giving up cannot
   * tell whether the chat it just claimed is being served.
   *
   * The source window releases its lease before opening the target folder, but
   * the two windows are separate processes: a few seconds of overlap is normal
   * and is not a reason to refuse the chat, which is why this waits at all.
   * `signal` is what `dispose()` aborts, so a window that is going away stops
   * retrying instead of holding the lifecycle chain for the whole deadline.
   */
  async takeOver(
    config: ForgeConfig,
    opts: { deadlineMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    const deadlineMs = opts.deadlineMs ?? TAKEOVER_CLAIM_DEADLINE_MS;
    const startedAt = Date.now();
    let last: unknown;
    for (;;) {
      if (this.active.size > 0) return;
      try {
        await this.startAll(config);
        return;
      } catch (err) {
        if (!(err instanceof RemoteLeaseError)) throw err;
        last = err;
      }
      const remaining = deadlineMs - (Date.now() - startedAt);
      if (remaining <= 0 || opts.signal?.aborted) throw lastTakeoverFailure(last);
      await this.sleep(Math.min(TAKEOVER_RETRY_MS, remaining), opts.signal);
      if (opts.signal?.aborted) throw lastTakeoverFailure(last);
    }
  }

  /** Bounded sleep that ends early on abort, so `dispose()` is not a wait. */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  async stopTransport(name: string): Promise<void> {
    const transport = this.active.get(name);
    if (!transport) return;
    // Load-bearing order (do not reorder): delete before notify so the sidebar
    // chip never reports a transport active while it is tearing down;
    // subscriptions disposed before controller.stop() so host events fired
    // during shutdown are dropped — current behaviour, pinned by tests.
    this.active.delete(name);
    this.notifyStatus();
    transport.subscriptions.dispose();
    // Drop the transport's pending aggregated-compaction state with it: the
    // buffer is a display convenience, and a stopped transport must not fire a
    // stray "N compactions complete." into a chat that no longer has a sink.
    this.onTransportStopped(transport.controller);
    transport.jobOutboxWatcher?.stop();
    transport.abort.abort();
    await transport.voice?.dispose();
    try {
      await transport.controller.stop();
    } finally {
      try {
        await transport.lease.release();
      } finally {
        this.store.setClaimOwner(name as 'telegram' | 'whatsapp', undefined);
      }
    }
  }

  async stopActive(): Promise<void> {
    await Promise.all([...this.active.keys()].map((name) => this.stopTransport(name)));
  }
}
