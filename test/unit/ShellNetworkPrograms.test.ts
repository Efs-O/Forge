import { describe, expect, it } from 'vitest';

import { statementNetworkProgram } from '../../src/tools/shellNetworkPrograms';

describe('statementNetworkProgram', () => {
  it('finds the verb past an option value, where the first token is not the verb', () => {
    expect(statementNetworkProgram(['git', '-C', 'N:\\repo', 'push'])).toBe('git-push');
    expect(statementNetworkProgram(['git', '-c', 'user.name=x', 'push', 'origin', 'main'])).toBe(
      'git-push',
    );
    expect(statementNetworkProgram(['npm', '--registry', 'https://r.example', 'install'])).toBe(
      'npm-install',
    );
  });

  it('keeps the plain verb-first forms it already caught', () => {
    expect(statementNetworkProgram(['git', 'push'])).toBe('git-push');
  });

  it('stays silent for local statements, with or without an option in front', () => {
    expect(statementNetworkProgram(['git', 'status'])).toBeUndefined();
    expect(statementNetworkProgram(['git', '-C', 'N:\\repo', 'status'])).toBeUndefined();
    expect(statementNetworkProgram(['npm', 'run', 'build'])).toBeUndefined();
    expect(statementNetworkProgram(['npm', 'test'])).toBeUndefined();
  });

  it('drops cherry-pick, which never touches a host', () => {
    expect(statementNetworkProgram(['git', 'cherry-pick', 'abc123'])).toBeUndefined();
  });

  it('accepts the fail-closed false positive on a verb used as an option value', () => {
    // Deliberate: an option value cannot be told from a verb without a per-program
    // option table, so the safe answer is the card. `git status` above proves the
    // other half still answers nothing.
    expect(statementNetworkProgram(['git', 'commit', '-m', 'push'])).toBe('git-push');
  });
});
