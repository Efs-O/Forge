import { describe, expect, it } from 'vitest';
import { classifyShellCommand } from '../../src/tools/shellPolicy';
import { makeShellTool } from '../../src/tools/shellTool';
import type { ForgeConfig } from '../../src/config/types';

const HOME = 'C:/Users/someone';
const win = { home: HOME, platform: 'win32' as const };
const ask = (command: string, shell: 'bash' | 'pwsh', check = win) =>
  classifyShellCommand(command, shell, check);

/**
 * A read-only command that names a secret path used to be auto-approved, which
 * is how `Get-Content .env` ran with no prompt in an autonomous run. The gate
 * classifies it `dangerous` rather than merely `normal` on purpose: `normal` is
 * approved without anyone looking in `/clanker` and unattended turns, and the
 * whole point of this rule is that nobody gets a secret read for free.
 */
describe('a read-only command naming a secret path asks', () => {
  const cases: Array<[command: string, shell: 'bash' | 'pwsh', pattern: string]> = [
    ['Get-Content .env', 'pwsh', '**/.env'],
    ['cat .env', 'bash', '**/.env'],
    ['cat ~/.ssh/id_rsa', 'bash', '~/.ssh/**'],
    ['type %USERPROFILE%\\.aws\\credentials', 'pwsh', '~/.aws/**'],
    ['Get-Content $env:USERPROFILE\\.npmrc', 'pwsh', '~/.npmrc'],
    ['rg KEY .env', 'bash', '**/.env'],
    ['Get-Content src/.env.production', 'pwsh', '**/.env.*'],
    ['cat ~/.forge/agent-bus/endpoint.json', 'bash', '~/.forge/agent-bus/endpoint.json'],
  ];

  it.each(cases)('%s → asks naming %s', (command, shell, pattern) => {
    const result = ask(command, shell);
    expect(result.classification).toBe('dangerous');
    expect(result.rule?.description).toBe(`reads a secret path (${pattern})`);
    expect(result.rule?.alternative).toContain(pattern);
    expect(result.rule?.alternative).toContain('permissions.secret_paths_allow');
  });

  // `ownerGate` is the classification that says a human owns this call: an
  // autonomous run refuses it at once and names the alternative, instead of
  // showing a card nobody is watching (docs/plans/V1_FINISH_PLAN.md, the
  // autonomous-run table).
  it('marks the rule as a gate only the owner may answer', () => {
    for (const [command, shell] of [
      ['Get-Content .env', 'pwsh'],
      ['cat ~/.ssh/id_rsa', 'bash'],
    ] as const) {
      expect(ask(command, shell).rule?.gateKind).toBe('ownerGate');
    }
  });

  it('asks on a secret read anywhere in a pipeline or a list', () => {
    expect(ask('Get-Content .env | Measure-Object', 'pwsh').classification).toBe('dangerous');
    expect(ask('echo hi; cat .env', 'bash').classification).toBe('dangerous');
    expect(ask('bash -c "cat .env"', 'bash').classification).toBe('dangerous');
  });

  it('asks when a secret read uses Git Bash drive spellings or a literal variable', () => {
    for (const command of [
      'cat "/c/Users/someone/.forge/agent-bus/endpoint.json"',
      'cat "/C/Users/someone/.forge/agent-bus/endpoint.json"',
      'cat "/cygdrive/c/Users/someone/.forge/agent-bus/endpoint.json"',
      'D="/c/Users/someone/.forge/agent-bus" && cat "$D/endpoint.json"',
    ]) {
      expect(ask(command, 'bash').classification, command).toBe('dangerous');
    }
  });
});

