import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnStatus } from '../../src/agentMesh/turnStatus';

let root: string;

afterEach(async () => {
  if (root) await fs.promises.rm(root, { recursive: true, force: true });
});

describe('turn status durability (F-08)', () => {
  it('writes the running record through a temporary file and rename', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mesh-status-'));
    const file = path.join(root, 'bus-codex-1.json');
    const renamed = vi.fn(fs.renameSync);

    new TurnStatus(root, renamed).markTurnStarted('bus-codex-1', 'in flight');

    expect(renamed).toHaveBeenCalledWith(`${file}.tmp`, file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      turnId: 'bus-codex-1',
      state: 'running',
    });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });
});
