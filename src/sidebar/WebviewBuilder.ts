import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { screenshotRoot } from '../tools/browser/screenshotPaths';
import { getNonce } from '../util/webviewNonce';

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
/** Everything the sidebar webview may load from disk. */
export function webviewResourceRoots(
  extensionUri: vscode.Uri,
  attachmentsRoot: string | undefined,
): vscode.Uri[] {
  return [
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
    vscode.Uri.joinPath(extensionUri, 'assets'),
    // Without this the transcript's thumbnails are silently blocked: a webview
    // URI outside every root does not load and reports nothing.
    ...(attachmentsRoot ? [vscode.Uri.file(attachmentsRoot)] : []),
    vscode.Uri.file(screenshotRoot()),
    // generate_image thumbnails load straight from where the image was saved.
    ...(vscode.workspace.workspaceFolders?.[0] ? [vscode.workspace.workspaceFolders[0].uri] : []),
  ];
}
