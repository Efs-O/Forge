import * as fs from 'fs';
import { describe, expect, it, vi } from 'vitest';
import { foldDrivePath, isWindowsAbsolute, pathApiFor } from '../../src/util/drivePath';

function readSource(rel: string): string {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
}

describe('the drive fold (`foldDrivePath`)', () => {
  it('turns the spellings Git Bash and Cygwin produce into the path Windows reads', () => {
    expect(foldDrivePath('/n/Apps/Forge/src/x.ts', 'win32')).toBe('N:/Apps/Forge/src/x.ts');
    expect(foldDrivePath('/cygdrive/n/Apps/Forge/src/x.ts', 'win32')).toBe(
      'N:/Apps/Forge/src/x.ts',
    );
    expect(foldDrivePath('/c/Users/someone/.forge/sessions/a.jsonl', 'win32')).toBe(
      'C:/Users/someone/.forge/sessions/a.jsonl',
    );
  });

  it('leaves the same spelling a folder on any other OS, where it really is one', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(foldDrivePath('/n/Apps/Forge/src/x.ts', platform)).toBe('/n/Apps/Forge/src/x.ts');
      expect(foldDrivePath('/home/x/y', platform)).toBe('/home/x/y');
    }
  });

  it('does not touch a folder that merely begins with a letter', () => {
    expect(foldDrivePath('/tmp/build.out', 'win32')).toBe('/tmp/build.out');
    expect(foldDrivePath('/node_modules/x', 'win32')).toBe('/node_modules/x');
    expect(foldDrivePath('/n', 'win32')).toBe('N:/');
    expect(foldDrivePath('N:/Apps/Forge/x', 'win32')).toBe('N:/Apps/Forge/x');
    expect(foldDrivePath('relative/x.ts', 'win32')).toBe('relative/x.ts');
  });

  it('answers the same OS question as its two neighbours', () => {
    expect(isWindowsAbsolute('N:/Apps/Forge/x', 'win32')).toBe(true);
    expect(isWindowsAbsolute('/n/Apps/Forge/x', 'win32')).toBe(false);
    expect(isWindowsAbsolute('N:/Apps/Forge/x', 'linux')).toBe(false);
    expect(pathApiFor('win32').basename('N:\\Apps\\Forge\\x.ts')).toBe('x.ts');
    expect(pathApiFor('linux').basename('N:\\Apps\\Forge\\x.ts')).toBe('N:\\Apps\\Forge\\x.ts');
  });
});

describe('the secret matcher stays free of vscode', () => {
  // `tools/secretPaths.ts` is imported by `config/permissionsSchema.ts`,
  // `config/types.ts`, `tools/exfilTaint.ts`, `tools/ownerPaths.ts` and the
  // document converters. It used to be free of VS Code; folding a drive letter
  // must not make all of them depend on an editor module.
  it('loads secretPaths.ts with a vscode mock that throws if anything asks for it', async () => {
    vi.resetModules();
    vi.doMock('vscode', () => {
      throw new Error('vscode was pulled into the secret-path matcher');
    });
    const secretPaths = await import('../../src/tools/secretPaths');
    // Ask the fold to do real work through the matcher, so a fold that came
    // from a VS Code-bound module would have had to load that module.
    expect(secretPaths.normalizePathForMatch('/n/Apps/Forge/x', 'win32')).toBe(
      'n:/apps/forge/x',
    );
  });

  it('keeps the fold out of the VS Code-bound path module', () => {
    const secret = readSource('../../src/tools/secretPaths.ts');
    expect(secret).toContain("from '../util/drivePath'");
    expect(secret, 'secretPaths must not reach a module that imports vscode').not.toContain(
      "from '../util/WorkspacePaths'",
    );
    const leaf = readSource('../../src/util/drivePath.ts');
    expect(leaf, 'the fold lives in a leaf that imports nothing but path').not.toContain(
      "from 'vscode'",
    );
    expect(leaf).toContain("import * as path from 'path'");
  });
});
