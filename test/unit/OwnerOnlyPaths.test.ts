import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ownerOnlyInstruction,
  ownerOnlySetFor,
  ownerOnlyStatementTargetFor,
  ownerOnlyToolRefusal,
  ownerOnlyWriteTargetFor,
  type OwnerOnlyHit,
  type OwnerOnlySet,
} from '../../src/tools/ownerPaths';
import { classifyShellCommand } from '../../src/tools/shellPolicy';
import { normalizePathForMatch } from '../../src/tools/secretPaths';

/**
 * Lane A of `docs/plans/OWNER_GUARDS_PLAN.md` item 4: Forge's own configuration
 * is owner-only, because an agent could otherwise edit the file its guards live
 * in and switch them off for itself.
 *
 * The fixture is deliberately made-up — `C:/Users/someone`, `N:/Apps/Forge` —
 * and `platform` is passed in rather than read: the guard judges a path as the
 * OS it is told about, so these same expectations hold on the Linux and macOS
 * CI runners, where a `N:/…` path means nothing to `path.posix`.
 */
const HOME = 'C:/Users/someone';
const WORKSPACE = 'N:/Apps/Forge';
const GLOBAL_CONFIG =
  'C:/Users/someone/AppData/Roaming/Code/User/globalStorage/forge-llm/config.yaml';
const win = { home: HOME, platform: 'win32' as const };
const set: OwnerOnlySet = ownerOnlySetFor({
  configPath: GLOBAL_CONFIG,
  workspaceRoot: WORKSPACE,
  ...win,
});
/** What `classifyShellCommand` is given in production: the roots, the home folder `~` expands against, the OS, and the folder the command runs in. */
const check = {
  ownerOnly: set.roots,
  home: HOME,
  platform: 'win32',
  cwd: WORKSPACE,
  readScript: () => '',
};

describe('the owner-only set', () => {
  it('holds ~/.forge plus both config.yaml files while no policy file exists', () => {
    // The fixture home has no policy.yaml, which is the un-migrated state: the
    // guards are still inside config.yaml, so that file is a root too. Order is
    // the order `ownerOnlySetFor` adds them — the folder it always protects first.
    expect(set.roots).toEqual([
      'c:/users/someone/.forge',
      'c:/users/someone/appdata/roaming/code/user/globalstorage/forge-llm/config.yaml',
      'n:/apps/forge/.forge/config.yaml',
    ]);
  });

  it('does not list the workspace config twice when it IS the loaded one', () => {
    const oneWindow = ownerOnlySetFor({
      configPath: 'N:/Apps/Forge/.forge/config.yaml',
      workspaceRoot: 'n:/apps/forge',
      ...win,
    });
    expect(oneWindow.roots).toEqual([
      'c:/users/someone/.forge',
      'n:/apps/forge/.forge/config.yaml',
    ]);
  });

  it('keeps the case a Linux or macOS file system keeps', () => {
    const onLinux = ownerOnlySetFor({
      configPath: '/home/dev/proj/.forge/config.yaml',
      workspaceRoot: '/home/dev/proj',
      home: '/home/dev',
      platform: 'linux',
    });
    expect(onLinux.roots).toEqual(['/home/dev/.forge', '/home/dev/proj/.forge/config.yaml']);
  });
});

/**
 * The other half of phase 3, on a real folder. `existsSync` cannot be faked, and
 * the question the guard asks is whether `~/.forge/policy.yaml` is there, so this
 * half of the rule needs a file that really exists. The fixture homes above are
 * made-up paths that cannot contain a policy file, which is why they model the
 * un-migrated state and this one models the migrated.
 *
 * `test/support/tempGuard.setup.ts` fails a test file that leaves anything in its
 * temp folder, so the folder is removed in `afterAll`.
 */
