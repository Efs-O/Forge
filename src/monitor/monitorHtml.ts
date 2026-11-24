import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce } from '../util/webviewNonce';

/** The vendored Strata page folder, copied to `dist/webview/` by esbuild.config.mjs. */
const VENDOR_DIR = ['dist', 'webview', 'strata-monitor'] as const;

/**
 * The Monitor panel's HTML: Strata's Monitor markup (with its icon sprite inlined,
 * because a `<use href>` pointing at another origin does not resolve in a webview)
 * plus the vendored script and stylesheet, addressed as webview URIs.
 *
 * CSP keeps `script-src` to the nonce alone; `style-src` also needs `'unsafe-inline'`
 * because the copied markup carries `style="width:0%"` starting states for the bars,
 * and the fonts come from the vendored folder.
 */
export function buildMonitorHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const vendor = path.join(extensionUri.fsPath, ...VENDOR_DIR);
  const uri = (file: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...VENDOR_DIR, file)).toString();
  const spritePath = path.join(vendor, 'sprite.svg');
  const sprite = fs.existsSync(spritePath) ? fs.readFileSync(spritePath, 'utf8') : '';
  const nonce = getNonce();
  const template = path.join(path.dirname(vendor), 'monitor.html');
  if (fs.existsSync(template))
    return fs
      .readFileSync(template, 'utf8')
      .replace(/\$\{cspSource\}/g, webview.cspSource)
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{themeKind\}/g, currentThemeKind())
      .replace(/\$\{sprite\}/g, sprite)
      .replace(/\$\{jsUri\}/g, uri('monitor.js'))
      .replace(/\$\{cssUri\}/g, uri('monitor.css'));
  return `<!DOCTYPE html><html lang="en" data-theme="${currentThemeKind()}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Forge: Monitor</title><link rel="stylesheet" href="${uri('monitor.css')}"></head><body><div class="monitor"></div><script nonce="${nonce}" src="${uri('monitor.js')}"></script></body></html>`;
}

/** Strata's design tokens key off `<html data-theme="light|dark">`; VS Code's theme
 *  kind decides which one this panel asks for. */
function currentThemeKind(): string {
  const kind = (vscode.window as unknown as { activeColorTheme?: { kind?: number } })
    .activeColorTheme?.kind;
  return kind === vscode.ColorThemeKind.Light ? 'light' : 'dark';
}
