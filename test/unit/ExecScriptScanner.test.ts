import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkExecScriptFile } from '../../src/tools/execScriptScanner';

const dirs: string[] = [];

function fixture(name: string, content: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-exec-script-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return { dir, file };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('exec script file scanning', () => {
  it('checks PowerShell -File, bare shell script arguments, and direct batch files', () => {
    const ps = fixture('danger.ps1', 'Write-Output ok\nRemove-Item x -Recurse -Force');
    expect(() => checkExecScriptFile('pwsh', ['-File', ps.file], ps.dir)).toThrow('line 2');

    const shell = fixture('danger.sh', 'echo ok\nrm -rf x');
    expect(() => checkExecScriptFile('bash', [shell.file], shell.dir)).toThrow('line 2');

    const batch = fixture('danger.bat', 'echo ok\nrd /s x');
    expect(() => checkExecScriptFile(batch.file, [], batch.dir)).toThrow('line 2');
  });

  it('refuses files over 256 KB with a reason and scans files outside workspace cwd', () => {
    const large = fixture('large.sh', 'x'.repeat(256 * 1024 + 1));
    expect(() => checkExecScriptFile('bash', [large.file], os.tmpdir())).toThrow('scans scripts up to');

    const outside = fixture('outside.sh', 'git reset --hard');
    expect(() => checkExecScriptFile('sh', [outside.file], os.tmpdir())).toThrow('git reset --hard');
  });

  it('checks git reset --hard in script text while allowing mixed and soft resets', () => {
    const hard = fixture('hard.sh', 'git reset --hard');
    expect(() => checkExecScriptFile('bash', [hard.file], hard.dir)).toThrow('git reset --hard');
    const soft = fixture('soft.sh', 'git reset --mixed\ngit reset --soft');
    expect(() => checkExecScriptFile('bash', [soft.file], soft.dir)).not.toThrow();
  });
});