describe('the owner-only set once the policy file exists', () => {
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-policy-home-'));
  const realWorkspace = path.join(realHome, 'workspace');
  const realPolicy = path.join(realHome, '.forge', 'policy.yaml');
  const realConfig = path.join(realWorkspace, '.forge', 'config.yaml');
  fs.mkdirSync(path.join(realHome, '.forge'), { recursive: true });
  fs.mkdirSync(path.join(realWorkspace, '.forge'), { recursive: true });
  fs.writeFileSync(realPolicy, '# the owner wrote this\n', 'utf8');
  fs.writeFileSync(realConfig, 'active_model: none\nmodels: []\n', 'utf8');
  afterAll(() => fs.rmSync(realHome, { recursive: true, force: true }));

  /** Exactly what `registerAllTools.ts` builds per decision, from the same facts. */
  const built = () =>
    ownerOnlySetFor({
      configPath: realConfig,
      workspaceRoot: realWorkspace,
      home: realHome,
      platform: process.platform,
    });
  const expectedHomeRoot = normalizePathForMatch(
    path.resolve(path.join(realHome, '.forge')),
    process.platform,
  );

  it('holds ~/.forge alone, so config.yaml is an ordinary file an agent may edit', () => {
    expect(built().roots).toEqual([expectedHomeRoot]);
    expect(ownerOnlyWriteTargetFor('.forge/config.yaml', built(), realWorkspace)).toBeUndefined();
    expect(
      ownerOnlyStatementTargetFor(
        ['Add-Content', '.forge/config.yaml', 'x'],
        built(),
        realWorkspace,
      ),
    ).toBeUndefined();
    // The owner's file beside them is not: it is what says what an agent may do, and
    // it lives in the folder that is still protected.
    expect(
      ownerOnlyWriteTargetFor(path.join(realHome, '.forge', 'policy.yaml'), built()).root,
    ).toBe(expectedHomeRoot);
    // A config.yaml that lives inside ~/.forge is still refused, by the folder and
    // not by its name: the root is what the rule protects, which is why opening
    // config.yaml to agents did not open the owner's own copy of it.
    expect(
      ownerOnlyWriteTargetFor(path.join(realHome, '.forge', 'config.yaml'), built()),
    ).toBeDefined();
  });

  it('asks again on every decision, so deleting policy.yaml brings the wall back at once', () => {
    // Claude's condition on the phase-3 gate: a cached "the policy file is there"
    // would leave config.yaml open after the owner removed the file that made
    // opening it safe. The guard rebuilds its set per call, so the next edit is
    // refused without a window reload.
    const openBefore = ownerOnlyWriteTargetFor('.forge/config.yaml', built(), realWorkspace);
    expect(openBefore).toBeUndefined();
    fs.rmSync(realPolicy);
    const after = built();
    expect(after.roots).toEqual([
      expectedHomeRoot,
      normalizePathForMatch(path.resolve(realConfig), process.platform),
    ]);
    expect(ownerOnlyWriteTargetFor('.forge/config.yaml', after, realWorkspace)?.target).toBe(
      normalizePathForMatch(path.resolve(realConfig), process.platform),
    );
    fs.writeFileSync(realPolicy, '# the owner put it back\\n', 'utf8');
    expect(ownerOnlyWriteTargetFor('.forge/config.yaml', built(), realWorkspace)).toBeUndefined();
  });
});

