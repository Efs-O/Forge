import { describe, expect, it } from 'vitest';
import { coverageForPaths } from '../../src/checkpoint/CheckpointInventory';
import { parseCommittedManifest } from '../../src/checkpoint/CheckpointManifest';

describe('checkpoint manifest boundaries', () => {
  it('rejects traversal and protected .forge paths', () => {
    const base = {
      version: 1,
      status: 'committed',
      turnId: 'turn-1',
      workspaceRoot: 'C:\\workspace',
      createdAt: 1,
      originalEntries: [],
      createdPaths: ['../outside.txt'],
    };
    expect(() => parseCommittedManifest(JSON.stringify(base))).toThrow(/unsafe checkpoint path/);
    expect(() => coverageForPaths('C:\\workspace', ['C:\\workspace\\.forge\\config.yaml'])).toThrow(
      /unsafe|protected path/,
    );
  });
});
