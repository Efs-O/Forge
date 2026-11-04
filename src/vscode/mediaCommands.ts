import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { checkMediaSetup } from '../media/mediaSetupCheck';

export const CHECK_MEDIA_SETUP_COMMAND = 'forge.checkMediaSetup';

/** Register the read-only media setup report. */
export function registerMediaSetupCommand(
  context: vscode.ExtensionContext,
  getConfig: () => ForgeConfig,
  getConfigPath: () => string,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CHECK_MEDIA_SETUP_COMMAND, async () => {
      const workspaceRoot =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.dirname(getConfigPath());
      const config = getConfig();
      const stillBackendNames =
        config.image_generation?.backends
          .filter((backend) => backend.provider === 'sdcpp')
          .map((backend) => backend.name) ?? [];
      const report = checkMediaSetup(config.media, workspaceRoot, { stillBackendNames });
      await vscode.window.showInformationMessage(report.text);
    }),
  );
}
