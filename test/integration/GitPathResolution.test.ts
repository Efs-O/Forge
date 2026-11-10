import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeGitReadTool } from '../../src/tools/gitReadTool';
import {
  makeCommitTool,
  makeCreateBranchTool,
  makeRestoreFileTool,
  makeStageTool,
  makeSwitchBranchTool,
} from '../../src/tools/gitTools';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Forge Test',
  GIT_AUTHOR_EMAIL: 'forge@test.invalid',
  GIT_COMMITTER_NAME: 'Forge Test',
  GIT_COMMITTER_EMAIL: 'forge@test.invalid',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' });
}

describe('git cwd and path resolution', () => {
  let ws: string;
  let nested: string;

  beforeEach(() => {
    ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-git-paths-')));
    nested = path.join(ws, 'demo', 'repo');
    fs.mkdirSync(nested, { recursive: true });
    git(ws, ['init', '-b', 'main']);
    git(ws, ['config', 'user.name', 'Forge Test']);
    git(ws, ['config', 'user.email', 'forge@test.invalid']);
    fs.writeFileSync(path.join(ws, 'top.txt'), 'outer old\n', 'utf8');
    git(ws, ['add', 'top.txt']);
    git(ws, ['commit', '-m', 'outer seed']);
    git(nested, ['init', '-b', 'main']);
    git(nested, ['config', 'user.name', 'Forge Test']);
    git(nested, ['config', 'user.email', 'forge@test.invalid']);
    fs.writeFileSync(path.join(nested, 'config.txt'), 'nested old\n', 'utf8');
    git(nested, ['add', 'config.txt']);
    git(nested, ['commit', '-m', 'nested seed']);
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(ws) });
  });

  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0);
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('refuses a missing cwd in every public git tool with the full message', async () => {
    const tools = [
      ['git_read', () => makeGitReadTool().handler({ operation: 'status', cwd: 'missing/dir' })],
      ['stage', () => makeStageTool().handler({ cwd: 'missing/dir', paths: ['x.txt'] })],
      [
        'restore_file',
        () => makeRestoreFileTool().handler({ cwd: 'missing/dir', paths: ['config.txt'] }),
      ],
      ['commit', () => makeCommitTool().handler({ cwd: 'missing/dir', message: 'no' })],
      [
        'create_branch',
        () => makeCreateBranchTool().handler({ cwd: 'missing/dir', name: 'next' }),
      ],
      ['switch_branch', () => makeSwitchBranchTool().handler({ cwd: 'missing/dir', name: 'main' })],
    ] as const;
    const expected =
      `cwd "missing/dir" does not exist (resolved to ${path.resolve(ws, 'missing/dir')}). ` +
      `A relative cwd resolves from the workspace root, ${ws}. ` +
      "Pass the repository's directory, absolute or relative to that root.";
    for (const [tool, invoke] of tools) {
      let message = '';
      try {
        await invoke();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toBe(`${tool}: ${expected}`);
    }
  });

  it('refuses a diff path outside the repository selected by cwd exactly', async () => {
    let message = '';
    try {
      await makeGitReadTool().handler({ operation: 'diff', cwd: 'demo/repo', path: '../../top.txt' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      `git_read: path "../../top.txt" resolves to ${path.join(ws, 'top.txt')}, which is outside the repository that cwd "demo/repo" selects (${nested}). ` +
        'Pass a path inside that repository, relative to cwd or to the workspace root.',
    );
  });

  it('refuses a diff path that neither exists nor is tracked exactly', async () => {
    let message = '';
    try {
      await makeGitReadTool().handler({ operation: 'diff', cwd: 'demo/repo', path: 'nothere.txt' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      `git_read: path "nothere.txt" resolves to ${path.join(nested, 'nothere.txt')}, which neither exists nor is tracked in the repository at ${nested}. ` +
        'Pass a path inside that repository, relative to cwd or to the workspace root.',
    );
  });

  it('resolves diff path spellings from cwd or workspace and leaves the outer repo alone', async () => {
    fs.writeFileSync(path.join(nested, 'config.txt'), 'nested new\n', 'utf8');
    const calls = [
      { cwd: 'demo/repo', path: 'config.txt' },
      { cwd: 'demo/repo', path: 'demo/repo/config.txt' },
      { path: 'demo/repo/config.txt' },
      { path: path.join(nested, 'config.txt') },
    ];
    for (const args of calls) {
      const result = String(await makeGitReadTool().handler({ operation: 'diff', ...args }));
      expect(result).toContain('-nested old');
      expect(result).toContain('+nested new');
    }
    expect(git(ws, ['diff', '--name-only'])).toBe('');
  });

  it('blames the nested file when cwd is supplied', async () => {
    const result = String(
      await makeGitReadTool().handler({ operation: 'blame', cwd: 'demo/repo', path: 'config.txt' }),
    );
    expect(result).toContain('nested old');
    expect(result).toContain('author Forge Test');
    expect(git(ws, ['status', '--porcelain']).trimEnd()).toBe('?? demo/');
  });

  it('stages all cwd/workspace path spellings only in the nested repository', async () => {
    const stage = makeStageTool();
    const cases = [
      { cwd: 'demo/repo', file: 'f.txt', spelling: 'f.txt' },
      { cwd: 'demo/repo', file: 'f.txt', spelling: 'demo/repo/f.txt' },
      { file: 'f.txt', spelling: 'demo/repo/f.txt' },
    ];
    for (const { cwd, file, spelling } of cases) {
      fs.writeFileSync(path.join(nested, file), 'new\n', 'utf8');
      await expect(stage.handler({ ...(cwd ? { cwd } : {}), paths: [spelling] })).resolves.toContain(
        'added',
      );
      expect(git(nested, ['diff', '--cached', '--name-only']).trim()).toBe(file);
      expect(git(ws, ['diff', '--cached', '--name-only'])).toBe('');
      git(nested, ['reset', '--quiet', 'HEAD', '--', file]);
      fs.rmSync(path.join(nested, file));
    }
  });

  it('restores matching paths and snapshots the exact absolute paths it restores', async () => {
    const restore = makeRestoreFileTool();
    const cases = [
      { cwd: 'demo/repo', spelling: 'config.txt' },
      { cwd: 'demo/repo', spelling: 'demo/repo/config.txt' },
      { spelling: 'demo/repo/config.txt' },
      { spelling: path.join(nested, 'config.txt') },
    ];
    for (const { cwd, spelling } of cases) {
      fs.writeFileSync(path.join(nested, 'config.txt'), 'changed\n', 'utf8');
      expect(restore.mutation?.paths?.({ ...(cwd ? { cwd } : {}), paths: [spelling] })).toEqual([
        path.join(nested, 'config.txt'),
      ]);
      await restore.handler({ ...(cwd ? { cwd } : {}), paths: [spelling] });
      expect(fs.readFileSync(path.join(nested, 'config.txt'), 'utf8').replace(/\r\n/gu, '\n')).toBe(
        'nested old\n',
      );
    }

    fs.rmSync(path.join(nested, 'config.txt'));
    expect(restore.mutation?.paths?.({ cwd: 'demo/repo', paths: ['config.txt'] })).toEqual([
      path.join(nested, 'config.txt'),
    ]);
    await restore.handler({ cwd: 'demo/repo', paths: ['config.txt'] });
    expect(fs.readFileSync(path.join(nested, 'config.txt'), 'utf8').replace(/\r\n/gu, '\n')).toBe(
      'nested old\n',
    );
    expect(git(ws, ['status', '--porcelain']).trimEnd()).toBe('?? demo/');
  });

  it('accepts an existing file as cwd and shows no diff for an existing untracked file', async () => {
    fs.writeFileSync(path.join(nested, 'untracked.txt'), 'untracked\n', 'utf8');
    await expect(
      makeGitReadTool().handler({ operation: 'status', cwd: 'demo/repo/config.txt' }),
    ).resolves.toBe('? untracked.txt');
    await expect(
      makeGitReadTool().handler({
        operation: 'diff',
        cwd: 'demo/repo',
        path: 'untracked.txt',
      }),
    ).resolves.toBe('(no diff)');
    expect(git(ws, ['diff', '--name-only'])).toBe('');
  });
});
