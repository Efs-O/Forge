import { describe, expect, it } from 'vitest';
import {
  andChainHint,
  GIT_IDENTITY_HINT,
  gitIdentityHint,
  posixIdioms,
  pwshHint,
} from '../../src/tools/commandHints';

/** The whole `&&` note, pinned word for word: the plan's CI-enforceable row says a
 *  later change to this wording fails CI. */
const AND_CHAIN_NOTE =
  '\nThis line joins steps with &&, which skips every step after one that exits non-zero, so the output above may stop before the last step. grep, rg, findstr and diff exit 1 for "no match" or "files differ", which is an answer, not a fault. Join checks that do not depend on each other with ; so each one runs.';

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

describe('andChainHint', () => {
  it('names the exact note it appends to a failed && chain', () => {
    expect(andChainHint('bash', 1, false, 'cd a && grep x f')).toBe(AND_CHAIN_NOTE);
  });

  it('adds the note for a pwsh && chain too', () => {
    expect(andChainHint('pwsh', 1, false, 'Get-Item a && Get-Item b')).toBe(AND_CHAIN_NOTE);
  });

  it('stays silent when the chain exited 0', () => {
    expect(andChainHint('bash', 0, false, 'cd a && grep x f')).toBe('');
  });

  it('stays silent for joins that do not skip later steps', () => {
    expect(andChainHint('bash', 1, false, 'grep x f; ls')).toBe('');
    expect(andChainHint('bash', 1, false, 'grep x f || ls')).toBe('');
    expect(andChainHint('bash', 1, false, 'grep x f & ls')).toBe('');
  });

  it('stays silent when the && is quoted or an operand of a bash test', () => {
    expect(andChainHint('bash', 1, false, 'echo "a && b"')).toBe('');
    expect(andChainHint('bash', 1, false, '[[ -f a && -f b ]]')).toBe('');
  });

  it('stays silent when the run timed out or never reported an exit code', () => {
    expect(andChainHint('bash', 1, true, 'cd a && grep x f')).toBe('');
    expect(andChainHint('bash', null, false, 'cd a && grep x f')).toBe('');
  });
});
