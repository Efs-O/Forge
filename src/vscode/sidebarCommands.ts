import * as vscode from 'vscode';
import type { IBackendPool } from '../backend/BackendPool';
import type { ForgeConfig } from '../config/types';
import type { SidebarProvider } from '../sidebar/SidebarProvider';
import { ModelManagerPanel } from '../sidebar/modelManager/ModelManagerPanel';
import { MonitorPanel, type MonitorPanelOptions } from '../monitor/MonitorPanel';
import { setModelServerReadyListener } from '../backend/modelServerReady';
import type { ControlStats } from '../backend/controlStats';

export interface SidebarCommandDeps {
  pool: IBackendPool;
  sidebar: SidebarProvider;
  getConfig: () => ForgeConfig;
  getConfigPath: () => string;
  getStats: () => ControlStats;
  getSecret: (name: string) => Promise<string | undefined>;
}

/** Report `run()`'s outcome to the user either way — a failed Keep/Undo that
 *  only reached the log would leave the user believing their files changed. */
async function reportOutcome(run: () => Promise<string>): Promise<void> {
  try {
    void vscode.window.showInformationMessage(await run());
  } catch (err) {
    void vscode.window.showErrorMessage(`Forge: ${(err as Error).message}`);
  }
}

/**
 * The sidebar-facing commands: revealing the view, the Model Manager panel,
 * the backend console, and the per-turn Keep/Undo pair. Split out of
 * `extension.ts` so activation stays a wiring file. See docs/OWNERS.md.
 */
export function registerSidebarCommands(
  context: vscode.ExtensionContext,
  deps: SidebarCommandDeps,
): void {
  const monitorOptions = (): MonitorPanelOptions => ({
    extensionUri: context.extensionUri,
    pool: deps.pool,
    getConfig: deps.getConfig,
    getStats: deps.getStats,
    getSecret: deps.getSecret,
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('forge.openSidebar', () => {
      void vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
    }),

    vscode.commands.registerCommand('forge.modelManager', () => {
      const panel = ModelManagerPanel.createOrShow(
        context.extensionUri,
        deps.pool,
        deps.getConfig,
        deps.getConfigPath,
      );
      panel.refresh();
    }),

    vscode.commands.registerCommand('forge.openMonitor', () => {
      MonitorPanel.createOrShow(context, monitorOptions());
    }),

    vscode.commands.registerCommand('forge.showBackendConsole', () => {
      deps.pool.showConsole();
    }),

    vscode.commands.registerCommand('forge.undo', () =>
      reportOutcome(async () => {
        const restored = await deps.sidebar.undo();
        return `Forge: undid last turn, restored ${restored.length} file(s)`;
      }),
    ),

    vscode.commands.registerCommand('forge.keep', () =>
      reportOutcome(async () => {
        await deps.sidebar.keep();
        return 'Forge: changes kept';
      }),
    ),

    vscode.commands.registerCommand('forge.newChat', () => {
      deps.sidebar.newConversation();
    }),
  );

  // The Monitor shows itself once per window, the first time this window brings
  // a model server up — the owner should see the panel exactly when there is
  // something to read on it. Closing it is an answer, so it never comes back.
  let autoOpened = false;
  setModelServerReadyListener(() => {
    if (autoOpened || deps.getConfig().monitor?.auto_open === false) return;
    autoOpened = true;
    MonitorPanel.createOrShow(context, monitorOptions(), { background: true });
  });
  context.subscriptions.push({ dispose: () => setModelServerReadyListener(undefined) });
}
