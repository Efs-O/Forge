import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeCheckpointStats } from '../../src/sidebar/checkpointStats';

const lines = (n: number, prefix = 'line'): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';

describe('computeCheckpointStats', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ckpt-stats-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts a new file once by its final contents, however many writes made it', () => {
    // The checkpoint bar used to sum every write's diff, so a new file edited
    // after creation read as more lines than it has.
    const file = path.join(dir, 'game.html');
    fs.writeFileSync(file, lines(40));
    expect(computeCheckpointStats([{ filePath: file, original: null }])).toEqual({
      fileCount: 1,
      added: 40,
      removed: 0,
      uncountedFiles: 0,
    });
  });

  it('nets an edited file against its pre-turn contents', () => {
    const file = path.join(dir, 'a.ts');
    const before = lines(10);
    fs.writeFileSync(file, before.replace('line 3\n', 'changed 3\n') + 'extra\n');
    expect(computeCheckpointStats([{ filePath: file, original: before }])).toEqual({
      fileCount: 1,
      added: 2,
      removed: 1,
      uncountedFiles: 0,
    });
  });

  it('skips a file written back to its original contents', () => {
    const file = path.join(dir, 'same.ts');
    fs.writeFileSync(file, lines(5));
    expect(computeCheckpointStats([{ filePath: file, original: lines(5) }]).fileCount).toBe(0);
  });

  it('counts a deleted file as all lines removed', () => {
    const file = path.join(dir, 'gone.ts');
    expect(computeCheckpointStats([{ filePath: file, original: lines(7) }])).toEqual({
      fileCount: 1,
      added: 0,
      removed: 7,
      uncountedFiles: 0,
    });
  });

  it('counts files above the in-process diff cap through git', () => {
    const file = path.join(dir, 'big.html');
    fs.writeFileSync(file, lines(2136));
    const stats = computeCheckpointStats([{ filePath: file, original: null }]);
    expect(stats.fileCount).toBe(1);
    expect(stats.added + stats.uncountedFiles).toBeGreaterThan(0);
    if (stats.uncountedFiles === 0) expect(stats.added).toBe(2136);
  });

  it('ignores a snapshotted directory', () => {
    expect(computeCheckpointStats([{ filePath: dir, original: null }]).fileCount).toBe(0);
  });
});
