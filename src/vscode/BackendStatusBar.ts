import * as vscode from 'vscode';

export type BackendStatus = 'noConfig' | 'stopped' | 'starting' | 'ready' | 'generating' | 'error';

export class BackendStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private lastError = '';

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'Forge';
    this.setStopped(null);
    this.item.show();
  }

  setNoConfig(): void {
    this.update('noConfig', null);
  }

  setStopped(modelName?: string | null): void {
    this.update('stopped', modelName ?? null);
  }

  setStarting(modelName?: string | null): void {
    this.update('starting', modelName ?? null);
  }

  setReady(modelName?: string | null): void {
    this.update('ready', modelName ?? null);
  }

  setGenerating(modelName?: string | null): void {
    this.update('generating', modelName ?? null);
  }

  setError(message: string): void {
    this.lastError = message;
    this.update('error', null);
  }

  dispose(): void {
    this.item.dispose();
  }

  private update(status: BackendStatus, modelName: string | null): void {
    this.item.backgroundColor = undefined;
    switch (status) {
      case 'noConfig':
        this.item.text = '$(tools) Forge: setup';
        this.item.tooltip = 'Forge config is missing. Run the setup wizard.';
        this.item.command = 'forge.setupWizard';
        break;
      case 'stopped':
        this.item.text = '$(circle-slash) Forge: stopped';
        this.item.tooltip = modelName
          ? `Forge backend stopped. Active model: ${modelName}`
          : 'Forge backend stopped.';
        this.item.command = 'forge.startBackend';
        break;
      case 'starting':
        this.item.text = '$(sync~spin) Forge: starting';
        this.item.tooltip = modelName
          ? `Starting Forge backend for ${modelName}.`
          : 'Starting Forge backend.';
        this.item.command = 'forge.showBackendConsole';
        break;
      case 'ready':
        this.item.text = `$(check) Forge: ${modelName ?? 'ready'}`;
        this.item.tooltip = modelName
          ? `Forge backend ready: ${modelName}`
          : 'Forge backend ready.';
        this.item.command = 'forge.openSidebar';
        break;
      case 'generating':
        this.item.text = '$(pulse) Forge: generating';
        this.item.tooltip = modelName
          ? `Forge is generating with ${modelName}.`
          : 'Forge is generating.';
        this.item.command = 'forge.openSidebar';
        break;
      case 'error':
        this.item.text = '$(error) Forge: error';
        this.item.tooltip = this.lastError || 'Forge backend error.';
        this.item.command = 'forge.showBackendConsole';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  }
}