describe('what the gate must not ask about', () => {
  // Whole-token matching is the difference between this gate being usable and
  // being switched off: `git rm -f notes.env.md` is not a `.env` read.
  it('does not mistake a longer name for a secret', () => {
    for (const command of [
      'git rm -f notes.env.md',
      'cat notes.env.md',
      'ls environment',
    ] as const) {
      const result = ask(command, 'bash');
      expect(result.rule?.description ?? '').not.toContain('secret path');
    }
    expect(ask('cat notes.env.md', 'bash').classification).toBe('read_only');
  });

  // A here-document body is stdin, not commands: the text inside it is not a
  // path anyone is reading. The command itself still asks, because `<` is a
  // redirection and `parseCommand` already treats a redirection as more than a
  // read — what this test pins is that the BODY is not what made it ask.
  it('does not read the body of a here-document as a path', () => {
    const result = ask("cat <<'EOF'\nnotes about .env here\nEOF", 'bash');
    expect(result.rule?.description ?? '').not.toContain('secret path');
    expect(ask("cat <<'EOF'\nnotes about .env here\nEOF", 'bash').classification).toBe('normal');
  });

  it('leaves ordinary read-only commands auto-approved', () => {
    for (const [command, shell] of [
      ['ls -la', 'bash'],
      ['cat README.md', 'bash'],
      ['Get-ChildItem -Force', 'pwsh'],
      ['git status --short', 'bash'],
      ['ls src/{a,b}.ts', 'bash'],
      ['Get-Content C:\\notes.txt', 'pwsh'],
    ] as const) {
      expect(ask(command, shell).classification).toBe('read_only');
    }
  });

  // The committed templates carry names, not values, and the agent reads them
  // every session: `read_file .env.example` runs with no card, and so does the
  // shell equivalent, or the gate would be answering the same file all day.
  it('lets the committed templates through', () => {
    for (const command of [
      'cat .env.example',
      'cat .env.sample',
      'cat .env.template',
      'cat src/.env.example',
    ] as const) {
      expect(ask(command, 'bash').classification).toBe('read_only');
    }
  });

  // `permissions.secret_paths_allow` is the escape hatch for a job that
  // genuinely needs one file: naming the exact path stops the ask.
  it('honours the allow list', () => {
    const config = {
      permissions: { secret_paths_allow: ['.env'] },
    } as unknown as ForgeConfig;
    expect(ask('cat .env', 'bash', { ...win, getConfig: () => config }).classification).toBe(
      'read_only',
    );
    expect(ask('cat .env.local', 'bash', { ...win, getConfig: () => config }).classification).toBe(
      'dangerous',
    );
  });

  // The owner writes the allow entry as the path they mean — absolute — and the
  // command names the same file relative to the folder it runs in. Re-run finding
  // 3 of the 2026-10-28 live security test: the card asked anyway, because only
  // the spelling inside the token was compared with the list.
  it('honours an allow entry naming the file the command reaches from its cwd', () => {
    const config = {
      permissions: { secret_paths_allow: ['N:/ws/.env'] },
    } as unknown as ForgeConfig;
    const at = { ...win, getConfig: () => config, cwd: 'N:/ws' };
    for (const command of ['cat .env', 'cat ./.env', 'cat N:/ws/.env'] as const) {
      expect(ask(command, 'bash', at).classification, `${command} should run`).toBe('read_only');
    }
    expect(ask('cat other/.env', 'bash', at).classification).toBe('dangerous');
    expect(ask('cat .env.local', 'bash', at).classification).toBe('dangerous');
    // The same relative token in a different folder is a different file, so it
    // still asks: the fix recognises one file, not every file with that name.
    expect(ask('cat .env', 'bash', { ...at, cwd: 'N:/ws/other' }).classification).toBe('dangerous');
    // And the read still costs this chat its next fetch — the hatch skips the
    // card, never the taint (case 5 of the same report).
    expect(ask('cat .env', 'bash', at).readSecretIgnoringAllowList).toBe('**/.env');
  });

  it('gates a path this PC added to the list', () => {
    const config = {
      permissions: { secret_paths: ['N:/vs code apps/private-repo/**'] },
    } as unknown as ForgeConfig;
    const check = { ...win, getConfig: () => config };
    const result = ask('cat "N:/vs code apps/private-repo/notes.md"', 'bash', check);
    expect(result.classification).toBe('dangerous');
    expect(result.rule?.description).toContain('N:/vs code apps/private-repo/**');
    // Typed without quotes, the shell splits that path into three words, and no
    // token matcher can put them back together — `cat N:/vs code apps/x` really
    // does read three files. Documented rather than fixed: the fix would be
    // re-quoting the agent's own command line, which this gate does not do.
    expect(ask('cat N:/vs code apps/private-repo/notes.md', 'bash', check).classification).not.toBe(
      'dangerous',
    );
  });

  it('still refuses what the deny list refuses, whatever the path', () => {
    expect(ask('rm -rf ~/.ssh', 'bash').classification).toBe('dangerous');
    expect(ask('Remove-Item -Recurse .env', 'pwsh').classification).toBe('dangerous');
  });
});

