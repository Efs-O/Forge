import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * BL-051: `find_blender.py` chose the OLDEST Blender in the standard install
 * folder, so every script the shipped skill then ran ran on that older major
 * while its reference material is Blender 5.x. This test drives the Windows
 * branch of `standard_paths()` on any OS (the script reads `os.name`, so the
 * driver patches it) and pins the order: newest major first, and numeric, so
 * 4.10 beats 4.2.
 */
const repoRoot = path.resolve(__dirname, '../..');
const scriptDir = path.join(repoRoot, 'resources', 'skills', 'blender', 'scripts');
const script = path.join(scriptDir, 'find_blender.py');
const python = process.platform === 'win32' ? 'python' : 'python3';
const pythonCheck = spawnSync(python, ['-c', 'pass'], { encoding: 'utf8' });
const canRun = pythonCheck.status === 0 && fs.existsSync(script);

const DRIVER = [
  // Import the stdlib first: shutil picks its platform module at import time,
  // and with os.name patched to "nt" it imports Windows-only `nt` on POSIX.
  'import glob, os, re, shutil, sys',
  'os.name = "nt"',
  'os.environ.pop("BLENDER", None)',
  'os.environ["ProgramFiles"] = sys.argv[1]',
  'sys.path.insert(0, sys.argv[2])',
  'import find_blender',
  'print("\\n".join(find_blender.standard_paths()))',
].join('\n');

function tempInstallTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh051-blender-'));
  // Written newest-last so a plain (unsorted) glob cannot pass by accident.
  for (const version of ['3.6', '4.2', '4.10', '5.0']) {
    const folder = path.join(root, 'Blender Foundation', `Blender ${version}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'blender.exe'), '');
  }
  return root;
}

describe('shipped Blender skill: find_blender.py install-folder order', () => {
  let tree: string | undefined;
  afterAll(() => {
    if (tree) fs.rmSync(tree, { recursive: true, force: true });
  });

  it.skipIf(!canRun)('prefers the newest Blender, comparing versions as numbers', () => {
    tree = tempInstallTree();
    const env = { ...process.env };
    delete env['BLENDER'];
    const result = spawnSync(python, ['-B', '-c', DRIVER, tree, scriptDir], {
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
    expect(result.status).toBe(0);
    const found = result.stdout
      .split('\n')
      .map((line) => path.basename(path.dirname(line.trim())))
      .filter((name) => name.startsWith('Blender '));
    expect(found).toEqual(['Blender 5.0', 'Blender 4.10', 'Blender 4.2', 'Blender 3.6']);
  });
});
