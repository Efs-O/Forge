import { describe, expect, it } from 'vitest';
import { ownerOnlySetFor, type OwnerOnlySet } from '../../src/tools/ownerPaths';
import { classifyShellCommand } from '../../src/tools/shellPolicy';
import { isReadOnly } from '../../src/tools/shellReadOnlyRules';

/**
 * The three refusals the 2026-10-30 session-failure list found, each judged
 * through `classifyShellCommand` — the shape production uses — with the same
 * made-up fixture `OwnerOnlyPaths.test.ts` uses: `platform` is passed in rather
 * than read, so these expectations hold on the Linux and macOS runners too.
 */
const HOME = 'C:/Users/someone';
const WORKSPACE = 'N:/Apps/Forge';
const win = { home: HOME, platform: 'win32' as const };
const set: OwnerOnlySet = ownerOnlySetFor({
  configPath: 'C:/Users/someone/AppData/Roaming/Code/User/globalStorage/forge-llm/config.yaml',
  workspaceRoot: WORKSPACE,
  ...win,
});
const check = {
  ownerOnly: set.roots,
  home: HOME,
  platform: 'win32' as const,
  cwd: WORKSPACE,
};
const judged = (command: string, shell: 'bash' | 'pwsh') =>
  classifyShellCommand(command, shell, check).classification;

describe('inspection of Forge own files, which reads and changes nothing', () => {
  /**
   * BL-027. `test`, `[` and `[[` were absent from `READ_ONLY_UNIX` while
   * PowerShell's `test-path` sat in `READ_ONLY_PS`, so the file-existence check
   * an agent reaches for first was classed as a write, and `shellOwnerRule.ts`
   * answered it with `ruleFor` — "refuses to change Forge's own files" plus the
   * instruction to tell the user what change they want. Seen live on 2026-11-02
   * 23:37: a `test -f` of `~/.forge/policy.yaml` came back as that refusal, and
   * the `ls` joined to it on the same line was refused with it.
   */
  it('lets a file test ask about ~/.forge instead of refusing a read', () => {
    for (const command of [
      'test -f ~/.forge/policy.yaml',
      'test -f ~/.forge/policy.yaml && echo present',
      '[ -s ~/.forge/jobs/state/llama-updates.json ]',
      '[[ -d ~/.forge/sessions ]]',
      'true && test -e ~/.forge/policy.yaml',
      'test -f "$HOME/.forge/policy.yaml"',
    ]) {
      expect(judged(command, 'bash'), command).not.toBe('refused');
    }
  });

  it('does not let a command substitution inside a test hide a writer', () => {
    // The table says `test` reads its own arguments; it does not say whatever
    // `$( … )` runs is read-only, and the nested pass is what keeps that true.
    expect(judged('test -f "$(rm -rf ~/.forge/x)"', 'bash')).not.toBe('read_only');
  });

  /**
   * The same hazard with no `$()` for the nested pass to find: `[[ -eq` and its
   * siblings evaluate their operands as arithmetic, and `test -v` / `[ -v ]`
   * evaluates an array subscript, so a substitution written inside a QUOTED
   * operand still runs. Claude found both on review of BL-027.
   */
  it('does not class an arithmetic or subscript test as a read', () => {
    for (const command of [
      "test -f 'a[$(touch ~/.forge/x)]'",
      "test -v 'a[$(touch ~/.forge/x)]'",
      "[ -v 'a[$(touch ~/.forge/x)]' ]",
      "[[ 'a[$(touch ~/.forge/x)]' -eq 0 ]]",
      "test -v 'x`touch ~/.forge/y`'",
    ]) {
      expect(judged(command, 'bash'), command).not.toBe('read_only');
    }
  });

  it('still reads the plain inspections the table was added for', () => {
    // The shapes BL-027 is about must stay reads, or the fix is just a slower
    // way to say the same refusal.
    for (const command of [
      'test -f ~/.forge/policy.yaml',
      '[ -s ~/.forge/jobs/state/llama-updates.json ]',
      '[[ -d ~/.forge/sessions ]]',
      '[[ -n "$HOME" ]]',
      '[[ -f ~/.forge/policy.yaml ]]',
    ]) {
      expect(judged(command, 'bash'), command).toBe('read_only');
    }
  });

  it('still refuses the write that follows an inspection in the same line', () => {
    expect(
      judged('test -f ~/.forge/policy.yaml && touch ~/.forge/policy.yaml', 'bash'),
      'a test that reads must not excuse a touch that writes',
    ).toBe('refused');
  });

  /**
   * BL-030, the half of BL-027 Claude asked to keep separate from it: the parser ended
   * a statement at the `&&` INSIDE a bash `[[ … ]]`, so `[[ -n "$HOME" && -d ~/.forge ]]`
   * came out as `[[ -n "$HOME"` plus `-d ~/.forge ]]`, and the second statement's program
   * was `-d` — absent from `READ_ONLY_UNIX`, so the owner guard refused it with the very
   * wording BL-027 had fixed for the single-condition form. Only `[[` nests: `[ … ]` and
   * `test …` join their conditions with `-a`/`-o`, so a `&&` after them is a real break.
   */
  it('reads a compound [[ … ]] test instead of refusing it as a write', () => {
    expect(judged('[[ -n "$HOME" && -d ~/.forge ]]', 'bash')).toBe('read_only');
    expect(
      judged('[[ -r ~/.forge/policy.yaml && -s ~/.forge/jobs/state/x.json ]]', 'bash'),
      'the operands on both sides of the && are inspections',
    ).toBe('read_only');
    expect(
      judged(
        '[[ -f ~/.forge/policy.yaml && -r ~/.forge/policy.yaml ]] && touch ~/.forge/policy.yaml',
        'bash',
      ),
      'the test must not excuse the touch that follows it',
    ).toBe('refused');
  });
});

