import * as path from 'path';
import * as vscode from 'vscode';

export const SETUP_WITH_AGENT_COMMAND = 'forge.setupWithAgent';

/** The prompt the user pastes into Claude Code or Codex. It names absolute
 *  paths so the agent never has to guess where the extension or the config
 *  lives; AI_SETUP.md carries everything else. */
export function agentSetupPrompt(
  extensionPath: string,
  globalConfigPath: string,
  workspaceConfigPath: string | undefined,
): string {
  const workspaceLine = workspaceConfigPath
    ? `workspace config: ${workspaceConfigPath}`
    : 'workspace config: none (no folder is open in VS Code)';
  return [
    'Set up the Forge LLM VS Code extension on this machine.',
    `Follow the instructions in ${path.join(extensionPath, 'AI_SETUP.md')} step by step.`,
    `The extension is installed at ${extensionPath}.`,
    `Forge reads its config from one of: global config: ${globalConfigPath}; ${workspaceLine}.`,
    'Ask me before each optional step, and tell me whenever I need to do something in VS Code.',
  ].join('\n');
}

/** Registered before config bootstrap: the command matters most when there is
 *  no config yet, which is exactly when the rest of activation never runs. */
export function registerAgentSetupCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(SETUP_WITH_AGENT_COMMAND, async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const prompt = agentSetupPrompt(
        context.extensionPath,
        path.join(context.globalStorageUri.fsPath, 'config.yaml'),
        workspace ? path.join(workspace, '.forge', 'config.yaml') : undefined,
      );
      await vscode.env.clipboard.writeText(prompt);
      const choice = await vscode.window.showInformationMessage(
        'Forge: setup prompt copied. Paste it into Claude Code or Codex in a terminal on this machine.',
        'Show Instructions',
      );
      if (choice === 'Show Instructions') {
        const doc = vscode.Uri.file(path.join(context.extensionPath, 'AI_SETUP.md'));
        await vscode.commands.executeCommand('markdown.showPreview', doc);
      }
    }),
  );
}
