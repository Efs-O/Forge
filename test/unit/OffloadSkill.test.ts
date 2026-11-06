import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills-lab');
const SELFTEST = path.join(SKILLS_ROOT, 'offload', 'scripts', 'selftest.py');
const pythonAvailable = spawnSync('python', ['--version'], { encoding: 'utf8' }).status === 0;
const canRun = process.platform === 'win32' && pythonAvailable;

function findBytecodeCaches(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === '__pycache__') found.push(fullPath);
    else if (entry.isDirectory()) found.push(...findBytecodeCaches(fullPath));
  }
  return found;
}

describe('skills-lab/offload', () => {
  it.skipIf(!canRun)(
    'self-tests copy, verification refusal, and same-call purge without bytecode caches',
    () => {
      const result = spawnSync('python', ['-B', SELFTEST], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      expect(result.error?.message).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(findBytecodeCaches(SKILLS_ROOT)).toEqual([]);
    },
    120_000,
  );
});
