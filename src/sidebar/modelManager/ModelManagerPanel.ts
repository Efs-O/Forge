import * as vscode from 'vscode';
import type { IBackendPool } from '../../backend/BackendPool';
import type { ForgeConfig } from '../../config/types';
import { buildModelManagerHtml } from './panelHtml';
import { buildModelManagerState } from './modelSnapshot';
import { editModelField, purgeModel, purgeOrphanFile, removeModelFromConfig } from './editOps';
import { addScannedModels, scanDirectoryForCandidates } from './scanOps';
import { addGroup, removeGroup, setGroupField } from './groupsOps';
import type { ModelManagerHostToPanel, ModelManagerPanelToHost } from './messages';

/**
 * Singleton editor-area webview panel for the Model Zoo Manager (F7/§2.3).
 * Stateless view: pushes fresh state on open and whenever `refresh()` is
 * called (the caller wires this to the same config.yaml watcher that already
 * feeds `SidebarProvider.applyForgeConfig`). All writes route through
 * `editOps`/`scanOps`/`groupsOps`, which use the comment-preserving
 * ConfigWriter. See docs/OWNERS.md.
 */
export class ModelManagerPanel {
  static current: ModelManagerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    extensionUri: vscode.Uri,
    private readonly pool: IBackendPool,
    private readonly getConfig: () => ForgeConfig,
    private readonly getConfigPath: () => string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'forge.modelManager',
      'Forge: Model Manager',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
      },
    );
    this.panel.webview.html = buildModelManagerHtml(extensionUri, this.panel.webview);
    this.panel.webview.onDidReceiveMessage((raw: unknown) =>
      this.handleMessage(raw as ModelManagerPanelToHost),
    );
    this.panel.onDidDispose(() => {
      if (ModelManagerPanel.current === this) ModelManagerPanel.current = undefined;
    });
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    pool: IBackendPool,
    getConfig: () => ForgeConfig,
    getConfigPath: () => string,
  ): ModelManagerPanel {
    if (ModelManagerPanel.current) {
      ModelManagerPanel.current.panel.reveal();
      return ModelManagerPanel.current;
    }
    const instance = new ModelManagerPanel(extensionUri, pool, getConfig, getConfigPath);
    ModelManagerPanel.current = instance;
    return instance;
  }

  /** Push fresh state — call on open, and whenever config.yaml reloads. */
  refresh(): void {
    void this.pushState();
  }

  private post(msg: ModelManagerHostToPanel): void {
    void this.panel.webview.postMessage(msg);
  }

  private async pushState(): Promise<void> {
    try {
      const state = await buildModelManagerState(this.getConfig(), this.getConfigPath(), (name) =>
        this.pool.isLoaded(name),
      );
      this.post(state);
    } catch (err) {
      this.post({ type: 'error', message: `Forge: ${(err as Error).message}` });
    }
  }

  private reportError(err: unknown, field?: string, modelName?: string): void {
    this.post({
      type: 'error',
      message: `Forge: ${(err as Error).message}`,
      ...(field !== undefined ? { field } : {}),
      ...(modelName !== undefined ? { modelName } : {}),
    });
  }

  private async handleMessage(msg: ModelManagerPanelToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
      case 'refresh':
        void this.pushState();
        return;

      case 'editField':
        try {
          editModelField(this.getConfigPath(), msg.modelName, msg.field, msg.value);
        } catch (err) {
          this.reportError(err, msg.field, msg.modelName);
        }
        return;

      case 'removeModel': {
        const choice = await vscode.window.showWarningMessage(
          `Remove "${msg.modelName}" from config.yaml? This does not delete any files.`,
          { modal: true },
          'Remove',
        );
        if (choice !== 'Remove') return;
        try {
          removeModelFromConfig(this.getConfigPath(), msg.modelName);
        } catch (err) {
          this.reportError(err);
        }
        return;
      }

      case 'purgeModel': {
        if (msg.typedName !== msg.modelName) {
          this.reportError(new Error('typed name does not match — purge cancelled'));
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          `Permanently delete "${msg.modelName}" and its GGUF file(s) from disk? This cannot be undone.`,
          { modal: true },
          'Delete permanently',
        );
        if (choice !== 'Delete permanently') return;
        try {
          purgeModel(this.getConfigPath(), this.getConfig(), msg.modelName, (name) =>
            this.pool.isLoaded(name),
          );
        } catch (err) {
          this.reportError(err);
        }
        return;
      }

      case 'scanDirectory': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          title: 'Forge: scan directory for GGUF models',
        });
        const dir = picked?.[0]?.fsPath;
        if (!dir) return;
        try {
          const candidates = await scanDirectoryForCandidates(this.getConfig(), dir);
          this.post({ type: 'scanResult', candidates });
        } catch (err) {
          this.reportError(err);
        }
        return;
      }

      case 'addScanned':
        try {
          addScannedModels(this.getConfigPath(), this.getConfig(), msg.picks);
        } catch (err) {
          this.reportError(err);
        }
        return;

      case 'loadAndTry':
        try {
          await this.pool.acquire(msg.modelName);
          this.post({ type: 'loadResult', modelName: msg.modelName, ok: true });
        } catch (err) {
          this.post({
            type: 'loadResult',
            modelName: msg.modelName,
            ok: false,
            message: (err as Error).message,
          });
        }
        return;

      case 'revealInExplorer': {
        const model = this.getConfig().models.find((m) => m.name === msg.modelName);
        if (model?.gguf_path) {
          void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(model.gguf_path));
        }
        return;
      }

      case 'setGroupField':
        try {
          setGroupField(this.getConfigPath(), msg.groupName, msg.field, msg.value);
        } catch (err) {
          this.reportError(err);
        }
        return;

      case 'addGroup':
        try {
          addGroup(this.getConfigPath(), msg.groupName);
        } catch (err) {
          this.reportError(err);
        }
        return;

      case 'removeGroup':
        try {
          removeGroup(this.getConfigPath(), msg.groupName);
        } catch (err) {
          this.reportError(err);
        }
        return;

      case 'purgeOrphan': {
        const choice = await vscode.window.showWarningMessage(
          `Permanently delete "${msg.path}"? It is not referenced by any configured model.`,
          { modal: true },
          'Delete permanently',
        );
        if (choice !== 'Delete permanently') return;
        try {
          purgeOrphanFile(msg.path);
          void this.pushState();
        } catch (err) {
          this.reportError(err);
        }
      }
    }
  }
}
