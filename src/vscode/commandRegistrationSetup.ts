import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import type { BackendPool } from '../backend/BackendPool';
import type { SidebarProvider } from '../sidebar/SidebarProvider';
import type { BackendStatusBar } from './BackendStatusBar';
import type { ControlServer } from '../backend/ControlServer';
import { ForgeCodeActionProvider } from './codeActions';
import { registerNativeCommands } from './nativeCommands';
import { registerMediaSetupCommand } from './mediaCommands';
import { registerSecretCommands } from './secretCommands';
import { registerSidebarCommands } from './sidebarCommands';

export interface CommandRegistrationOptions {
  backend: BackendPool;
  sidebar: SidebarProvider;
  statusBar: BackendStatusBar;
  configPath: string;
  getConfig: () => ForgeConfig;
  setConfig: (next: ForgeConfig) => void;
  controlServer: ControlServer;
}

/** Register the contributed commands and file code actions after the sidebar exists. */
export function registerActivationCommands(
  context: vscode.ExtensionContext,
  options: CommandRegistrationOptions,
): void {
  registerNativeCommands(context, {
    backend: options.backend,
    sidebar: options.sidebar,
    statusBar: options.statusBar,
    getConfig: options.getConfig,
    getConfigPath: () => options.configPath,
    setConfig: (next) => {
      options.setConfig(next);
      options.sidebar.applyForgeConfig(next);
      options.statusBar.setStopped(next.active_model);
    },
  });
  registerSecretCommands(context, options.getConfig, options.configPath);
  registerMediaSetupCommand(context, options.getConfig, () => options.configPath);
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new ForgeCodeActionProvider(),
      { providedCodeActionKinds: ForgeCodeActionProvider.providedCodeActionKinds },
    ),
  );
  registerSidebarCommands(context, {
    pool: options.backend,
    sidebar: options.sidebar,
    getConfig: options.getConfig,
    getConfigPath: () => options.configPath,
    getStats: () => options.controlServer.buildStats(),
    getSecret: async (name) => await context.secrets.get(name),
  });
}
