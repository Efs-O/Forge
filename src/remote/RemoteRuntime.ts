import * as path from 'path';
import { randomUUID } from 'crypto';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { CompactionEvent } from '../sidebar/CompactionService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { RemoteAuth } from './RemoteAuth';
import { RemoteController, type RemoteControllerOptions } from './RemoteController';
import { buildVoiceBridge } from './RemoteVoiceBridge';
import { buildSpeechDelivery } from './RemoteSpeechDelivery';
import { RemoteRequestStore } from './RemoteRequestStore';
import { resolveWorkspaceAliases, type WorkspaceAliasTarget } from './RemoteWorkspaceDiscovery';
import {
  announceWorkspaceArrivals,
  recordWorkspaceHandoff,
  resumeWorkspaceHandoffs,
  workspaceIdFor,
} from './RemoteWorkspaceHandoff';
import { RemoteTransportLease } from './RemoteTransportLease';
import type { RemoteChannel, RemoteStatus } from './types';
import { RemoteAuditLog } from './RemoteAuditLog';
import { remoteCompactionNotice } from './remoteCompactionNotice';
import { subscribeHostToRemote, type HostSubscriptions } from './remoteHostSubscriptions';
import { RemoteAttachmentStore } from './RemoteAttachmentStore';

export interface RemoteChannelFactoryContext {
  getCursor: (key: string) => string | undefined;
  setCursor: (key: string, value: string) => Promise<void>;
}
export type RemoteChannelFactory = (
  context: RemoteChannelFactoryContext,
) => Promise<RemoteChannel> | RemoteChannel;

export interface RemoteRuntimeOptions {
  storageDirectory: string;
  workspaceRoot?: string | undefined;
  workspaceId: string;
  host: ForgeHostFacade;
  secrets: vscode.SecretStorage;
  channelFactories?: Partial<Record<'telegram' | 'whatsapp', RemoteChannelFactory>>;
  notifyLocal: (message: string) => void;
  /**
   * Fired whenever the set of running transports or the paired-owner state
   * changes. The listener reads `status()` - which has to await SecretStorage -
   * rather than being handed a value, so the notification stays synchronous and
   * cannot interleave with the lifecycle operation that raised it.
   */
  onStatusChanged?: (() => void) | undefined;
  setInactivityTimeout?: ((minutes: number) => Promise<void>) | undefined;
  reloadWindow?: (() => Promise<void>) | undefined;
  openWorkspace?: ((directory: string) => Promise<void>) | undefined;
}

interface ActiveTransport {
  channel: RemoteChannel;
  controller: RemoteController;
  lease: RemoteTransportLease;
  subscriptions: HostSubscriptions;
}

export interface RemoteValidationStatus {
  enabled: boolean;
  transports: Array<{
    name: 'telegram' | 'whatsapp';
    configured: boolean;
    active: boolean;
    ownerPaired: boolean;
    totpEnrolled: boolean;
    leaseOwned: boolean;
    providerOk: boolean;
    detail: string;
  }>;
  requests: ReturnType<RemoteRequestStore['requestHealth']>;
  outbox: ReturnType<RemoteRequestStore['outboxHealth']>;
}

/** Extension-scoped, serially reconfigurable owner of all remote transports. */
export class RemoteRuntime {
  private readonly auth: RemoteAuth;
  private readonly store: RemoteRequestStore;
  private readonly instanceId = randomUUID();
  private readonly audit: RemoteAuditLog;
  private readonly active = new Map<string, ActiveTransport>();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private appliedConfig: ForgeConfig | undefined;

  constructor(private readonly options: RemoteRuntimeOptions) {
    this.auth = new RemoteAuth(options.secrets, undefined, () => this.notifyStatus());
    this.store = new RemoteRequestStore(
      path.join(options.storageDirectory, 'remote-state-v2.json'),
      path.join(options.storageDirectory, 'remote-state-v1.json'),
    );
    this.audit = new RemoteAuditLog(
      path.join(options.storageDirectory, 'remote-audit-v1.json'),
      options.secrets,
    );
  }

  applyConfig(config: ForgeConfig): Promise<void> {
    const operation = this.lifecycleTail.then(() => this.replace(config));
    this.lifecycleTail = operation.catch(() => undefined);
    return operation;
  }

  /**
   * Recreates one provider after an out-of-band credential change. Secrets are
   * intentionally absent from ForgeConfig, so an ordinary config diff cannot
   * detect a replaced Telegram token.
   */
  refreshTransport(name: 'telegram' | 'whatsapp', config: ForgeConfig): Promise<void> {
    const operation = this.lifecycleTail.then(async () => {
      if (this.disposed) return;
      if (!this.appliedConfig) {
        await this.replace(config);
        return;
      }
      await this.stopTransport(name);
      this.auth.updateSessionPolicy({
        inactivityTimeoutMinutes: config.remote?.auth.inactivity_timeout_minutes ?? 30,
      });
      if (config.remote?.enabled === true && config.remote[name].enabled === true) {
        await this.store.load();
        await this.startTransport(name, config);
      }
      this.appliedConfig = config;
    });
    this.lifecycleTail = operation.catch(() => undefined);
    return operation;
  }

