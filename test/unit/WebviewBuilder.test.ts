import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { webviewResourceRoots } from '../../src/sidebar/WebviewBuilder';
import { screenshotRoot } from '../../src/tools/browser/screenshotPaths';

const SAVED = process.env.FORGE_SCREENSHOT_DIR;
let root: string | undefined;

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
  if (SAVED === undefined) delete process.env.FORGE_SCREENSHOT_DIR;
  else process.env.FORGE_SCREENSHOT_DIR = SAVED;
});

describe('webviewResourceRoots', () => {
  it('allows the packaged Forge icon directory outside the workspace', () => {
    const extension = vscode.Uri.file('C:/forge-extension');
    const roots = webviewResourceRoots(extension, undefined);
    expect(roots.map((root) => root.fsPath)).toContain(
      vscode.Uri.joinPath(extension, 'assets').fsPath,
    );
  });

  it('includes the browser and desktop screenshot directory', () => {
    delete process.env.FORGE_SCREENSHOT_DIR;
    const roots = webviewResourceRoots(vscode.Uri.file('C:/forge-extension'), undefined);
    expect(roots.map((root) => root.fsPath)).toContain(screenshotRoot());
    expect(screenshotRoot()).toBe(path.join(os.homedir(), '.forge', 'screenshots'));
  });

  it('follows the same override the writer honours, so thumbnails are not blocked', () => {
    // The webview may only load images from a root it is given. If the webview
    // read one screenshot path and `saveScreenshot` read another, a capture
    // would render as a broken thumbnail and report nothing — so both must come
    // from `screenshotPaths.ts`, and this is the assertion that says so.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-webview-shots-'));
    process.env.FORGE_SCREENSHOT_DIR = root;
    const roots = webviewResourceRoots(vscode.Uri.file('C:/forge-extension'), undefined);
    expect(roots.map((root) => root.fsPath)).toContain(root);
  });
});
