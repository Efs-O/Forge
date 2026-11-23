import * as path from 'path';
import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { openPendingLocalSetup } from './sidebar/localSetupChat';
import { HistoryArchive } from './sidebar/HistoryArchive';
import { watchWorkspaceFolders } from './sidebar/workspaceInfo';
import { buildStatusBarTurnEvents } from './sidebar/statusBarTurnEvents';
import { setExternalRequestHook } from './backend/ExternalModelServers';
import { disposeServerChannel } from './backend/DirectBackend';
import { wireTailnetServices, type TailnetServicesWiring } from './vscode/tailnetServicesSetup';
import { RemoteMediaJobs } from './media/remoteMediaJobs';
import { wireControlServer } from './vscode/controlServerSetup';
import type { ControlServer } from './backend/ControlServer';
import { wireRemoteStarter, releaseRemoteStarterLeases } from './llm/RemoteStarterClient';
import { configureRemoteWindowRoute } from './llm/RemoteWindowRoute';
import { thisWindowHostedElsewhere } from './vscode/remoteWindowKind';
import { registerAgentSetupCommand } from './vscode/agentSetupCommand';
import { bootstrapConfig } from './vscode/configBootstrap';
import { setupRemoteRuntime } from './vscode/remoteRuntimeSetup';
import { bootstrapWorkspace } from './vscode/workspaceBootstrap';
import { registerIndexWatchers } from './vscode/indexWatchers';
import type { ForgeConfig } from './config/types';
import { initLogger, getLogger } from './util/logger';
import { setRenameContentionListener } from './util/atomicWrite';
import { createCheckpointStack } from './vscode/checkpointSetup';
import { watchForgeConfig } from './vscode/configReload';
import { TemplateEngine } from './llm/TemplateEngine';
import { createForgeInstructionsLoader } from './llm/ForgeInstructionsLoader';
import { closeBrowserSessionOnShutdown } from './tools/browser/BrowserSessionManager';
import { getDesktopDriver } from './tools/desktop/PowerShellDesktopDriver';
import { BackendStatusBar } from './vscode/BackendStatusBar';
import { SessionTimeStatusBar } from './vscode/SessionTimeStatusBar';
import { ServerLogFollowers } from './backend/serverLogFollower';
import { ModelManagerPanel } from './sidebar/modelManager/ModelManagerPanel';
import { flushPendingModelUsage } from './sidebar/modelManager/usageTracker';
import { backgroundExecutionManager } from './tools/BackgroundExecutionManager';
import { backgroundRegistry } from './tools/backgroundRegistry';
import { sweepShellOutput } from './tools/shellOutput';
import type { RemoteRuntime } from './remote/RemoteRuntime';
import { setupJobs } from './vscode/jobsSetup';
import { pruneRequestDumps, requestDumpsDirectory } from './sessions/requestDump';
import {
  deactivateExternalModelLifecycle,
  registerExternalModelLifecycleLease,
  setupBackendPool,
  trackExternalModelLifecycle,
} from './vscode/backendPoolSetup';
import { registerActivationCommands } from './vscode/commandRegistrationSetup';
import { setupKeepUndo } from './vscode/keepUndoSetup';
import { setupToolActivation } from './vscode/toolActivationSetup';
import { MemoryStore, memoryFolderFor, attachMemoryStore } from './memory/memoryStore';

