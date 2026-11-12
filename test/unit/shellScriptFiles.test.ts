import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/tools/execHelpers', () => ({
  execCwdPreview: () => 'N:\\workspace',
  resolveExecCwd: () => 'N:\\workspace',
  runShellInForeground: async () => ({
    code: 0,
    seconds: 0.1,
    timedOut: false,
    stdout: '',
    stderr: '',
  }),
}));

import { classifyShellCommand } from '../../src/tools/shellPolicy';
import { makeShellTool } from '../../src/tools/shellTool';

const cwd = 'N:\\workspace';
const abs = (name: string): string => path.win32.resolve(cwd, name.replaceAll('/', '\\'));
const reader =
  (files: Record<string, string | { error: string }>) =>
  (filePath: string): string | { error: string } =>
    files[filePath] ?? { error: 'does not exist' };
const check = (files: Record<string, string | { error: string }>, extra = {}) => ({
  platform: 'win32' as NodeJS.Platform,
  cwd,
  home: 'C:\\Users\\owner',
  readScript: reader(files),
  ...extra,
});

describe('shell scripts are classified from their file contents', () => {
  it('matches the inline recursive-delete class and rule description', () => {
    const script = 'Remove-Item -Recurse -Force C:\\x';
    const inline = classifyShellCommand(script, 'pwsh');
    const fromFile = classifyShellCommand(
      'powershell -NoProfile -ExecutionPolicy Bypass -File s.ps1',
      'pwsh',
      check({ [abs('s.ps1')]: script }),
    );
    expect(fromFile.classification).toBe(inline.classification);
    expect(fromFile.rule?.description).toBe(inline.rule?.description);
  });

  it.each([
    ['bash s.sh', 'bash', 'rm -rf /c/x', 'bash'],
    ['bash runScript', 'bash', 'rm -rf /c/x', 'bash'],
    ['./s.sh', 'bash', 'rm -rf /c/x', 'bash'],
    ['& .\\s.ps1', 'pwsh', 'Remove-Item -Recurse -Force C:\\x', 'pwsh'],
    ['pwsh -f s.ps1', 'pwsh', 'Remove-Item -Recurse -Force C:\\x', 'pwsh'],
    ['cmd /c s.bat', 'pwsh', 'Remove-Item -Recurse -Force C:\\x', 'pwsh'],
  ] as const)('classifies %s from its script', (command, shell, contents, contentShell) => {
    const inline = classifyShellCommand(contents, contentShell);
    const result = classifyShellCommand(
      command,
      shell,
      check({
        [abs('s.sh')]: contents,
        [abs('runScript')]: contents,
        [abs('s.ps1')]: contents,
        [abs('s.bat')]: contents,
      }),
    );
    expect(result.classification).toBe(inline.classification);
    expect(result.rule?.description).toBe(inline.rule?.description);
  });

  it('keeps ordinary script text at the same class as inline commands', () => {
    const contents = 'Get-ChildItem; whoami';
    const inline = classifyShellCommand(contents, 'pwsh');
    const script = classifyShellCommand(
      'pwsh -File s.ps1',
      'pwsh',
      check({ [abs('s.ps1')]: contents }),
    );
    expect(script.classification).toBe(inline.classification);
    expect(script.classification).toBe('normal');
  });

  it('classifies a here-document body written and run in the same command', () => {
    const command =
      "cat > s.ps1 <<'EOF'\nRemove-Item -Recurse -Force C:\\x\nEOF\npowershell -File s.ps1";
    const result = classifyShellCommand(command, 'bash', check({}));
    const inline = classifyShellCommand('Remove-Item -Recurse -Force C:\\x', 'pwsh');
    expect(result.classification).toBe(inline.classification);
    expect(result.rule?.description).toBe(inline.rule?.description);
  });

  it('classifies a redirect rewrite of a script run later in the command as dangerous', () => {
    const result = classifyShellCommand(
      "echo 'rm -rf /c/x' > s.sh; bash s.sh",
      'bash',
      check({ [abs('s.sh')]: 'ls' }),
    );
    expect(result.classification).toBe('dangerous');
    expect(result.rule?.description).toBe(`runs a script this same command changes (${abs('s.sh')})`);
  });

  it('classifies a program rewrite of a script run later in the command as dangerous', () => {
    const result = classifyShellCommand(
      'cp evil.sh s.sh && bash s.sh',
      'bash',
      check({ [abs('s.sh')]: 'ls', [abs('evil.sh')]: 'ls' }),
    );
    expect(result.classification).toBe('dangerous');
    expect(result.rule?.description).toBe(`runs a script this same command changes (${abs('s.sh')})`);
  });

  it.each([
    'chmod +x s.sh && ./s.sh',
    'cat s.sh && bash s.sh',
    'ls -la s.sh; bash s.sh',
  ])('does not treat a non-writing mention in %s as a script rewrite', (command) => {
    const result = classifyShellCommand(command, 'bash', check({ [abs('s.sh')]: 'ls' }));
    const direct = classifyShellCommand('bash s.sh', 'bash', check({ [abs('s.sh')]: 'ls' }));
    expect(result.classification).toBe(direct.classification);
    expect(result.rule?.description).toBe(direct.rule?.description);
  });

  it('classifies an in-place sed rewrite of a script run later in the command as dangerous', () => {
    const result = classifyShellCommand(
      "sed -i 's/a/b/' s.sh && bash s.sh",
      'bash',
      check({ [abs('s.sh')]: 'ls' }),
    );
    expect(result.classification).toBe('dangerous');
    expect(result.rule?.description).toBe(`runs a script this same command changes (${abs('s.sh')})`);
  });

  it('pairs a here-document body with its own redirect after an unrelated redirect', () => {
    const command =
      "echo note > a.txt\ncat > s.sh <<'EOF'\nrm -rf /c/x\nEOF\nbash s.sh";
    const result = classifyShellCommand(command, 'bash', check({ [abs('s.sh')]: 'ls' }));
    const inline = classifyShellCommand('rm -rf /c/x', 'bash');
    expect(result.classification).toBe(inline.classification);
    expect(result.rule?.description).toBe(inline.rule?.description);
  });

  it('follows literal script paths in elevated Start-Process argument lists', () => {
    const contents = 'Remove-Item -Recurse -Force C:\\x';
    const command =
      `powershell -Command "Start-Process powershell -Verb RunAs -ArgumentList '-File','evil.ps1'"`;
    const result = classifyShellCommand(command, 'pwsh', check({ [abs('evil.ps1')]: contents }));
    const inline = classifyShellCommand(contents, 'pwsh');
    expect(result.classification).toBe(inline.classification);
    expect(result.rule?.description).toBe(inline.rule?.description);
  });

  it('makes missing, unreadable, directory, and oversized scripts dangerous with their paths named', () => {
    for (const [error, file] of [
      ['does not exist', undefined],
      ['permission denied', { error: 'permission denied' }],
      ['is a directory', { error: 'is a directory' }],
      ['exceeds 262144 bytes', { error: 'exceeds 262144 bytes' }],
    ] as const) {
      const result = classifyShellCommand(
        'pwsh -File large.ps1',
        'pwsh',
        check(file ? { [abs('large.ps1')]: file } : {}),
      );
      expect(result.classification).toBe('dangerous');
      expect(result.rule?.description).toContain(abs('large.ps1'));
      expect(result.rule?.description).toContain(error);
    }
  });

  it('names the bash drive-path backslash trap only for an unquoted token', () => {
    const bashDrive = classifyShellCommand(
      'pwsh -NoProfile -ExecutionPolicy Bypass -File V:\\Maya\\local\\update-maya.ps1',
      'bash',
      check({}),
    );
    expect(bashDrive.rule?.description).toBe(
      'runs a script Forge could not read (V:\\Mayalocalupdate-maya.ps1: does not exist; bash removed the backslashes in V:\\Maya\\local\\update-maya.ps1: pass shell "pwsh", or write the path with forward slashes)',
    );

    const pwshDrive = classifyShellCommand('pwsh -File V:\\Maya\\x.ps1', 'pwsh', check({}));
    expect(pwshDrive.rule?.description).toBe(
      'runs a script Forge could not read (V:\\Maya\\x.ps1: does not exist)',
    );

    const bashRelative = classifyShellCommand('./missing.sh', 'bash', check({}));
    expect(bashRelative.rule?.description).toBe(
      `runs a script Forge could not read (${abs('missing.sh')}: does not exist)`,
    );

    const bashQuoted = classifyShellCommand(
      "pwsh -File 'V:\\Maya\\x.ps1'",
      'bash',
      check({}),
    );
    expect(bashQuoted.rule?.description).toBe(
      'runs a script Forge could not read (V:\\Maya\\x.ps1: does not exist)',
    );
  });

  it('rejects a real 300 KiB script with the production reader', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-script-policy-'));
    const filePath = path.join(folder, 'large.sh');
    fs.writeFileSync(filePath, 'x'.repeat(300 * 1024));
    try {
      const result = classifyShellCommand(`bash "${filePath.replaceAll('\\', '/')}"`, 'bash', {
        cwd: folder,
      });
      expect(result.classification).toBe('dangerous');
      expect(result.rule?.description).toContain(filePath);
      expect(result.rule?.description).toContain('262144');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('refuses script writes to owner-only roots exactly as inline writes', () => {
    const settings = {
      ownerOnly: ['C:\\Users\\owner\\.forge'],
    };
    const inline = classifyShellCommand(
      'Set-Content ~/.forge/policy.yaml x',
      'pwsh',
      check({}, settings),
    );
    const script = classifyShellCommand(
      'pwsh -File update.ps1',
      'pwsh',
      check({ [abs('update.ps1')]: 'Set-Content ~/.forge/policy.yaml x' }, settings),
    );
    expect(script.classification).toBe(inline.classification);
    expect(script.rule?.description).toBe(inline.rule?.description);
    expect(script.classification).toBe('refused');
  });

  it('follows three script levels, rejects a fourth, and terminates self references', () => {
    const chain = {
      [abs('one.ps1')]: 'pwsh -File two.ps1',
      [abs('two.ps1')]: 'pwsh -File three.ps1',
      [abs('three.ps1')]: 'Remove-Item -Recurse -Force C:\\x',
    };
    expect(classifyShellCommand('pwsh -File one.ps1', 'pwsh', check(chain)).classification).toBe(
      'dangerous',
    );
    const deep = {
      ...chain,
      [abs('three.ps1')]: 'pwsh -File four.ps1',
      [abs('four.ps1')]: 'Get-ChildItem',
    };
    const tooDeep = classifyShellCommand('pwsh -File one.ps1', 'pwsh', check(deep));
    expect(tooDeep.classification).toBe('dangerous');
    expect(tooDeep.rule?.description).toContain('deeper than the limit (3)');
    expect(
      classifyShellCommand(
        'pwsh -File loop.ps1',
        'pwsh',
        check({ [abs('loop.ps1')]: 'pwsh -File loop.ps1' }),
      ).classification,
    ).toBe('normal');
  });

  it('adds the elevation note to a normal shell result and omits it otherwise', async () => {
    const tool = makeShellTool({ platform: 'win32', env: { PATH: '' } });
    const elevation = "Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList x";
    const elevatedResult = await tool.handler({ command: elevation }, { beforeMutate: () => {} });
    expect(
      elevatedResult.endsWith(
        '\nThis started an elevated process; Windows asked the owner to confirm it, and only the owner at the PC can. ' +
          'Before starting another elevated process, tell the owner why, and: put every remaining admin step (drivers, services, HKLM, Program Files) in one script, so one prompt covers them; ' +
          'have it write its log where this shell can read it (the workspace or C:\\Users\\Public, never C:\\Windows\\Temp) and read that log before running anything again; ' +
          'and if the same service will need restarting again, grant the owner start and stop rights to it once (sc sdset), so later restarts need no prompt.',
      ),
    ).toBe(true);
    expect(tool.approval?.({ command: elevation })?.dangerous).not.toBe(true);
    const script = classifyShellCommand(
      'pwsh -File elevate.ps1',
      'pwsh',
      check({ [abs('elevate.ps1')]: elevation }),
    );
    expect(script.classification).toBe('normal');
    expect(script.elevatedProcess).toBe(true);
    const ordinaryResult = await tool.handler(
      { command: 'Get-ChildItem' },
      { beforeMutate: () => {} },
    );
    expect(ordinaryResult).not.toContain('This started an elevated process');
  });

  it('keeps shellPolicy.ts under ESLint’s 500-line limit', () => {
    const source = fs.readFileSync(path.resolve('src/tools/shellPolicy.ts'), 'utf8');
    expect(source.split(/\r?\n/u).filter((line) => line.length > 0).length).toBeLessThanOrEqual(
      500,
    );
  });
});
