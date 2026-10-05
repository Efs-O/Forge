import { afterEach, describe, expect, it, vi } from 'vitest';
import { backgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import {
  makeMonitorExecutionTool,
} from '../../src/tools/backgroundExecutionTools';

describe('monitor_execution wait limit', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clamps wait_ms above 60000 and reports the clamp', async () => {
    const observe = vi.spyOn(backgroundExecutionManager, 'observe').mockResolvedValue({
      id: 'exec-clamp',
      command: 'node',
      status: 'running',
      pid: 1,
      startedAt: Date.now(),
      finishedAt: undefined,
      exitCode: null,
      error: undefined,
      stdout: '',
      stderr: '',
      stdoutStart: 0,
      stderrStart: 0,
      stdoutEnd: 0,
      stderrEnd: 0,
      stdoutOldest: 0,
      stderrOldest: 0,
      stdoutDropped: 0,
      stderrDropped: 0,
    });
    const result = await makeMonitorExecutionTool().handler({
      execution_id: 'exec-clamp',
      wait_ms: 60_001,
    });
    expect(observe).toHaveBeenCalledWith('exec-clamp', 60_000, 0, 0, undefined);
    expect(result).toContain('wait_ms clamped to 60000');
  });

});
