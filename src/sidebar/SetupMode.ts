import * as vscode from 'vscode';
import type { BackendStatusBar } from '../vscode/BackendStatusBar';
import { runFirstRunWizard } from './FirstRunWizard';
import { SidebarProvider } from './SidebarProvider';
import { SETUP_WITH_AGENT_COMMAND } from '../vscode/agentSetupCommand';

class SetupPlaceholderProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = `<!DOCTYPE html><html><body style="padding:20px;font-family:sans-serif;">
      <p style="margin-bottom:12px;">No <code>config.yaml</code> found.</p>
      <button onclick="acquireVsCodeApi().postMessage({type:'wizard'})"
        style="padding:8px 16px;cursor:pointer;">Run Setup Wizard</button>
      <p style="margin:12px 0;">Or let Claude Code / Codex set everything up:</p>
      <button onclick="acquireVsCodeApi().postMessage({type:'agent'})"
        style="padding:8px 16px;cursor:pointer;">Copy AI Setup Prompt</button>
      <script>const vscode = acquireVsCodeApi();</script>
    </body></html>`;
    view.webview.onDidReceiveMessage((message) => {
      if (message.type === 'wizard') void vscode.commands.executeCommand('forge.setupWizard');
      if (message.type === 'agent') void vscode.commands.executeCommand(SETUP_WITH_AGENT_COMMAND);
    });
  }
}

export function enterSetupMode(
  context: vscode.ExtensionContext,
  statusBar: BackendStatusBar,
  message: string,
): void {
  statusBar.setNoConfig();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewId,
      new SetupPlaceholderProvider(),
    ),
    vscode.commands.registerCommand('forge.setupWizard', async () => {
      const done = await runFirstRunWizard(context);
      if (done) void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
  );
  void vscode.window.showInformationMessage(message, 'Setup', 'Set Up With AI').then((choice) => {
    if (choice === 'Setup') void vscode.commands.executeCommand('forge.setupWizard');
    if (choice === 'Set Up With AI') void vscode.commands.executeCommand(SETUP_WITH_AGENT_COMMAND);
  });
}