describe('a copy that reads Forge own files', () => {
  it('lets a source inside ~/.forge be copied out, because a copy reads its sources', () => {
    for (const [command, shell] of [
      [
        'cp ~/.forge/skills/hf-download/scripts/hf_parallel_dl.py N:/models/tools/hf_parallel_dl.py',
        'bash',
      ],
      ['cp ~/.forge/skills/a.py N:/tools/a.py', 'bash'],
      ['cp -r ~/.forge/skills N:/tools/skills', 'bash'],
      ['Copy-Item -Path ~/.forge/skills/a.py -Destination N:/tools/a.py', 'pwsh'],
      ['Copy-Item ~/.forge/a.py N:/b.py', 'pwsh'],
    ] as const) {
      expect(judged(command, shell), `${shell}: ${command}`).not.toBe('refused');
    }
  });

  it('still refuses a copy whose destination is inside ~/.forge', () => {
    for (const command of [
      'cp a.py ~/.forge/x/a.py',
      'cp -t ~/.forge/x a.py',
      'cp a.py b.py ~/.forge/x',
      'cp ~/.forge/a.py ~/.forge/b.py',
    ]) {
      expect(judged(command, 'bash'), command).toBe('refused');
    }
  });

  it('refuses a Copy-Item whose -Destination is inside ~/.forge', () => {
    expect(judged('Copy-Item -Path a.py -Destination ~/.forge/b.py', 'pwsh')).toBe('refused');
    expect(judged('Copy-Item -Path ~/.forge/a.py -Destination ~/.forge/b.py', 'pwsh')).toBe(
      'refused',
    );
  });

  it('fails closed when a flag could reorder the arguments or the target is inline', () => {
    for (const [command, shell] of [
      ['cp -rt ~/.forge/x src', 'bash'],
      ['cp src ~/.forge/x -S .bak', 'bash'],
      ['cp --suffix .bak src ~/.forge/x', 'bash'],
      ['cp --target-directory=~/.forge/x a', 'bash'],
      ['Copy-Item src ~/.forge/x -Filter *.py', 'pwsh'],
      ['Copy-Item src ~/.forge/x -Include *.py', 'pwsh'],
      ['Copy-Item a -Destination:~/.forge/x', 'pwsh'],
      ['Copy-Item -Path ~/.forge/a.py ~/.forge/b.py', 'pwsh'],
      ['Copy-Item -Path:~/.forge/a.py ~/.forge/b.py', 'pwsh'],
      ['Copy-Item -LiteralPath:~/.forge/a ~/.forge/b', 'pwsh'],
    ] as const) {
      expect(judged(command, shell), `${shell}: ${command}`).toBe('refused');
    }
  });

  it('keeps a move source judged, because a move deletes it', () => {
    for (const [command, shell] of [
      ['mv ~/.forge/x /tmp/x', 'bash'],
      ['Move-Item ~/.forge/a.py N:/b.py', 'pwsh'],
      ['rsync -a ~/.forge/skills N:/tools', 'bash'],
    ] as const) {
      expect(judged(command, shell), `${shell}: ${command}`).toBe('refused');
    }
  });
});

