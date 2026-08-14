import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { coverageForPaths } from '../../src/checkpoint/CheckpointInventory';
import { parseCommittedManifest } from '../../src/checkpoint/CheckpointManifest';

describe('checkpoint manifest boundaries', () => {
  it('rejects traversal and protected .forge paths', () => {
    const workspaceRoot = path.join(path.sep, 'workspace');
    const base = {
      version: 1,
      status: 'committed',
      turnId: 'turn-1',
      workspaceRoot,
      createdAt: 1,
      originalEntries: [],
      createdPaths: ['../outside.txt'],
    };
    expect(() => parseCommittedManifest(JSON.stringify(base))).toThrow(/unsafe checkpoint path/);
    expect(() => coverageForPaths(workspaceRoot, [path.join(workspaceRoot, '.forge', 'config.yaml')])).toThrow(
      /unsafe|protected path/,
    );
  });
});
