import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ExecCommandError,
  MAX_OUTPUT_CHARS_CEILING,
  parseExecOutputOptions,
  runShellInForeground,
  spawnAndWait,
  stripAnsi,
  resolveExecCwd,
} from '../../src/tools/execHelpers';
import { ShellOutputCollector } from '../../src/tools/shellOutput';
import { shutdownJobKeeper } from '../../src/util/windowsJobKeeper';
import { removeTreeWhenFree } from '../support/removeTempTree';
import * as vscode from 'vscode';

const ESC = String.fromCharCode(27);

// Every spawn in this file goes through the job keeper now, and the real keeper
// is PowerShell. Point the seam at the fake keeper for the whole file, from
// before the first test: the keeper is a per-process singleton, so a real one
// started by an earlier test in the file would answer the later ones too. The
// log path is fixed here as well, because the fake reads it once at startup.
let keeperRoot = '';
let keeperLog = '';

beforeAll(() => {
  keeperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-job-keeper-'));
  keeperLog = path.join(keeperRoot, 'commands.log');
  fs.writeFileSync(keeperLog, '');
  process.env.FORGE_JOB_KEEPER_CMD = path.join(
    process.cwd(),
    'test',
    'support',
    'fakeJobKeeper.cjs',
  );
  process.env.FORGE_JOB_KEEPER_LOG = keeperLog;
});

afterAll(async () => {
  shutdownJobKeeper();
  delete process.env.FORGE_JOB_KEEPER_CMD;
  delete process.env.FORGE_JOB_KEEPER_LOG;
  // The keeper is a child process that had this folder's file open, and Windows
  // will not remove a folder while something still holds it: poll until free.
  await removeTreeWhenFree(keeperRoot);
});

/** The `job <token> <pid>` lines the keeper has been asked for so far. */
function jobLines(): string[] {
  return fs
    .readFileSync(keeperLog, 'utf8')
    .split('\n')
    .filter((line) => /^job \d+ \d+$/u.test(line));
}

describe('stripAnsi', () => {
  it('strips SGR color codes', () => {
    const colored = `${ESC}[36m RUN ${ESC}[39m${ESC}[31m1 failed${ESC}[39m`;
    expect(stripAnsi(colored)).toBe(' RUN 1 failed');
  });

  it('strips cursor/erase codes (K, G) alongside color', () => {
    const noisy = `${ESC}[2K${ESC}[1G${ESC}[1m${ESC}[36mvitest${ESC}[0m done`;
    expect(stripAnsi(noisy)).toBe('vitest done');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('no codes here')).toBe('no codes here');
  });
});

