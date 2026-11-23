import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { IBackendPool } from '../backend/BackendPool';
import type { ControlStats } from '../backend/controlStats';
import { createMonitorPollers, type MonitorPollers } from './monitorPollers';
import { buildMonitorHtml } from './monitorHtml';
import type { MonitorHostToPanel, MonitorPanelToHost } from './monitorTypes';
import type { GpuInfo } from '../system/systemProbes';

export interface MonitorPanelOptions {
  extensionUri: vscode.Uri;
  pool: IBackendPool;
  getConfig: () => ForgeConfig;
  getStats: () => ControlStats;
  getSecret: (name: string) => Promise<string | undefined>;
  probeGpus?: (signal: AbortSignal) => Promise<GpuInfo[]>;
}

export class MonitorPanel implements vscode.Disposable {
  static current: MonitorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly pollers: MonitorPollers;
  private disposed = false;

  private constructor(options: MonitorPanelOptions) {
    this.panel = vscode.window.createWebviewPanel(
      'forge.monitor',
      'Forge: Monitor',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, 'dist', 'webview')],
      },
    );
    this.panel.webview.html = buildMonitorHtml(options.extensionUri, this.panel.webview);
    this.pollers = createMonitorPollers({
      ...options,
      post: (snapshot) => this.post({ type: 'monitorSnapshot', snapshot }),
    });
    this.panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = raw as MonitorPanelToHost;
      if (message.type === 'ready' && this.panel.visible) this.pollers.start();
    });
    this.panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.visible) this.pollers.start();
      else this.pollers.stop();
    });
    this.panel.onDidDispose(() => this.dispose());
  }

  static createOrShow(
    context: vscode.ExtensionContext,
    options: MonitorPanelOptions,
  ): MonitorPanel {
    if (MonitorPanel.current) {
      MonitorPanel.current.panel.reveal();
      return MonitorPanel.current;
    }
    const instance = new MonitorPanel(options);
    MonitorPanel.current = instance;
    context.subscriptions.push(instance);
    return instance;
  }

  private post(message: MonitorHostToPanel): void {
    void this.panel.webview.postMessage(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pollers.dispose();
    if (MonitorPanel.current === this) MonitorPanel.current = undefined;
    this.panel.dispose();
  }
}