let activeRemoteRuntime: RemoteRuntime | undefined;
/** Kept for `deactivate()`, which closes the starter BEFORE `stopOnExit`. */
let activeTailnetServices: TailnetServicesWiring | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger(context);
  const log = getLogger();
  log.info('Forge activating');
  setRenameContentionListener((message) => log.warn(message));
  try {
    await backgroundRegistry.reap();
  } catch (error) {
    const message = `Could not reap orphaned Forge background executions: ${error instanceof Error ? error.message : String(error)}`;
    log.error(message, error);
    void vscode.window.showErrorMessage(message);
  }
  void sweepShellOutput().catch((error: unknown) =>
    log.warn(
      `Shell output spill sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );

  const storagePath = context.globalStorageUri.fsPath;
  const statusBar = new BackendStatusBar();
  context.subscriptions.push(statusBar);

  registerAgentSetupCommand(context);

  // ── Find or create config ─────────────────────────────────────────────────
  const bootstrapped = bootstrapConfig(context, statusBar, storagePath);
  const pruneOptions = bootstrapped?.config.record_requests
    ? { maxBytes: bootstrapped.config.record_requests.max_mb * 1024 * 1024 }
    : {};
  void pruneRequestDumps(requestDumpsDirectory(), pruneOptions).catch((error: unknown) =>
    log.warn(
      `[requestDump] activation prune failed: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  if (!bootstrapped) return;
  const activeConfigPath = bootstrapped.configPath;
  let config: ForgeConfig = bootstrapped.config;
  const workspaceForMemories =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? activeConfigPath;
  const memoryStore = await MemoryStore.migrate(
    memoryFolderFor(workspaceForMemories),
    context.workspaceState,
  );
  attachMemoryStore(context.workspaceState, memoryStore);
  if (memoryStore.migrationFailed) {
    void vscode.window.showErrorMessage(
      `Forge could not move workspace memories to markdown files: ${memoryStore.migrationFailureReason ?? 'unknown migration error'}. Existing memories remain available from VS Code storage; the move will retry next load.`,
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.showMemories', async () => {
      try {
        const file = memoryStore.regenerateIndex();
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(document);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Could not open Forge memories: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
  // A VS Code tunnel or SSH window holds no cloud keys of its own, so a
  // key-based model goes through the desktop's cloud relay rather than reading
  // this window's keychain. Set once here, before any request can be made, on
  // the live config, so a reload changes what the rule sees. Which remote kinds
  // that covers is `vscode/remoteWindowKind.ts`'s decision — WSL, a container
  // and Codespaces are local. `vscode/tailnetServicesSetup.ts` is the other
  // half: a hosted window never binds the relay, so it never forwards to itself.
  configureRemoteWindowRoute(thisWindowHostedElsewhere(), () => config);

  // ── Template engine (v0.8) ────────────────────────────────────────────────
  const builtinDir = path.join(context.extensionPath, 'config', 'templates', 'builtin');
  const userDirs = config.templates_dir ? [config.templates_dir] : [];
  let templateEngine: TemplateEngine | undefined;
  try {
    templateEngine = new TemplateEngine(builtinDir, userDirs);
  } catch (err) {
    log.warn(
      `[TemplateEngine] init failed; prompt-based turns will report the setup error: ${(err as Error).message}`,
    );
  }

  // ── Backend pool ──────────────────────────────────────────────────────────
  // Created before the tool registry so LocalDelegationService can be injected.
  const backendSetup = setupBackendPool(context, config, () => config);
  const { pool, externalServers, sharedRegistry, remoteLeases, externalLifecycleLeaseId } =
    backendSetup;

  // Declared early (closures use it); assigned after CodeLens, so an early route sees it unset.
  // eslint-disable-next-line prefer-const
  let sidebarProvider: SidebarProvider;
  // The media tools unload models through the control server, which is wired
  // below the tool registry; the getter resolves it per call.
  let controlServerRef: ControlServer | undefined;
  const toolSetup = setupToolActivation({
    context,
    config,
    getConfig: () => config,
    activeConfigPath,
    templateEngine,
    pool,
    getSidebarProvider: () => sidebarProvider,
    log,
    getControlServer: () => controlServerRef,
    // The media tools free GPUs through this window's lifecycle, which has to
    // see a managed external server as loaded and refuse while any window is
    // streaming on it (BL-031).
    getExternals: () => ({
      servers: externalServers,
      holds: sharedRegistry.externalTurnHolders(),
    }),
  });
  const {
    indexManager,
    workspaceRoot,
    workspaceId,
    cliSessions,
    toolRegistry,
    jobsStore,
    userQuestions,
    userNotifications,
    chatAttachments,
    sdServers,
  } = toolSetup;

  const checkpoints = createCheckpointStack(context);

  controlServerRef = undefined;
  const wiredControlServer = wireControlServer({
    context,
    pool,
    getConfig: () => config,
    workspaceRoot,
    getSidebarProvider: () => sidebarProvider,
    getRemoteRuntime: () => activeRemoteRuntime,
  });
  const { controlServer, recoverPendingReplies } = wiredControlServer;
  controlServerRef = controlServer;
  const getConfig = () => config;
  const tailnetServices = wireTailnetServices(
    context,
    getConfig,
    pool,
    controlServer,
    remoteLeases,
    // The laptop media jobs, built only for the window that owns the relay
    // (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md). They live here, not in the
    // relay, so a listener restart cannot touch a running render.
    () =>
      new RemoteMediaJobs({
        getConfig,
        root: path.join(storagePath, 'remote-media'),
        secrets: context.secrets,
        ...(sdServers ? { sdServers: () => sdServers.handles() } : {}),
      }),
  );
  activeTailnetServices = tailnetServices;

  // ── KeepUndo CodeLens + Diff Decorations ─────────────────────────────────
  const { diffDecorations, codeLensProvider } = setupKeepUndo(context, () => sidebarProvider);

  // ── Workspace bootstrap: session migration (v2) + FORGE.md auto-create ──
  await bootstrapWorkspace(context, workspaceRoot, config, activeConfigPath, getConfig);

  // ── Sidebar ───────────────────────────────────────────────────────────────
  const forgeLoader = createForgeInstructionsLoader();
  if (forgeLoader) context.subscriptions.push(forgeLoader);
  let refreshSessionTime = (): void => {};
  let followSessionTime: (conversationId: string | undefined) => void = () => {};
  const activeTurnModels = new Map<string, string>();
  sidebarProvider = new SidebarProvider(
    context.extensionUri,
    pool,
    config,
    checkpoints,
    toolRegistry,
    indexManager,
    userQuestions,
    userNotifications,
    context.workspaceState,
    codeLensProvider,
    diffDecorations,
    templateEngine,
    buildStatusBarTurnEvents({
      statusBar,
      pool,
      userNotifications,
      activeTurnModels,
      // Thunks, not values: both `let`s are reassigned later in activate(), and a
      // captured value would freeze the no-op initialisation behind the bar.
      followSessionTime: (conversationId) => followSessionTime(conversationId),
      refreshSessionTime: () => refreshSessionTime(),
    }),
    forgeLoader,
    context.secrets,
    workspaceRoot,
    () => activeConfigPath,
    cliSessions,
    chatAttachments,
    HistoryArchive.inStorageDir(context.storageUri?.fsPath, workspaceRoot),
    jobsStore,
    context.globalState,
  );
  trackExternalModelLifecycle({
    pool,
    servers: externalServers,
    registry: sharedRegistry,
    leaseId: externalLifecycleLeaseId,
    isBusy: (modelName) =>
      [...activeTurnModels.values()].includes(modelName) || remoteLeases.hasLease(modelName),
  });
  // The laptop side: before a request to a `remote_start` model, ask the desktop
  // to start or load it and hold a lease, renewed only while a turn runs here.
  wireRemoteStarter(() => config, activeTurnModels);
  void recoverPendingReplies();
  // globalStorage is shared across all workspaces. Prune only after session load
  // and only in a real workspace: windows without one share a derived id, so
  // each would take the other's chats for dead ones.
  if (workspaceRoot) {
    void Promise.resolve()
      .then(() => chatAttachments.prune(sidebarProvider.liveConversationIds()))
      .catch((error: unknown) =>
        log.warn(
          `[ChatAttachmentStore] activation prune failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }
  // Persistent agent jobs (B1). Runs in whichever window wins the
  // `jobs-scheduler` lease; a no-op when `jobs.enabled` is false.
  const jobsSetup = setupJobs(context, () => config, workspaceId, sidebarProvider, jobsStore, pool);
  const remoteRuntime = await setupRemoteRuntime(context, {
    workspaceRoot,
    workspaceId,
    configPath: activeConfigPath,
    isModelLoaded: (modelName) => pool.isLoaded(modelName),
    getConfig: () => config,
    setConfig: (next) => {
      config = next;
    },
    sidebarProvider,
    jobStore: jobsStore,
  });
  activeRemoteRuntime = remoteRuntime;
  sidebarProvider.startConversationRetention();
  // The wizard's human-only steps (Telegram pairing, Tailscale sign-in): it
  // could not open a chat itself, so it left a marker for this start. Setup
  // mode returns earlier, so a marker is only ever consumed with a config.
  void openPendingLocalSetup(context.globalState, sidebarProvider.getHostFacade()).catch(
    (error: unknown) => {
      const message = `Could not open the setup chat: ${error instanceof Error ? error.message : String(error)}`;
      log.error(message, error);
      void vscode.window.showErrorMessage(message);
    },
  );
  const sessionTimeBar = new SessionTimeStatusBar((followed) =>
    sidebarProvider.getSessionMetrics(followed),
  );
  refreshSessionTime = () => sessionTimeBar.refresh();
  followSessionTime = (conversationId) => sessionTimeBar.follow(conversationId);
  context.subscriptions.push(sessionTimeBar);
  // Contributed in package.json since the setting was added, but read by
  // nothing until now -- unticking the box changed no behaviour. Same shape as
  // the `forge.logLevel` gap fixed in 0.13.0. Note the section prefix: the key
  // asked for here is the remainder after 'forge.'.
  const retainSidebarContext = vscode.workspace
    .getConfiguration('forge')
    .get<boolean>('sidebar.retainContextWhenHidden', true);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: retainSidebarContext },
    }),
    watchWorkspaceFolders(workspaceRoot, () => sidebarProvider.postWorkspaceInfo()),
  );
  registerIndexWatchers(context, indexManager);

  log.info('[Forge] backend will start on first prompt');
  statusBar.setStopped(config.active_model);
  const serverLogs = new ServerLogFollowers();
  serverLogs.apply(config);
  context.subscriptions.push(serverLogs);

  context.subscriptions.push(
    watchForgeConfig({
      configPath: activeConfigPath,
      getConfig: () => config,
      onReloaded: (next) => {
        config = next;
        if (config.log_level) log.setLevel(config.log_level);
        templateEngine?.reload(config.templates_dir ? [config.templates_dir] : []);
        sidebarProvider.applyForgeConfig(config);
        // pool.applyForgeConfig is called inside sidebarProvider.applyForgeConfig
        controlServer.applyForgeConfig(config);
        if (config.control_server?.enabled) controlServer.start();
        // Disabling the starter closes the listener and releases every lease.
        tailnetServices.applyConfig();
        statusBar.setStopped(config.active_model);
        serverLogs.apply(config);
        sdServers?.applyForgeConfig(config);
        ModelManagerPanel.current?.refresh();
        // A reload can disable jobs (delete the recurring wake task) or change
        // a schedule (re-register it). Reconcile either way.
        jobsSetup?.onConfigReloaded();
        void remoteRuntime.applyConfig(config).catch((err) => {
          getLogger().error(`[remote] start failed: ${(err as Error).message}`);
          void vscode.window.showErrorMessage(
            `Forge remote failed to reload: ${(err as Error).message}`,
          );
        });
      },
    }),
  );

  registerActivationCommands(context, {
    backend: pool,
    sidebar: sidebarProvider,
    statusBar,
    getConfig: () => config,
    configPath: activeConfigPath,
    setConfig: (next) => {
      config = next;
    },
    controlServer,
  });
  registerExternalModelLifecycleLease(context, backendSetup);

  log.info('Forge activated');
}

export async function deactivate(): Promise<void> {
  await backgroundExecutionManager.dispose();
  // Before `stopOnExit`: an in-flight ensure must not race the exit, and
  // releasing the leases here is what lets the last-window stop see them idle.
  const tailnetServices = activeTailnetServices;
  activeTailnetServices = undefined;
  tailnetServices?.dispose();
  // Give up any lease this window held on a desktop model, best effort: a missed
  // release lapses by TTL there, and a closing window must not wait on a machine
  // that may be asleep.
  await releaseRemoteStarterLeases();
  await deactivateExternalModelLifecycle();
  setExternalRequestHook(undefined);
  disposeServerChannel();
  await closeBrowserSessionOnShutdown((err) => getLogger().error('browser close failed', err));
  const desktopDriver = getDesktopDriver();
  await desktopDriver.dispose().catch((e) => getLogger().error('desktop dispose', e));
  flushPendingModelUsage();
  await activeRemoteRuntime?.dispose();
  activeRemoteRuntime = undefined;
}