describe('background output helpers', () => {
  it('keeps oversized text output limits as a refusal with a file alternative', () => {
    expect(() =>
      parseExecOutputOptions({ max_output_chars: MAX_OUTPUT_CHARS_CEILING + 1 }),
    ).toThrow(/redirect.*file/iu);
  });

  it('classifies a missing executable', async () => {
    await expect(
      spawnAndWait('forge-definitely-missing-executable', [], process.cwd(), 1_000),
    ).rejects.toMatchObject<Partial<ExecCommandError>>({ kind: 'missing_executable' });
  });

  it('classifies a missing working directory separately from a missing executable', async () => {
    const cwd = path.join(os.tmpdir(), `forge-missing-cwd-${Date.now()}`);
    await expect(spawnAndWait(process.execPath, [], cwd, 1_000)).rejects.toMatchObject<
      Partial<ExecCommandError>
    >({ kind: 'missing_cwd' });
  });

  it('resolves shell cwd only to an existing directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-cwd-'));
    const folders = vscode.workspace.workspaceFolders;
    const previous = folders ? [...folders] : undefined;
    folders?.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    try {
      let missingError: unknown;
      try {
        resolveExecCwd('build');
      } catch (error) {
        missingError = error;
      }
      expect(missingError).toBeInstanceOf(Error);
      expect((missingError as Error).message).toContain('cwd "build" does not exist');
      expect((missingError as Error).message).toContain(`resolved to ${root}`);
      const file = path.join(root, 'not-a-folder');
      fs.writeFileSync(file, '');
      expect(() => resolveExecCwd('not-a-folder')).toThrow(/is not a folder/u);
    } finally {
      folders?.splice(0, Infinity, ...(previous ?? []));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Measured 2026-11-27 over 14 days of logs: every one of the 10 `cwd does not
  // exist` refusals was the same slip — a separator written where the real
  // folder name has a space (`N:/vs code/apps/Forge`). The tool now runs in the
  // folder that does exist and says so, rather than buying the same slip again.
  describe('a cwd whose space was written as a separator', () => {
    /** Runs `body` with the workspace root pointed at a temp folder holding
     *  `vs code apps/Forge`, plus `file name.txt` as the file case. */
    function withWorkspace(body: (root: string) => void): void {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-cwd-space-'));
      fs.mkdirSync(path.join(root, 'vs code apps', 'Forge'), { recursive: true });
      fs.writeFileSync(path.join(root, 'file name.txt'), '');
      const folders = vscode.workspace.workspaceFolders;
      const previous = folders ? [...folders] : undefined;
      folders?.splice(0, Infinity, { uri: vscode.Uri.file(root) });
      try {
        body(root);
      } finally {
        folders?.splice(0, Infinity, ...(previous ?? []));
        fs.rmSync(root, { recursive: true, force: true });
      }
    }

    it('runs in the real folder and names it in the note', () => {
      withWorkspace((root) => {
        const real = path.join(root, 'vs code apps', 'Forge');
        expect(resolveExecCwd('vs code/apps/Forge')).toEqual({
          cwd: real,
          note:
            `Note: cwd "vs code/apps/Forge" does not exist; ran in ${real} instead, ` +
            'the same path with a space where a separator was.',
        });
      });
    });

    it('adds no note when the folder exists as written', () => {
      withWorkspace((root) => {
        const real = path.join(root, 'vs code apps', 'Forge');
        expect(resolveExecCwd(path.join('vs code apps', 'Forge'))).toEqual({ cwd: real });
      });
    });

    it('refuses a folder that is missing for another reason', () => {
      withWorkspace(() => {
        let message = '';
        try {
          resolveExecCwd('nothing/here');
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain('cwd "nothing/here" does not exist (resolved to ');
        expect(message).toContain('Create it first');
      });
    });

    it('refuses when the respaced form is a file, not a folder', () => {
      withWorkspace(() => {
        let message = '';
        try {
          resolveExecCwd('file/name.txt');
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain('cwd "file/name.txt" does not exist (resolved to ');
      });
    });
  });

  it('classifies a timeout', async () => {
    await expect(
      spawnAndWait(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], process.cwd(), 10),
    ).rejects.toMatchObject<Partial<ExecCommandError>>({ kind: 'timeout' });
  });

  it('cancels the full spawned command promptly', async () => {
    const controller = new AbortController();
    const pending = spawnAndWait(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.cwd(),
      10_000,
      {},
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject<Partial<ExecCommandError>>({ kind: 'cancelled' });
  });

  // The foreground path has its own spawn, not spawnAndWait, so it needs the
  // job object itself: without it, an aborted `sleep 600` under Git Bash
  // outlived the call because the forker that created it was already gone.
  it('protects a foreground command so a cancel takes its children too', async () => {
    const root = fs.mkdtempSync(path.join(keeperRoot, 'foreground-'));
    const askedFor = jobLines().length;
    const controller = new AbortController();
    const collector = new ShellOutputCollector(
      'foreground-protect',
      'call-1',
      1000,
      path.join(root, 'spill'),
    );
    const pending = runShellInForeground(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.cwd(),
      10_000,
      {},
      controller.signal,
      collector,
    );
    try {
      // A keeper is a cold process: the protocol tests give its first line five
      // seconds, and this is a keeper that earlier tests already started.
      await vi.waitFor(() => expect(jobLines().length).toBeGreaterThan(askedFor), {
        timeout: 5_000,
      });
      controller.abort();
      await expect(pending).resolves.toMatchObject({ code: null, timedOut: false });
    } finally {
      await removeTreeWhenFree(root);
    }
  }, 30_000);
});
