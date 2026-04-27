import * as path from 'path';
import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { DirectBackend } from './backend/DirectBackend';
import { BridgeBackend } from './backend/BridgeBackend';
import { loadConfig, findConfigPath, watchConfig } from './config/ConfigLoader';
import { initLogger, getLogger } from './util/logger';
import { ToolRegistry } from './tools/ToolRegistry';
import { CheckpointStack } from './checkpoint/CheckpointStack';
import { KeepUndoCodeLensProvider } from './sidebar/KeepUndoCodeLens';
import { TemplateEngine } from './llm/TemplateEngine';
import { runFirstRunWizard } from './sidebar/FirstRunWizard';
import { registerAllTools } from './tools/registerAllTools';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger(context);
  const log = getLogger();
  log.info('Forge activating');

  const storagePath = context.globalStorageUri.fsPath;

  // ── Find or create config ─────────────────────────────────────────────────
  let configPath = findConfigPath(storagePath);

  if (!configPath) {
    const wizardDone = await runFirstRunWizard(context);
    if (!wizardDone) {
      const msg = 'Forge: No config.yaml found. Create .forge/config.yaml in your workspace.';
      log.error(msg);
      void vscode.window.showErrorMessage(msg, 'Retry').then((choice) => {
        if (choice === 'Retry') void vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
    }
    return; // wizard asks user to reload; let activate re-run
  }

  let config;
  try {
    config = loadConfig(path.dirname(configPath));
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

  // ── Backend ───────────────────────────────────────────────────────────────
  const backend = config.bridge_mode
    ? new BridgeBackend({
        baseUrl: `http://${config.llama_server.host ?? '127.0.0.1'}:${config.llama_server.port ?? 8080}`,
      })
    : new DirectBackend(config);

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

  // ── Sidebar ───────────────────────────────────────────────────────────────
  sidebarProvider = new SidebarProvider(
    context.extensionUri,
    backend,
    config,
    checkpoints,
    toolRegistry,
    context.workspaceState,
    codeLensProvider,
    templateEngine,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  backend.start().catch((err: Error) => {
    log.error(`Backend start failed: ${err.message}`);
    void vscode.window.showErrorMessage(`Forge: ${err.message}`);
  });

  // ── Config hot-reload (v0.8) ──────────────────────────────────────────────
  context.subscriptions.push(
    watchConfig(configPath, (newConfig, err) => {
      if (err) {
        void vscode.window.showErrorMessage(`Forge: config reload failed — ${err.message}`);
      } else if (newConfig) {
        const newUserDirs = newConfig.templates_dir ? [newConfig.templates_dir] : [];
        templateEngine?.reload(newUserDirs);
        log.info('Forge: config reloaded');
        void vscode.window.showInformationMessage(
          'Forge: config reloaded (restart backend to apply model changes)',
        );
      }
    }),
  );

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('forge.openSidebar', () => {
      void vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
    }),

    vscode.commands.registerCommand('forge.restartBackend', async () => {
      try {
        await backend.start();
        void vscode.window.showInformationMessage('Forge: backend restarted');
      } catch (err) {
        void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
      }
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
      sidebarProvider.newChat();
    }),

    // v0.2 — send active editor selection to sidebar input
    vscode.commands.registerCommand('forge.sendSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showWarningMessage('Forge: no text selected');
        return;
      }
      const text = editor.document.getText(editor.selection);
      sidebarProvider.sendSelectionContent(text);
    }),

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

    // v0.3 — first-run / setup wizard (manual trigger)
    vscode.commands.registerCommand('forge.setupWizard', async () => {
      await runFirstRunWizard(context);
    }),
  );

  context.subscriptions.push({
    dispose: () => { void backend.stop(); },
  });

  log.info('Forge activated');
}

export function deactivate(): void {
  // backend.stop() called via subscription above
}
