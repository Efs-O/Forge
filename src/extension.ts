import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { BackendPool } from './backend/BackendPool';
import { SingleBackendPool } from './backend/SingleBackendPool';
import { BridgeBackend } from './backend/BridgeBackend';
import type { ForgeConfig } from './config/types';
import { resolveBridgeConfigPath } from './config/BridgeConfigLoader';
import { loadConfig, findConfigPath, watchForgeConfigPaths } from './config/ConfigLoader';
import { initLogger, getLogger } from './util/logger';
import { ToolRegistry } from './tools/ToolRegistry';
import { CheckpointStack } from './checkpoint/CheckpointStack';
import { KeepUndoCodeLensProvider } from './sidebar/KeepUndoCodeLens';
import { DiffDecorations } from './sidebar/DiffDecorations';
import { TemplateEngine } from './llm/TemplateEngine';
import { createForgeInstructionsLoader } from './llm/ForgeInstructionsLoader';
import { runFirstRunWizard } from './sidebar/FirstRunWizard';
import { SESSION_KEY_V1 } from './sidebar/sessionTypes';
import { registerAllTools } from './tools/registerAllTools';
import { BackendStatusBar } from './vscode/BackendStatusBar';
import { ForgeCodeActionProvider } from './vscode/codeActions';
import { registerNativeCommands } from './vscode/nativeCommands';
import { EmbeddingBackend } from './backend/EmbeddingBackend';
import { IndexManager } from './search/IndexManager';

class SetupPlaceholderProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = `<!DOCTYPE html><html><body style="padding:20px;font-family:sans-serif;">
      <p style="margin-bottom:12px;">No <code>config.yaml</code> found.</p>
      <button onclick="acquireVsCodeApi().postMessage({type:'wizard'})"
        style="padding:8px 16px;cursor:pointer;">Run Setup Wizard</button>
      <script>const vscode = acquireVsCodeApi();</script>
    </body></html>`;
    view.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'wizard') {
        void vscode.commands.executeCommand('forge.setupWizard');
      }
    });
  }
}

/**
 * Drop the extension into setup mode: a placeholder sidebar with a "Run Setup
 * Wizard" button plus an actionable notification. Used both when no config
 * exists and when the global fallback config fails to load — the latter must
 * not abort activation, or one stale global config bricks every workspace.
 */
