import { describe, expect, it } from 'vitest';
import {
  ExecCommandError,
  formatExecCommandOutput,
  formatOutput,
  MAX_EXEC_STORED_CHARS,
  MAX_OUTPUT_CHARS,
  spawnAndWait,
  stripAnsi,
} from '../../src/tools/execHelpers';

const ESC = String.fromCharCode(27);

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

describe('formatOutput', () => {
  it('strips ANSI from both stdout and stderr', () => {
    const out = formatOutput({
      stdout: `${ESC}[32mok${ESC}[0m`,
      stderr: `${ESC}[31mwarn${ESC}[0m`,
      exitCode: 0,
    });
    expect(out).toBe('ok\n[stderr]\nwarn\n[exit code: 0]');
    expect(out.includes(ESC)).toBe(false);
  });

  it('keeps the summary at the end of over-long test output', () => {
    const out = formatOutput({
      stdout: 'x'.repeat(200_000) + '\nTests  3 failed | 12 passed',
      stderr: '',
      exitCode: 1,
    });
    expect(out).toContain('Tests  3 failed | 12 passed');
    expect(out).toContain('characters dropped');
  });
});

describe('structured exec_command outcomes', () => {
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
      const help = `usage: llama-server\n` + Array.from({ length: 800 }, (_, i) => `  --flag${i}  does something\n`).join('');
      expect(help.length).toBeGreaterThan(MAX_OUTPUT_CHARS);
      const output = JSON.parse(formatExecCommandOutput('llama-server', { stdout: help, stderr: '', exitCode: 0 }));
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
      const output = JSON.parse(formatExecCommandOutput('tool', { stdout, stderr: '', exitCode: 0 }));
      // The middle sits past the old 10k head; it must be in the stored text.
      expect(output.stdout).toContain(middle);
      expect(output.stdout).toBe(stdout);
    });

    it('caps stored output at the retention bound and says how much was dropped', () => {
      const stdout = 'x'.repeat(MAX_EXEC_STORED_CHARS + 5_000);
      const output = JSON.parse(formatExecCommandOutput('tool', { stdout, stderr: '', exitCode: 0 }));
      expect(output.stdout).toHaveLength(MAX_EXEC_STORED_CHARS);
      expect(output.stdout_truncated).toBe(true);
      expect(output.stdout_note).toContain('5000 characters');
    });

    // A build puts its error and summary last; a head-only cut dropped them.
    it('keeps the end of an over-long stream, where the failure is', () => {
      const stdout = `START\n${'progress\n'.repeat(MAX_EXEC_STORED_CHARS / 4)}error TS2322: boom\n`;
      const output = JSON.parse(formatExecCommandOutput('tsc', { stdout, stderr: '', exitCode: 2 }));
      expect(output.stdout).toHaveLength(MAX_EXEC_STORED_CHARS);
      expect(output.stdout.startsWith('START')).toBe(true);
      expect(output.stdout.endsWith('error TS2322: boom\n')).toBe(true);
      expect(output.stdout).toContain('characters dropped');
    });

    // The bound is the real worst case one exec_command can add to a round:
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
        formatExecCommandOutput('tool', { stdout: 'short', stderr: '', exitCode: 0 }, { maxChars: 2_000 }),
      );
      expect(output.stdout).toBe('short');
      expect(output).not.toHaveProperty('stdout_truncated');
    });
  });
});
