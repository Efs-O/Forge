import { describe, expect, it } from 'vitest';
import { gitShowArgs } from '../../src/tools/gitLog';

describe('gitShowArgs', () => {
  it('passes a ref and the ref:path form through', () => {
    expect(gitShowArgs('HEAD~1')).toEqual(['show', 'HEAD~1']);
    expect(gitShowArgs('main:package.json')).toEqual(['show', 'main:package.json']);
  });

  // git_show runs unconfirmed; `git show --output=<file>` writes anywhere.
  it('refuses a ref git would read as an option', () => {
    expect(() => gitShowArgs('--output=C:/Users/me/.bashrc')).toThrow(/looks like an option/);
    expect(() => gitShowArgs('-p')).toThrow(/looks like an option/);
  });

  it('refuses an empty ref, a non-string, or one with control characters', () => {
    expect(() => gitShowArgs('')).toThrow(/non-empty/);
    expect(() => gitShowArgs(undefined)).toThrow(/non-empty/);
    expect(() => gitShowArgs('HEAD\n--output=x')).toThrow(/control characters/);
  });
});
