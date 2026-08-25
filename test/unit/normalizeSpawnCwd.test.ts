import { describe, expect, it } from 'vitest';
import { normalizeSpawnCwd } from '../../src/util/processSpawn';

// VS Code's Uri.fsPath lower-cases the Windows drive letter. Passing that
// straight to spawn made vitest load two copies of its own module graph and
// fail every file at `describe` with "Cannot read properties of undefined
// (reading 'config')" — a broken path that reads as a broken test file.
describe('normalizeSpawnCwd', () => {
  const win = process.platform === 'win32';

  it.runIf(win)('upper-cases a lower-case Windows drive letter', () => {
    expect(normalizeSpawnCwd('n:\vs code apps\Forge')).toBe('N:\vs code apps\Forge');
    expect(normalizeSpawnCwd('c:/Users/x')).toBe('C:/Users/x');
  });

  it.runIf(win)('leaves an already upper-case drive letter alone', () => {
    expect(normalizeSpawnCwd('N:\vs code apps\Forge')).toBe('N:\vs code apps\Forge');
  });

  it.runIf(win)('leaves UNC and relative paths alone', () => {
    expect(normalizeSpawnCwd('\\server\share\proj')).toBe('\\server\share\proj');
    expect(normalizeSpawnCwd('sub/dir')).toBe('sub/dir');
  });

  it.runIf(!win)('is a no-op off Windows', () => {
    expect(normalizeSpawnCwd('/home/user/proj')).toBe('/home/user/proj');
  });
});
