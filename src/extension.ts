import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar/SidebarProvider';
import { DirectBackend } from './backend/DirectBackend';
import { BridgeBackend } from './backend/BridgeBackend';
import { loadConfig } from './config/ConfigLoader';
import { initLogger, getLogger } from './util/logger';
import { ToolRegistry } from './tools/ToolRegistry';
import { CheckpointStack } from './checkpoint/CheckpointStack';
import {
  makeReadFileTool,
  makeWriteFileTool,
  makeReplaceSelectionTool,
  makeInsertCodeTool,
} from './tools/builtinTools';
import { makeWebSearchTool } from './tools/searchTool';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger(context);
  const log = getLogger();
  log.info('Forge activating');

  const storagePath = context.globalStorageUri.fsPath;
  let config;
  try {
    config = loadConfig(storagePath);
  } catch (err) {
    const msg = (err as Error).message;
    log.error(msg);
    void vscode.window.showErrorMessage(msg);
    return;
  }

  if (config.log_level) {
    log.setLevel(config.log_level);
  }

  // ── Tool registry ─────────────────────────────────────────────────────────
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(makeReadFileTool());
  toolRegistry.register(makeWriteFileTool());
  toolRegistry.register(makeReplaceSelectionTool());
  toolRegistry.register(makeInsertCodeTool());

  if (config.search) {
    toolRegistry.register(makeWebSearchTool(context.secrets, config.search));
  }

  // ── Checkpoint stack ──────────────────────────────────────────────────────
  const checkpoints = new CheckpointStack();

  // ── Backend ───────────────────────────────────────────────────────────────
  const backend = config.bridge_mode
    ? new BridgeBackend({
        baseUrl: `http://${config.llama_server.host ?? '127.0.0.1'}:${config.llama_server.port ?? 8080}`,
      })
    : new DirectBackend(config);

  // ── Sidebar ───────────────────────────────────────────────────────────────
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    backend,
    config,
    checkpoints,
    toolRegistry,
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

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
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

    vscode.commands.registerCommand('forge.setSearchApiKey', async () => {
      if (!config.search) {
        void vscode.window.showErrorMessage(
          'Forge: search is not configured in config.yaml. Add a "search:" block first.',
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
        void vscode.window.showInformationMessage(
          `Forge: ${config.search.provider} API key saved.`,
        );
      }
    }),
  );

  context.subscriptions.push({
    dispose: () => { void backend.stop(); },
  });

  log.info('Forge activated');
}

export function deactivate(): void {
  // backend.stop() is called via the subscription added in activate().
}
