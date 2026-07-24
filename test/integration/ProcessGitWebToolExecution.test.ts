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
  makeCommitTool,
  makeCreateBranchTool,
  makeGitBlameTool,
  makeGitDiffTool,
  makeGitLogTool,
  makeGitShowTool,
  makeGitStatusTool,
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
  });

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

  it('executes all Git handlers against a disposable repository or fake Git API', async () => {
    execFileSync('git', ['init'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'fixture\n', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Forge Test',
        '-c',
        'user.email=forge@test.invalid',
        'commit',
        '-m',
        'fixture',
      ],
      { cwd: root },
    );

    const repo = {
      state: {
        workingTreeChanges: [{ uri: vscode.Uri.file(path.join(root, 'tracked.txt')), status: 1 }],
        indexChanges: [],
      },
      log: vi.fn().mockResolvedValue([
        {
          hash: '1234567890',
          message: 'fixture commit',
          authorName: 'Forge Test',
          commitDate: new Date('2026-01-01T00:00:00Z'),
        },
      ]),
      diff: vi.fn().mockResolvedValue('fixture diff'),
      show: vi.fn().mockResolvedValue('unused'),
      createBranch: vi.fn().mockResolvedValue(undefined),
      checkout: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(vscode.extensions, 'getExtension').mockReturnValue({
      exports: { getAPI: () => ({ repositories: [repo] }) },
    } as never);

    await expect(makeGitStatusTool().handler({})).resolves.toContain('M tracked.txt');
    await expect(makeGitLogTool().handler({ max_entries: 1 })).resolves.toContain('1234567');
    await expect(makeGitDiffTool().handler({ staged: false })).resolves.toBe('fixture diff');
    await expect(makeGitBlameTool().handler({ path: 'tracked.txt' })).resolves.toContain(
      'author Forge Test',
    );
    await expect(makeGitShowTool().handler({ ref: 'HEAD' })).resolves.toContain('fixture');
    await expect(makeCreateBranchTool().handler({ name: 'feature', from: 'HEAD' })).resolves.toBe(
      'Branch created: feature',
    );
    await expect(makeSwitchBranchTool().handler({ name: 'main' })).resolves.toBe(
      'Switched to main',
    );
    await expect(makeStageTool().handler({ paths: ['tracked.txt'] })).resolves.toContain(
      'tracked.txt',
    );
    await expect(makeCommitTool().handler({ message: 'next' })).resolves.toBe('Committed: next');
    expect(repo.createBranch).toHaveBeenCalledWith('feature', true, 'HEAD');
    expect(repo.add).toHaveBeenCalledWith([path.join(root, 'tracked.txt')]);
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