function enterSetupMode(
  context: vscode.ExtensionContext,
  statusBar: BackendStatusBar,
  message: string,
): void {
  statusBar.setNoConfig();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewId,
      new SetupPlaceholderProvider(),
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.setupWizard', async () => {
      const done = await runFirstRunWizard(context);
      if (done) void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
  );
  // Don't auto-launch the wizard — the window may not be focused yet (e.g.
  // freshly opened by --install-extension), which causes showQuickPick to
  // return undefined immediately. Show a notification instead; the sidebar
  // placeholder also has a "Run Setup Wizard" button.
  void vscode.window.showInformationMessage(message, 'Setup').then((choice) => {
    if (choice === 'Setup') void vscode.commands.executeCommand('forge.setupWizard');
  });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger(context);
  const log = getLogger();
  log.info('Forge activating');

  const storagePath = context.globalStorageUri.fsPath;
  const statusBar = new BackendStatusBar();
  context.subscriptions.push(statusBar);

  // ── Find or create config ─────────────────────────────────────────────────
  const explicitConfig = vscode.workspace.getConfiguration('forge').get<string>('configFile');
  let configPath = findConfigPath(storagePath, explicitConfig);

  if (!configPath) {
    enterSetupMode(context, statusBar, 'Forge: No config found. Run the setup wizard to get started.');
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

  // ── Tool registry ─────────────────────────────────────────────────────────
  const embeddingBackend = new EmbeddingBackend(config);
  context.subscriptions.push(embeddingBackend);
  const indexManager = new IndexManager(config, embeddingBackend);
  const toolRegistry = new ToolRegistry();
  registerAllTools(toolRegistry, context.workspaceState, context.secrets, config.search, indexManager);

  // ── Checkpoint stack ──────────────────────────────────────────────────────
  const checkpoints = new CheckpointStack();

  // ── Backend pool ──────────────────────────────────────────────────────────
  const pool = config.bridge_mode
    ? new SingleBackendPool(
        new BridgeBackend({
          baseUrl: `http://${config.llama_server.host ?? '127.0.0.1'}:${config.llama_server.port ?? 8080}`,
        }, config),
      )
    : new BackendPool(config);

  // ── KeepUndo CodeLens + Diff Decorations ─────────────────────────────────
  // Declared before SidebarProvider so the provider can reference its methods
  let sidebarProvider: SidebarProvider;

  const diffDecorations = new DiffDecorations();
  context.subscriptions.push(diffDecorations);

  const codeLensProvider = new KeepUndoCodeLensProvider(
    () => { sidebarProvider.keep(); },
    () => { sidebarProvider.undo(); },
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
  );
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

  const bridgeWatchPaths: string[] = config.bridge_config
    ? [resolveBridgeConfigPath(activeConfigPath, config.bridge_config)]
    : [];

  // ── Config hot-reload (v0.8+ bridge.yaml watch) ───────────────────────────
  context.subscriptions.push(
    watchForgeConfigPaths(activeConfigPath, bridgeWatchPaths, (newConfig, err) => {
      if (err) {
        void vscode.window.showErrorMessage(`Forge: config reload failed — ${err.message}`);
        return;
      }
      if (!newConfig) return;

      const prevActive = config.active_model;
      if (prevActive && newConfig.models.some((m) => m.name === prevActive)) {
        newConfig.active_model = prevActive;
      }

      config = newConfig;
      if (config.log_level) log.setLevel(config.log_level);

      const newUserDirs = config.templates_dir ? [config.templates_dir] : [];
      templateEngine?.reload(newUserDirs);

      sidebarProvider.applyForgeConfig(config);
      // pool.applyForgeConfig is called inside sidebarProvider.applyForgeConfig
      statusBar.setStopped(config.active_model);

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

    vscode.commands.registerCommand('forge.showBackendConsole', () => {
      pool.showConsole();
    }),

    vscode.commands.registerCommand('forge.undo', () => {
      try {
        const restored = sidebarProvider.undo();
        void vscode.window.showInformationMessage(
          `Forge: undid last turn, restored ${restored.length} file(s)`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('forge.keep', () => {
      try {
        sidebarProvider.keep();
        void vscode.window.showInformationMessage('Forge: changes kept');
      } catch (err) {
        void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('forge.newChat', () => {
      sidebarProvider.newConversation();
    }),

    // v0.2 — send active editor selection to sidebar input
    vscode.commands.registerCommand('forge.setSearchApiKey', async () => {
      // If search is already configured, use existing provider/key name.
      // If not, ask the user to pick a provider and write the block to config.yaml.
      let provider: string;
      let secretKeyName: string;

      if (config.search) {
        provider = config.search.provider;
        secretKeyName = config.search.secret_key_name;
      } else {
        const pick = await vscode.window.showQuickPick(
          [
            { label: 'Tavily', description: 'tavily.com — recommended', value: 'tavily' },
            { label: 'Brave Search', description: 'brave.com/search/api', value: 'brave' },
          ],
          { title: 'Forge: Select Search Provider', placeHolder: 'Which search provider do you want to use?' },
        );
        if (!pick) return;
        provider = pick.value;
        secretKeyName = `forge.${provider}.apiKey`;

        // Append search block to config.yaml
        if (configPath) {
          try {
            const existing = fs.readFileSync(configPath, 'utf8');
            const block = `\nsearch:\n  provider: ${provider}\n  secret_key_name: ${secretKeyName}\n  max_results: 5\n`;
            if (!/^search:/m.test(existing)) {
              fs.appendFileSync(configPath, block, 'utf8');
              void vscode.window.showInformationMessage(`Forge: search block added to config.yaml. Reload window to activate.`);
            }
          } catch {
            void vscode.window.showWarningMessage('Forge: could not update config.yaml — add the search: block manually.');
          }
        }
      }

      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${provider} API key`,
        password: true,
        placeHolder: `Paste ${provider} API key here`,
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store(secretKeyName, key);
        void vscode.window.showInformationMessage(`Forge: ${provider} API key saved.`);
      }
    }),

  );

  context.subscriptions.push({
    dispose: () => { void pool.stopAll(); },
  });

  log.info('Forge activated');
}

export function deactivate(): void {
  // backend.stop() called via subscription above
}
