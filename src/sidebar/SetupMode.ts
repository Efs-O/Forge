import * as vscode from 'vscode';
import type { BackendStatusBar } from '../vscode/BackendStatusBar';
import { runFirstRunWizard } from './FirstRunWizard';
import { SidebarProvider } from './SidebarProvider';

class SetupPlaceholderProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = `<!DOCTYPE html><html><body style="padding:20px;font-family:sans-serif;">
      <p style="margin-bottom:12px;">No <code>config.yaml</code> found.</p>
      <button onclick="acquireVsCodeApi().postMessage({type:'wizard'})"
        style="padding:8px 16px;cursor:pointer;">Run Setup Wizard</button>
      <script>const vscode = acquireVsCodeApi();</script>
    </body></html>`;
    view.webview.onDidReceiveMessage((message) => {
      if (message.type === 'wizard') void vscode.commands.executeCommand('forge.setupWizard');
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
  void vscode.window.showInformationMessage(message, 'Setup').then((choice) => {
    if (choice === 'Setup') void vscode.commands.executeCommand('forge.setupWizard');
  });
}
