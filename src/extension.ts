import * as path from 'path';
import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { BackendPool } from './backend/BackendPool';
import { ControlServer } from './backend/ControlServer';
import { ControlServerRegistry, controlServerRegistryPath } from './backend/ControlServerRegistry';
import { buildControlChatProxy } from './llm/ControlChatProxy';
import { registerControlServerCommands } from './vscode/controlCommands';
import type { ForgeConfig } from './config/types';
import { loadConfig, findConfigPath, watchForgeConfigPaths } from './config/ConfigLoader';
import { expandAlias, splitModelProfile } from './config/ConfigResolver';
import { initLogger, getLogger } from './util/logger';
import { ToolRegistry } from './tools/ToolRegistry';
import { CheckpointStack } from './checkpoint/CheckpointStack';
import { KeepUndoCodeLensProvider } from './sidebar/KeepUndoCodeLens';
import { DiffDecorations } from './sidebar/DiffDecorations';
import { TemplateEngine } from './llm/TemplateEngine';
import { createForgeInstructionsLoader } from './llm/ForgeInstructionsLoader';
import { SESSION_KEY_V1 } from './sidebar/sessionTypes';
import { registerAllTools } from './tools/registerAllTools';
import { connectMcpServers } from './tools/mcpBridge';
import { BackendStatusBar } from './vscode/BackendStatusBar';
import { ForgeCodeActionProvider } from './vscode/codeActions';
import { registerNativeCommands } from './vscode/nativeCommands';
import { EmbeddingBackend } from './backend/EmbeddingBackend';
import { IndexManager } from './search/IndexManager';
import { registerSecretCommands } from './vscode/secretCommands';
import { enterSetupMode } from './sidebar/SetupMode';
import { LocalDelegationService } from './delegation/LocalDelegationService';
import { registerWorkerCommands } from './vscode/workerCommands';
import { ModelManagerPanel } from './sidebar/modelManager/ModelManagerPanel';

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
  const delegationService = new LocalDelegationService({
    getConfig: () => config,
    backendPool: pool,
    workspaceRoot,
  });
  const toolRegistry = new ToolRegistry();
  registerAllTools(
    toolRegistry,
    context.workspaceState,
    context.secrets,
    config.search,
    indexManager,
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

  // ── Checkpoint stack ──────────────────────────────────────────────────────
  const checkpointConfig = vscode.workspace.getConfiguration('forge.checkpoint');
  const externalCliRollbackEnabled = checkpointConfig.get<boolean>('externalCliEnabled');
  const checkpointMaxBytes = checkpointConfig.get<number>('maxBytes');
  const checkpointMaxFiles = checkpointConfig.get<number>('maxFiles');
  const checkpointStorageSetting = checkpointConfig.get<string>('storagePath');
  if (
    typeof externalCliRollbackEnabled !== 'boolean' ||
    !Number.isSafeInteger(checkpointMaxBytes) ||
    checkpointMaxBytes === undefined ||
    checkpointMaxBytes < 1 ||
    !Number.isSafeInteger(checkpointMaxFiles) ||
    checkpointMaxFiles === undefined ||
    checkpointMaxFiles < 1 ||
    checkpointStorageSetting === undefined
  ) {
    throw new Error('Forge checkpoint settings are invalid. Review forge.checkpoint.* settings.');
  }
  const checkpointStorageRoot = checkpointStorageSetting.trim()
    ? path.resolve(checkpointStorageSetting.trim())
    : path.join(context.globalStorageUri.fsPath, 'checkpoints');
  if (checkpointStorageSetting.trim() && !path.isAbsolute(checkpointStorageSetting.trim())) {
    throw new Error('forge.checkpoint.storagePath must be an absolute path when configured.');
  }
  const checkpoints = new CheckpointStack({
    storageRoot: checkpointStorageRoot,
    limits: { maxBytes: checkpointMaxBytes, maxFiles: checkpointMaxFiles },
    externalCliRollbackEnabled,
  });

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
  const forgeLoader = createForgeInstructionsLoader();
  if (forgeLoader) context.subscriptions.push(forgeLoader);

  sidebarProvider = new SidebarProvider(
    context.extensionUri,
    pool,
    config,
    checkpoints,
    toolRegistry,
    indexManager,
    context.workspaceState,
    codeLensProvider,
    diffDecorations,
    templateEngine,
    {
      onGenerationStarted: (modelName) => statusBar.setGenerating(modelName),
      onGenerationFinished: (modelName) => {
        if (pool.isAnyReady()) statusBar.setReady(modelName);
        else statusBar.setStopped(modelName);
      },
      onBackendError: (message) => statusBar.setError(message),
      onBackendReady: (modelName) => statusBar.setReady(modelName),
      onConversationSwitched: (modelName) => {
        if (pool.isAnyReady()) statusBar.setReady(modelName);
        else statusBar.setStopped(modelName);
      },
    },
    forgeLoader,
    context.secrets,
    workspaceRoot,
    () => activeConfigPath,
  );
  context.subscriptions.push({
    dispose: () => {
      void sidebarProvider.dispose();
    },
  });
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

  // ── Config hot-reload ────────────────────────────────────────────────────
  context.subscriptions.push(
    watchForgeConfigPaths(activeConfigPath, [], (newConfig, err) => {
      if (err) {
        void vscode.window.showErrorMessage(`Forge: config reload failed — ${err.message}`);
        return;
      }
      if (!newConfig) return;

      const prevActive = config.active_model;
      // Preserve the previous selection (incl. any @profile) across reloads if
      // its base model still exists in the new config (F6).
      const prevBase = prevActive
        ? splitModelProfile(expandAlias(newConfig, prevActive)).base
        : null;
      if (prevActive && prevBase && newConfig.models.some((m) => m.name === prevBase)) {
        newConfig.active_model = prevActive;
      }

      config = newConfig;
      if (config.log_level) log.setLevel(config.log_level);

      const newUserDirs = config.templates_dir ? [config.templates_dir] : [];
      templateEngine?.reload(newUserDirs);

      sidebarProvider.applyForgeConfig(config);
      // pool.applyForgeConfig is called inside sidebarProvider.applyForgeConfig
      controlServer.applyForgeConfig(config);
      if (config.control_server?.enabled) controlServer.start();
      statusBar.setStopped(config.active_model);
      ModelManagerPanel.current?.refresh();

      log.info('Forge: config reloaded');
      void vscode.window.showInformationMessage(
        'Forge: configuration reloaded (restart backend if you changed llama-server spawn settings)',
      );
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
  registerWorkerCommands(context, sidebarProvider, () => config);
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new ForgeCodeActionProvider(),
      { providedCodeActionKinds: ForgeCodeActionProvider.providedCodeActionKinds },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('forge.openSidebar', () => {
      void vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
    }),

    vscode.commands.registerCommand('forge.modelManager', () => {
      const panel = ModelManagerPanel.createOrShow(
        context.extensionUri,
        pool,
        () => config,
        () => activeConfigPath,
      );
      panel.refresh();
    }),

    vscode.commands.registerCommand('forge.showBackendConsole', () => {
      pool.showConsole();
    }),

    vscode.commands.registerCommand('forge.undo', async () => {
      try {
        const restored = await sidebarProvider.undo();
        void vscode.window.showInformationMessage(
          `Forge: undid last turn, restored ${restored.length} file(s)`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('forge.keep', async () => {
      try {
        await sidebarProvider.keep();
        void vscode.window.showInformationMessage('Forge: changes kept');
      } catch (err) {
        void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('forge.newChat', () => {
      sidebarProvider.newConversation();
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      void pool.stopAll();
    },
  });

  log.info('Forge activated');
}

export function deactivate(): void {
  // backend.stop() called via subscription above
}
