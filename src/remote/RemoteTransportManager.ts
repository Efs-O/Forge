import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ForgeConfig } from '../config/types';
import type { CompactionEvent } from '../sidebar/CompactionService';
import { RemoteAuth } from './RemoteAuth';
import { RemoteController } from './RemoteController';
import { buildVoiceBridge, type VoiceBridgeBundle } from './RemoteVoiceBridge';
import { buildSpeechDelivery, type RemoteSpeechDelivery } from './RemoteSpeechDelivery';
import { RemoteRequestStore } from './RemoteRequestStore';
import { RemoteTransportLease } from './RemoteTransportLease';
import type { RemoteChannel, RemoteRuntimeOptions } from './types';
import { RemoteAuditLog } from './RemoteAuditLog';
import { subscribeHostToRemote, type HostSubscriptions } from './remoteHostSubscriptions';
import { JobOutboxWatcher } from './JobOutboxWatcher';
import { deliverOwnerNotification } from './ownerNotification';
import { defaultOutboxDir } from '../jobs/JobOutbox';
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
  /**
   * Drains the jobs outbox to the owner chat (B.4). Present only when
   * `jobs.enabled`: this window holds the Telegram lease, so it is the one
   * whose sink can reach the owner's phone, and it is the one that delivers
   * what the scheduler window wrote.
   */
  jobOutboxWatcher?: JobOutboxWatcher | undefined;
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
    const lease = await RemoteTransportLease.acquire({
      directory: path.join(this.options.storageDirectory, 'remote-leases'),
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
    let voice: VoiceBridgeBundle | undefined;
    try {
      const channel = await factory({
        getCursor: (key) => this.store.cursor(key),
        setCursor: (key, value) => this.store.setCursor(key, value),
      });
      voice = buildVoiceBridge(channel, config, undefined, {
        confirmServerStart: this.options.confirmWhisperServerStart,
      });
      const speech = buildSpeechDelivery(channel, config, undefined, this.options.notifyLocal);
      const controller = new RemoteController(
        channel,
        this.store,
        this.auth,
        this.options.host,
        buildRemoteControllerOptions(config, this.deps),
        this.audit,
        voice,
        speech,
      );
      const subscriptions = subscribeHostToRemote(this.options.host, controller, {
        onCompaction: (event) => this.onCompaction(event, controller),
        onActivityError: (message) =>
          this.options.notifyLocal(`Forge remote activity notification failed: ${message}`),
      });
      try {
        // Subscribe before channel startup: an automatic compaction can
        // complete while a transport is activating. Controller.start() starts
        // the durable outbox, which flushes anything queued here.
        await controller.start();
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
          ...(voice ? { voice } : {}),
          ...(speech ? { speech } : {}),
          ...(jobOutboxWatcher ? { jobOutboxWatcher } : {}),
        });
        this.notifyStatus();
      } catch (err) {
        subscriptions.dispose();
        await voice?.dispose();
        throw err;
      }
    } catch (err) {
      await lease.release();
      throw err;
    }
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
    transport.jobOutboxWatcher?.stop();
    await transport.voice?.dispose();
    await transport.controller.stop();
    await transport.lease.release();
  }

  async stopActive(): Promise<void> {
    await Promise.all([...this.active.keys()].map((name) => this.stopTransport(name)));
  }
}
