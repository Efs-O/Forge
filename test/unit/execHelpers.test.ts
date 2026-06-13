import { describe, expect, it } from 'vitest';
import { stripAnsi, formatOutput } from '../../src/tools/execHelpers';

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