describe('which write targets are owner-only', () => {
  it('refuses the workspace config however it is spelled', () => {
    for (const spelling of [
      '.forge/config.yaml',
      './.forge/config.yaml',
      '.FORGE\\Config.yaml',
      './x/../.forge/config.yaml',
      'N:/Apps/Forge/.forge/config.yaml',
      'n:/apps/forge/.FORGE/config.yaml',
      './.forge/./config.yaml',
    ]) {
      expect(ownerOnlyWriteTargetFor(spelling, set)?.target, `${spelling} should be refused`).toBe(
        'n:/apps/forge/.forge/config.yaml',
      );
    }
  });

  it('refuses the file this window loaded, and anything under ~/.forge/', () => {
    expect(ownerOnlyWriteTargetFor('~/.forge/sessions/chat.jsonl', set)?.target).toBe(
      'c:/users/someone/.forge/sessions/chat.jsonl',
    );
    expect(
      ownerOnlyWriteTargetFor('$env:USERPROFILE\\.forge\\jobs\\nightly.json', set)?.target,
    ).toBe('c:/users/someone/.forge/jobs/nightly.json');
    expect(ownerOnlyWriteTargetFor(GLOBAL_CONFIG, set)?.target).toBe(
      'c:/users/someone/appdata/roaming/code/user/globalstorage/forge-llm/config.yaml',
    );
  });

  it('refuses a folder that would take the config with it', () => {
    expect(ownerOnlyWriteTargetFor('~/.forge', set)?.root).toBe('c:/users/someone/.forge');
    expect(ownerOnlyWriteTargetFor('~/.forge/jobs', set)?.target).toBe(
      'c:/users/someone/.forge/jobs',
    );
  });

  it('opens only memory markdown files inside a project folder and files inside skills', () => {
    for (const spelling of [
      '~/.forge/memories/Forge-5f7df423/basalt-parked-2026-11-01.md',
      '~/.forge/memories/Qwen_fine_tuning-e6c968d1/MEMORY.md',
      '~/.forge/skills/hf-download/SKILL.md',
      '~/.forge/skills/new-skill/scripts/run.py',
    ]) {
      expect(ownerOnlyWriteTargetFor(spelling, set), `${spelling} should be open`).toBeUndefined();
    }
  });

  it.each([
    '~/.forge/policy.yaml',
    '~/.forge/jobs/strata-update.json',
    '~/.forge/sessions/x.jsonl',
    '~/.forge/notify.ps1',
    '~/.forge/agent-bus/forge.sh',
    '~/.forge/memories',
    '~/.forge/memories/Forge-5f7df423',
    '~/.forge/memories/x.md',
    '~/.forge/memories/Forge-5f7df423/sub/x.md',
    '~/.forge/memories/Forge-5f7df423/x.json',
    '~/.forge/skills',
    '~/.forge/skills-retired/x/SKILL.md',
    '~/.forge/memoriesX/a/b.md',
    '~/.forge/skills/../policy.yaml',
    '~/.forge/memories/Forge-5f7df423/../../policy.yaml',
  ])('keeps the non-open target owner-only: %s', (spelling) => {
    expect(ownerOnlyWriteTargetFor(spelling, set), `${spelling} should be refused`).toBeDefined();
  });

  it('gives shell writes the same open memory and skills decisions as file tools', () => {
    expect(
      classifyShellCommand('echo x > ~/.forge/jobs/a.json', 'bash', check).classification,
    ).toBe('refused');
    expect(
      classifyShellCommand('echo x > ~/.forge/skills/a/SKILL.md', 'bash', check).classification,
    ).not.toBe('refused');
    expect(
      classifyShellCommand(
        'cd ~/.forge/memories/Forge-5f7df423 && echo x > notes.md',
        'bash',
        check,
      ).classification,
    ).not.toBe('refused');
  });

  it('leaves a config.yaml outside .forge/ writable', () => {
    for (const writable of [
      'config.yaml',
      'src/config.yaml',
      'N:/Apps/Forge/config.yaml',
      '.forge/config.yaml.bak',
      '.forge/tmp/launcher.vbs',
      'forge/config.yaml',
      'C:/Users/someone/.forge2/x.json',
      'C:/Users/someone/project/.forge/config.yaml',
    ]) {
      expect(
        ownerOnlyWriteTargetFor(writable, set),
        `${writable} should be writable`,
      ).toBeUndefined();
    }
  });

  it('cannot judge a relative path with no folder to resolve against, so it allows it', () => {
    const noWorkspace = { roots: set.roots, ...win };
    expect(ownerOnlyWriteTargetFor('.forge/config.yaml', noWorkspace)).toBeUndefined();
    // An absolute spelling needs no base, so it is still judged.
    expect(ownerOnlyWriteTargetFor('N:/Apps/Forge/.forge/config.yaml', noWorkspace)).toBeDefined();
  });

  it('does not mistake a PowerShell flag for a destination (lab T22)', () => {
    // Reproduced from the lab: a command run from inside `~/.forge` where a bare
    // `-Force` resolved against the current folder, landed inside the owner-only
    // root, and the refusal named the flag as the file it supposedly refused to
    // change — which sent one chat into a 17-command re-spelling loop.
    const forgeHome = `${HOME}/.forge`;
    // The flag alone, judged from inside the root: skipped, so no hit.
    expect(ownerOnlyStatementTargetFor(['Set-Content', '-Force'], set, forgeHome)).toBeUndefined();
    // The real destination in the same shape is still caught: the flag is skipped, the path is not.
    expect(
      ownerOnlyStatementTargetFor(
        ['Set-Content', '-Force', 'config.yaml'],
        set,
        forgeHome,
      )?.target,
    ).toContain('/.forge/config.yaml');
    // Claude review 2026-11-09 item 3: in PowerShell the destination can sit *inside* the flag
    // token (`-Path:<file>`), and skipping the whole token would let an owner-only write through.
    // The bare-flag skip (T22) must stay; the colon form must still be judged.
    expect(
      ownerOnlyStatementTargetFor(
        ['Set-Content', '-Path:C:/Users/someone/.forge/policy.yaml', 'x'],
        set,
        forgeHome,
      )?.target,
    ).toContain('/.forge/policy.yaml');
    expect(
      ownerOnlyStatementTargetFor(
        ['Out-File', '-FilePath:C:/Users/someone/.forge/x.txt'],
        set,
        forgeHome,
      )?.target,
    ).toContain('/.forge/x.txt');
    // Claude review on f6a977a9 item 2: a colon value that is not a path (`-Encoding:utf8`,
    // `-Force:$true`) must be skipped exactly like the bare `-Force` above, not resolved against
    // the current folder — and a real path after the colon is still judged even when the
    // surrounding command is otherwise all flags.
    expect(ownerOnlyStatementTargetFor(['Get-ChildItem', '-Force:$true'], set, forgeHome)).toBeUndefined();
    expect(ownerOnlyStatementTargetFor(['Get-ChildItem', '-Filter:*.yaml'], set, forgeHome)).toBeUndefined();
    expect(
      ownerOnlyStatementTargetFor(['Set-Content', '-Encoding:utf8', 'config.yaml'], set, forgeHome)
        ?.target,
    ).toContain('/.forge/config.yaml');
  });

  it('resolves a command against the folder it runs in, including a nested repo', () => {
    const nested = 'N:/Apps/Forge/threejs-game';
    const nestedSet = ownerOnlySetFor({ workspaceRoot: nested, ...win });
    // A command run inside a project's .forge folder names its config bare.
    expect(
      ownerOnlyStatementTargetFor(
        ['Add-Content', 'config.yaml', 'x'],
        nestedSet,
        `${nested}/.forge`,
      )?.target,
    ).toBe('n:/apps/forge/threejs-game/.forge/config.yaml');
    // Run from the nested project's own root, the same relative spelling resolves
    // under it rather than under the outer workspace.
    expect(
      ownerOnlyStatementTargetFor(['Add-Content', '.forge/config.yaml', 'x'], nestedSet, nested)
        ?.target,
    ).toBe('n:/apps/forge/threejs-game/.forge/config.yaml');
    // Each window guards what it loads: the outer set refuses the outer file and
    // says nothing about a nested project's own config.
    expect(
      ownerOnlyStatementTargetFor(['Add-Content', '.forge/config.yaml', 'x'], set, WORKSPACE)
        ?.target,
    ).toBe('n:/apps/forge/.forge/config.yaml');
    expect(
      ownerOnlyStatementTargetFor(['Add-Content', 'config.yaml', 'x'], set, `${nested}/.forge`),
    ).toBeUndefined();
  });

  it('skips an argument that is a variable assignment, not a path', () => {
    expect(
      ownerOnlyStatementTargetFor(['env', 'FOO=.forge/config.yaml', 'printf', 'x'], set, WORKSPACE),
    ).toBeUndefined();
  });

  it('skips the program token, so a path in position zero is not a write onto it', () => {
    expect(ownerOnlyStatementTargetFor(['Add-Content', 'x', 'y'], set, WORKSPACE)).toBeUndefined();
    expect(
      ownerOnlyStatementTargetFor([`${WORKSPACE}/.forge/config.yaml`, 'run'], set, WORKSPACE),
    ).toBeUndefined();
  });

  it('does not treat a script being executed as a write target', () => {
    for (const [command, shell] of [
      ['pwsh -NoProfile -File ~/.forge/scripts/w.ps1', 'pwsh'],
      ['pwsh -f ~/.forge/scripts/w.ps1', 'pwsh'],
      ['powershell -FILE ~/.forge/scripts/w.ps1', 'pwsh'],
      ['bash ~/.forge/agent-bus/forge.sh who', 'bash'],
      ['sh ~/.forge/agent-bus/forge.sh who', 'bash'],
      ['bash -- ~/.forge/agent-bus/forge.sh who', 'bash'],
      [`bash ${HOME}/.forge/agent-bus/forge.sh who`, 'bash'],
      ['bash -c "~/.forge/agent-bus/forge.sh who"', 'bash'],
      ['~/.forge/scripts/w.ps1', 'pwsh'],
      ['& ~/.forge/scripts/w.ps1', 'pwsh'],
    ] as const) {
      expect(classifyShellCommand(command, shell, check).classification, command).toBe('normal');
    }
  });
});

