import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { IBackendPool } from '../backend/BackendPool';
import type { ControlStats } from '../backend/controlStats';
import { createMonitorPollers, type MonitorPollers } from './monitorPollers';
import { buildMonitorHtml } from './monitorHtml';
import type { MonitorHostToPanel, MonitorPanelToHost } from './monitorTypes';

export interface MonitorPanelOptions {
  extensionUri: vscode.Uri;
  pool: IBackendPool;
  getConfig: () => ForgeConfig;
  getStats: () => ControlStats;
  getSecret: (name: string) => Promise<string | undefined>;
}

export class MonitorPanel implements vscode.Disposable {
  static current: MonitorPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly pollers: MonitorPollers;
  private disposed = false;

  private constructor(options: MonitorPanelOptions, background: boolean) {
    this.panel = vscode.window.createWebviewPanel(
      'forge.monitor',
      'Forge: Monitor',
      // An auto-opened panel must not steal the keyboard from the editor, so it
      // opens in the background; an opened-by-hand panel takes focus as before.
      background
        ? { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }
        : vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, 'dist', 'webview')],
      },
    );
    this.panel.webview.html = buildMonitorHtml(options.extensionUri, this.panel.webview);
    this.pollers = createMonitorPollers({
      ...options,
      post: (metrics) => this.post({ type: 'monitorMetrics', metrics }),
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
    show?: { background?: boolean },
  ): MonitorPanel {
    if (MonitorPanel.current) {
      // A background open never brings an existing panel forward: the owner may
      // have moved it away or hidden it on purpose.
      if (!show?.background) MonitorPanel.current.panel.reveal();
      return MonitorPanel.current;
    }
    const instance = new MonitorPanel(options, show?.background === true);
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
