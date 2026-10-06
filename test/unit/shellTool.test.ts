import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { makeShellTool } from '../../src/tools/shellTool';
import { BackgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import { TEST_BASH } from '../support/bash';

const context = (extra: Record<string, unknown> = {}) => ({ beforeMutate: () => {}, ...extra });
const bashArgs = (command: string) => ({ command, ...(process.platform === 'win32' ? { shell: 'bash' } : {}) });

describe.skipIf(!TEST_BASH)('shell bash execution', () => {
  it('runs Git Bash with -c (or bash -c elsewhere) and returns ordered pipeline output', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-run-'));
    const previous = [...(vscode.workspace.workspaceFolders ?? [])];
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    try {
      const direct = spawnSync(TEST_BASH!, ['-c', 'printf "git-bash-ready"'], { encoding: 'utf8' });
      expect(direct.status).toBe(0);
      expect(direct.stdout).toBe('git-bash-ready');
      await expect(makeShellTool({ bashPath: TEST_BASH }).handler(
        bashArgs('printf "alpha\\nbeta\\n" | tail -n 1'), context(),
      )).resolves.toContain('beta');
    } finally {
      vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('kills the process tree at timeout and on abort', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-kill-'));
    const previous = [...(vscode.workspace.workspaceFolders ?? [])];
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    try {
      const tool = makeShellTool({ bashPath: TEST_BASH });
      await expect(tool.handler({ ...bashArgs('sleep 20'), timeout_ms: 1000 }, context())).resolves.toContain('timed out');
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
      await expect(makeShellTool({ platform: 'win32', env: { PATH: '' } }).handler({ command: 'Get-Date' }, context()))
        .rejects.toThrow(/Install PowerShell 7.*permissions\.exec\.shell: powershell/u);
    } finally {
      vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-Command', 'exit 0']).status !== 0)(
    'runs a pwsh pipeline and returns the native exit code', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-pwsh-'));
      const previous = [...(vscode.workspace.workspaceFolders ?? [])];
      vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(root) });
      try {
        const result = await makeShellTool().handler({ command: "Write-Output 'one','two' | Select-Object -Last 1; exit 7" }, context());
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
    const start = vi.spyOn(manager, 'start').mockReturnValue({ id: 'exec-shell', status: 'running', pid: 22, startedAt: Date.now() });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-background-'));
    const previous = [...(vscode.workspace.workspaceFolders ?? [])];
    vscode.workspace.workspaceFolders?.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    try {
      const tool = makeShellTool({ manager, bashPath: TEST_BASH });
      await expect(tool.handler({ command: 'echo hi', notify_on_exit: true }, context())).rejects.toThrow('requires background=true');
      await expect(tool.handler({ ...bashArgs('echo hi'), background: true, notify_on_exit: true }, context())).rejects.toThrow('requires a conversation');
      await expect(tool.handler({ ...bashArgs('echo hi'), background: true, notify_on_exit: true }, context({ conversationId: 'chat' })))
        .resolves.toContain('exec-shell');
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ notifyConversationId: 'chat', args: expect.arrayContaining(['-c', 'echo hi']) }));
    } finally {
      manager.dispose();
      vscode.workspace.workspaceFolders?.splice(0, Infinity, ...previous);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
