import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * npm 11 refuses to run an install script from a dependency that is not
 * covered by `allowScripts` in package.json. On Linux that skip is fatal here:
 * esbuild and keytar need their postinstall, so a fresh `npm install` leaves a
 * tree that cannot build until someone runs `npm rebuild`. The list is
 * name-only (no versions) so a version bump keeps its approval, and this test
 * is what notices a new native dependency arriving without one.
 */
describe('package.json allowScripts', () => {
  it('covers every dependency that runs an install script', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as unknown as { allowScripts?: Record<string, boolean> };
    expect(Object.keys(pkg.allowScripts ?? {}).sort()).toEqual([
      '@vscode/vsce-sign',
      '@whiskeysockets/baileys',
      'esbuild',
      'keytar',
      'protobufjs',
    ]);
  });
});
