import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRunBuildTool } from '../../src/tools/execTools';

describe('run_build cwd', () => {
  let root: string;

  beforeEach(() => {
    // Workspace root with no package.json, project one level down — the shape
    // that made run_build/run_tests fail with a bare ENOENT for a path the
    // model never chose.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-run-build-'));
    fs.mkdirSync(path.join(root, 'game'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'game', 'package.json'),
      JSON.stringify({ name: 'game', scripts: { build: 'echo built' } }),
      'utf8',
    );
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('names the directory it looked in, and how to redirect it', async () => {
    await expect(makeRunBuildTool().handler({})).rejects.toThrow(/no package.json in .*Pass cwd/s);
  });

  it('finds a script in the sub-project when cwd is given', async () => {
    // Reaching "script not found" proves package.json was located and parsed
    // in the sub-project, without this test having to actually run npm.
    await expect(makeRunBuildTool().handler({ cwd: 'game', script: 'nope' })).rejects.toThrow(
      'script "nope" not found',
    );
  });
});
