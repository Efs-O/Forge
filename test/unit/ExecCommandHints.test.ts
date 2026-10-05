import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeExecCommandTool } from '../../src/tools/execTools';

describe('exec_command result hints', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names a missing explicit path and keeps the search_code hint', async () => {
    await expect(
      makeExecCommandTool().handler({
        command: path.join(os.tmpdir(), 'grep.exe'),
        args: [],
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/no executable at .*grep\.exe.*search_code/s);
  });

  it('explains EINVAL for a .cmd shim and gives a working cmd /c route', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cmd-shim-'));
    const shim = path.join(dir, 'shim.cmd');
    fs.writeFileSync(shim, '@echo off\r\necho shim-ok\r\n');
    try {
      await expect(
        makeExecCommandTool().handler({ command: shim, args: [], cwd: dir }),
      ).rejects.toThrow(/Node cannot launch.*\.cmd.*cmd.*\/c/i);
      const route = JSON.parse(
        (await makeExecCommandTool(() => true).handler({
          command: 'cmd',
          args: ['/c', 'echo forge-ok'],
          cwd: dir,
        })) as string,
      ) as { stdout: string; exitCode: number };
      expect(route.exitCode).toBe(0);
      expect(route.stdout.toLowerCase()).toContain('forge-ok');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds an inline-script checkpoint warning without blocking the command', async () => {
    const result = JSON.parse(
      (await makeExecCommandTool().handler({
        command: process.execPath,
        args: ['--eval', 'process.stdout.write("inline-ok")'],
        cwd: process.cwd(),
      })) as string,
    ) as { stdout: string; note?: string };
    expect(result.stdout).toBe('inline-ok');
    expect(result.note).toContain('Files written by an inline script skip the per-turn checkpoint');
  });
});