describe('a here-document body', () => {
  it('is data even when it names ~/.forge, and the open form is refused for its own fault', () => {
    // Balanced: the body is taken out before any path is judged, so the owner
    // guard has nothing to refuse and the command runs.
    expect(judged("python - <<'PY'\nprint(\"~/.forge/skills/x\")\nPY", 'bash')).not.toBe('refused');
    // Open: `<<'PY` never closes its quote, so this is refused as bash's own
    // parse error, and the refusal must not talk about Forge's own files.
    const open = classifyShellCommand("python - <<'PY\nprint(\"~/.forge/skills/x\")\nPY", 'bash', check);
    expect(open.classification).toBe('refused');
    expect(open.rule?.description).toMatch(/no closing quote/);
    expect(open.rule?.alternative).not.toMatch(/own files|owner only/);
  });
});

describe('a script run by an interpreter', () => {
  it('lets an interpreter run a script inside ~/.forge, as bash and pwsh already could', () => {
    for (const command of [
      'python ~/.forge/skills/hf-download/scripts/hf_parallel_dl.py orcarouter/DeepSeek --dest N:/models',
      'python3 ~/.forge/skills/a.py --dest N:/models',
      'py -3 ~/.forge/skills/a.py',
      'python.exe ~/.forge/skills/a.py',
      'python -c "print(1)"',
      'node ~/.forge/skills/a.js --dest N:/models',
      'zsh ~/.forge/skills/a.sh',
      'dash ~/.forge/skills/a.sh',
    ]) {
      expect(judged(command, 'bash'), command).not.toBe('refused');
    }
  });

  it('still judges the arguments after the script, so a write into ~/.forge is refused', () => {
    expect(judged('python ~/.forge/skills/a.py --dest ~/.forge/out', 'bash')).toBe('refused');
    expect(judged('python ~/.forge/skills/a.py ~/.forge/out/next', 'bash')).toBe('refused');
    expect(judged('node ~/.forge/skills/a.js --out ~/.forge/out', 'bash')).toBe('refused');
  });
});

describe('git subcommands that only print', () => {
  const readTokens: string[][] = [
    ['git', 'check-ignore', '-v', '.forge/config.yaml'],
    ['git', 'check-attr', '--all', '.forge/config.yaml'],
    ['git', 'ls-tree', '-r', 'HEAD'],
    ['git', 'show-ref', '--tags'],
    ['git', 'merge-base', 'HEAD', 'HEAD~1'],
    ['git', 'cat-file', '-p', 'HEAD:a'],
    ['git', 'cat-file', '-e', 'HEAD:a'],
  ];
  const writeLikeTokens: string[][] = [
    ['git', 'cat-file', '--textconv', 'HEAD:a'],
    ['git', 'cat-file', '--filters', 'HEAD:a'],
    ['git', '-c', 'core.pager=x', 'check-ignore', 'a'],
    ['git', 'add', '.forge/config.yaml'],
  ];

  it('calls each inspect-only subcommand a read', () => {
    for (const tokens of readTokens) {
      expect(isReadOnly(tokens, 'bash'), tokens.join(' ')).toBe(true);
    }
  });

  it('does not call a switch that runs a configured program a read', () => {
    for (const tokens of writeLikeTokens) {
      expect(isReadOnly(tokens, 'bash'), tokens.join(' ')).toBe(false);
    }
  });

  it('stops refusing the command the agent actually ran', () => {
    expect(judged('git check-ignore -v .forge/config.yaml', 'bash')).toBe('read_only');
    expect(
      judged("git status --short | head -20; echo '== tracked? =='; git check-ignore -v .forge/config.yaml", 'bash'),
    ).not.toBe('refused');
    // `cat-file --textconv` runs the repository's configured program, so naming
    // the config file with it is still a write-shaped statement and refused. A
    // `HEAD:` rev-spec prefix is not a path, so that spelling is not refused.
    expect(judged('git cat-file --textconv .forge/config.yaml', 'bash')).toBe('refused');
    expect(judged('git cat-file --textconv HEAD:.forge/config.yaml', 'bash')).not.toBe('refused');
    expect(judged('git -c core.pager=x check-ignore .forge/config.yaml', 'bash')).toBe('refused');
  });
});

