import { describe, expect, it } from 'vitest';
import { checkDenyList, getBuiltinDenyList, isRecursiveForceDelete } from '../../src/tools/DenyList';

const denied = (command: string, args: string[] = []): string | null =>
  checkDenyList(command, args, getBuiltinDenyList())?.description ?? null;

describe('recursive force delete', () => {
  it('still blocks every destructive form', () => {
    // The whole point of the rule — these must never regress.
    expect(isRecursiveForceDelete('rm -rf /')).toBe(true);
    expect(isRecursiveForceDelete('rm -fr build')).toBe(true);
    expect(isRecursiveForceDelete('rm -r -f build')).toBe(true);
    expect(isRecursiveForceDelete('rm -f -r build')).toBe(true);
    expect(isRecursiveForceDelete('rm --recursive --force build')).toBe(true);
    expect(isRecursiveForceDelete('sudo rm -rf /var')).toBe(true);
    expect(isRecursiveForceDelete('git rm -rf src')).toBe(true);
    expect(isRecursiveForceDelete('rm -Rf build')).toBe(true);
  });

  it('no longer refuses a scoped delete because a filename contains "r"', () => {
    // The measured false positive: `git rm -f README.md` was refused while
    // `git rm -f notes.txt` was allowed, because the old pattern's trailing
    // `-?[rR]` matched the bare "r" in README.
    expect(isRecursiveForceDelete('git rm -f README.md')).toBe(false);
    expect(isRecursiveForceDelete('git rm -f notes.txt')).toBe(false);
    expect(
      isRecursiveForceDelete('git rm -f threejs-game-prompt/_check.js tests/_probe.mjs'),
    ).toBe(false);
  });

  it('does not fire on an unrelated command that merely mentions a path', () => {
    expect(isRecursiveForceDelete('node scripts/rm-report.mjs -r -f')).toBe(false);
    expect(isRecursiveForceDelete('echo rm -rf')).toBe(false);
  });

  it('routes refusals through checkDenyList with an alternative', () => {
    expect(denied('rm', ['-rf', 'build'])).toBe('rm -rf (recursive force delete)');
    expect(denied('git', ['rm', '-f', 'README.md'])).toBeNull();
    const entry = checkDenyList('rm', ['-rf', 'build'], getBuiltinDenyList());
    expect(entry?.alternative).toContain('delete_file');
  });

  it('leaves the other destructive rules intact', () => {
    expect(denied('git', ['clean', '-fd'])).toBe('git clean -f');
    expect(denied('git', ['reset', '--hard'])).toBe('git reset (hard/mixed/soft)');
    expect(denied('git', ['push', '--force'])).toBe('force push');
    expect(denied('shutdown', ['/s'])).toBe('system power command');
    expect(denied('diskpart', [])).toBe('diskpart');
  });
});
