import * as path from 'path';
import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { UserQuestionService } from './sidebar/UserQuestionService';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { BackendPool } from './backend/BackendPool';
import { disposeServerChannel } from './backend/DirectBackend';
import { ControlServer } from './backend/ControlServer';
import { ControlServerRegistry, controlServerRegistryPath } from './backend/ControlServerRegistry';
import { buildControlChatProxy } from './llm/ControlChatProxy';
import { registerControlServerCommands } from './vscode/controlCommands';
import type { ForgeConfig } from './config/types';
import { loadConfig, findConfigPath } from './config/ConfigLoader';
import { updateConfigFile } from './config/ConfigWriter';
import { initLogger, getLogger } from './util/logger';
import { ToolRegistry } from './tools/ToolRegistry';
import { createCheckpointStack } from './vscode/checkpointSetup';
import { watchForgeConfig } from './vscode/configReload';
import { KeepUndoCodeLensProvider } from './sidebar/KeepUndoCodeLens';
import { DiffDecorations } from './sidebar/DiffDecorations';
import { TemplateEngine } from './llm/TemplateEngine';
import {
  createForgeInstructionsLoader,
  discoverWorkspaceRepositoryRoots,
  ensureForgeInstructionsFile,
} from './llm/ForgeInstructionsLoader';
import { SESSION_KEY_V1 } from './sidebar/sessionTypes';
import { registerAllTools } from './tools/registerAllTools';
import { connectMcpServers } from './tools/mcpBridge';
import { BackendStatusBar } from './vscode/BackendStatusBar';
import { SessionTimeStatusBar } from './vscode/SessionTimeStatusBar';
import { ForgeCodeActionProvider } from './vscode/codeActions';
import { registerNativeCommands } from './vscode/nativeCommands';
import { EmbeddingBackend } from './backend/EmbeddingBackend';
import { IndexManager } from './search/IndexManager';
import { registerSecretCommands } from './vscode/secretCommands';
import { enterSetupMode } from './sidebar/SetupMode';
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
import { RemoteRuntime } from './remote/RemoteRuntime';
import { TelegramChannel, TELEGRAM_BOT_TOKEN_SECRET } from './remote/TelegramChannel';
import { registerRemoteCommands } from './vscode/remoteCommands';

