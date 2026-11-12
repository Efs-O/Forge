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
  it('does not taint on PowerShell members, search patterns, commit messages or metadata', () => {
    const falseReads: Array<[string, 'bash' | 'pwsh']> = [
      ['Where-Object { $_.Key -match "*.key" }', 'pwsh'],
      ['pwsh -Command "Where-Object { $_.Key -match \'*.key\' }"', 'pwsh'],
      ['grep -n "--env" maya.py', 'bash'],
      ['rg -n "\\.env" test/a.ts test/b.ts', 'bash'],
      ['git add a && git commit -m "~/.ssh/id_ed25519"', 'bash'],
      ['ls -la "/c/Users/x/_netrc"', 'bash'],
      ['ls -t ~/.forge/agent-bus/endpoints', 'bash'],
      ['Get-ChildItem $HOME/.ssh/id_rsa', 'pwsh'],
      ['Get-Item ~/.ssh/id_rsa', 'pwsh'],
      // Bash pipes text, so a listing piped to a text filter shows names, not bytes —
      // and bash's `type` is the builtin that describes a command, not Get-Content.
      ['ls -la ~/.ssh/id_rsa | head', 'bash'],
      ['ls ~/.ssh/id_rsa | type', 'bash'],
      // xargs runs the program named after it, and `echo` prints the names it is handed.
      ['ls ~/.ssh/id_rsa | xargs echo', 'bash'],
      ['ls ~/.ssh/id_rsa | xargs -e echo', 'bash'],
      ['Get-ChildItem ~/.ssh/id_rsa | Measure-Object', 'pwsh'],
      ['Test-Path ~/.ssh/id_rsa', 'pwsh'],
      ['stat ~/.ssh/id_rsa', 'bash'],
      ['Select-String -Pattern ~/.ssh/id_rsa app.ps1', 'pwsh'],
      ['Select-String -Pattern KEY -Path app.ps1', 'pwsh'],
      ['Select-String -Pattern:~/.ssh/id_rsa app.ps1', 'pwsh'],
      ['Select-String -Patt KEY app.ps1', 'pwsh'],
    ];
    for (const [command, shell] of falseReads) {
      expect(ask(command, shell).readSecretIgnoringAllowList, command).toBeUndefined();
    }
  });

  it('keeps content reads in those command families tainted', () => {
    const realReads: Array<[string, 'bash' | 'pwsh']> = [
      ['Get-Content $HOME/.ssh/id_rsa', 'pwsh'],
      ['Get-Content $env:USERPROFILE\\.ssh\\id_rsa', 'pwsh'],
      ['grep KEY .env', 'bash'],
      ['grep -f .env x', 'bash'],
      ['git commit -F ~/.ssh/id_rsa', 'bash'],
      ['cat ~/.forge/agent-bus/endpoints/abc.json', 'bash'],
      ['awk 1 .env', 'bash'],
      ['Get-ChildItem $HOME/.ssh/id_rsa | Get-Content', 'pwsh'],
      // A metadata listing that flows to a content reader is a content read: in
      // PowerShell the pipe carries the file object, and `cat`/`gc`/`type` are
      // Get-Content's aliases while `sls` binds pipeline paths too.
      ['Get-ChildItem ~/.ssh/id_rsa | cat', 'pwsh'],
      ['Get-ChildItem ~/.ssh/id_rsa | type', 'pwsh'],
      ['Get-ChildItem ~/.ssh/id_rsa | gc', 'pwsh'],
      ['Get-ChildItem .env | sls KEY', 'pwsh'],
      // Bash pipes text, so only a target that re-opens the names reads them.
      ['ls ~/.ssh/id_rsa | xargs cat', 'bash'],
      ['ls ~/.ssh/id_rsa | xargs -n 1 cat', 'bash'],
      // xargs' own options take values in their own tokens, so the word after one of
      // them is not the program it runs.
      ['ls ~/.ssh/id_rsa | xargs --max-args 1 cat', 'bash'],
      ['ls ~/.ssh/id_rsa | xargs -s 100 cat', 'bash'],
      // Option values are read off `xargs --help` (GNU findutils 4.10.0): `-a` takes
      // one, `-e`/`--eof` take theirs optionally and must not swallow the program.
      ['ls ~/.ssh/id_rsa | xargs -e cat', 'bash'],
      ['ls ~/.ssh/id_rsa | xargs --eof cat', 'bash'],
      ['ls ~/.ssh/id_rsa | xargs -a /dev/stdin cat', 'bash'],
      // `--replace` takes its value optionally and only attached, and short options
      // cluster: `-rn 1` is `-r` followed by `-n 1`.
      ['ls ~/.ssh/id_rsa | xargs --replace cat {}', 'bash'],
      ['ls ~/.ssh/id_rsa | xargs -rn 1 cat', 'bash'],
      ['ls ~/.ssh/id_rsa | xargs -n1 cat', 'bash'],
      // Measured against this xargs: `-e` takes its EOF string attached, so `n` is not
      // an option; `--max-lines` takes its value attached only, so `cat` is the program;
      // and GNU resolves an unambiguous long prefix, so `--max-a 1` is `--max-args 1`.
      ['ls ~/.ssh/id_rsa | xargs -en cat', 'bash'],
      ['ls ~/.ssh/id_rsa | xargs --max-lines cat', 'bash'],
      ['ls ~/.ssh/id_rsa | xargs --max-a 1 cat', 'bash'],
      // A reader can sit behind an intermediate stage: the objects still flow to it.
      ['Get-ChildItem .env | Select-Object -First 1 | cat', 'pwsh'],
      ['Select-String -Pattern KEY ~/.ssh/id_rsa', 'pwsh'],
      // -Pattern named means a positional binds to -Path, so the file is read.
      ['Select-String -Path ~/.ssh/id_rsa -Pattern KEY', 'pwsh'],
      ['Select-String ~/.ssh/id_rsa -Pattern KEY', 'pwsh'],
      ['Select-String -Path .env -Pattern KEY', 'pwsh'],
      // PowerShell's colon form carries the file inside the token, and a named
      // -LiteralPath leaves the bare word to bind to -Pattern instead.
      ['Select-String -Path:~/.ssh/id_rsa -Pattern KEY', 'pwsh'],
      ['Select-String -LiteralPath ~/.ssh/id_rsa KEY', 'pwsh'],
      // PowerShell binds a parameter by any prefix naming exactly one: -Patt is
      // -Pattern, -Lit is -LiteralPath, -PS and -LP are its PSPath and LP aliases
      // (measured under pwsh 7.6.9: `Get-Command Select-String | % Parameters` reports
      // LiteralPath aliases PSPath,LP; -Pat and -Pa are refused as ambiguous).
      ['Select-String .env -Patt KEY', 'pwsh'],
      ['Select-String -LiteralP .env KEY', 'pwsh'],
      ['Select-String -Lit .env KEY', 'pwsh'],
      ['Select-String -LP .env KEY', 'pwsh'],
      ['Select-String -LP:.env KEY', 'pwsh'],
      ['Select-String -PS ~/.ssh/id_rsa -Pattern KEY', 'pwsh'],
    ];
    for (const [command, shell] of realReads) {
      expect(ask(command, shell).readSecretIgnoringAllowList, command).toBeDefined();
    }
  });

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

  it('carries a no-gate dangerous shell rule reason into approval metadata', () => {
    const metadata = tool.approval?.({
      command: 'pwsh -NoProfile -ExecutionPolicy Bypass -File V:\\Maya\\local\\update-maya.ps1',
      shell: 'bash',
    });
    expect(metadata?.cardReason).toBe(
      'Matched rule: runs a script Forge could not read (V:\\Mayalocalupdate-maya.ps1: does not exist; bash removed the backslashes in V:\\Maya\\local\\update-maya.ps1: pass shell "pwsh", or write the path with forward slashes)',
    );
    expect(metadata?.gateKind).toBeUndefined();
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
