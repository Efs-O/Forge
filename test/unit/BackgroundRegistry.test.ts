import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundExecutionManager } from '../../src/tools/BackgroundExecutionManager';
import { BackgroundRegistry, type BackgroundRegistryDeps } from '../../src/tools/backgroundRegistry';

const root = path.join(process.cwd(), '.test-tmp', 'background-registry');
const entries = (): string[] => {
  try {
    return fs.readdirSync(root).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
};

function deps(overrides: Partial<BackgroundRegistryDeps> = {}): BackgroundRegistryDeps {
  return {
    isAlive: () => true,
    processStartMsAsync: async () => 1234,
    killTree: vi.fn(async () => {}),
    owner: { pid: process.pid, startedAt: 1234 },
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    ...overrides,
  };
}

describe('background execution registry', () => {
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('writes after asynchronous identity lookup, then removes on exit and stop', async () => {
    const identity = Promise.withResolvers<number | undefined>();
    const registry = new BackgroundRegistry(root, deps({ processStartMsAsync: () => identity.promise }));
    const manager = new BackgroundExecutionManager(registry);
    const first = manager.start({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 500)'],
      cwd: process.cwd(),
      env: { FORGE_CONVERSATION_ID: 'chat-a' },
    });
    expect(first.status).toBe('running');
    expect(entries()).toHaveLength(0); // start() did not block on PowerShell.
    identity.resolve(1234);
    await vi.waitFor(() => expect(entries()).toHaveLength(1));
    expect(manager.listRunningForConversation('chat-a').map((item) => item.id)).toEqual([first.id]);
    expect(manager.listRunningForConversation('chat-b')).toEqual([]);
    await vi.waitFor(() => expect(entries()).toHaveLength(0), { timeout: 5_000 });

    const second = manager.start({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    await vi.waitFor(() => expect(entries()).toHaveLength(1));
    await manager.stop(second.id);
    expect(entries()).toHaveLength(0);
    await manager.dispose();
  });

  it('does not write a stale record when the execution exits before lookup resolves', async () => {
    const identity = Promise.withResolvers<number | undefined>();
    const registry = new BackgroundRegistry(root, deps({ processStartMsAsync: () => identity.promise }));
    const manager = new BackgroundExecutionManager(registry);
    const started = manager.start({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd() });
    await vi.waitFor(() => expect(manager.list().find((item) => item.id === started.id)?.status).toBe('completed'));
    identity.resolve(1234);
    await Promise.resolve();
    expect(entries()).toHaveLength(0);
    await manager.dispose();
  });

  it('keeps the process running and logs when identity lookup fails', async () => {
    const errors = vi.fn();
    const registry = new BackgroundRegistry(root, deps({
      processStartMsAsync: async () => undefined,
      error: errors,
    }));
    const manager = new BackgroundExecutionManager(registry);
    const started = manager.start({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
    expect(errors.mock.calls[0]?.[0]).toContain(started.id);
    expect(errors.mock.calls[0]?.[0]).toContain('will not be reaped');
    expect(manager.list().find((item) => item.id === started.id)?.status).toBe('running');
    expect(entries()).toHaveLength(0);
    await manager.stop(started.id);
    await manager.dispose();
  });

  it('reaps only a dead owner with the same child PID and start time', async () => {
    const killTree = vi.fn(async () => {});
    const registry = new BackgroundRegistry(root, deps({
      owner: { pid: 10, startedAt: 100 },
      isAlive: (pid) => [11, 40, 41, 42].includes(pid),
      processStartMsAsync: async (pid) => ({ 11: 110, 40: 400, 41: 10_000, 42: 420 }[pid]),
      killTree,
    }));
    await registry.register({ id: 'exec-a', pid: 40, processStartedAt: 400, command: 'python', args: ['-m', 'http.server'] });
    await registry.register({ id: 'exec-b', pid: 41, processStartedAt: 410, command: 'reused', args: [] });
    const aliveOwner = new BackgroundRegistry(root, deps({ owner: { pid: 11, startedAt: 110 } }));
    await aliveOwner.register({ id: 'exec-c', pid: 42, processStartedAt: 420, command: 'still-owned', args: [] });

    await registry.reap();

    expect(killTree).toHaveBeenCalledExactlyOnceWith(40);
    expect(entries()).toEqual(['11-exec-c.json']);
  });

  it('treats an entry deleted by another activating window as handled', async () => {
    const proceed = Promise.withResolvers<void>();
    const killTree = vi.fn(async () => { await proceed.promise; });
    const registry = new BackgroundRegistry(root, deps({
      owner: { pid: 10, startedAt: 100 },
      isAlive: (pid) => pid === 40,
      processStartMsAsync: async () => 400,
      killTree,
    }));
    await registry.register({ id: 'exec-a', pid: 40, processStartedAt: 400, command: 'node', args: [] });
    const first = registry.reap();
    const second = registry.reap();
    await vi.waitFor(() => expect(killTree).toHaveBeenCalledTimes(2));
    proceed.resolve();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(entries()).toHaveLength(0);
  });
});
