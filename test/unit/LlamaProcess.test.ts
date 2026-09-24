import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { killLlamaProcess } from '../../src/backend/llamaProcess';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));

function child(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null, signalCode: null, kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('llama process teardown', () => {
  it('keeps the parent alive until taskkill can identify and stop its tree', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const proc = child();
    const killer = child();
    mocks.spawn.mockReturnValue(killer);
    let complete = false;
    const stopping = killLlamaProcess(proc).then(() => { complete = true; });
    expect(proc.kill).not.toHaveBeenCalled();
    proc.emit('exit', 0);
    await Promise.resolve();
    expect(complete).toBe(false);
    killer.emit('exit', 0);
    await stopping;
    expect(complete).toBe(true);
  });

  it('surfaces taskkill failure instead of reporting a free backend', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const killer = child();
    mocks.spawn.mockReturnValue(killer);
    const result = expect(killLlamaProcess(child())).rejects.toThrow('taskkill failed');
    killer.emit('exit', 1);
    await result;
  });

  it('treats taskkill "not found" as stopped once the server’s own exit is seen', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const proc = child();
    const killer = child();
    mocks.spawn.mockReturnValue(killer);
    let complete = false;
    const stopping = killLlamaProcess(proc).then(() => { complete = true; });
    killer.emit('exit', 128);
    await Promise.resolve();
    expect(complete).toBe(false);
    proc.emit('exit', 1);
    await stopping;
    expect(complete).toBe(true);
  });

  it('rejects a wedged POSIX process and clears escalation after normal exit', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    vi.useFakeTimers();
    const proc = child();
    const result = expect(killLlamaProcess(proc)).rejects.toThrow('did not stop');
    await vi.advanceTimersByTimeAsync(6000);
    await result;
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    const healthy = child();
    const stopped = killLlamaProcess(healthy);
    healthy.emit('exit', 0);
    await stopped;
    await vi.advanceTimersByTimeAsync(6000);
    expect(healthy.kill).toHaveBeenCalledTimes(1);
  });
});
