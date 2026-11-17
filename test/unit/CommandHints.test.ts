import { describe, expect, it } from 'vitest';
import {
  GIT_IDENTITY_HINT,
  gitIdentityHint,
  posixIdioms,
  pwshHint,
} from '../../src/tools/commandHints';

/** Git's own words, copied from a run on a machine with no identity set. */
const AUTHOR_IDENTITY_UNKNOWN = `Author identity unknown

*** Please tell me who you are.

Run

  git config --global user.email "you@example.com"
  git config --global user.name "Your Name"

to set your account's default identity.
Omit --global to set the identity only in this repository.

fatal: unable to auto-detect email address (got 'someone@laptop.(none)')`;

describe('gitIdentityHint', () => {
  it('names the exact sentence it appends', () => {
    expect(GIT_IDENTITY_HINT).toBe(
      'Git has no author identity here. Ask the user for the name and email with ask_user and set them only with their answer; in a scheduled job, stop and report it instead. Never invent one.',
    );
  });

  it("appends it to git's real \"Author identity unknown\" output", () => {
    expect(gitIdentityHint(AUTHOR_IDENTITY_UNKNOWN)).toBe('\n' + GIT_IDENTITY_HINT);
  });

  it('appends it for the committer half of the same error', () => {
    expect(gitIdentityHint('Committer identity unknown\n\n*** Please tell me who you are.')).toBe(
      '\n' + GIT_IDENTITY_HINT,
    );
  });

  it('stays silent on ordinary git output', () => {
    expect(gitIdentityHint('nothing to commit, working tree clean')).toBe('');
    expect(gitIdentityHint('')).toBe('');
  });
});

describe('pwshHint', () => {
  it('suggests bash when a POSIX idiom fails under PowerShell', () => {
    const hint = pwshHint('pwsh', 1, 'sort -rn files');
    expect(hint).toContain('Rerun it with shell: "bash".');
    expect(hint).toContain('sort -rn');
  });

  it('stays silent when the PowerShell command succeeded', () => {
    expect(pwshHint('pwsh', 0, 'sort -rn files')).toBe('');
  });

  it('stays silent for a POSIX shell', () => {
    expect(pwshHint('bash', 1, 'sort -rn files')).toBe('');
  });
});

describe('posixIdioms', () => {
  it('lists the POSIX idioms in a command', () => {
    expect(posixIdioms('head -1 f && sort -rn x')).toEqual(['head', 'sort -rn']);
  });
});
