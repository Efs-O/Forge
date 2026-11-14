import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ExecCommandError,
  formatExecCommandOutput,
  MAX_EXEC_STORED_CHARS,
  MAX_OUTPUT_CHARS,
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

  it('distinguishes success from non-zero exit', () => {
    expect(
      JSON.parse(formatExecCommandOutput('tool', { stdout: 'ok', stderr: '', exitCode: 0 })),
    ).toMatchObject({ kind: 'success', program: 'tool', exitCode: 0 });
    expect(
      JSON.parse(formatExecCommandOutput('tool', { stdout: '', stderr: 'bad', exitCode: 2 })),
    ).toMatchObject({ kind: 'non_zero_exit', program: 'tool', exitCode: 2, stderr: 'bad' });
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

  it('returns a bounded final output window without a shell pipe', () => {
    const output = JSON.parse(
      formatExecCommandOutput(
        'tool',
        { stdout: 'one\ntwo\nthree\n', stderr: 'warning\n', exitCode: 0 },
        { tailLines: 2, stream: 'stdout' },
      ),
    );

    expect(output).toMatchObject({ stdout: 'two\nthree', stdout_truncated: true });
    expect(output).not.toHaveProperty('stderr');
  });

  describe('recoverable output (no line window)', () => {
    // A `--help` dump past the per-round head: the OLD code stored only the
    // 10k/16k slice and the middle was gone forever. Now the full stream is
    // stored, so read_tool_result can page the part the head cut off.
    it('stores the full stream when it is under the retention bound', () => {
      const help =
        `usage: llama-server\n` +
        Array.from({ length: 800 }, (_, i) => `  --flag${i}  does something\n`).join('');
      expect(help.length).toBeGreaterThan(MAX_OUTPUT_CHARS);
      const output = JSON.parse(
        formatExecCommandOutput('llama-server', { stdout: help, stderr: '', exitCode: 0 }),
      );
      // The whole dump is in the transcript, not just the head.
      expect(output.stdout).toBe(help);
      expect(output).not.toHaveProperty('stdout_truncated');
      expect(output).not.toHaveProperty('stdout_note');
    });

    it('lets read_tool_result recover the middle the head would have dropped', () => {
      const head = 'A'.repeat(MAX_OUTPUT_CHARS);
      const middle = 'SPLIT_MODE_SECTION';
      const tail = 'B'.repeat(MAX_OUTPUT_CHARS);
      const stdout = `${head}\n${middle}\n${tail}\n`;
      const output = JSON.parse(
        formatExecCommandOutput('tool', { stdout, stderr: '', exitCode: 0 }),
      );
      // The middle sits past the old 10k head; it must be in the stored text.
      expect(output.stdout).toContain(middle);
      expect(output.stdout).toBe(stdout);
    });

    it('caps stored output at the retention bound and says how much was dropped', () => {
      const stdout = 'x'.repeat(MAX_EXEC_STORED_CHARS + 5_000);
      const output = JSON.parse(
        formatExecCommandOutput('tool', { stdout, stderr: '', exitCode: 0 }),
      );
      expect(output.stdout).toHaveLength(MAX_EXEC_STORED_CHARS);
      expect(output.stdout_truncated).toBe(true);
      expect(output.stdout_note).toContain('5000 characters');
    });

    // A build puts its error and summary last; a head-only cut dropped them.
    it('keeps the end of an over-long stream, where the failure is', () => {
      const stdout = `START\n${'progress\n'.repeat(MAX_EXEC_STORED_CHARS / 4)}error TS2322: boom\n`;
      const output = JSON.parse(
        formatExecCommandOutput('tsc', { stdout, stderr: '', exitCode: 2 }),
      );
      expect(output.stdout).toHaveLength(MAX_EXEC_STORED_CHARS);
      expect(output.stdout.startsWith('START')).toBe(true);
      expect(output.stdout.endsWith('error TS2322: boom\n')).toBe(true);
      expect(output.stdout).toContain('characters dropped');
    });

    // The bound is the real worst case one retained output stream can add:
    // the excerptor downstream only cuts when the window is already tight.
    it('bounds a both-streams result to twice the retention bound', () => {
      const huge = 'x'.repeat(MAX_EXEC_STORED_CHARS * 3);
      const output = JSON.parse(
        formatExecCommandOutput('tool', { stdout: huge, stderr: huge, exitCode: 1 }),
      );
      expect(output.stdout.length + output.stderr.length).toBe(MAX_EXEC_STORED_CHARS * 2);
    });

    // max_output_chars used to be ignored unless head_lines/tail_lines came
    // with it, so a caller asking for a small result got the whole stream.
    it('honours max_output_chars with no line window', () => {
      const stdout = 'y'.repeat(20_000);
      const output = JSON.parse(
        formatExecCommandOutput('tool', { stdout, stderr: '', exitCode: 0 }, { maxChars: 2_000 }),
      );
      expect(output.stdout).toHaveLength(2_000);
      expect(output.stdout_truncated).toBe(true);
      expect(output.stdout_note).toContain('max_output_chars');
    });

    it('leaves a stream shorter than max_output_chars whole and unmarked', () => {
      const output = JSON.parse(
        formatExecCommandOutput(
          'tool',
          { stdout: 'short', stderr: '', exitCode: 0 },
          { maxChars: 2_000 },
        ),
      );
      expect(output.stdout).toBe('short');
      expect(output).not.toHaveProperty('stdout_truncated');
    });
  });
});