describe('`cd` is a read, until something in the same command writes', () => {
  // The refusal the plan names: `cd` is not on the read-only table, so
  // `cd ~/.forge/agent-bus && ls` — pure reading — cost a card or a refusal,
  // and each misfire teaches the agent a workaround.
  it('lets the read-only cd the agent actually ran through', () => {
    expect(judged('cd ~/.forge/agent-bus && ls', 'bash')).toBe('read_only');
    expect(judged('cd ~/.forge && ls -1', 'bash')).toBe('read_only');
    expect(judged('cd /n/Apps/Forge/src && rg foo', 'bash')).toBe('read_only');
    expect(judged('Set-Location ~/.forge/agent-bus; Get-ChildItem', 'pwsh')).toBe('read_only');
    expect(judged('sl ~/.forge; ls', 'pwsh')).toBe('read_only');
  });

  it('refuses the whole command when a write follows the cd, so cd cannot smuggle one in', () => {
    // `rm x` names a relative path, which this guard resolves against the
    // tool's cwd, not the directory the `cd` just moved into — so the safe
    // answer is to refuse, and the `cd` itself is what names `~/.forge`.
    expect(judged('cd ~/.forge && rm x', 'bash')).toBe('refused');
    expect(judged('cd ~/.forge && echo hi > notes.txt', 'bash')).toBe('refused');
    expect(judged('cd ~/.forge && Add-Content notes.txt hi', 'pwsh')).toBe('refused');
    // A `cd` out of the protected roots plus a workspace-relative write is
    // ordinary: it is a `normal` command, not a gate.
    expect(judged('cd /n/Apps/Other && rm x', 'bash')).toBe('normal');
  });

  it('does not call a cd this table cannot follow free', () => {
    expect(judged('cd $(mktemp -d) && ls', 'bash')).not.toBe('read_only');
    expect(judged('cd', 'bash')).not.toBe('read_only');
    expect(isReadOnly(['cd', '~/.forge/agent-bus'], 'bash', true)).toBe(true);
    expect(isReadOnly(['cd', '~/.forge/agent-bus'], 'bash')).toBe(false);
    expect(isReadOnly(['cd'], 'bash', true)).toBe(false);
    expect(isReadOnly(['cd', '$TARGET'], 'bash', true)).toBe(false);
    expect(isReadOnly(['Set-Location', '~/.forge'], 'pwsh', true)).toBe(true);
  });

  it('does not tax ordinary workspace work, which is the whole point of the plan', () => {
    // `src` and `notes.txt` resolve against the workspace the command started in,
    // and neither is an owner-only path, so a `cd` inside the workspace plus a
    // write there must not cost a card or a refusal.
    expect(judged('cd src && echo hi > notes.txt', 'bash')).not.toBe('refused');
    expect(judged('cd src && rm x', 'bash')).not.toBe('refused');
    expect(judged('cd src/tools && rg foo', 'bash')).toBe('read_only');
    expect(judged('Set-Location src; Remove-Item x', 'pwsh')).not.toBe('refused');
  });

  it('names both statements and the alternative, so the agent is not left guessing', () => {
    const out = classifyShellCommand('cd ~/.forge && rm x', 'bash', check);
    expect(out.classification).toBe('refused');
    expect(out.rule?.description, 'the cd and the write that follows it').toContain('cd ~/.forge');
    expect(out.rule?.description).toContain('rm x');
    expect(out.rule?.alternative).toMatch(/absolute path/iu);
    expect(out.rule?.alternative).toMatch(/working directory between calls/iu);
    expect(out.rule?.alternative).toMatch(/`cwd` argument/iu);
    // A plain write into ~/.forge keeps its own older, more specific wording.
    const plain = classifyShellCommand('rm ~/.forge/notes.txt', 'bash', check);
    expect(plain.rule?.description).toContain("refuses to change Forge's own files");
  });

  it('judges a relative write against the cwd the tool was given, not the workspace', () => {
    // The advice the refusal gives is to pass the folder as the tool's `cwd` instead
    // of `cd`-ing, so that argument must be judged the same way: a relative write
    // under an owner-only `cwd` is still a write into Forge's own files.
    const intoForge = classifyShellCommand('rm x', 'bash', {
      ...check,
      cwd: `${HOME}/.forge`,
    });
    expect(intoForge.classification).toBe('refused');
    expect(intoForge.rule?.description).toContain("refuses to change Forge's own files");
    // And a `cwd` inside the workspace is not taxed: the same relative write is
    // ordinary work.
    expect(
      classifyShellCommand('rm x', 'bash', { ...check, cwd: 'src' }).classification,
    ).not.toBe('refused');
  });
});

