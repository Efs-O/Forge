import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { UserQuestionService } from './sidebar/UserQuestionService';
import { UserNotificationService } from './sidebar/UserNotificationService';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { ChatAttachmentStore } from './sidebar/ChatAttachmentStore';
import { HistoryArchive } from './sidebar/HistoryArchive';
import { watchWorkspaceFolders } from './sidebar/workspaceInfo';
import { BackendPool } from './backend/BackendPool';
import { ExternalModelServers, setExternalRequestHook } from './backend/ExternalModelServers';
import { SharedRuntimeRegistry } from './backend/SharedRuntimeRegistry';
import { disposeServerChannel } from './backend/DirectBackend';
import { ControlServer } from './backend/ControlServer';
import { ControlServerRegistry, controlServerRegistryPath } from './backend/ControlServerRegistry';
import { buildControlChatProxy } from './llm/ControlChatProxy';
import { registerControlServerCommands } from './vscode/controlCommands';
import { setupAgentMessaging } from './vscode/agentMessagingSetup';
import { registerAgentSetupCommand } from './vscode/agentSetupCommand';
import { bootstrapConfig } from './vscode/configBootstrap';
import { setupRemoteRuntime } from './vscode/remoteRuntimeSetup';
import { bootstrapWorkspace } from './vscode/workspaceBootstrap';
import { registerIndexWatchers } from './vscode/indexWatchers';
import type { ForgeConfig } from './config/types';
import { initLogger, getLogger } from './util/logger';
import { ToolRegistry } from './tools/ToolRegistry';
import { createCheckpointStack } from './vscode/checkpointSetup';
import { watchForgeConfig } from './vscode/configReload';
import { KeepUndoCodeLensProvider } from './sidebar/KeepUndoCodeLens';
import { DiffDecorations } from './sidebar/DiffDecorations';
import { TemplateEngine } from './llm/TemplateEngine';
import { createForgeInstructionsLoader } from './llm/ForgeInstructionsLoader';
import { registerAllTools } from './tools/registerAllTools';
import { closeBrowserSessionOnShutdown } from './tools/browser/BrowserSessionManager';
import { getDesktopDriver } from './tools/desktop/PowerShellDesktopDriver';
import { connectMcpServers } from './tools/mcpBridge';
import { BackendStatusBar } from './vscode/BackendStatusBar';
import { SessionTimeStatusBar } from './vscode/SessionTimeStatusBar';
import { ForgeCodeActionProvider } from './vscode/codeActions';
import { registerNativeCommands } from './vscode/nativeCommands';
import { EmbeddingBackend } from './backend/EmbeddingBackend';
import { ServerLogFollowers } from './backend/serverLogFollower';
import { IndexManager } from './search/IndexManager';
import { registerSecretCommands } from './vscode/secretCommands';
import { LocalDelegationService } from './delegation/LocalDelegationService';
import {
  CliSessionRegistry,
  DEFAULT_CLI_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_CLI_AGENTS,
} from './agents/CliSessionRegistry';
import { ModelManagerPanel } from './sidebar/modelManager/ModelManagerPanel';
import { registerSidebarCommands } from './vscode/sidebarCommands';
import { flushPendingModelUsage } from './sidebar/modelManager/usageTracker';
import { backgroundExecutionManager } from './tools/BackgroundExecutionManager';
import { terminalCommandTracker } from './tools/TerminalCommandTracker';
import type { RemoteRuntime } from './remote/RemoteRuntime';
import { workspaceIdFor } from './remote/RemoteWorkspaceHandoff';
import { setupJobs } from './vscode/jobsSetup';
import { JobStore } from './jobs/JobStore';

let activeRemoteRuntime: RemoteRuntime | undefined;
const EXTERNAL_LIFECYCLE_LEASE_KEY = 'external-model-stop-on-exit';

interface ActiveExternalLifecycle {
  pool: BackendPool;
  servers: ExternalModelServers;
  registry: SharedRuntimeRegistry;
  leaseId: string;
  isBusy: (modelName: string) => boolean;
}

