import { describe, expect, it } from 'vitest';
import { classifyShellCommand } from '../../src/tools/shellPolicy';

const base = {
  home: 'C:/Users/efso office',
  platform: 'win32' as const,
  cwd: 'N:/vs code apps/Forge',
};
const owner = ['c:/users/efso office/.forge'];

describe('assignment-only shell statements', () => {
  const allowed = [
    'ls -t "C:/Users/efso office/.forge/sessions" | head -3; f=$(ls -t "C:/Users/efso office/.forge/sessions"/*.jsonl | head -1); echo "FILE: $f"; tail -c 1200 "$f"',
    'f=$(ls -t "C:/Users/efso office/.forge/sessions"/*.jsonl | head -1)',
    'f=$(ls -t "C:/Users/efso office/.forge/sessions"/*.jsonl | head -1); tail -c 1200 "$f"',
    'n=$(wc -l < "C:/Users/efso office/.forge/sessions/x.jsonl")',
    'f=`ls "C:/Users/efso office/.forge/sessions"`',
    'x=1; y=abc',
  ];

  it.each(allowed)('classifies read-only assignment %s with and without ownerOnly', (command) => {
    expect(classifyShellCommand(command, 'bash', base).classification).toBe('read_only');
    expect(classifyShellCommand(command, 'bash', { ...base, ownerOnly: owner }).classification).toBe(
      'read_only',
    );
  });

  it.each([
    'f=$(ls); echo x > "C:/Users/efso office/.forge/policy.yaml"',
    'f=$(rm -rf "C:/Users/efso office/.forge/sessions")',
    'f=$(tee "C:/Users/efso office/.forge/policy.yaml" < /dev/null)',
    'f=x; rm "C:/Users/efso office/.forge/jobs/a.json"',
    'f=$(cp a.txt "C:/Users/efso office/.forge/policy.yaml")',
  ])('still refuses owner-only writes in %s', (command) => {
    expect(classifyShellCommand(command, 'bash', { ...base, ownerOnly: owner }).classification).toBe(
      'refused',
    );
  });

  it('classifies a PowerShell variable assigned from a read-only pipeline as read-only', () => {
    const command =
      '$f = Get-ChildItem "C:/Users/efso office/.forge/sessions" -Filter *.jsonl | Sort-Object LastWriteTime -Descending | Select-Object -First 1';
    expect(classifyShellCommand(command, 'pwsh', base).classification).toBe('read_only');
    expect(
      classifyShellCommand(command, 'pwsh', { ...base, ownerOnly: owner }).classification,
    ).toBe('read_only');
  });
});