describe('a read of Forge own files is not refused for being a read', () => {
  // The 2026-11-02 live test paid four refusals for commands that only read:
  // `ls` and `du` on the session logs, and `icacls` on one file's permissions.
  // `icacls` with no modification switch PRINTS the ACL, and `du` only adds up
  // sizes — neither can change anything — but neither was on the read-only
  // table, so the owner guard treated the whole command as a change and refused
  // it. A refusal that costs a round and prevents nothing teaches the agent to
  // route around the guard instead of reading the file.
  it('lets du, df and a plain ls read a folder under ~/.forge', () => {
    for (const command of [
      'ls "/c/Users/someone/.forge/sessions"',
      'ls "/c/Users/someone/.forge/sessions" | head -12',
      'du -sh ~/.forge/sessions',
      'du -sh "/c/Users/someone/.forge/sessions" | head -4',
      'df -h ~/.forge',
      'ls -la ~/.forge/sessions && du -sh ~/.forge/sessions',
    ]) {
      const result = classifyShellCommand(command, 'bash', check);
      expect(
        result.classification,
        `${command} — expected to run, got ${result.classification}: ${result.rule?.description ?? ''}`,
      ).not.toBe('refused');
    }
  });

  it('lets icacls list a file\'s permissions and refuses the switches that rewrite them', () => {
    for (const command of [
      'icacls ~/.forge/hallumeter-bridge.json',
      'icacls "C:/Users/someone/.forge/hallumeter-bridge.json"',
      'icacls /c/Users/someone/.forge/hallumeter-bridge.json',
      'icacls "C:/Users/someone/.forge/hallumeter-bridge.json" /T',
      'icacls ~/.forge/hallumeter-bridge.json',
    ]) {
      for (const shell of ['bash', 'pwsh'] as const) {
        expect(
          classifyShellCommand(command, shell, check).classification,
          `${shell}: ${command} is a listing`,
        ).not.toBe('refused');
      }
    }
    // Every switch outside the listing-only list fails closed, including the
    // `//grant` spelling Git Bash needs to get the switch through at all.
    for (const command of [
      'icacls ~/.forge/hallumeter-bridge.json /grant someone:F',
      'icacls ~/.forge/hallumeter-bridge.json //grant someone:F',
      'icacls ~/.forge/hallumeter-bridge.json /reset',
      'icacls ~/.forge/hallumeter-bridge.json /deny *S-1-5-21:x:(DE)',
      'icacls ~/.forge/hallumeter-bridge.json /inheritance:r',
    ]) {
      const result = classifyShellCommand(command, 'bash', check);
      expect(result.classification, `${command} rewrites the ACL`).toBe('refused');
      expect(result.rule?.description).toContain("refuses to change Forge's own files");
    }
  });

  it('keeps refusing the command that really changes a file under ~/.forge', () => {
    for (const [command, shell] of [
      ['rm ~/.forge/sessions/x.jsonl', 'bash'],
      ['Remove-Item ~/.forge/sessions/x.jsonl', 'pwsh'],
      ['rm "/c/Users/someone/.forge/sessions/x.jsonl"', 'bash'],
    ]) {
      const result = classifyShellCommand(command, shell, check);
      expect(result.classification, `${shell}: ${command}`).toBe('refused');
      expect(result.rule?.description).toContain("refuses to change Forge's own files");
      // The refusal still names the tools that CAN read it, which is the half the
      // 11-02 agent was missing when it reached for a shell one-liner.
      expect(result.rule?.alternative).toContain('read_file');
      expect(result.rule?.alternative).toContain('search_code');
    }
  });

  it('says "change" only when something was classed as a change', () => {
    // `cd` into `~/.forge` with nothing writing: the guard cannot follow a folder
    // built at run time, so it refuses — and the old wording told the agent it
    // had refused to CHANGE that folder, which is the sentence that made a
    // session-log reader believe its read had been refused.
    const computed = classifyShellCommand('cd ~/.forge/$d && ls', 'bash', check);
    expect(computed.classification).toBe('refused');
    expect(computed.rule?.description).toMatch(/cannot judge/iu);
    expect(computed.rule?.description).not.toMatch(/refuses to change/iu);
    expect(computed.rule?.alternative).toMatch(/was classed as a change/iu);
    expect(computed.rule?.alternative).toMatch(/not a refusal to write/iu);

    // A `>` whose target is outside Forge's files is a write, just not one there:
    // the `cd` used to make the whole line look like a write inside.
    const outside = classifyShellCommand(
      'cd ~/.forge/sessions && ls > /tmp/out.txt',
      'bash',
      check,
    );
    expect(outside.classification, 'the write lands in /tmp, not in ~/.forge').not.toBe('refused');

    // And the same command with a RELATIVE target really does write inside, so it
    // is refused — with the write named, not just the folder.
    const inside = classifyShellCommand('cd ~/.forge/sessions && ls > notes.txt', 'bash', check);
    expect(inside.classification).toBe('refused');
    expect(inside.rule?.description).toContain('notes.txt');
    expect(inside.rule?.description).toMatch(/cd/iu);
    expect(inside.rule?.alternative).toMatch(/cwd/iu);
  });

  it('still refuses a script that names a Forge own file as its argument', () => {
    // Python is not on the read-only table and never will be: a token check
    // cannot see inside a script, so the guard has to refuse the whole call. The
    // refusal is only useful if it names the tools that can read the file.
    const result = classifyShellCommand(
      'python -c "print(open(p).read())" ~/.forge/sessions/a.jsonl',
      'bash',
      check,
    );
    expect(result.classification).toBe('refused');
    expect(result.rule?.alternative).toContain('read_file');
    expect(result.rule?.alternative).toContain('search_code');
  });
});

