import * as vscode from 'vscode';

/** The shared command both Telegram and the agent bus use to reload this window. */
export async function executeWindowReloadCommand(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}
