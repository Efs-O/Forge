import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunBuildTool } from '../../src/tools/execTools';
import { backgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';

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

  it('starts a long script in the background instead of racing the timeout', async () => {
    // The whole point: `npm run package` takes ~3 min here, so a foreground
    // run_build could never finish it. Background returns an execution_id at
    // once, and monitor_execution takes it from there.
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'slow', scripts: { package: 'node -e "setTimeout(()=>{},400)"' } }),
      'utf8',
    );
    const output = await makeRunBuildTool().handler({ script: 'package', background: true });
    expect(output).toMatch(/execution_id/u);

    // Windows keeps the cwd locked while the child lives, so the temp-dir
    // teardown fails unless the run is allowed to finish first.
    const id = /"execution_id":"([^"]+)"/u.exec(output)![1]!;
    await backgroundExecutionManager.observe(id, 5_000, 0, 0);
  });

  it('names background as the way out when a foreground run times out', async () => {
    // The audited failure: `run_build {script: "package"}` answered
    // "process timed out after 120000ms" and nothing else, so the retry that
    // works had to be guessed. A refusal that cannot name its alternative
    // teaches the agent the capability does not exist.
    vi.useFakeTimers();
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'slow', scripts: { package: 'node -e "setTimeout(()=>{},600000)"' } }),
      'utf8',
    );
    const pending = makeRunBuildTool().handler({ script: 'package' });
    const assertion = expect(pending).rejects.toThrow(/background: true[\s\S]*monitor_execution/u);
    await vi.advanceTimersByTimeAsync(120_001);
    await assertion;
    vi.useRealTimers();
  });

  it('finds a script in the sub-project when cwd is given', async () => {
    // Reaching "script not found" proves package.json was located and parsed
    // in the sub-project, without this test having to actually run npm.
    await expect(makeRunBuildTool().handler({ cwd: 'game', script: 'nope' })).rejects.toThrow(
      'script "nope" not found',
    );
  });
});