describe('a write is judged from the folder the `cd`s before it moved to', () => {
  it('refuses a relative write that a `cd` carries into Forge own files', () => {
    for (const [command, shell] of [
      ['cd ~ && cp evil.yaml .forge/policy.yaml', 'bash'],
      ['cd $HOME && mv evil.yaml .forge/policy.yaml', 'bash'],
      ['cd C:/Users/someone && cd .forge && rm policy.yaml', 'bash'],
      ['Set-Location $env:USERPROFILE; Copy-Item evil.yaml .forge/policy.yaml', 'pwsh'],
    ] as const) {
      const result = classifyShellCommand(command, shell, check);
      expect(result.classification, command).toBe('refused');
      expect(result.rule?.description, command).toContain("Forge's own files");
    }
  });

  it('refuses a write naming .forge after a `cd` it cannot follow, and allows one that does not', () => {
    const blind = classifyShellCommand('cd $X && cp evil.yaml .forge/policy.yaml', 'bash', check);
    expect(blind.classification).toBe('refused');
    expect(blind.rule?.description).toContain('cannot judge');
    expect(judged('cd $X && cp a.txt b.txt', 'bash')).not.toBe('refused');
    expect(judged('cd ~ && cp a.txt projects/b.txt', 'bash')).not.toBe('refused');
  });
});

describe('a redirect target that a separator ends with no space', () => {
  // 2026-11-02 red-team: `echo x >> ~/.forge/policy.yaml; echo hi` passed, because
  // the `;` ended the word `policy.yaml` after the parser had already stopped
  // waiting for a redirect target.
  it('refuses the write whatever separator follows it', () => {
    for (const command of [
      'echo x >> ~/.forge/policy.yaml; echo hi',
      'echo x >> "C:/Users/someone/.forge/policy.yaml"; echo "exit=$?"',
      'echo x >~/.forge/policy.yaml|cat',
      'echo x >~/.forge/policy.yaml&',
      'echo x >> ~/.forge/policy.yaml&&echo hi',
      'echo x >> ~/.forge/policy.yaml||echo hi',
    ]) {
      expect(judged(command, 'bash'), command).toBe('refused');
    }
    expect(judged('echo x >> $HOME/.forge/policy.yaml; echo hi', 'pwsh')).toBe('refused');
  });

  it('still lets a redirect outside Forge files through', () => {
    expect(judged('echo a > b.txt; ls', 'bash')).not.toBe('refused');
  });
});