describe('a path built at run time asks, because nothing can judge it', () => {
  // The plan's phase-1 trap. `parseCommand` already disqualifies `$(` and a
  // backtick from read-only, so the gap was the plain concatenation and the
  // variable: those now classify `normal` (asks) instead of `read_only`.
  const cases = [
    ['Get-Content ("src/" + "app.ts")', 'pwsh'],
    ['cat src/$name', 'bash'],
    ['Get-Content ($env:TEMP + "\\notes.txt")', 'pwsh'],
    ["cat $(printf '%s' ~/.s)sh/id_rsa", 'bash'],
  ] as const;

  it.each(cases)('%s → asks', (command, shell) => {
    expect(['normal', 'dangerous']).toContain(ask(command, shell).classification);
  });

  // Asked the other way round: the same commands with a path written out must
  // not ask, or the rule is just "shell always asks".
  it('does not ask when the same path is written out', () => {
    expect(ask('cat src/app.ts', 'bash').classification).toBe('read_only');
    expect(ask('Get-Content src\\app.ts', 'pwsh').classification).toBe('read_only');
    expect(ask('ls src/{a,b}.ts', 'bash').classification).toBe('read_only');
  });
});

describe('the shell tool carries the gate to the card', () => {
  const tool = makeShellTool({ home: HOME, platform: 'win32' });

  it('describes the foreground limit and names the background alternative in its error', async () => {
    const timeout = tool.describe?.()?.function.parameters.properties['timeout_ms'];
    expect(timeout?.description).toContain('1,000–600,000 ms');
    expect(timeout?.description).toContain('(default 120,000)');
    expect(timeout?.description).toContain('background: true');
    const error =
      'shell: timeout_ms must be a whole number of milliseconds. ' +
      'Foreground timeout: 1,000–600,000 ms (default 120,000); set background: true for longer commands.';
    await expect(tool.handler({ command: 'echo hi', timeout_ms: 600001 })).rejects.toThrow(
      error,
    );
    await expect(tool.handler({ command: 'echo hi', timeout_ms: 1500.5 })).rejects.toThrow(error);
  });

  it('asks as dangerous, naming the pattern, as a gate only the owner may answer', () => {
    const card = tool.approval?.({ command: 'Get-Content .env', shell: 'pwsh' });
    expect(card?.dangerous).toBe(true);
    expect(card?.detail).toContain('.env');
    expect(card?.cardReason).toContain('reads a secret path (**/.env)');
    expect(card?.gateKind).toBe('ownerGate');
    expect(card?.declineHint).toContain('permissions.secret_paths_allow');
  });

  it('does not auto-approve a secret read, and still auto-approves a safe one', () => {
    expect(tool.autoApproveIf?.({ command: 'Get-Content .env', shell: 'pwsh' })).toBe(false);
    expect(tool.autoApproveIf?.({ command: 'ls -la', shell: 'bash' })).toBe(true);
    expect(tool.autoApproveIf?.({ command: 'Get-Content README.md', shell: 'pwsh' })).toBe(true);
  });

  // Without the check the tool loses the gate silently, which is the failure
  // mode that matters: `registerAllTools` only passes `getConfig` when a config
  // getter exists.
  it('still gates when no config getter was passed', () => {
    const bare = makeShellTool({ home: HOME, platform: 'win32' });
    expect(bare.approval?.({ command: 'cat ~/.ssh/id_rsa', shell: 'bash' })?.dangerous).toBe(true);
  });
});
