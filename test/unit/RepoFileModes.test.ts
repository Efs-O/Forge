import { execFileSync } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Git only runs a hook it can execute. A `.githooks` file committed as
 * 100644 is silently skipped on Linux and macOS (Windows tolerates it because
 * `core.fileMode` is false there), so the modes are pinned here instead of
 * discovered by a fresh clone on another machine.
 */
describe('tracked file modes', () => {
  it('keeps every git hook executable (100755)', () => {
    const listing = execFileSync('git', ['ls-files', '-s', '.githooks'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const lines = listing
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // A listing that found nothing would pass a vacuous `every`.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      expect(line.startsWith('100755 ')).toBe(true);
    }
  });
});
