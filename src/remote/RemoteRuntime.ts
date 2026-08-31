import * as path from 'path';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { CompactionEvent } from '../sidebar/CompactionService';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { RemoteAuth } from './RemoteAuth';
import { RemoteController, type RemoteControllerOptions } from './RemoteController';
import { RemoteRequestStore } from './RemoteRequestStore';
import { RemoteTransportLease } from './RemoteTransportLease';
import type { RemoteChannel } from './types';
import { RemoteAuditLog } from './RemoteAuditLog';
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
  setInactivityTimeout?: ((minutes: number) => Promise<void>) | undefined;
  reloadWindow?: (() => Promise<void>) | undefined;
  openWorkspace?: ((directory: string) => Promise<void>) | undefined;
}

interface ActiveTransport {
  channel: RemoteChannel;
  controller: RemoteController;
  lease: RemoteTransportLease;
  compactionSubscription?: { dispose(): void } | undefined;
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
    this.auth = new RemoteAuth(options.secrets);
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

  unpair(channel: 'telegram' | 'whatsapp'): Promise<void> {
    return this.auth.unpair(channel);
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
    await this.resumeWorkspaceHandoffs();
    try {
      for (const channelName of ['telegram', 'whatsapp'] as const) {
        await this.startTransport(channelName, config);
      }
    } catch (err) {
      await this.stopActive();
      throw err;
    }
    this.appliedConfig = config;
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
      );
      const compactionSubscription = this.options.host.onCompactionEvent?.((event) =>
        this.onCompactionEvent(event, controller),
      );
      try {
        // Subscribe before channel startup: an automatic compaction can
        // complete while a transport is activating. Controller.start() starts
        // the durable outbox, which flushes anything queued here.
        await controller.start();
        this.active.set(channelName, { channel, controller, lease, compactionSubscription });
      } catch (err) {
        compactionSubscription?.dispose();
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
      workspaceAliases: Object.fromEntries(
        Object.entries(remote.workspace_aliases).map(([alias, value]) => [
          alias,
          value.display_name,
        ]),
      ),
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

  private async handoff(
    config: ForgeConfig,
    alias: string,
    channel: string,
    chatId: string,
  ): Promise<void> {
    const target = config.remote?.workspace_aliases[alias];
    if (!target || !this.options.openWorkspace)
      throw new Error(`workspace “${alias}” was not found.`);
    const targetWorkspaceId = createHash('sha256').update(path.resolve(target.path)).digest('hex');
    await this.store.beginWorkspaceHandoff({
      channel: channel as 'telegram' | 'whatsapp' | 'fake',
      chatId,
      sourceWorkspaceId: this.options.workspaceId,
      targetWorkspaceId,
      targetAlias: alias,
    });
    await this.stopActive();
    await this.options.openWorkspace(target.path);
  }

  private async resumeWorkspaceHandoffs(): Promise<void> {
    const handoffs = await this.store.claimWorkspaceHandoffs(this.options.workspaceId);
    for (const handoff of handoffs) {
      const conversation = await this.options.host.createConversation({ activate: false });
      await this.store.setBinding({
        channel: handoff.channel,
        chatId: handoff.chatId,
        workspaceId: this.options.workspaceId,
        conversationId: conversation.id,
      });
      await this.store.completeWorkspaceHandoff(handoff.id);
    }
  }

  private async stopTransport(name: string): Promise<void> {
    const transport = this.active.get(name);
    if (!transport) return;
    this.active.delete(name);
    transport.compactionSubscription?.dispose();
    await transport.controller.stop();
    await transport.lease.release();
  }

  /**
   * Delivery policy for host-originated compaction events:
   * - trigger 'auto'  → notify on started + finished (primary new capability)
   * - trigger 'remote' → suppress (the /compact handler already sent progress)
   * - trigger 'sidebar' → suppress (local actions are not mirrored by default)
   */
  private onCompactionEvent(event: CompactionEvent, controller: RemoteController): void {
    if (event.trigger !== 'auto') return;
    const text =
      event.phase === 'started'
        ? 'Forge: compacting…'
        : event.outcome === 'compacted'
          ? 'Forge: compaction complete.'
          : event.outcome === 'skipped'
            ? undefined
            : 'Forge: compaction failed.';
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
}

function transportNames(config: ForgeConfig): string[] {
  if (config.remote?.enabled !== true) return [];
  return (['telegram', 'whatsapp'] as const).filter(
    (name) => config.remote?.[name].enabled === true,
  );
}