let activeRemoteRuntime: RemoteRuntime | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger(context);
  const log = getLogger();
  log.info('Forge activating');

  const storagePath = context.globalStorageUri.fsPath;
  const statusBar = new BackendStatusBar();
  context.subscriptions.push(statusBar);

  // ── Find or create config ─────────────────────────────────────────────────
  const explicitConfig = vscode.workspace.getConfiguration('forge').get<string>('configFile');
  const configPath = findConfigPath(storagePath, explicitConfig);

  if (!configPath) {
    enterSetupMode(
      context,
      statusBar,
      'Forge: No config found. Run the setup wizard to get started.',
    );
    return;
  }
  const activeConfigPath = configPath;

  let config: ForgeConfig;
  try {
    config = loadConfig(path.dirname(activeConfigPath));
  } catch (err) {
    const msg = (err as Error).message;
    log.error(msg);
    // A broken global fallback config must not brick every workspace. Surface
    // the reason, then drop into setup mode rather than aborting activation.
    // For an explicit/workspace config the user is actively editing, surface a
    // hard error instead so the mistake is not masked.
    const isGlobalFallback = activeConfigPath.startsWith(storagePath);
    if (isGlobalFallback) {
      enterSetupMode(
        context,
        statusBar,
        `Forge: global config failed to load — ${msg}. Run setup or fix ${activeConfigPath}.`,
      );
    } else {
      void vscode.window.showErrorMessage(msg);
    }
    return;
  }

  if (config.log_level) log.setLevel(config.log_level);

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
  const pool = new BackendPool(config);

  // ── Tool registry ─────────────────────────────────────────────────────────
  const embeddingBackend = new EmbeddingBackend(config);
  context.subscriptions.push(embeddingBackend);
  const indexManager = new IndexManager(config, embeddingBackend);
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  // One registry for the whole extension. Sharing it between delegation and
  // the sidebar's CLI chat means a repeat `ask_local_agent` to Claude Code
  // resumes the warm process instead of re-paying its cold start, and that
  // max_cli_agents caps the true number of live CLI processes.
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
  // One owner for agent questions, shared by ask_user and the sidebar facade so
  // a remotely driven turn can answer from the chat that started it.
  const userQuestions = new UserQuestionService();
  terminalCommandTracker.start();
  context.subscriptions.push(terminalCommandTracker);
  registerAllTools(
    toolRegistry,
    context.workspaceState,
    context.secrets,
    config.search,
    indexManager,
    userQuestions,
    delegationService,
    () => config,
  );

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

  // Localhost model-control API for external orchestrators + the Forge command
  // palette. Always instantiated (cheap); the HTTP listener opens only when enabled.
  const registryPath = controlServerRegistryPath();
  const registry = registryPath ? new ControlServerRegistry(registryPath) : undefined;
  const packageVersion = context.extension.packageJSON['version'];
  const controlServer = new ControlServer(pool, config, {
    chatProxy: buildControlChatProxy(() => config, context.secrets),
    ...(registry ? { registry } : {}),
    version: typeof packageVersion === 'string' ? packageVersion : 'unknown',
  });
  if (config.control_server?.enabled) controlServer.start();
  context.subscriptions.push(controlServer);
  registerControlServerCommands(context, controlServer);

  // ── KeepUndo CodeLens + Diff Decorations ─────────────────────────────────
  // Declared before SidebarProvider so the provider can reference its methods
  // Assigned after CodeLens construction; callbacks only run after activation completes.
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

  // ── Migration v2: globalState → workspaceState (sessions now per-workspace) ──
  if (!context.workspaceState.get<boolean>('forge.migrated.sessions.v2')) {
    await context.workspaceState.update('forge.migrated.sessions.v2', true);
    if (!context.workspaceState.get(SESSION_KEY_V1)) {
      const globalSession = context.globalState.get(SESSION_KEY_V1);
      if (globalSession) await context.workspaceState.update(SESSION_KEY_V1, globalSession);
    }
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────
  if (workspaceRoot && config.forge_instructions?.auto_create) {
    const repositoryRoots = await discoverWorkspaceRepositoryRoots(workspaceRoot);
    for (const repositoryRoot of repositoryRoots) {
      const bootstrap = ensureForgeInstructionsFile(repositoryRoot);
      if (bootstrap.status === 'error') {
        const message = `Forge: could not create ${path.basename(bootstrap.path)} in ${repositoryRoot} — ${bootstrap.error.message}`;
        log.warn(message);
        void vscode.window.showWarningMessage(message);
      }
    }
  }
  const forgeLoader = createForgeInstructionsLoader();
  if (forgeLoader) context.subscriptions.push(forgeLoader);

  let refreshSessionTime = (): void => {};
  sidebarProvider = new SidebarProvider(
    context.extensionUri,
    pool,
    config,
    checkpoints,
    toolRegistry,
    indexManager,
    userQuestions,
    context.workspaceState,
    codeLensProvider,
    diffDecorations,
    templateEngine,
    {
      onGenerationStarted: (modelName) => {
        statusBar.setGenerating(modelName);
        refreshSessionTime();
      },
      onGenerationFinished: (modelName) => {
        if (pool.isAnyReady()) statusBar.setReady(modelName);
        else statusBar.setStopped(modelName);
        refreshSessionTime();
      },
      onBackendError: (message) => statusBar.setError(message),
      onBackendReady: (modelName) => statusBar.setReady(modelName),
      onConversationSwitched: (modelName) => {
        if (pool.isAnyReady()) statusBar.setReady(modelName);
        else statusBar.setStopped(modelName);
        refreshSessionTime();
      },
    },
    forgeLoader,
    context.secrets,
    workspaceRoot,
    () => activeConfigPath,
    cliSessions,
  );
  const workspaceId = createHash('sha256')
    .update(workspaceRoot || `no-workspace:${activeConfigPath}`)
    .digest('hex');
  const remoteRuntime = new RemoteRuntime({
    storageDirectory: context.globalStorageUri.fsPath,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    workspaceId,
    host: sidebarProvider.getHostFacade(),
    secrets: context.secrets,
    channelFactories: {
      telegram: async (cursor) => {
        const token = await context.secrets.get(TELEGRAM_BOT_TOKEN_SECRET);
        if (!token) {
          throw new Error(
            'Telegram is enabled but no bot token is stored. Run “Forge: Set Telegram Bot Token”.',
          );
        }
        return new TelegramChannel({
          token,
          ...cursor,
          onError: (message) => void vscode.window.showErrorMessage(message),
        });
      },
      whatsapp: async () => {
        const [{ BaileysWhatsAppChannel }, { WhatsAppAuthStore }] = await Promise.all([
          import('./remote/whatsapp/BaileysWhatsAppChannel'),
          import('./remote/whatsapp/WhatsAppAuthStore'),
        ]);
        return new BaileysWhatsAppChannel({
          authStore: new WhatsAppAuthStore(
            path.join(context.globalStorageUri.fsPath, 'whatsapp-auth-v1.enc.json'),
            context.secrets,
          ),
          onError: (message) => void vscode.window.showErrorMessage(message),
          onPairingCode: (code) =>
            void vscode.window.showInformationMessage(
              `Forge WhatsApp pairing code: ${code}. Enter it in WhatsApp Linked Devices.`,
              { modal: true },
            ),
        });
      },
    },
    notifyLocal: (message) => void vscode.window.showErrorMessage(message),
    setInactivityTimeout: async (minutes) => {
      updateConfigFile(activeConfigPath, (doc) => {
        doc.setIn(['remote', 'auth', 'inactivity_timeout_minutes'], minutes);
      });
      config = loadConfig(path.dirname(activeConfigPath));
      await activeRemoteRuntime?.applyConfig(config);
    },
    reloadWindow: async () => {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
    openWorkspace: async (directory) => {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(directory), false);
    },
  });
  activeRemoteRuntime = remoteRuntime;
  await remoteRuntime.applyConfig(config).catch((err) => {
    void vscode.window.showErrorMessage(`Forge remote failed to start: ${(err as Error).message}`);
  });
  context.subscriptions.push({
    dispose: () => {
      void sidebarProvider.dispose();
    },
  });
  context.subscriptions.push({ dispose: () => void remoteRuntime.dispose() });
  registerRemoteCommands(context, remoteRuntime, () => config, activeConfigPath);
  const sessionTimeBar = new SessionTimeStatusBar(() => sidebarProvider.getActiveSessionMetrics());
  refreshSessionTime = () => sessionTimeBar.refresh();
  context.subscriptions.push(sessionTimeBar);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      indexManager.markDirty(document.uri.fsPath);
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      for (const file of event.files) indexManager.markDirty(file.fsPath);
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const file of event.files) indexManager.removePath(file.fsPath);
    }),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const file of event.files) {
        indexManager.removePath(file.oldUri.fsPath);
        indexManager.markDirty(file.newUri.fsPath);
      }
    }),
  );

  log.info('[Forge] backend will start on first prompt');
  statusBar.setStopped(config.active_model);

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
        ModelManagerPanel.current?.refresh();
        void remoteRuntime.applyConfig(config).catch((err) => {
          void vscode.window.showErrorMessage(
            `Forge remote failed to reload: ${(err as Error).message}`,
          );
        });
      },
    }),
  );

  // ── Commands ──────────────────────────────────────────────────────────────
  registerNativeCommands(context, {
    backend: pool,
    sidebar: sidebarProvider,
    statusBar,
    getConfig: () => config,
    getConfigPath: () => activeConfigPath,
    setConfig: (next) => {
      config = next;
      sidebarProvider.applyForgeConfig(config);
      // pool.applyForgeConfig is called inside sidebarProvider.applyForgeConfig
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

  context.subscriptions.push({
    dispose: () => {
      void pool.stopAll();
    },
  });
  context.subscriptions.push({
    dispose: () => backgroundExecutionManager.dispose(),
  });

  log.info('Forge activated');
}

export async function deactivate(): Promise<void> {
  // backend.stop() called via subscription above.
  disposeServerChannel();
  // Debounced last_used writes would otherwise be lost when the window closes
  // within DEBOUNCE_MS of a turn — the exact case the Model Manager cares about.
  flushPendingModelUsage();
  await activeRemoteRuntime?.dispose();
  activeRemoteRuntime = undefined;
}
