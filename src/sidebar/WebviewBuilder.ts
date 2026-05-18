import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function buildWebviewHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const distDir = path.join(extensionUri.fsPath, 'dist', 'webview');
  const jsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js'),
  );
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles.css'),
  );
  const nonce = getNonce();

  const templatePath = path.join(distDir, 'index.html');
  if (fs.existsSync(templatePath)) {
    return fs
      .readFileSync(templatePath, 'utf8')
      .replace(/\$\{cspSource\}/g, webview.cspSource)
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{jsUri\}/g, jsUri.toString())
      .replace(/\$\{cssUri\}/g, cssUri.toString());
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}
