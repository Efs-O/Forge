import * as path from 'path';
import { loadConfig } from '../config/ConfigLoader';
import { updateForgeKeyFile } from '../config/ConfigWriter';
import { setNestedField } from '../config/ConfigWriterHelpers';
import type { ForgeConfig } from '../config/types';
import { RemoteAuth } from './RemoteAuth';
import { RemoteRequestStore } from './RemoteRequestStore';
import { remoteSessionAction, type RemoteSessionActionResult } from './RemoteSessionBridge';
import { claimRemoteMidTurnTell } from './RemoteMidTurnTells';
import type { MidTurnDrainResult } from '../agent/MidTurnInbox';
import { RemoteAuditLog } from './RemoteAuditLog';
import { RemoteAttachmentStore } from './RemoteAttachmentStore';
import { RemoteTransportManager } from './RemoteTransportManager';
import { type RemoteControllerOptionsDeps } from './remoteControllerOptions';
import { RemoteHandoffCoordinator } from './RemoteHandoffCoordinator';
import { RemoteCompactionNoticeBuffers } from './compactionNoticeBuffer';
import {
  canUpdateTransportsInPlace,
  updateActiveTransportOptions,
} from './remoteRuntimeInPlaceUpdate';
import { RemoteStartRetry } from './RemoteStartRetry';
import {
  claimWorkspaceArrivals,
  createAnnounceGate,
  releaseTransportsAfterRollback,
  switchRemoteWorkspace,
  switchWorkspacePreflight,
  takeTransportsForActivation,
  takeTransportsForRollback,
  type WorkspaceHandoffRuntimeDeps,
} from './remoteWorkspaceSwitch';
import { createRemoteWindowWatch, RemoteWindowWatch } from './RemoteWindowWatch';
import { buildRemoteValidationStatus } from './remoteValidationStatus';
import { sendRemoteWorkspaceFile } from './remoteFileDelivery';
import {
  type RemoteRuntimeOptions,
  type WorkspaceSwitchModeChoice,
  type RemoteFileSendResult,
  type RemoteValidationStatus,
  type RemoteChannelFactory,
  type RemoteChannelFactoryContext,
  type RemoteStatus,
} from './types';

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
  private readonly compactionBuffers: RemoteCompactionNoticeBuffers;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private disposed = false;
  private appliedConfig: ForgeConfig | undefined;
  /** Retained even if transport startup fails, for later handoff recovery. */
  private requestedConfig: ForgeConfig | undefined;
  private readonly startRetry = new RemoteStartRetry({
    serialize: (task) => this.enqueue(task),
    wanted: (config) =>
      !this.disposed &&
      config.remote?.enabled === true &&
      this.requestedConfig === config &&
      this.manager.names().length === 0,
    start: (config) => this.replace(config),
  });
  /** Handoff machinery, built once so the runtime is a thin caller of it. */
  private readonly handoff: WorkspaceHandoffRuntimeDeps;
  /** This window's own 5 s watch: retries a refused claim; `dispose()` clears it. */
  private readonly windowWatch: RemoteWindowWatch;
  /** Aborted by `dispose()`, which is what cancels an activation lease retry. */
  private readonly lifecycleAbort = new AbortController();

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
    this.compactionBuffers = new RemoteCompactionNoticeBuffers((message) =>
      options.notifyLocal(`Forge remote compaction notification failed: ${message}`),
    );
    this.deps = this.controllerOptionsDeps();
    this.manager = new RemoteTransportManager(
      options,
      this.store,
      this.auth,
      this.audit,
      this.deps,
      (event, controller) => this.compactionBuffers.onCompactionEvent(event, controller),
      (controller, conversationId) =>
        this.compactionBuffers.beforeConversationNotify(controller, conversationId),
      (controller) => this.compactionBuffers.onTransportStopped(controller),
      () => this.notifyStatus(),
    );
    this.coordinator = new RemoteHandoffCoordinator({
      store: this.store,
      storePath,
      workspaceId: options.workspaceId,
      serialize: (task) => this.enqueue(task),
      claimArrivals: () => claimWorkspaceArrivals(this.handoff),
      takeTransports: () => takeTransportsForRollback(this.handoff),
      releaseTransports: () => releaseTransportsAfterRollback(this.handoff),
      sendToChat: (channel, chatId, text) =>
        this.manager
          .get(channel)
          ?.channel.send(chatId, text)
          .then(() => undefined) ?? Promise.resolve(),
      notifyLocal: options.notifyLocal,
      ...(options.handoffWatch ?? {}),
    });
    this.handoff = {
      store: this.store,
      manager: this.manager,
      coordinator: this.coordinator,
      workspaceId: options.workspaceId,
      ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
      host: options.host,
      isDisposed: () => this.disposed,
      requestedConfig: () => this.requestedConfig,
      activeTransports: () => this.manager.names(),
      announceOnce: createAnnounceGate(),
      totpEnrolled: (channel) => this.auth.totpEnrolled(channel),
      notifyLocal: options.notifyLocal,
      stopTransports: () => this.manager.stopActive(),
      globalStoragePath: options.storageDirectory,
      userConfigFileSetting: () => options.userConfigFileSetting?.() ?? undefined,
      ...(options.openWorkspace ? { openWorkspace: options.openWorkspace } : {}),
      ...(options.closeWindow ? { closeWindow: options.closeWindow } : {}),
      ...(options.hasUnsavedEditors ? { hasUnsavedEditors: options.hasUnsavedEditors } : {}),
    };
    // The whole watch, deps included, is built in `RemoteWindowWatch.ts`: this
    // file is at the ESLint line stop and the plan says the room for phase 3 has
    // to come from extracting the runtime's bodies, not from widening them.
    this.windowWatch = createRemoteWindowWatch({
      handoff: this.handoff,
      // Through the lifecycle chain, or a retry could interleave a second
      // `startAll` over the active map and leak a lease.
      serialize: (task) => this.enqueue(task),
      ...(options.handoffWatch?.pollIntervalMs
        ? { tickIntervalMs: options.handoffWatch.pollIntervalMs }
        : {}),
    });
  }

  /**
   * Undefined until the remote store has loaded; callers must fail closed.
   * Remote turned off never loads the store, so it pins nothing — and a remote
   * window runs no transports of its own, so answering `undefined` there would
   * make every chat in it read as "unreachable remote runtime" and never sweep.
   */
  blocksConversationEviction(conversationId: string): boolean | undefined {
    if (this.options.hostedElsewhere) return false;
    if (this.store.isLoaded()) return this.store.blocksConversationEviction(conversationId);
    return this.appliedConfig && this.appliedConfig.remote?.enabled !== true ? false : undefined;
  }
  conversationOriginChannel(id: string): string | undefined {
    return this.store.bindingsForConversation(id)[0]?.channel;
  }

  /** Serializes operations that touch the active transport map. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.lifecycleTail.then(task);
    this.lifecycleTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  applyConfig(config: ForgeConfig): Promise<void> {
    this.startRetry.cancel();
    return this.enqueue(() => this.replaceWithRetry(config));
  }

  /**
   * Recreates one provider after an out-of-band credential change. Secrets are
   * intentionally absent from ForgeConfig, so an ordinary config diff cannot
   * detect a replaced Telegram token.
   */
  refreshTransport(name: 'telegram' | 'whatsapp', config: ForgeConfig): Promise<void> {
    return this.enqueue(async () => {
      if (this.disposed) return;
      // A remote window runs no transports, so there is no provider to rebuild;
      // a new token stored here belongs to the desktop's window, not to this one.
      if (this.options.hostedElsewhere) return;
      if (!this.appliedConfig) {
        await this.replaceWithRetry(config);
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
    if (this.options.hostedElsewhere) throw new Error(this.options.hostedElsewhere);
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

  unlinkWhatsApp(): Promise<void> {
    return this.enqueue(async () => {
      const transport = this.manager.get('whatsapp');
      if (!transport?.channel.unlink) throw new Error('Forge remote WhatsApp is not running.');
      await transport.channel.unlink();
      await this.manager.stopTransport('whatsapp');
      await this.auth.unpair('whatsapp');
    });
  }

  activeTransports(): string[] {
    return this.manager.names();
  }

  /**
   * Resolves the conversation's unique Telegram binding and sends under its active lease.
   */
  sendFileToConversation(
    conversationId: string,
    requestedPath: string,
    caption: string,
  ): Promise<RemoteFileSendResult> {
    return this.enqueue(() =>
      sendRemoteWorkspaceFile({
        conversationId,
        requestedPath,
        caption,
        workspaceId: this.options.workspaceId,
        ...(this.options.workspaceRoot ? { workspaceRoot: this.options.workspaceRoot } : {}),
        isDisposed: () => this.disposed,
        isEnabled: () => this.appliedConfig?.remote?.enabled === true,
        manager: this.manager,
        store: this.store,
        auth: this.auth,
      }),
    );
  }

  remoteSessionAction(
    from: string,
    sessionId: string,
    exchangeId: string,
    action: 'ask' | 'notify',
    text: string,
  ): Promise<RemoteSessionActionResult> {
    return remoteSessionAction({
      from,
      sessionId,
      exchangeId,
      action,
      text,
      store: this.store,
      auth: this.auth,
      available: (channel) => this.manager.get(channel) !== undefined,
      kick: (channel) => this.manager.get(channel)?.controller.outbox.kick(),
    });
  }

  claimMidTurnTell(conversationId: string): Promise<MidTurnDrainResult> {
    return claimRemoteMidTurnTell(
      this.store,
      (channel, chatId) => this.auth.canDeliver(channel, chatId),
      conversationId,
      (channel) => this.manager.get(channel)?.controller.outbox.kick(),
      (channel, requestId) => this.manager.get(channel)?.controller.retireQueuedReceipt(requestId),
    );
  }

  async validationStatus(config: ForgeConfig): Promise<RemoteValidationStatus> {
    return buildRemoteValidationStatus(config, this.manager, this.auth, this.store);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.startRetry.cancel();
    // Abort first: a still-looping lease retry starts transports on the way out.
    this.lifecycleAbort.abort();
    this.windowWatch.dispose();
    this.coordinator.dispose();
    await this.applySerializedStop();
  }

  /**
   * Persist `voice.output.enabled` to config.yaml and apply it without a window
   * reload. The write is schema-validated and atomic (temp + rename, .bak
   * backup) by updateForgeKeyFile. Re-reading the file keeps the in-memory config
   * and the file in agreement. `output.enabled` is excluded from the voice
   * runtime signature, so this takes the in-place path (speech.setEnabled) and
   * the controller -- with the pending auto-deletes of this very command --
   * survives.
   *
   * Routed through lifecycleTail (like applyConfig) so a /voice toggle cannot
   * interleave a second replace() over the active map with a concurrent
   * config reload.
   */
  async setVoiceOutput(on: boolean): Promise<void> {
    if (!this.options.configPath) throw new Error('config path is not available');
    return this.enqueue(() => {
      updateForgeKeyFile(this.options.configPath!, 'voice', (doc) =>
        setNestedField(doc, ['voice', 'output', 'enabled'], on),
      );
      const config = loadConfig(path.dirname(this.options.configPath!));
      this.appliedConfig = config;
      return this.replaceWithRetry(config);
    });
  }

  private async replaceWithRetry(config: ForgeConfig): Promise<void> {
    try {
      await this.replace(config);
    } catch (err) {
      this.startRetry.failed(config, err);
      throw err;
    }
  }

  private async replace(config: ForgeConfig): Promise<void> {
    this.requestedConfig = config;
    if (this.options.hostedElsewhere) {
      // A VS Code Remote window: the desktop's own Forge window owns the
      // transports, so this window must not load the store, sweep attachments,
      // take a lease or watch for handoffs — all of it would only collide with
      // the window that does own them. Same disabled path as `remote.enabled:
      // false`, decided before `canUpdateInPlace` so a config that looks
      // unchanged cannot smuggle a start through this branch either.
      await this.manager.stopActive();
      this.coordinator.dispose();
      this.windowWatch.dispose();
      this.auth.updateSessionPolicy({ inactivityTimeoutMinutes: 30 });
      this.appliedConfig = config;
      return;
    }
    if (this.canUpdateInPlace(config)) {
      this.updateActiveOptions(config);
      this.appliedConfig = config;
      return;
    }
    await this.manager.stopActive();
    if (this.disposed || config.remote?.enabled !== true) {
      this.coordinator.dispose();
      this.windowWatch.dispose();
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
    this.windowWatch.start();
    // Lease before claim (plan phase 2, audit 1.2): a window that cannot serve
    // the phone must not bind the chat, so it leaves the record for the window
    // that holds the lease, or for its own `RemoteWindowWatch` retry later.
    const leaseRefused = await takeTransportsForActivation(this.manager, config, {
      waitingForAChat: this.store.hasPendingWorkspaceHandoff(this.options.workspaceId),
      signal: this.lifecycleAbort.signal,
    });
    this.appliedConfig = config;
    this.startRetry.cancel();
    // Skipped rather than awaited: a claim retries the lease for 90 s, and that
    // wait belongs to the watch, which re-claims on its own timer.
    if (!leaseRefused)
      await claimWorkspaceArrivals(this.handoff, { signal: this.lifecycleAbort.signal });
  }

  private canUpdateInPlace(config: ForgeConfig): boolean {
    return canUpdateTransportsInPlace(
      config,
      this.appliedConfig,
      this.disposed,
      this.manager.names(),
    );
  }

  private updateActiveOptions(config: ForgeConfig): void {
    updateActiveTransportOptions(config, this.auth, this.manager.values(), this.deps);
  }

  private applySerializedStop(): Promise<void> {
    return this.enqueue(() => this.manager.stopActive());
  }

  /** Move one chat to another project's window with a rollback on failure. */
  switchWorkspace(
    config: ForgeConfig,
    alias: string,
    channel: string,
    chatId: string,
    mode: WorkspaceSwitchModeChoice,
  ): Promise<() => Promise<void>> {
    return switchRemoteWorkspace(this.handoff, { config, alias, channel, chatId, mode });
  }

  /** Current transport and pairing status for the sidebar chip. */
  async status(): Promise<RemoteStatus> {
    const transports = this.manager.names() as RemoteStatus['transports'];
    const owned = await Promise.all(transports.map((name) => this.auth.hasOwner(name)));
    return { transports, paired: owned.some(Boolean) };
  }

  private notifyStatus(): void {
    this.options.onStatusChanged?.();
  }

  /** Callbacks read live runtime state rather than a config snapshot. */
  private controllerOptionsDeps(): RemoteControllerOptionsDeps {
    return {
      workspaceId: this.options.workspaceId,
      workspaceRoot: this.options.workspaceRoot,
      configPath: this.options.configPath,
      isModelLoaded: this.options.isModelLoaded,
      setInactivityTimeout: this.options.setInactivityTimeout,
      setRateLimit: this.options.setRateLimit,
      reloadWindow: this.options.reloadWindow,
      onError: this.options.notifyLocal,
      voiceOutputEnabled: () => this.appliedConfig?.voice?.output?.enabled === true,
      setVoiceOutput: (on: boolean) => this.setVoiceOutput(on),
      hasConfigPath: this.options.configPath !== undefined,
      switchWorkspace: (config, alias, channel, chatId, mode) =>
        this.switchWorkspace(config, alias, channel, chatId, mode),
      workspacePreflight: (config, alias, channel) =>
        switchWorkspacePreflight(this.handoff, { config, alias, channel }),
      ...(this.options.jobStore ? { jobsStore: this.options.jobStore } : {}),
      ...(this.options.windowSurface ? { windowSurface: this.options.windowSurface } : {}),
    };
  }
}
