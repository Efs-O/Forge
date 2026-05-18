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
import { TemplateEngine } from './llm/TemplateEngine';
import { runFirstRunWizard } from './sidebar/FirstRunWizard';
import { SESSION_KEY_V1 } from './sidebar/sessionTypes';
import { registerAllTools } from './tools/registerAllTools';
import { BackendStatusBar } from './vscode/BackendStatusBar';
import { ForgeCodeActionProvider } from './vscode/codeActions';
import { registerNativeCommands } from './vscode/nativeCommands';

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
    void vscode.window.showInformationMessage(
      'Forge: No config found. Run the setup wizard to get started.',
      'Setup',
    ).then((choice) => {
      if (choice === 'Setup') void vscode.commands.executeCommand('forge.setupWizard');
    });
    return;
  }
  const activeConfigPath = configPath;

  let config: ForgeConfig;
  try {
    config = loadConfig(path.dirname(activeConfigPath));
  } catch (err) {
    const msg = (err as Error).message;
    log.error(msg);
    void vscode.window.showErrorMessage(msg);
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
  const toolRegistry = new ToolRegistry();
  registerAllTools(toolRegistry, context.workspaceState, context.secrets, config.search);

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

  // ── KeepUndo CodeLens (v0.6) ──────────────────────────────────────────────
  // Declared before SidebarProvider so the provider can reference its methods
  let sidebarProvider: SidebarProvider;

  const codeLensProvider = new KeepUndoCodeLensProvider(
    () => { sidebarProvider.keep(); },
    () => { sidebarProvider.undo(); },
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider),
    codeLensProvider,
  );

  // ── One-time migration: workspaceState → globalState (history now global) ──
  if (!context.globalState.get<boolean>('forge.migrated.sessions.v1')) {
    void context.globalState.update('forge.migrated.sessions.v1', true);
    // Try seed file written by external migration tool (old efs-o.forge-llm data)
    const seedPath = path.join(context.globalStorageUri.fsPath, 'sessions.seed.json');
    if (fs.existsSync(seedPath)) {
      try {
        const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        void context.globalState.update(SESSION_KEY_V1, seed);
        fs.unlinkSync(seedPath);
      } catch { /* ignore corrupt seed */ }
    } else if (!context.globalState.get(SESSION_KEY_V1)) {
      const wsSession = context.workspaceState.get(SESSION_KEY_V1);
      if (wsSession) void context.globalState.update(SESSION_KEY_V1, wsSession);
    }
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────
  sidebarProvider = new SidebarProvider(
    context.extensionUri,
    pool,
    config,
    checkpoints,
    toolRegistry,
    context.globalState,
    codeLensProvider,
    templateEngine,
    {
      onGenerationStarted: (modelName) => statusBar.setGenerating(modelName),
      onGenerationFinished: (modelName) => {
        if (pool.isAnyReady()) statusBar.setReady(modelName);
        else statusBar.setStopped(modelName);
      },
      onBackendError: (message) => statusBar.setError(message),
      onBackendReady: (modelName) => statusBar.setReady(modelName),
    },
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
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
      if (!config.search) {
        void vscode.window.showErrorMessage(
          'Forge: search not configured. Add a "search:" block to config.yaml first.',
        );
        return;
      }
      const key = await vscode.window.showInputBox({
        prompt: `Enter your ${config.search.provider} API key`,
        password: true,
        placeHolder: `Paste ${config.search.provider} API key here`,
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store(config.search.secret_key_name, key);
        void vscode.window.showInformationMessage(`Forge: ${config.search.provider} API key saved.`);
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
