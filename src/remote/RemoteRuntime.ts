import * as path from 'path';
import { loadConfig } from '../config/ConfigLoader';
import { updateConfigFile } from '../config/ConfigWriter';
import { setNestedField } from '../config/ConfigWriterHelpers';
import type { ForgeConfig } from '../config/types';
import type { CompactionEvent } from '../sidebar/CompactionService';
import { RemoteAuth } from './RemoteAuth';
import type { RemoteController } from './RemoteController';
import { RemoteRequestStore } from './RemoteRequestStore';
import { RemoteLeaseError } from './RemoteTransportLease';
import type { WorkspaceHandoff } from './RemoteStoreSchemas';
import { RemoteAuditLog } from './RemoteAuditLog';
import { RemoteAttachmentStore } from './RemoteAttachmentStore';
import { RemoteTransportManager } from './RemoteTransportManager';
import {
  buildRemoteControllerOptions,
  currentWorkspaceIdentity,
  workspaceAliases,
  transportNames,
  type RemoteControllerOptionsDeps,
} from './remoteControllerOptions';
import { RemoteHandoffCoordinator } from './RemoteHandoffCoordinator';
import {
  recordWorkspaceHandoff,
  resumeWorkspaceHandoffs,
  announceWorkspaceArrivals,
} from './RemoteWorkspaceHandoff';
import { remoteCompactionNotice } from './remoteCompactionNotice';
import { voiceRuntimeSignature } from './voiceRuntimeSignature';
import {
  type RemoteRuntimeOptions,
  type RemoteValidationStatus,
  type RemoteChannelFactory,
  type RemoteChannelFactoryContext,
  type RemoteStatus,
} from './types';

// Re-exported so existing importers of these types from this module keep
// working after the split. They are declared in ./types (not here) so the
// transport manager can import them without importing the runtime back.
export type {
  RemoteRuntimeOptions,
  RemoteValidationStatus,
  RemoteChannelFactory,
  RemoteChannelFactoryContext,
};

/** Extension-scoped, serially reconfigurable owner of all remote transports. */
export class RemoteRuntime {
  private readonly auth: RemoteAuth;
  private readonly store: RemoteRequestStore;
  private readonly audit: RemoteAuditLog;
  private readonly manager: RemoteTransportManager;
  private readonly deps: RemoteControllerOptionsDeps;
  private readonly coordinator: RemoteHandoffCoordinator;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private appliedConfig: ForgeConfig | undefined;
  /** The config this window was last asked to run, kept separately from
   *  `appliedConfig` so a startup that failed on a contended transport lease
   *  still knows what to start when a handoff later arrives here. */
  private requestedConfig: ForgeConfig | undefined;

  constructor(private readonly options: RemoteRuntimeOptions) {
    this.auth = new RemoteAuth(options.secrets, undefined, () => this.notifyStatus());
    const storePath = path.join(options.storageDirectory, 'remote-state-v2.json');
    this.store = new RemoteRequestStore(
      storePath,
      path.join(options.storageDirectory, 'remote-state-v1.json'),
    );
    this.audit = new RemoteAuditLog(
      path.join(options.storageDirectory, 'remote-audit-v1.json'),
      options.secrets,
    );
    this.deps = this.controllerOptionsDeps();
    this.manager = new RemoteTransportManager(
      options,
      this.store,
      this.auth,
      this.audit,
      this.deps,
      (event, controller) => this.onCompactionEvent(event, controller),
      () => this.notifyStatus(),
    );
    this.coordinator = new RemoteHandoffCoordinator({
      store: this.store,
      storePath,
      workspaceId: options.workspaceId,
      serialize: (task) => this.enqueue(task),
      claimArrivals: () => this.claimArrivals(),
      restoreTransports: () => this.restoreTransports(),
      sendToChat: (channel, chatId, text) =>
        this.manager.get(channel)?.channel.send(chatId, text) ?? Promise.resolve(),
      notifyLocal: options.notifyLocal,
      ...(options.handoffWatch ?? {}),
    });
  }

