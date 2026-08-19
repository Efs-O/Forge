import { describe, expect, it } from 'vitest';
import {
  ExecCommandError,
  formatExecCommandOutput,
  formatOutput,
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
});
