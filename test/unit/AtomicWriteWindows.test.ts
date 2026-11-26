import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../../src/util/atomicWrite';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function powershellScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('FORGE_LOCK_READY')) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`file-holding PowerShell exited with ${code}: ${output}`));
    });
  });
}

describe('Windows rename holder diagnostics', () => {
  it.skipIf(process.platform !== 'win32')(
    'names a process that holds the destination without delete sharing',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-atomic-windows-'));
      roots.push(root);
      const target = path.join(root, 'held.py');
      fs.writeFileSync(target, 'before');
      const script = String.raw`
$file = [IO.File]::Open($env:FORGE_TEST_TARGET, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
[Console]::Out.WriteLine('FORGE_LOCK_READY')
[Console]::In.ReadLine() | Out-Null
$file.Dispose()
`;
      const child = spawn(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', powershellScript(script)],
        { env: { ...process.env, FORGE_TEST_TARGET: target }, windowsHide: true },
      );
      try {
        await waitForReady(child);
        const error = await writeFileAtomic(target, 'after', { retryBudgetMs: 100 }).catch(
          (value: NodeJS.ErrnoException) => value,
        );
        expect(error.message).toMatch(/held by \d+ .*powershell/i);
        expect(error).toMatchObject({ code: 'EPERM', path: target });
        expect(fs.readFileSync(target, 'utf8')).toBe('before');
        expect(fs.readdirSync(root)).toEqual(['held.py']);
      } finally {
        child.stdin.end('\n');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    },
    30_000,
  );
});
