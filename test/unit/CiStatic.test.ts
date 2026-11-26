import { describe, expect, it } from 'vitest';
import { STATIC_SCRIPTS, summarize } from '../../scripts/ci-static.mjs';

/** What `ci-static.mjs` hands `summarize` for one finished check. */
type CheckResult = {
  script: string;
  seconds: number;
  code: number | null;
  stdout?: string;
  stderr?: string;
};

const check = (script: string, seconds: number, code: number | null = 0): CheckResult => ({
  script,
  seconds,
  code,
  stdout: `${script} output`,
});

describe('the ci-static step', () => {
  it('runs the two type-checks and the lint, and nothing else', () => {
    expect(STATIC_SCRIPTS).toEqual(['type-check:ext', 'type-check:webview', 'lint']);
  });

  it('passes only when all three exited 0', () => {
    const results = [check('type-check:ext', 8.8), check('type-check:webview', 4.9), check('lint', 22.2)];
    expect(summarize(results).exitCode).toBe(0);
  });

  it('fails the step when one check exits 2, and still prints the other two', () => {
    const results = [
      check('type-check:ext', 8.8),
      check('type-check:webview', 4.9, 2),
      check('lint', 22.2),
    ];
    const { exitCode, lines } = summarize(results);
    expect(exitCode).toBe(1);
    // Nothing is dropped: the point of running them side by side is that one
    // run reports every error, not only the first check's.
    expect(lines.filter((line) => line.startsWith('──'))).toEqual([
      '── type-check:ext (8.8 s, exit 0)',
      '── type-check:webview (4.9 s, exit 2)',
      '── lint (22.2 s, exit 0)',
    ]);
    expect(lines).toContain('lint output');
  });

  it('treats a killed check as a failure', () => {
    expect(summarize([check('lint', 22.2, null)]).exitCode).toBe(1);
  });

  it('names the script, the seconds to one decimal and the exit code in the header', () => {
    const { lines } = summarize([{ script: 'lint', seconds: 22.2, code: 0 }]);
    expect(lines[0]).toBe('── lint (22.2 s, exit 0)');
  });

  it('prints a check output after that check ended, not after the one that started first', () => {
    // `lint` started first and ended last: its output must still sit below the
    // two that finished earlier, because each block is printed whole.
    const { lines } = summarize([
      check('type-check:ext', 8.8),
      check('type-check:webview', 4.9),
      check('lint', 22.2),
    ]);
    expect(lines).toEqual([
      '── type-check:ext (8.8 s, exit 0)',
      'type-check:ext output',
      '── type-check:webview (4.9 s, exit 0)',
      'type-check:webview output',
      '── lint (22.2 s, exit 0)',
      'lint output',
    ]);
  });

  it('keeps stdout above stderr for one check and drops the trailing blank line', () => {
    const { lines } = summarize([
      { script: 'lint', seconds: 1, code: 0, stdout: 'first\nsecond\n', stderr: 'oh no\n' },
    ]);
    expect(lines).toEqual(['── lint (1.0 s, exit 0)', 'first', 'second', 'oh no']);
  });
});
