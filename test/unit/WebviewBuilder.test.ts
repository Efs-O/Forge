import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { webviewResourceRoots } from '../../src/sidebar/WebviewBuilder';
import { SCREENSHOT_DIR } from '../../src/tools/browser/browserTools';

describe('webviewResourceRoots', () => {
  it('includes the browser and desktop screenshot directory', () => {
    const roots = webviewResourceRoots(vscode.Uri.file('C:/forge-extension'), undefined);
    expect(roots.map((root) => root.fsPath)).toContain(SCREENSHOT_DIR);
  });
});