describe('the shell route onto Forge own configuration', () => {
  const judged = (command: string, shell: 'bash' | 'pwsh') =>
    classifyShellCommand(command, shell, check);

  it('refuses writing, copying, moving, deleting and redirecting onto it, in both shells', () => {
    const refused: Array<[string, 'bash' | 'pwsh']> = [
      ['Add-Content .forge/config.yaml x', 'pwsh'],
      ['Set-Content .forge/config.yaml x', 'pwsh'],
      ['echo x > .forge/config.yaml', 'bash'],
      ['echo x >> ~/.forge/notes.txt', 'bash'],
      ['cp a.yaml .forge/config.yaml', 'bash'],
      ['Copy-Item a.yaml .forge/config.yaml', 'pwsh'],
      ['mv .forge/config.yaml /tmp/x', 'bash'],
      ['Move-Item .forge/config.yaml x.bak', 'pwsh'],
      ['rm .forge/config.yaml', 'bash'],
      ['Remove-Item .forge/config.yaml', 'pwsh'],
      ['rm -rf ~/.forge', 'bash'],
      ['sed -i s/a/b/ .forge/config.yaml', 'bash'],
      ['tee .forge/config.yaml', 'bash'],
      ['git rm -f .forge/config.yaml', 'bash'],
      ['bash ~/.forge/x.sh > ~/.forge/out.txt', 'bash'],
      ['bash -c "rm ~/.forge/jobs/a.json"', 'bash'],
      ['cp a.txt ~/.forge/x', 'bash'],
      ['pwsh -File ~/.forge/x.ps1 -Out ~/.forge/config.yaml', 'pwsh'],
      ['Set-Content ~/.forge/x.txt hi', 'pwsh'],
      ['bash ~/.forge/x.sh ~/.forge/config.yaml', 'bash'],
      ['Add-Content .FORGE\\Config.yaml x', 'pwsh'],
      ['Add-Content ./x/../.forge/config.yaml x', 'pwsh'],
      ['bash -c "echo x > .forge/config.yaml"', 'bash'],
      ['pwsh -Command "Remove-Item .forge/config.yaml"', 'pwsh'],
      ['printf x | Out-File ~/.forge/notes.txt', 'pwsh'],
    ];
    for (const [command, shell] of refused) {
      const result = judged(command, shell);
      expect(
        result.classification,
        `${shell}: ${command} — expected refused, got ${result.classification}`,
      ).toBe('refused');
      // The refusal the agent reads has to say who may change the file and what
      // to do about it, or it goes looking for another way.
      expect(result.rule?.alternative).toMatch(/owner only|only the owner/);
      expect(result.rule?.alternative).toMatch(/Tell the user what change you want and why/);
    }
  });

  it('refuses a redirect onto it even when the program itself is read-only', () => {
    // `echo` and `cat` are on the read-only table; the `>` is what writes, and
    // the target is the write, not the other file the command names.
    expect(judged('echo done > ~/.forge/state/build.txt', 'bash').classification).toBe('refused');
    expect(judged('cat notes.txt > ~/.forge/x', 'bash').classification).toBe('refused');
  });

  it('refuses Git Bash drive spellings and literal same-line variables', () => {
    for (const command of [
      'rm "/c/Users/someone/.forge/jobs/a.py"',
      'cp x.py "/c/Users/someone/.forge/jobs/a.py"',
      'rm "/C/Users/someone/.forge/jobs/a.py"',
      'rm "/cygdrive/c/Users/someone/.forge/jobs/a.py"',
      'D="/c/Users/someone/.forge/jobs" && rm "$D/a.py"',
      'export D="/c/Users/someone/.forge/jobs"; rm "${D}/a.py"',
    ]) {
      expect(judged(command, 'bash').classification, command).toBe('refused');
    }
  });

  it('maps Git Bash drives only on Windows and leaves ordinary POSIX paths alone', () => {
    expect(normalizePathForMatch('/c/Users/someone/.forge/x', 'win32')).toBe(
      'c:/users/someone/.forge/x',
    );
    expect(normalizePathForMatch('/C/Users/someone/.forge/x', 'win32')).toBe(
      'c:/users/someone/.forge/x',
    );
    expect(normalizePathForMatch('/cygdrive/c/Users/someone/.forge/x', 'win32')).toBe(
      'c:/users/someone/.forge/x',
    );
    expect(normalizePathForMatch('/c/Users/someone/.forge/x', 'linux')).toBe(
      '/c/Users/someone/.forge/x',
    );
    expect(normalizePathForMatch('/tmp/x', 'win32')).toBe('/tmp/x');
    expect(normalizePathForMatch('/usr/bin', 'win32')).toBe('/usr/bin');
    expect(normalizePathForMatch('/C', 'win32')).toBe('c:/');
  });

  it('leaves a non-literal variable assignment as an unexpanded residual gap', () => {
    expect(() => judged('D="$(pwd)/.forge" && rm "$D/a.py"', 'bash')).not.toThrow();
    expect(judged('D="$(pwd)/.forge" && rm "$D/a.py"', 'bash').classification).toBe('normal');
  });

  it('leaves a read of the same path open', () => {
    const open: Array<[string, 'bash' | 'pwsh']> = [
      ['Get-Content .forge/config.yaml', 'pwsh'],
      ['cat .forge/config.yaml', 'bash'],
      ['git diff .forge/config.yaml', 'bash'],
      ['git diff -- .FORGE/Config.yaml', 'bash'],
      ['rg active_model .forge/config.yaml', 'bash'],
      ['Get-Content ~/.forge/sessions/chat.jsonl', 'pwsh'],
      ['cat .forge/config.yaml > /tmp/backup.txt', 'bash'],
      ["sed -n '1p' .forge/config.yaml", 'bash'],
      ['type .forge/config.yaml', 'pwsh'],
      ['head -n 5 .forge/config.yaml', 'bash'],
      ['wc -l .forge/config.yaml', 'bash'],
      ['ls .forge', 'bash'],
      // Lab T22: a piped read run from inside the root. Before the flag guard, the bare
      // `-Force` resolved against the current folder and the refusal named the flag as the
      // write target — a write-class shape; the read shape below was always let through.
      ['Get-ChildItem -Force . | Measure-Object).Count', 'pwsh'],
      ['Get-ChildItem -Force . | Select-Object -Expand Count', 'pwsh'],
    ];
    for (const [command, shell] of open) {
      const result = classifyShellCommand(command, shell, check);
      expect(
        result.classification,
        `${shell}: ${command} — expected to run, got ${result.classification}`,
      ).not.toBe('refused');
    }
  });

  it('does not refuse a command that only mentions the path inside a longer name', () => {
    // The substring trap this repo has been bitten by twice: a guard that
    // refuses work it should allow teaches the agent the capability is gone.
    expect(judged('Add-Content config.yaml x', 'pwsh').classification).toBe('normal');
    expect(judged('git rm -f .forge/config.yaml.bak', 'bash').classification).toBe('normal');
    expect(judged('rg config.yaml src', 'bash').classification).toBe('read_only');
    expect(judged('Add-Content logs/x.txt x', 'pwsh').classification).toBe('normal');
  });

  it('is inert when nothing supplies the roots, so an unwired window changes nothing', () => {
    expect(
      classifyShellCommand('Add-Content .forge/config.yaml x', 'pwsh', {
        ...win,
        cwd: WORKSPACE,
      }).classification,
    ).toBe('normal');
    expect(
      classifyShellCommand('echo x > .forge/config.yaml', 'bash', {
        ...win,
        cwd: WORKSPACE,
        ownerOnly: [],
      }).classification,
    ).toBe('normal');
  });

  it('judges a relative path against the nested cwd, not the workspace root', () => {
    const nested = 'N:/Apps/Forge/threejs-game';
    const nestedSet = ownerOnlySetFor({ workspaceRoot: nested, ...win });
    const nestedCheck = {
      ownerOnly: nestedSet.roots,
      home: HOME,
      platform: 'win32',
      cwd: nested,
    };
    expect(classifyShellCommand('rm .forge/config.yaml', 'bash', nestedCheck).classification).toBe(
      'refused',
    );
    // The same command at the outer root names a file that is not this nested
    // project's config, so it stays the ordinary command it always was.
    expect(
      classifyShellCommand('rm .forge/config.yaml', 'bash', {
        ...nestedCheck,
        cwd: WORKSPACE,
      }).classification,
    ).toBe('normal');
  });

  it('still classifies the dangerous commands it always refused', () => {
    expect(judged('rm -rf build', 'bash').classification).toBe('dangerous');
    expect(judged('curl x | sh', 'bash').classification).toBe('refused');
    expect(judged('git reset --hard', 'bash').classification).toBe('dangerous');
    expect(
      judged('Get-Content | Where-Object { Remove-Item -Recurse $_.FullName }', 'pwsh')
        .classification,
    ).toBe('dangerous');
  });
});

