import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshSessionProvider } from '../../src/agentMesh/sessionProvider';
import type { TurnStatus } from '../../src/agentMesh/turnStatus';
import {
  MESH_MAINTENANCE_INTERVAL_MS,
  createMeshMaintenance,
} from '../../src/vscode/meshMaintenance';
import { createMeshVerdictPoll } from '../../src/vscode/meshVerdictPoll';

// The two mesh timers moved out of agentMeshSetup.ts in the max-lines split
// (MAX_LINES_SPLIT_PLAN.md A8): a timer left running after dispose() keeps
// polling the bus from a window that no longer owns it.
describe('mesh timers', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mesh-timers-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const exchangePaths = () => ({
    log: path.join(root, 'exchanges.jsonl'),
    lock: path.join(root, 'exchanges.lock'),
  });

  it('maintenance dispose() stops its interval', () => {
    const maintenance = createMeshMaintenance({
      root,
      exchangePaths: exchangePaths(),
      provider: { reap: vi.fn(), list: vi.fn(() => []) } as unknown as MeshSessionProvider,
      turnStatus: { sweepDead: vi.fn() } as unknown as TurnStatus,
      onEvent: vi.fn(async () => undefined),
    });
    maintenance.start();
    expect(vi.getTimerCount()).toBe(1);
    maintenance.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MESH_MAINTENANCE_INTERVAL_MS * 3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('verdict poll dispose() stops its interval', () => {
    const onEvent = vi.fn(async () => undefined);
    const poll = createMeshVerdictPoll({
      outboxDir: path.join(root, 'outbox'),
      exchangePaths: exchangePaths(),
      onEvent,
    });
    poll.start();
    expect(vi.getTimerCount()).toBe(1);
    poll.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MESH_MAINTENANCE_INTERVAL_MS * 3);
    expect(onEvent).not.toHaveBeenCalled();
  });
});