  /** One owner for the lifecycle chain: every operation that touches the
   *  active transport map queues here rather than interleaving. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const operation = this.lifecycleTail.then(task);
    this.lifecycleTail = operation.catch(() => undefined);
    return operation;
  }

  applyConfig(config: ForgeConfig): Promise<void> {
    return this.enqueue(() => this.replace(config));
  }

  /**
   * Recreates one provider after an out-of-band credential change. Secrets are
   * intentionally absent from ForgeConfig, so an ordinary config diff cannot
   * detect a replaced Telegram token.
   */
  refreshTransport(name: 'telegram' | 'whatsapp', config: ForgeConfig): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      if (!this.appliedConfig) {
        await this.replace(config);
        return;
      }
      await this.manager.stopTransport(name);
      this.auth.updateSessionPolicy({
        inactivityTimeoutMinutes: config.remote?.auth.inactivity_timeout_minutes ?? 30,
      });
      if (config.remote?.enabled === true && config.remote[name].enabled === true) {
        await this.store.load();
        await this.manager.startTransport(name, config);
      }
      this.appliedConfig = config;
    });
  }

  beginPairing(channel: 'telegram' | 'whatsapp'): string {
    if (!this.manager.has(channel)) {
      throw new Error(`Forge remote ${channel} is not running.`);
    }
    return this.auth.beginPairing(channel);
  }

  async unpair(channel: 'telegram' | 'whatsapp'): Promise<void> {
    await this.auth.unpair(channel);
    this.manager.get(channel)?.controller.forgetChannel(channel);
  }

  createTotpEnrollmentSecret(channel: 'telegram' | 'whatsapp'): Promise<string> {
    if (!this.manager.has(channel)) throw new Error(`Forge remote ${channel} is not running.`);
    return this.auth.createTotpEnrollmentSecret(channel);
  }

  confirmTotpEnrollment(
    channel: 'telegram' | 'whatsapp',
    secret: string,
    code: string,
  ): Promise<void> {
    return this.auth.confirmTotpEnrollment(channel, secret, code);
  }

  disableTotp(channel: 'telegram' | 'whatsapp'): Promise<void> {
    return this.auth.disableTotp(channel);
  }

  requestWhatsAppPairingCode(phoneNumber: string): Promise<string> {
    const channel = this.manager.get('whatsapp')?.channel;
    if (!channel?.requestPairingCode) throw new Error('Forge remote WhatsApp is not running.');
    return channel.requestPairingCode(phoneNumber);
  }

  async unlinkWhatsApp(): Promise<void> {
    const transport = this.manager.get('whatsapp');
    if (!transport?.channel.unlink) throw new Error('Forge remote WhatsApp is not running.');
    await transport.channel.unlink();
    // NOTE: mutates the active map outside the lifecycleTail (pre-existing
    // race, not introduced by the split). A concurrent applyConfig could
    // interleave. Left for a separate change.
    await this.manager.stopTransport('whatsapp');
    await this.auth.unpair('whatsapp');
  }

  activeTransports(): string[] {
    return this.manager.names();
  }

  async validationStatus(config: ForgeConfig): Promise<RemoteValidationStatus> {
    const transports: RemoteValidationStatus['transports'] = [];
    for (const name of ['telegram', 'whatsapp'] as const) {
      const configured = config.remote?.enabled === true && config.remote[name].enabled === true;
      const active = this.manager.get(name);
      const leaseOwned = active ? await active.lease.verify() : false;
      let health = {
        ok: active !== undefined,
        detail: active ? 'Transport is active; no provider probe is available.' : 'Not active.',
      };
      if (active?.channel.healthCheck) {
        try {
          health = await active.channel.healthCheck();
        } catch (err) {
          health = {
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }
      transports.push({
        name,
        configured,
        active: active !== undefined,
        ownerPaired: await this.auth.hasOwner(name),
        totpEnrolled: await this.auth.totpEnrolled(name),
        leaseOwned,
        providerOk: health.ok,
        detail: health.detail,
      });
    }
    return {
      enabled: config.remote?.enabled === true,
      transports,
      requests: this.store.requestHealth(),
      outbox: this.store.outboxHealth(),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.coordinator.dispose();
    await this.applySerializedStop();
  }

  /**
   * Persist `voice.output.enabled` to config.yaml and rebuild the transports so
   * the change applies without a window reload. The write is schema-validated
   * and atomic (temp + rename, .bak backup) by updateConfigFile. Re-reading
   * the file keeps the in-memory config and the file in agreement, and the
   * changed voice runtime signature forces a full transport rebuild (the
   * in-place path would not rebuild the speech delivery).
   *
   * Routed through lifecycleTail (like applyConfig) so a /voice toggle cannot
   * interleave a second replace() over the active map with a concurrent
   * config reload.
   */
  async setVoiceOutput(on: boolean): Promise<void> {
    if (!this.options.configPath) throw new Error('config path is not available');
    return this.enqueue(() => {
      updateConfigFile(this.options.configPath!, (doc) =>
        setNestedField(doc, ['voice', 'output', 'enabled'], on),
      );
      const config = loadConfig(path.dirname(this.options.configPath!));
      this.appliedConfig = config;
      return this.replace(config);
    });
  }

  private async replace(config: ForgeConfig): Promise<void> {
    this.requestedConfig = config;
    if (this.canUpdateInPlace(config)) {
      this.updateActiveOptions(config);
      this.appliedConfig = config;
      return;
    }
    await this.manager.stopActive();
    if (this.disposed || config.remote?.enabled !== true) {
      this.coordinator.dispose();
      this.auth.updateSessionPolicy({ inactivityTimeoutMinutes: 30 });
      this.appliedConfig = config;
      return;
    }
    this.auth.updateSessionPolicy({
      inactivityTimeoutMinutes: config.remote.auth.inactivity_timeout_minutes,
    });
    await this.store.load();
    if (
      this.options.workspaceRoot &&
      config.remote.attachments.enabled &&
      config.remote.attachments.retain_days !== null
    ) {
      await new RemoteAttachmentStore(this.options.workspaceRoot).prune(
        config.remote.attachments.retain_days,
      );
    }
    // Started before the transports, and left running whatever they do: a
    // window that loses the lease race still has to be able to claim a chat
    // handed to it later, which is exactly the case that used to go silent.
    this.coordinator.watch();
    const arrivals = await resumeWorkspaceHandoffs(
      this.store,
      this.options.workspaceId,
      this.options.host,
    );
    try {
      for (const channelName of ['telegram', 'whatsapp'] as const) {
        await this.manager.startTransport(channelName, config);
      }
    } catch (err) {
      await this.manager.stopActive();
      throw err;
    }
    this.appliedConfig = config;
    await this.announce(arrivals, config);
  }

  private announce(arrivals: readonly WorkspaceHandoff[], config: ForgeConfig): Promise<void> {
    return announceWorkspaceArrivals(arrivals, {
      channelFor: (name) => this.manager.get(name)?.channel,
      displayNameFor: (alias) =>
        workspaceAliases(config, this.options.workspaceRoot)[alias]?.display_name ?? alias,
      totpEnrolled: (channel) => this.auth.totpEnrolled(channel),
      notifyLocal: this.options.notifyLocal,
    });
  }

  /**
   * A handoff addressed here while this window was already running. The
   * transport lease is taken *before* the record is claimed: it is the only
   * cross-process mutex there is, so letting it decide keeps two windows on the
   * same folder from both binding the chat, and leaves the record pending for
   * the source window to take back when this window cannot serve it at all.
   *
   * Runs inside the lifecycle chain (the coordinator serializes it), so it must
   * not enqueue again.
   */
  private async claimArrivals(): Promise<void> {
    const config = this.requestedConfig;
    if (this.disposed || config?.remote?.enabled !== true) return;
    await this.takeOverTransports(config);
    if (this.manager.names().length === 0) return;
    const arrivals = await resumeWorkspaceHandoffs(
      this.store,
      this.options.workspaceId,
      this.options.host,
    );
    this.appliedConfig = config;
    await this.announce(arrivals, config);
  }

  /**
   * The source window releases its lease before opening the target folder, but
   * the two windows are separate processes: a few seconds of overlap is normal
   * and is not a reason to refuse the chat.
   */
  private async takeOverTransports(config: ForgeConfig): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (this.manager.names().length > 0) return;
      try {
        for (const channelName of ['telegram', 'whatsapp'] as const) {
          await this.manager.startTransport(channelName, config);
        }
        return;
      } catch (err) {
        await this.manager.stopActive();
        if (!(err instanceof RemoteLeaseError)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  /** Puts this window back the way it was after a switch that never happened. */
  private async restoreTransports(): Promise<void> {
    if (this.disposed || !this.requestedConfig) return;
    await this.replace(this.requestedConfig);
  }

  private canUpdateInPlace(config: ForgeConfig): boolean {
    if (!this.appliedConfig || this.disposed) return false;
    const configured = transportNames(config);
    const active = this.manager.names();
    return (
      configured.length === active.length &&
      configured.every((name, index) => name === active[index]) &&
      voiceRuntimeSignature(config) === voiceRuntimeSignature(this.appliedConfig)
    );
  }

  private updateActiveOptions(config: ForgeConfig): void {
    if (!config.remote) return;
    this.auth.updateSessionPolicy({
      inactivityTimeoutMinutes: config.remote.auth.inactivity_timeout_minutes,
    });
    for (const transport of this.manager.values()) {
      transport.controller.updateOptions(buildRemoteControllerOptions(config, this.deps));
    }
  }

  private applySerializedStop(): Promise<void> {
    return this.enqueue(() => this.manager.stopActive());
  }

  /**
   * Moves one chat to another project's window: record the departure, stop
   * this window's transports so the target can take the lease, then open the
   * folder. Public because the runtime owns the whole move, not just the half
   * the controller can reach.
   */
  async switchWorkspace(
    config: ForgeConfig,
    alias: string,
    channel: string,
    chatId: string,
  ): Promise<void> {
    const target = workspaceAliases(config, this.options.workspaceRoot)[alias];
    if (!target || !this.options.openWorkspace)
      throw new Error(`workspace “${alias}” was not found.`);
    const handoffId = await recordWorkspaceHandoff(
      this.store,
      this.options.workspaceId,
      target,
      alias,
      channel,
      chatId,
    );
    await this.manager.stopActive();
    const rollback = {
      handoffId,
      channel: channel as 'telegram' | 'whatsapp',
      chatId,
      targetName: target.display_name,
      currentName:
        currentWorkspaceIdentity(
          workspaceAliases(config, this.options.workspaceRoot),
          this.options.workspaceId,
          this.options.workspaceRoot,
        ).name ?? 'this workspace',
    };
    // Armed before the folder opens: if this window reloads, the process dies
    // with the timer and the target window's claim is the only thing that
    // happens. If it does not reload, this is what breaks the silence.
    this.coordinator.armRollback(rollback);
    try {
      await this.options.openWorkspace(target.path);
    } catch (err) {
      await this.coordinator.rollbackNow(rollback);
      throw err;
    }
  }

  private onCompactionEvent(event: CompactionEvent, controller: RemoteController): void {
    const text = remoteCompactionNotice(event);
    if (text === undefined) return;
    void controller.enqueueHostNotification(event.conversationId, text).catch((err) => {
      this.options.notifyLocal(
        `Forge remote compaction notification failed: ${(err as Error).message}`,
      );
    });
  }

  /**
   * What the sidebar chip shows. Sorted so two reads of an unchanged runtime
   * produce an identical value, which is what lets the webview treat a repeated
   * message as a no-op.
   */
  async status(): Promise<RemoteStatus> {
    const transports = this.manager.names() as RemoteStatus['transports'];
    const owned = await Promise.all(transports.map((name) => this.auth.hasOwner(name)));
    return { transports, paired: owned.some(Boolean) };
  }

  private notifyStatus(): void {
    this.options.onStatusChanged?.();
  }

  /**
   * Built once; the callbacks close over live runtime state (the applied
   * config for the voice toggle, the handoff path) rather than a config
   * snapshot, so values like `voice.output.enabled` are read at call time.
   */
  private controllerOptionsDeps(): RemoteControllerOptionsDeps {
    return {
      workspaceId: this.options.workspaceId,
      workspaceRoot: this.options.workspaceRoot,
      setInactivityTimeout: this.options.setInactivityTimeout,
      reloadWindow: this.options.reloadWindow,
      onError: this.options.notifyLocal,
      voiceOutputEnabled: () => this.appliedConfig?.voice?.output?.enabled === true,
      setVoiceOutput: (on: boolean) => this.setVoiceOutput(on),
      hasConfigPath: this.options.configPath !== undefined,
      switchWorkspace: (config, alias, channel, chatId) =>
        this.switchWorkspace(config, alias, channel, chatId),
    };
  }
}