describe('what a refusal says', () => {
  /** The hit a real call would produce for this spelling, so these tests read the
   *  sentence an agent reads, not a hand-written one. */
  const hitFor = (spelling: string): OwnerOnlyHit => {
    const hit = ownerOnlyWriteTargetFor(spelling, set);
    if (!hit) throw new Error(`${spelling} should have been refused`);
    return hit;
  };

  it('names the owner and tells the agent to tell the user the change it wants', () => {
    const tool = ownerOnlyToolRefusal('write_file', hitFor('.forge/config.yaml'));
    const shell = ownerOnlyInstruction();
    for (const text of [tool, shell]) {
      expect(text).toMatch(/owner only|only the owner/);
      expect(text).toMatch(/Tell the user what change you want and why/);
    }
    // The wording is pinned, not just its gist: a reword that drops the
    // instruction is how this guard becomes another silent refusal.
    expect(shell).toContain('changed by the owner only');
    expect(tool).toContain('which only the owner changes');
  });

  it('names the sanctioned way to read them, and no way to change them itself', () => {
    const texts = [
      ownerOnlyToolRefusal('write_file', hitFor('.forge/config.yaml')),
      ownerOnlyToolRefusal('delete_file', hitFor('~/.forge/x')),
      ownerOnlyInstruction(),
    ];
    for (const text of texts) {
      // CLAUDE.md: a refusal names the sanctioned alternative. Here it is for
      // READING: the call that got refused in the re-run was reading session logs
      // with a `python -` one-liner, and nothing in the refusal told it that
      // `read_file` was open to it all along.
      expect(text).toContain('read_file');
      expect(text).toContain('search_code');
      // Not a write tool, though: naming one would invite the agent to try its
      // own hand at the file the owner forbade it from touching.
      expect(text).not.toMatch(/use `?(edit_file|write_file|restore_file|delete_file|move_file)/);
      expect(text).not.toMatch(/permissions\.[a-z_]+/);
    }
  });

  // `~/.forge/` holds session logs and jobs as well as settings, and the old text
  // called all of it "configuration": the agent that was refused for reading a log
  // believed the READ had been refused (re-run finding 2).
  it('never calls a session log, a job or the workspace config "configuration"', () => {
    for (const spelling of [
      '~/.forge/sessions/chat.jsonl',
      '~/.forge/jobs/nightly.json',
      '~/.forge/background-execs/x.json',
      '.forge/config.yaml',
    ]) {
      const text = ownerOnlyToolRefusal('write_file', hitFor(spelling));
      expect(text, `${spelling} is not a setting`).not.toMatch(/configuration/i);
    }
    // The shell rule's own line is the other half of what that agent read, so it
    // is checked too: the rule line and the instruction beside it.
    const rule = classifyShellCommand(
      'Add-Content ~/.forge/sessions/chat.jsonl x',
      'pwsh',
      check,
    ).rule;
    expect(rule?.description).toMatch(/Forge's own files/);
    expect(rule?.description).not.toMatch(/configuration/i);
    expect(rule?.alternative).not.toMatch(/configuration/i);
  });

  // The other half of re-run finding 5: the repo's own `.forge/config.yaml` is not
  // under `~/.forge/`, and a refusal that says "everything under `~/.forge/`" for
  // it sent the agent looking for a file that was never there.
  it('does not imply the workspace config lives under ~/.forge/', () => {
    const repo = ownerOnlyToolRefusal('write_file', hitFor('.forge/config.yaml'));
    expect(repo).toContain('the config file Forge loads');
    expect(repo).not.toContain('~/.forge/');
    // The folder's own files do say where they are, because that is where they are.
    const underHome = ownerOnlyToolRefusal('delete_file', hitFor('~/.forge/note.txt'));
    expect(underHome).toContain('~/.forge/');
    expect(underHome).toContain('it holds session logs and jobs');
  });

  it('uses the complete updated ~/.forge refusal text for policy.yaml', () => {
    expect(
      ownerOnlyToolRefusal('edit_file', hitFor('~/.forge/policy.yaml')),
    ).toBe(
      "edit_file: ~/.forge/policy.yaml is part of Forge's own files (everything under `~/.forge/` except memory files (`~/.forge/memories/<project>/<name>.md`) and skills (`~/.forge/skills/`); it holds session logs and jobs, and `policy.yaml` there is the owner's settings file, the one that says what an agent may do), which only the owner changes. Reading them with `read_file` or `search_code` is allowed. Tell the user what change you want and why, and let them make it.",
    );
  });
});
