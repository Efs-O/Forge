import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { makeShellTool, withPathEntry, gitBashDir, posixIdioms } from '../../src/tools/shellTool';
import { BackgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import { TEST_BASH } from '../support/bash';

const context = (extra: Record<string, unknown> = {}) => ({ beforeMutate: () => {}, ...extra });
const bashArgs = (command: string) => ({
  command,
  ...(process.platform === 'win32' ? { shell: 'bash' } : {}),
});

describe.skipIf(!TEST_BASH)('shell bash execution', () => {
  it('runs Git Bash with -c (or bash -c elsewhere) and returns ordered pipeline output', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-run-'));
    const previous = [...(vscode.workspace.workspaceFolders ?? [])];
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    try {
      const direct = spawnSync(TEST_BASH!, ['-c', 'printf "git-bash-ready"'], { encoding: 'utf8' });
      expect(direct.status).toBe(0);
      expect(direct.stdout).toBe('git-bash-ready');
      await expect(
        makeShellTool({ bashPath: TEST_BASH }).handler(
          bashArgs('printf "alpha\\nbeta\\n" | tail -n 1'),
          context(),
        ),
      ).resolves.toContain('beta');
    } finally {
      vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('puts the bundled ripgrep folder on PATH so a bare `rg` resolves', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-rg-'));
    const previous = [...(vscode.workspace.workspaceFolders ?? [])];
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(dir) });
    fs.writeFileSync(path.join(dir, 'forge-probe-rg'), '#!/bin/sh\necho probe-rg-ran\n', {
      mode: 0o755,
    });
    try {
      await expect(
        makeShellTool({ bashPath: TEST_BASH, ripgrepDir: () => dir }).handler(
          bashArgs('forge-probe-rg'),
          context(),
        ),
      ).resolves.toContain('probe-rg-ran');
    } finally {
      vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previous);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kills the process tree at timeout and on abort', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-kill-'));
    const previous = [...(vscode.workspace.workspaceFolders ?? [])];
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    try {
      const tool = makeShellTool({ bashPath: TEST_BASH });
      await expect(
        tool.handler({ ...bashArgs('sleep 20'), timeout_ms: 1000 }, context()),
      ).resolves.toContain('timed out');
      const abort = new AbortController();
      const running = tool.handler(bashArgs('sleep 20'), context({ abortSignal: abort.signal }));
      setTimeout(() => abort.abort(), 300);
      await expect(running).resolves.toContain('exit');
    } finally {
      vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('shell tool validation and PowerShell', () => {
  it('refuses missing pwsh with the install/config fix', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-missing-'));
    const previous = [...(vscode.workspace.workspaceFolders ?? [])];
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    try {
      await expect(
        makeShellTool({ platform: 'win32', env: { PATH: '' } }).handler(
          { command: 'Get-Date' },
          context(),
        ),
      ).rejects.toThrow(/Install PowerShell 7.*permissions\.exec\.shell: powershell/u);
    } finally {
      vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status !== 0)(
    'runs a pwsh pipeline and returns the native exit code',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-pwsh-'));
      const previous = [...(vscode.workspace.workspaceFolders ?? [])];
      vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(root) });
      try {
        const result = await makeShellTool().handler(
          { command: "Write-Output 'one','two' | Select-Object -Last 1; exit 7" },
          context(),
        );
        expect(result).toContain('two');
        expect(result).toMatch(/^exit 7 ·/u);
      } finally {
        vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previous);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('validates notify_on_exit and wires a background shell invocation', async () => {
    const manager = new BackgroundExecutionManager();
    const start = vi
      .spyOn(manager, 'start')
      .mockReturnValue({ id: 'exec-shell', status: 'running', pid: 22, startedAt: Date.now() });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-background-'));
    const previous = [...(vscode.workspace.workspaceFolders ?? [])];
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    try {
      const tool = makeShellTool({ manager, bashPath: TEST_BASH });
      await expect(
        tool.handler({ command: 'echo hi', notify_on_exit: true }, context()),
      ).rejects.toThrow('requires background=true');
      await expect(
        tool.handler({ ...bashArgs('echo hi'), background: true, notify_on_exit: true }, context()),
      ).rejects.toThrow('requires a conversation');
      await expect(
        tool.handler(
          { ...bashArgs('echo hi'), background: true, notify_on_exit: true },
          context({ conversationId: 'chat' }),
        ),
      ).resolves.toContain('exec-shell');
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({
          notifyConversationId: 'chat',
          args: expect.arrayContaining(['-c', 'echo hi']),
        }),
      );
    } finally {
      manager.dispose();
      vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('withPathEntry', () => {
  it('appends once, keeps the existing PATH key, and ignores a missing folder', () => {
    const sep = path.delimiter;
    expect(withPathEntry({ Path: `a${sep}b` }, 'rg')).toEqual({ Path: `a${sep}b${sep}rg` });
    expect(withPathEntry({ PATH: `a${sep}rg` }, 'rg')).toEqual({ PATH: `a${sep}rg` });
    expect(withPathEntry({}, 'rg')).toEqual({ PATH: 'rg' });
    const env = { PATH: 'a' };
    expect(withPathEntry(env, undefined)).toBe(env);
  });

  it('prepend moves the folder first, so Git Bash beats the System32 WSL launcher', () => {
    const sep = path.delimiter;
    expect(withPathEntry({ Path: `sys${sep}git` }, 'git', 'prepend')).toEqual({
      Path: `git${sep}sys`,
    });
    const first = { PATH: `git${sep}sys` };
    expect(withPathEntry(first, 'git', 'prepend')).toBe(first);
  });

  it('posixIdioms names bash-isms by whole token, as smoke item 4 wrote them', () => {
    expect(posixIdioms('cd logs && rg -i "dead" *.log | wc -l')).toEqual([
      'rg with a bare glob',
      'wc',
    ]);
    expect(posixIdioms("rg -o 'x' . | sort | uniq -c | sort -rn")).toEqual(['uniq', 'sort -rn']);
    expect(posixIdioms('for f in logs/a.log logs/b.log; do printf "%s" "$f"; done')).toEqual([
      'a for … in loop',
    ]);
    expect(posixIdioms('Get-ChildItem *.log | Sort-Object Length')).toEqual([]);
    expect(posixIdioms('rg "a*b" src')).toEqual([]);
    expect(posixIdioms('git headroom')).toEqual([]);
  });

  it('gitBashDir takes the configured bash folder', () => {
    expect(gitBashDir({ bashPath: String.raw`C:\Git\bin\bash.exe` })).toBe(String.raw`C:\Git\bin`);
  });
});
