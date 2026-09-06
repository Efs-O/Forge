import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  makeExecCommandTool,
  makeRunBuildTool,
  makeRunTerminalTool,
  makeRunTestsTool,
} from '../../src/tools/execTools';
import { makeWebFetchTool } from '../../src/tools/fetchTool';
import {
  makeGitBlameTool,
  makeGitDiffTool,
  makeGitLogTool,
  makeGitShowTool,
  makeGitStatusTool,
} from '../../src/tools/gitReadTools';
import {
  makeCommitTool,
  makeCreateBranchTool,
  makeStageTool,
  makeSwitchBranchTool,
} from '../../src/tools/gitTools';
import { makeWebSearchTool } from '../../src/tools/searchTool';

describe('isolated process, Git, and web tool execution', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-process-tools-'));
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('executes headless commands and project scripts in the temporary workspace', async () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        scripts: {
          test: 'node -e "console.log(\'fixture tests passed\')"',
          build: 'node -e "console.log(\'fixture build passed\')"',
        },
      }),
      'utf8',
    );
    await expect(
      makeExecCommandTool().handler({
        command: process.execPath,
        args: ['-e', "process.stdout.write('fixture command')"],
        cwd: '.',
        timeout_ms: 10_000,
      }),
    ).resolves.toContain('fixture command');
    await expect(makeRunTestsTool().handler({})).resolves.toContain('fixture tests passed');
    await expect(makeRunBuildTool().handler({ script: 'build' })).resolves.toContain(
      'fixture build passed',
    );
    await expect(
      makeExecCommandTool().handler({ command: process.execPath, args: ['&&', 'bad'] }),
    ).rejects.toThrow('Shell operator');
  }, 15_000);

  it('pastes terminal commands without executing them', async () => {
    const sendText = vi.fn();
    const show = vi.fn();
    vi.spyOn(vscode.window, 'createTerminal').mockReturnValue({ sendText, show } as never);
    await expect(
      makeRunTerminalTool().handler({ command: 'echo fixture', cwd: '.' }),
    ).resolves.toBe('Command pasted to terminal — press Enter to run.');
    expect(show).toHaveBeenCalledWith(false);
    expect(sendText).toHaveBeenCalledWith('echo fixture', false);
  });

  it('executes every Git handler through CLI discovery, with no Git extension present', async () => {
    // The VS Code Git extension is deliberately absent here. Every tool below
    // used to need it: `git_log`, `create_branch` and `switch_branch` went
    // through its wrapper methods, and repository discovery went through its
    // repository list, so all three failed outright in a window where the
    // extension was unavailable while `git_status` beside them worked.
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue(undefined as never);

    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'forge@test.invalid'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'fixture\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture commit\n\nbody line'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed\n', 'utf8');

    await expect(makeGitStatusTool().handler({})).resolves.toBe('M tracked.txt');

    const log = String(await makeGitLogTool().handler({ max_entries: 1 }));
    // First line of the raw body, not git's normalised subject.
    expect(log).toContain('fixture commit (Forge Test, ');
    expect(log).not.toContain('body line');

    await expect(makeGitDiffTool().handler({ staged: false })).resolves.toContain('-fixture');
    await expect(makeGitBlameTool().handler({ path: 'tracked.txt' })).resolves.toContain(
      'author Not Committed Yet',
    );
    await expect(makeGitShowTool().handler({ ref: 'HEAD' })).resolves.toContain('fixture');

    await expect(makeCreateBranchTool().handler({ name: 'feature', from: 'HEAD' })).resolves.toBe(
      'Branch created: feature',
    );
    expect(currentBranch(root)).toBe('feature');
    await expect(makeSwitchBranchTool().handler({ name: 'main' })).resolves.toBe('Switched to main');
    expect(currentBranch(root)).toBe('main');

    // Acceptance #9: the refusal must name the tool that fixes it, not just
    // state the rule -- see docs/plans/TOOL_ERROR_PROMPT_PLAN.md.
    await expect(makeCommitTool().handler({ message: 'empty' })).rejects.toThrow(
      /nothing is staged\. Call stage with the paths to commit first, or git_status/u,
    );
    await expect(makeStageTool().handler({ paths: ['tracked.txt'] })).resolves.toContain(
      'tracked.txt',
    );
    await expect(makeGitStatusTool().handler({})).resolves.toBe('M tracked.txt [staged]');
    await expect(makeCommitTool().handler({ message: 'next' })).resolves.toBe('Committed: next');
  }, 15_000);

  it('never restores a file that shares the requested branch name', async () => {
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue(undefined as never);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'forge@test.invalid'], { cwd: root });
    // A tracked file whose name is also the branch name. `git checkout main`
    // with no `--` restores this file from the index and stays on the current
    // branch -- silently discarding edits instead of switching.
    fs.writeFileSync(path.join(root, 'main'), 'committed\n', 'utf8');
    execFileSync('git', ['add', 'main'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root });
    execFileSync('git', ['checkout', '-b', 'feature'], { cwd: root });
    fs.writeFileSync(path.join(root, 'main'), 'edited\n', 'utf8');

    await expect(makeSwitchBranchTool().handler({ name: 'main' })).resolves.toBe('Switched to main');
    expect(currentBranch(root)).toBe('main');
  });

  it('rejects option-like and control-character branch arguments before spawning git', async () => {
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue(undefined as never);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });

    await expect(makeSwitchBranchTool().handler({ name: '--orphan' })).rejects.toThrow(
      /looks like an option/u,
    );
    await expect(
      makeCreateBranchTool().handler({ name: 'ok', from: '--force' }),
    ).rejects.toThrow(/looks like an option/u);
    await expect(makeCreateBranchTool().handler({ name: 'bad\nname' })).rejects.toThrow(
      /control characters/u,
    );
    await expect(makeGitLogTool().handler({ max_entries: 0 })).rejects.toThrow(
      /max_entries must be an integer/u,
    );
  });

  it('reports an empty history rather than a failure, and a bad ref rather than an empty log', async () => {
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue(undefined as never);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });

    await expect(makeGitLogTool().handler({})).resolves.toBe('No commits.');
    await expect(makeGitLogTool().handler({ branch: 'no-such-branch' })).rejects.toThrow(/git log/u);
  });

  it('frames log records so separator characters in a message cannot split them', async () => {
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue(undefined as never);
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Ünïcode Authör'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'forge@test.invalid'], { cwd: root });
    fs.writeFileSync(path.join(root, 'a.txt'), 'a\n', 'utf8');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    // \x1f and \x1e are exactly the control separators a naive --format would
    // have used as field delimiters. A commit message may contain them.
    execFileSync('git', ['commit', '-m', 'sep \x1f and \x1e and — em dash\n\nsecond para'], {
      cwd: root,
    });

    const log = String(await makeGitLogTool().handler({}));
    expect(log.split('\n')).toHaveLength(1);
    expect(log).toContain('sep \x1f and \x1e and — em dash');
    expect(log).toContain('Ünïcode Authör');
  });

  it('executes fetch and search handlers with deterministic network adapters', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('tavily')) {
        return new Response(
          JSON.stringify({
            results: [
              { title: 'Fixture', url: 'https://example.com/result', content: 'Result text' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('<html><body>Fixture <b>page</b></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeWebFetchTool().handler({ url: 'https://example.com/page', max_chars: 100 }),
    ).resolves.toContain('Fixture page');
    await expect(makeWebFetchTool().handler({ url: 'http://127.0.0.1/private' })).rejects.toThrow(
      'Blocked loopback',
    );
    const secrets = { get: async () => 'fixture-secret' } as unknown as vscode.SecretStorage;
    await expect(
      makeWebSearchTool(secrets, {
        provider: 'tavily',
        secret_key_name: 'search-key',
        max_results: 1,
      }).handler({ query: 'fixture' }),
    ).resolves.toContain('**Fixture**');
  });
});

function currentBranch(cwd: string): string {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}
