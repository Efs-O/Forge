import { describe, expect, it } from 'vitest';
import { makeGitReadTool } from '../../src/tools/gitReadTool';
import type { ForgeConfig } from '../../src/config/types';

const HOME = 'C:/Users/someone';
const win = { home: HOME, platform: 'win32' as const };
const tool = (config?: ForgeConfig) =>
  makeGitReadTool({ ...win, ...(config ? { getConfig: () => config } : {}) });

/**
 * `git show HEAD:.env` and a diff limited to `.env` print the file's contents,
 * so they are a read of it and get the same card as `read_file`. `git status`
 * and `git log` name paths without printing their contents, so they stay
 * ungated — a gate that asks on `git status` is a gate that gets switched off.
 */
describe('git_read asks for a secret path it would print', () => {
  const cases: Array<[args: Record<string, unknown>, pattern: string]> = [
    [{ operation: 'show', ref: 'HEAD:.env' }, '**/.env'],
    [{ operation: 'show', ref: 'HEAD~1:src/.env' }, '**/.env'],
    [{ operation: 'diff', path: '.env' }, '**/.env'],
    [{ operation: 'diff', path: 'apps/api/.env.production' }, '**/.env.*'],
    [{ operation: 'blame', path: 'C:/Users/someone/.ssh/id_ed25519' }, '~/.ssh/**'],
    [{ operation: 'show', ref: 'HEAD:C:/Users/someone/.aws/credentials' }, '~/.aws/**'],
  ];

  it.each(cases)('%s → asks naming %s', (args, pattern) => {
    const card = tool().approval?.(args);
    expect(card?.dangerous).toBe(true);
    expect(card?.cardReason).toBe(`reads a secret path (${pattern})`);
    expect(card?.declineHint).toContain(pattern);
    expect(card?.gateKind).toBe('ownerGate');
  });

  it('names the path that matched, not the ref', () => {
    const card = tool().approval?.({ operation: 'show', ref: 'HEAD~2:.env' });
    expect(card?.detail).toContain('.env');
    expect(card?.detail).not.toContain('HEAD~2');
  });
});

describe('what git_read may still do for free', () => {
  // Every operation that does not name a path prints names only.
  it('does not ask for a read that prints no contents', () => {
    for (const args of [
      { operation: 'status' },
      { operation: 'log', max_entries: 5 },
      { operation: 'diff', staged: true },
      { operation: 'show', ref: 'HEAD~1' },
      { operation: 'blame', path: 'src/app.ts' },
      { operation: 'diff', path: 'notes.env.md' },
      { operation: 'show', ref: 'HEAD:CHANGELOG.md' },
      { operation: 'show', ref: 'v1.2.3' },
    ] as const) {
      expect(tool().approval?.(args as Record<string, unknown>)).toBeUndefined();
    }
  });

  // A ref that carries a path is `git show <ref>:<path>`; the ref part is not a
  // path, so `HEAD:src/app.ts` is judged on `src/app.ts` alone.
  it('splits the ref at its first colon', () => {
    expect(
      tool().approval?.({ operation: 'show', ref: 'C:/Users/someone/.ssh:notes.txt' }),
    ).toBeUndefined();
  });

  it('honours permissions.secret_paths_allow', () => {
    const allowed = {
      permissions: { secret_paths_allow: ['.env'] },
    } as unknown as ForgeConfig;
    expect(tool(allowed).approval?.({ operation: 'show', ref: 'HEAD:.env' })).toBeUndefined();
    expect(
      tool(allowed).approval?.({ operation: 'show', ref: 'HEAD:.env.local' })?.cardReason,
    ).toContain('**/.env.*');
  });

  it('gates what this PC added to the list', () => {
    const config = {
      permissions: { secret_paths: ['N:/private/**'] },
    } as unknown as ForgeConfig;
    const card = tool(config).approval?.({ operation: 'diff', path: 'N:/private/notes.md' });
    expect(card?.cardReason).toContain('N:/private/**');
  });

  it('keeps the git-read permission it had before (the card is the addition)', () => {
    expect(tool().permission).toBe('git-read');
  });
});
