import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce } from '../util/webviewNonce';

export function buildMonitorHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const distDir = path.join(extensionUri.fsPath, 'dist', 'webview');
  const jsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'monitor.js'),
  );
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'monitor.css'),
  );
  const nonce = getNonce();
  const template = path.join(distDir, 'monitor.html');
  if (fs.existsSync(template))
    return fs
      .readFileSync(template, 'utf8')
      .replace(/\$\{cspSource\}/g, webview.cspSource)
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{jsUri\}/g, jsUri.toString())
      .replace(/\$\{cssUri\}/g, cssUri.toString());
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Forge: Monitor</title><link rel="stylesheet" href="${cssUri}"></head><body><div id="app"></div><script nonce="${nonce}" src="${jsUri}"></script></body></html>`;
}
