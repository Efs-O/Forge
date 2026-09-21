import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Audit A11 (2026-09-21): the tag workflow published through `npm run publish`,
 * which let vsce repackage on its own and skipped check-vsix-version.mjs. The
 * release must be the artifact the canonical `npm run package` gate built.
 */

const workflow = fs.readFileSync(path.resolve('.github/workflows/publish.yml'), 'utf8');
const runLines = workflow
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
const lineOf = (needle: string): number => runLines.findIndex((line) => line.includes(needle));

describe('publish workflow contract (audit A11)', () => {
  it('packages through the canonical script before anything is published', () => {
    const packaged = lineOf('npm run package');
    expect(packaged).toBeGreaterThan(-1);
    expect(packaged).toBeLessThan(lineOf('vsce publish'));
    expect(packaged).toBeLessThan(lineOf('ovsx publish'));
    expect(packaged).toBeLessThan(lineOf('gh release create'));
  });

  it('publishes the packaged VSIX instead of letting vsce repackage', () => {
    expect(runLines.filter((line) => line.includes('vsce publish'))).toEqual([
      expect.stringContaining('--packagePath'),
    ]);
    expect(lineOf('npm run publish')).toBe(-1);
    expect(lineOf('vsce package')).toBe(-1);
  });

  it('keeps the version check inside the canonical package script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.package).toMatch(/^node scripts\/check-vsix-version\.mjs && /);
  });
});
