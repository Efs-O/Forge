import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
const skillRoot = join(root, 'skills-lab');
const shippedSkillsRoot = join(root, 'resources', 'skills');
const python = process.platform === 'win32' ? 'python' : 'python3';
const pythonCheck = spawnSync(python, ['-c', 'import numpy; import PIL'], { encoding: 'utf8' });
const ffmpegCheck = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
const canRun = pythonCheck.status === 0 && ffmpegCheck.status === 0;

function containsPycache(directory: string): boolean {
  if (!existsSync(directory)) return false;
  return readdirSync(directory, { withFileTypes: true }).some((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? entry.name === '__pycache__' || containsPycache(path)
      : entry.name.endsWith('.pyc');
  });
}

describe('media-inspect lab skill', () => {
  it.skipIf(!canRun)('self-tests its shared media library without Python cache files', () => {
    // Budget sized for a loaded machine, not an idle one: this selftest costs 28 s
    // on a quiet box, but under the full suite's process load it ran past 120 s and
    // failed with `spawnSync python ETIMEDOUT` (three full runs in a row on
    // 2026-11-14). The test timeout stays above the spawn timeout on purpose: then
    // the spawn's own error is what fails the test, whereas a vitest kill mid-run
    // also strands the selftest's own temp folders, which the temp guard then
    // blames on this file as a second, misleading failure.
    const result = spawnSync(
      python,
      ['-B', join(skillRoot, 'media-inspect', 'scripts', 'selftest.py')],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 300_000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('ok test_core.py');
    expect(containsPycache(skillRoot)).toBe(false);
    expect(containsPycache(shippedSkillsRoot)).toBe(false);
  }, 330_000);
});