let activeExternalLifecycle: ActiveExternalLifecycle | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger(context);
  const log = getLogger();
  log.info('Forge activating');

  const storagePath = context.globalStorageUri.fsPath;
  const statusBar = new BackendStatusBar();
  context.subscriptions.push(statusBar);

  registerAgentSetupCommand(context);

  // ── Find or create config ─────────────────────────────────────────────────
  const bootstrapped = bootstrapConfig(context, statusBar, storagePath);
  if (!bootstrapped) return;
  const activeConfigPath = bootstrapped.configPath;
  let config: ForgeConfig = bootstrapped.config;

  // ── Template engine (v0.8) ────────────────────────────────────────────────
  const builtinDir = path.join(context.extensionPath, 'config', 'templates', 'builtin');
  const userDirs = config.templates_dir ? [config.templates_dir] : [];
  let templateEngine: TemplateEngine | undefined;
  try {
    templateEngine = new TemplateEngine(builtinDir, userDirs);
  } catch (err) {
    log.warn(`[TemplateEngine] init failed, using hardcoded prompts: ${(err as Error).message}`);
  }

  // ── Backend pool ──────────────────────────────────────────────────────────
  // Created before the tool registry so LocalDelegationService can be injected.
  const externalServers = new ExternalModelServers(
    () => config,
    async (key) => context.secrets.get(key),
  );
  // Reuse the shared-runtime lease registry for cross-window liveness. Its
  // existing PID cleanup means a crashed extension host cannot block shutdown.
  const sharedRegistry = new SharedRuntimeRegistry();
  const externalLifecycleLeaseId = randomUUID();
  sharedRegistry.acquireLease(EXTERNAL_LIFECYCLE_LEASE_KEY, externalLifecycleLeaseId);
  const pool = new BackendPool(config, sharedRegistry, externalServers);
  setExternalRequestHook((model) => pool.prepareExternal(model.name));

  // ── Tool registry ─────────────────────────────────────────────────────────
  const embeddingBackend = new EmbeddingBackend(config);
  context.subscriptions.push(embeddingBackend);
  const indexManager = new IndexManager(config, embeddingBackend);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  // One registry for the whole extension: delegation and the sidebar's CLI chat
  // share it, so a repeat `ask_local_agent` resumes the warm process.
  const cliSessions = new CliSessionRegistry(
    config.max_cli_agents ?? DEFAULT_MAX_CLI_AGENTS,
    config.cli_idle_timeout_ms ?? DEFAULT_CLI_IDLE_TIMEOUT_MS,
  );
  const delegationService = new LocalDelegationService({
    getConfig: () => config,
    backendPool: pool,
    workspaceRoot,
    cliSessions,
    secrets: context.secrets,
  });
  const toolRegistry = new ToolRegistry();
  // One job store, shared by the scheduler and the `manage_jobs` tool.
  const jobsStore = new JobStore();
  const jobsHostFacade = (): import('./sidebar/ForgeHostFacade').ForgeHostFacade | undefined =>
    sidebarProvider.getHostFacade();
  // One owner for agent questions, shared by ask_user and the sidebar facade so
  // a remotely driven turn can answer from the chat that started it.
  const userQuestions = new UserQuestionService();
  // One owner for agent-authored notifications, shared by notify_user and the
  // sidebar facade so a remotely driven turn reaches the chat that started it.
  const userNotifications = new UserNotificationService(
    (message) => void vscode.window.showWarningMessage(message),
  );
  terminalCommandTracker.start();
  context.subscriptions.push(terminalCommandTracker);
  const chatAttachments = new ChatAttachmentStore(
    path.join(context.globalStorageUri.fsPath, 'chat-attachments'),
  );
  const sdServers = registerAllTools(
    toolRegistry,
    context.workspaceState,
    context.secrets,
    config.search,
    indexManager,
    userQuestions,
    userNotifications,
    delegationService,
    () => config,
    () => pool.backendProcesses(),
    (relativePath) => chatAttachments.resolve(relativePath),
    { store: jobsStore, hostFacade: jobsHostFacade, configPath: activeConfigPath },
    (key) => sidebarProvider.forgetMemoryKey(key),
  );
  // The sd-server children built for `generate_image`. Teardown on deactivate,
  // and reconciliation on a config reload that removes or edits an sdcpp
  // backend -- `applyForgeConfig` below. Same lifecycle EmbeddingBackend has.
  if (sdServers) context.subscriptions.push(sdServers);

  // External MCP stdio servers (e.g. halluscribe-mcp). Bridged as a
  // non-blocking background task: ToolRegistry.definitions() is re-read every
  // agent turn (see AgentLoop.ts), so a slow or missing server binary never
  // delays activation — its tools simply appear on a later turn once
  // connected, and connectMcpServers never throws out of this call.
  if (config.mcp_servers?.length) {
    void connectMcpServers(config.mcp_servers, toolRegistry, log)
      .then((disposable) => context.subscriptions.push(disposable))
      .catch((err) => log.error('MCP bridge failed unexpectedly', err));
  }

  const checkpoints = createCheckpointStack(context);

  // Localhost control API (models, chat proxy, agent messages); listens only when enabled.
  const registryPath = controlServerRegistryPath();
  const registry = registryPath ? new ControlServerRegistry(registryPath) : undefined;
  const packageVersion = context.extension.packageJSON['version'];
  const controlServer = new ControlServer(pool, config, {
    agentRoutes: setupAgentMessaging(
      context,
      () => sidebarProvider,
      () => config,
      workspaceRoot,
    ),
    chatProxy: buildControlChatProxy(() => config, context.secrets),
    ...(registry ? { registry } : {}),
    version: typeof packageVersion === 'string' ? packageVersion : 'unknown',
  });
  if (config.control_server?.enabled) controlServer.start();
  context.subscriptions.push(controlServer);
  registerControlServerCommands(context, controlServer);

  // ── KeepUndo CodeLens + Diff Decorations ─────────────────────────────────
  // Declared early (closures above use it); assigned after CodeLens construction.
  // eslint-disable-next-line prefer-const
  let sidebarProvider: SidebarProvider;

  const diffDecorations = new DiffDecorations();
  context.subscriptions.push(diffDecorations);

  const codeLensProvider = new KeepUndoCodeLensProvider(
    () => {
      void sidebarProvider.keep();
    },
    () => {
      void sidebarProvider.undo();
    },
    diffDecorations,
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    codeLensProvider,
  );

  // ── Workspace bootstrap: session migration (v2) + FORGE.md auto-create ──
  await bootstrapWorkspace(context, workspaceRoot, config.forge_instructions?.auto_create);

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
    {
      onGenerationStarted: (modelName, conversationId) => {
        if (modelName && conversationId) activeTurnModels.set(conversationId, modelName);
        statusBar.setGenerating(modelName);
        // Turn START, not end: a cancelled or thrown turn never reaches its end,
        // and a leaked counter would silently mute the agent from then on.
        // Unconditional, including the no-conversation key: a conversation-less
        // turn still charges that bucket (notify_user from a /compact summary,
        // send_file with no chat bound), so guarding this call on a defined id
        // would let that budget fill once and never drain again.
        userNotifications.resetTurn(conversationId);
        // The bar follows the chat that just started, so a chat run in the
        // background (`forge.sh --new`) is the one it shows.
        if (conversationId !== undefined) followSessionTime(conversationId);
        refreshSessionTime();
      },
      onGenerationFinished: (modelName, conversationId) => {
        if (conversationId) activeTurnModels.delete(conversationId);
        if (pool.isAnyReady()) statusBar.setReady(modelName);
        else statusBar.setStopped(modelName);
        refreshSessionTime();
      },
      onBackendError: (message) => statusBar.setError(message),
      onBackendReady: (modelName) => statusBar.setReady(modelName),
      onConversationSwitched: (modelName) => {
        if (pool.isAnyReady()) statusBar.setReady(modelName);
        else statusBar.setStopped(modelName);
        // Picking a chat is the user saying which one they want to see.
        followSessionTime(undefined);
        refreshSessionTime();
      },
    },
    forgeLoader,
    context.secrets,
    workspaceRoot,
    () => activeConfigPath,
    cliSessions,
    chatAttachments,
    HistoryArchive.inStorageDir(context.storageUri?.fsPath, workspaceRoot),
  );
  activeExternalLifecycle = {
    pool,
    servers: externalServers,
    registry: sharedRegistry,
    leaseId: externalLifecycleLeaseId,
    isBusy: (modelName) => [...activeTurnModels.values()].includes(modelName),
  };
  // Best-effort, after the session is loaded: an attachment whose conversation
  // is gone is unreachable, and nothing else ever deletes it.
  void chatAttachments.prune(sidebarProvider.liveConversationIds());
  const workspaceId = workspaceRoot
    ? workspaceIdFor(workspaceRoot)
    : createHash('sha256').update(`no-workspace:${activeConfigPath}`).digest('hex');
  // Persistent agent jobs (B1). Runs in whichever window wins the
  // `jobs-scheduler` lease; a no-op when `jobs.enabled` is false.
  const jobsSetup = setupJobs(context, () => config, workspaceId, sidebarProvider, jobsStore, pool);
  const remoteRuntime = await setupRemoteRuntime(context, {
    workspaceRoot,
    workspaceId,
    configPath: activeConfigPath,
    getConfig: () => config,
    setConfig: (next) => {
      config = next;
    },
    sidebarProvider,
    jobStore: jobsStore,
  });
  activeRemoteRuntime = remoteRuntime;
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
        statusBar.setStopped(config.active_model);
        serverLogs.apply(config);
        sdServers?.applyForgeConfig(config);
        ModelManagerPanel.current?.refresh();
        // A reload can disable jobs (delete the recurring wake task) or change
        // a schedule (re-register it). Reconcile either way.
        jobsSetup?.onConfigReloaded();
        void remoteRuntime.applyConfig(config).catch((err) => {
          void vscode.window.showErrorMessage(
            `Forge remote failed to reload: ${(err as Error).message}`,
          );
        });
      },
    }),
  );

  registerNativeCommands(context, {
    backend: pool,
    sidebar: sidebarProvider,
    statusBar,
    getConfig: () => config,
    getConfigPath: () => activeConfigPath,
    setConfig: (next) => {
      config = next;
      sidebarProvider.applyForgeConfig(config);
      statusBar.setStopped(config.active_model);
    },
  });
  registerSecretCommands(context, () => config, activeConfigPath);
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new ForgeCodeActionProvider(),
      { providedCodeActionKinds: ForgeCodeActionProvider.providedCodeActionKinds },
    ),
  );

  registerSidebarCommands(context, {
    pool,
    sidebar: sidebarProvider,
    getConfig: () => config,
    getConfigPath: () => activeConfigPath,
  });

  context.subscriptions.push(
    {
      dispose: () =>
        sharedRegistry.releaseLease(EXTERNAL_LIFECYCLE_LEASE_KEY, externalLifecycleLeaseId),
    },
    { dispose: () => backgroundExecutionManager.dispose() },
  );

  log.info('Forge activated');
}

export async function deactivate(): Promise<void> {
  const lifecycle = activeExternalLifecycle;
  activeExternalLifecycle = undefined;
  if (lifecycle) {
    lifecycle.registry.releaseLease(EXTERNAL_LIFECYCLE_LEASE_KEY, lifecycle.leaseId);
    const lastWindow = !lifecycle.registry.hasBorrowers(EXTERNAL_LIFECYCLE_LEASE_KEY);
    await lifecycle.servers.stopOnExit({
      lastWindow,
      isBusy: lifecycle.isBusy,
      leaseDir: lifecycle.registry.leaseDir(EXTERNAL_LIFECYCLE_LEASE_KEY),
    });
    await lifecycle.pool
      .stopAll()
      .catch((error) => getLogger().error('[BackendPool] deactivate stop failed', error));
  }
  setExternalRequestHook(undefined);
  disposeServerChannel();
  await closeBrowserSessionOnShutdown((err) => getLogger().error('browser close failed', err));
  const desktopDriver = getDesktopDriver();
  await desktopDriver.dispose().catch((e) => getLogger().error('desktop dispose', e));
  flushPendingModelUsage();
  await activeRemoteRuntime?.dispose();
  activeRemoteRuntime = undefined;
}