  beginPairing(channel: 'telegram' | 'whatsapp'): string {
    if (!this.active.has(channel)) {
      throw new Error(`Forge remote ${channel} is not running.`);
    }
    return this.auth.beginPairing(channel);
  }

  async unpair(channel: 'telegram' | 'whatsapp'): Promise<void> {
    await this.auth.unpair(channel);
    this.active.get(channel)?.controller.forgetChannel(channel);
  }

  createTotpEnrollmentSecret(channel: 'telegram' | 'whatsapp'): Promise<string> {
    if (!this.active.has(channel)) throw new Error(`Forge remote ${channel} is not running.`);
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
    const channel = this.active.get('whatsapp')?.channel;
    if (!channel?.requestPairingCode) throw new Error('Forge remote WhatsApp is not running.');
    return channel.requestPairingCode(phoneNumber);
  }

  async unlinkWhatsApp(): Promise<void> {
    const transport = this.active.get('whatsapp');
    if (!transport?.channel.unlink) throw new Error('Forge remote WhatsApp is not running.');
    await transport.channel.unlink();
    await this.stopTransport('whatsapp');
    await this.auth.unpair('whatsapp');
  }

  activeTransports(): string[] {
    return [...this.active.keys()];
  }

  async validationStatus(config: ForgeConfig): Promise<RemoteValidationStatus> {
    const transports: RemoteValidationStatus['transports'] = [];
    for (const name of ['telegram', 'whatsapp'] as const) {
      const configured = config.remote?.enabled === true && config.remote[name].enabled === true;
      const active = this.active.get(name);
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
    await this.applySerializedStop();
  }

  private async replace(config: ForgeConfig): Promise<void> {
    if (this.canUpdateInPlace(config)) {
      this.updateActiveOptions(config);
      this.appliedConfig = config;
      return;
    }
    await this.stopActive();
    if (this.disposed || config.remote?.enabled !== true) {
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
    const arrivals = await resumeWorkspaceHandoffs(
      this.store,
      this.options.workspaceId,
      this.options.host,
    );
    try {
      for (const channelName of ['telegram', 'whatsapp'] as const) {
        await this.startTransport(channelName, config);
      }
    } catch (err) {
      await this.stopActive();
      throw err;
    }
    this.appliedConfig = config;
    await announceWorkspaceArrivals(arrivals, {
      channelFor: (name) => this.active.get(name)?.channel,
      displayNameFor: (alias) => this.workspaceAliases(config)[alias]?.display_name ?? alias,
      totpEnrolled: (channel) => this.auth.totpEnrolled(channel),
      notifyLocal: this.options.notifyLocal,
    });
  }

  private canUpdateInPlace(config: ForgeConfig): boolean {
    if (!this.appliedConfig || this.disposed) return false;
    const configured = transportNames(config);
    const active = [...this.active.keys()].sort();
    return (
      configured.length === active.length &&
      configured.every((name, index) => name === active[index])
    );
  }

  private updateActiveOptions(config: ForgeConfig): void {
    if (!config.remote) return;
    this.auth.updateSessionPolicy({
      inactivityTimeoutMinutes: config.remote.auth.inactivity_timeout_minutes,
    });
    for (const transport of this.active.values()) {
      transport.controller.updateOptions(this.controllerOptions(config));
    }
  }

  private async startTransport(
    channelName: 'telegram' | 'whatsapp',
    config: ForgeConfig,
  ): Promise<void> {
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
    try {
      const channel = await factory({
        getCursor: (key) => this.store.cursor(key),
        setCursor: (key, value) => this.store.setCursor(key, value),
      });
      const controller = new RemoteController(
        channel,
        this.store,
        this.auth,
        this.options.host,
        this.controllerOptions(config),
        this.audit,
        buildVoiceBridge(channel, config),
        buildSpeechDelivery(channel, config, undefined, this.options.notifyLocal),
      );
      const subscriptions = subscribeHostToRemote(this.options.host, controller, {
        onCompaction: (event) => this.onCompactionEvent(event, controller),
        onActivityError: (message) =>
          this.options.notifyLocal(`Forge remote activity notification failed: ${message}`),
      });
      try {
        // Subscribe before channel startup: an automatic compaction can
        // complete while a transport is activating. Controller.start() starts
        // the durable outbox, which flushes anything queued here.
        await controller.start();
        this.active.set(channelName, {
          channel,
          controller,
          lease,
          subscriptions,
        });
        this.notifyStatus();
      } catch (err) {
        subscriptions.dispose();
        throw err;
      }
    } catch (err) {
      await lease.release();
      throw err;
    }
  }

  private controllerOptions(config: ForgeConfig): RemoteControllerOptions {
    const remote = config.remote;
    if (!remote) throw new Error('Forge remote configuration is unavailable.');
    const aliases = this.workspaceAliases(config);
    return {
      workspaceId: this.options.workspaceId,
      queueLimit: remote.queue_limit,
      maxMessageChars: remote.max_message_chars,
      rateLimitPerMinute: remote.rate_limit_per_minute,
      modelNames: config.models.map((model) => model.name),
      ...(this.options.workspaceRoot
        ? { attachmentStore: new RemoteAttachmentStore(this.options.workspaceRoot) }
        : {}),
      attachmentsEnabled: remote.attachments.enabled,
      acceptPdfAttachments: remote.attachments.accept_pdf,
      // Resolved here rather than per command: controllerOptions re-runs on
      // every config change, so a newly created sibling project appears after
      // a config edit or a window reload — not instantly. Making it lazy would
      // have meant a callback type and touching a dozen controller fixtures for
      // a refresh nobody asked for.
      workspaceAliases: Object.fromEntries(
        Object.entries(aliases).map(([alias, value]) => [alias, value.display_name]),
      ),
      // Hash each path exactly as extension.ts derives workspaceId, so the list
      // can mark which entry this chat is actually sitting in.
      ...(() => {
        const current = Object.entries(aliases).find(
          ([, value]) => workspaceIdFor(value.path) === this.options.workspaceId,
        );
        // The name is answered from the open folder when no alias matches, so
        // "where am I?" never comes back blank just because this project was
        // reached outside the alias list.
        const name = current
          ? current[1].display_name
          : this.options.workspaceRoot
            ? path.basename(path.resolve(this.options.workspaceRoot))
            : undefined;
        return {
          ...(current ? { currentWorkspaceAlias: current[0] } : {}),
          ...(name ? { currentWorkspaceName: name } : {}),
        };
      })(),
      switchWorkspace: (alias, channel, chatId) => this.handoff(config, alias, channel, chatId),
      inactivityTimeoutMinutes: remote.auth.inactivity_timeout_minutes,
      setInactivityTimeout: this.options.setInactivityTimeout,
      reloadWindow: this.options.reloadWindow,
      onError: this.options.notifyLocal,
    };
  }

  private applySerializedStop(): Promise<void> {
    const operation = this.lifecycleTail.then(() => this.stopActive());
    this.lifecycleTail = operation.catch(() => undefined);
    return operation;
  }

  /** Discovered siblings merged under explicit config, re-scanned on each use
   *  so a project created after this window opened is still reachable. */
  private workspaceAliases(config: ForgeConfig): Record<string, WorkspaceAliasTarget> {
    return resolveWorkspaceAliases(
      config.remote?.workspace_aliases ?? {},
      this.options.workspaceRoot,
    );
  }

  private async handoff(
    config: ForgeConfig,
    alias: string,
    channel: string,
    chatId: string,
  ): Promise<void> {
    const target = this.workspaceAliases(config)[alias];
    if (!target || !this.options.openWorkspace)
      throw new Error(`workspace “${alias}” was not found.`);
    await recordWorkspaceHandoff(
      this.store,
      this.options.workspaceId,
      target,
      alias,
      channel,
      chatId,
    );
    await this.stopActive();
    await this.options.openWorkspace(target.path);
  }

  private async stopTransport(name: string): Promise<void> {
    const transport = this.active.get(name);
    if (!transport) return;
    this.active.delete(name);
    this.notifyStatus();
    transport.subscriptions.dispose();
    await transport.controller.stop();
    await transport.lease.release();
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

  private async stopActive(): Promise<void> {
    await Promise.all([...this.active.keys()].map((name) => this.stopTransport(name)));
  }

  /**
   * What the sidebar chip shows. Sorted so two reads of an unchanged runtime
   * produce an identical value, which is what lets the webview treat a repeated
   * message as a no-op.
   */
  async status(): Promise<RemoteStatus> {
    const transports = (this.activeTransports() as RemoteStatus['transports']).sort();
    const owned = await Promise.all(transports.map((name) => this.auth.hasOwner(name)));
    return { transports, paired: owned.some(Boolean) };
  }

  private notifyStatus(): void {
    this.options.onStatusChanged?.();
  }
}

function transportNames(config: ForgeConfig): string[] {
  if (config.remote?.enabled !== true) return [];
  return (['telegram', 'whatsapp'] as const).filter(
    (name) => config.remote?.[name].enabled === true,
  );
}
