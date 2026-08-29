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

export type RemoteChannelFactory = () => Promise<RemoteChannel> | RemoteChannel;

export interface RemoteRuntimeOptions {
  storageDirectory: string;
  workspaceId: string;
  host: ForgeHostFacade;
  secrets: vscode.SecretStorage;
  channelFactories?: Partial<Record<'telegram' | 'whatsapp', RemoteChannelFactory>>;
  notifyLocal: (message: string) => void;
}

interface ActiveTransport {
  controller: RemoteController;
  lease: RemoteTransportLease;
}

/** Extension-scoped, serially reconfigurable owner of all remote transports. */
export class RemoteRuntime {
  private readonly auth: RemoteAuth;
  private readonly store: RemoteRequestStore;
  private readonly instanceId = randomUUID();
  private readonly active = new Map<string, ActiveTransport>();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: RemoteRuntimeOptions) {
    this.auth = new RemoteAuth(options.secrets);
    this.store = new RemoteRequestStore(
      path.join(options.storageDirectory, 'remote-state-v1.json'),
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

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.applySerializedStop();
  }

  private async replace(config: ForgeConfig): Promise<void> {
    await this.stopActive();
    if (this.disposed || config.remote?.enabled !== true) return;
    await this.store.load();
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
          void this.stopTransport(channelName);
        },
      });
      try {
        const channel = await factory();
        const controller = new RemoteController(channel, this.store, this.auth, this.options.host, {
          workspaceId: this.options.workspaceId,
          queueLimit: config.remote.queue_limit,
          maxMessageChars: config.remote.max_message_chars,
        });
        await controller.start();
        this.active.set(channelName, { controller, lease });
      } catch (err) {
        await lease.release();
        throw err;
      }
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
