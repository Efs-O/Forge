import * as path from 'path';
import { randomUUID } from 'crypto';
import type * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { RemoteAuth } from './RemoteAuth';
import { RemoteController } from './RemoteController';
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
}

interface ActiveTransport {
  channel: RemoteChannel;
  controller: RemoteController;
  lease: RemoteTransportLease;
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
    try {
      for (const channelName of ['telegram', 'whatsapp'] as const) {
        if (config.remote[channelName].enabled !== true) continue;
        const factory = this.options.channelFactories?.[channelName];
        if (!factory) {
          this.options.notifyLocal(
            `Forge remote ${channelName} is enabled but its transport is unavailable.`,
          );
          continue;
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
            {
              workspaceId: this.options.workspaceId,
              queueLimit: config.remote.queue_limit,
              maxMessageChars: config.remote.max_message_chars,
              rateLimitPerMinute: config.remote.rate_limit_per_minute,
              modelNames: config.models.map((model) => model.name),
              ...(this.options.workspaceRoot
                ? { attachmentStore: new RemoteAttachmentStore(this.options.workspaceRoot) }
                : {}),
              attachmentsEnabled: config.remote.attachments.enabled,
              acceptPdfAttachments: config.remote.attachments.accept_pdf,
              inactivityTimeoutMinutes: config.remote.auth.inactivity_timeout_minutes,
              setInactivityTimeout: this.options.setInactivityTimeout,
              onError: this.options.notifyLocal,
            },
            this.audit,
          );
          await controller.start();
          this.active.set(channelName, { channel, controller, lease });
        } catch (err) {
          await lease.release();
          throw err;
        }
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
    const remote = config.remote;
    if (!remote) return;
    this.auth.updateSessionPolicy({
      inactivityTimeoutMinutes: remote.auth.inactivity_timeout_minutes,
    });
    for (const transport of this.active.values()) {
      transport.controller.updateOptions({
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
        inactivityTimeoutMinutes: remote.auth.inactivity_timeout_minutes,
        setInactivityTimeout: this.options.setInactivityTimeout,
        onError: this.options.notifyLocal,
      });
    }
  }

  private applySerializedStop(): Promise<void> {
    const operation = this.lifecycleTail.then(() => this.stopActive());
    this.lifecycleTail = operation.catch(() => undefined);
    return operation;
  }

  private async stopTransport(name: string): Promise<void> {
    const transport = this.active.get(name);
    if (!transport) return;
    this.active.delete(name);
    await transport.controller.stop();
    await transport.lease.release();
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
