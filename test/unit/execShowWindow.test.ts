/**
 * `show_window` on background `exec_command` (plan Phase 2 items 3-5; report
 * §3.3). The defect was that EVERY background launch used `windowsHide: true`,
 * so a GUI app started through `exec_command` could never appear on screen.
 *
 * These tests assert the SPAWN OPTION, not a visible window, so they are
 * deterministic in CI: `child_process.spawn` is faked and its options captured.
 * The live half (launch a disposable GUI, see it in `desktop_windows`, close
 * only the test-owned process) is a separate manual smoke, recorded as such.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcessByStdio } from 'child_process';

interface SpawnCall {
  command: string;
  args: string[];
  options: { windowsHide?: boolean; cwd?: string; env?: NodeJS.ProcessEnv };
}

const h = vi.hoisted(() => ({ calls: [] as SpawnCall[] }));

vi.mock('child_process', () => ({
  spawn: (command: string, args: string[], options: SpawnCall['options']) => {
    h.calls.push({ command, args: [...args], options });
    const child = new EventEmitter() as unknown as ChildProcessByStdio<
      null,
      NodeJS.ReadableStream,
      NodeJS.ReadableStream
    > & { pid: number };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4321;
    // A real killed child reports exit/close; stop() waits for that, so the fake
    // must emit it or every stop() hangs. Nothing here exits on its own.
    child.kill = () => {
      setTimeout(() => {
        child.emit('exit', null);
        child.emit('close', null);
      }, 0);
      return true;
    };
    return child;
  },
}));

// Imported after vi.mock is registered (vitest hoists the mock above imports).
import {
  BackgroundExecutionManager,
  backgroundExecutionManager,
} from '../../src/tools/BackgroundExecutionManager';
import { makeExecCommandTool } from '../../src/tools/execTools';

function lastSpawn(): SpawnCall {
  const call = h.calls[h.calls.length - 1];
  if (!call) throw new Error('no spawn was attempted');
  return call;
}

const tool = () => makeExecCommandTool(() => false);

describe('exec_command show_window (spawn visibility)', () => {
  const manager = new BackgroundExecutionManager();

  beforeEach(() => {
    h.calls.length = 0;
  });
  afterEach(() => {
    // The tool handler starts jobs on the module singleton, not on `manager`, so
    // both have to be torn down or a fake child leaks between tests.
    manager.dispose();
    backgroundExecutionManager.dispose();
  });

  it('defaults to a hidden window when show_window is absent', async () => {
    // The regression guard for §3.3 in the other direction: console helpers must
    // stay hidden, so the default cannot flip to visible.
    const started = manager.start({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    });
    expect(lastSpawn().options.windowsHide).toBe(true);
    await manager.stop(started.id);
  });

  it('honours showWindow: true as windowsHide: false, and false as hidden', async () => {
    const visible = manager.start({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      showWindow: true,
    });
    expect(lastSpawn().options.windowsHide).toBe(false);

    const hidden = manager.start({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      showWindow: false,
    });
    expect(lastSpawn().options.windowsHide).toBe(true);
    await manager.stop(visible.id);
    await manager.stop(hidden.id);
  });

  it('declares show_window as a strict boolean in the schema', () => {
    const props = tool().definition.function.parameters?.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props['show_window']?.['type']).toBe('boolean');
  });

  it('passes show_window through to the single spawn site', async () => {
    const result = (await tool().handler({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      background: true,
      show_window: true,
    })) as string;
    // One spawn only: the flag must not introduce a second launch path.
    expect(h.calls).toHaveLength(1);
    expect(lastSpawn().options.windowsHide).toBe(false);
    // And the result names the launcher/child limit (item 4).
    expect(result).toMatch(/tracks the process started here/);
    expect(result).toMatch(/may report completed while its GUI stays open/);
    const id = /exec-[0-9a-f-]+/.exec(result)?.[0];
    if (!id) throw new Error('no execution id in the result');
    // The job lives on the singleton; stop it by the id the tool reported.
    await backgroundExecutionManager.stop(id);
  });

  it('defaults to hidden through the tool when show_window is omitted', async () => {
    await tool().handler({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      background: true,
    });
    expect(h.calls).toHaveLength(1);
    expect(lastSpawn().options.windowsHide).toBe(true);
  });

  it('refuses show_window without background BEFORE any spawn', async () => {
    await expect(
      tool().handler({
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: process.cwd(),
        show_window: true,
      }),
    ).rejects.toThrow(/show_window requires background: true/);
    expect(h.calls).toEqual([]);
  });

  it('refuses a non-boolean show_window BEFORE any spawn', async () => {
    for (const bad of ['true', 1, 'false', null]) {
      await expect(
        tool().handler({
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: process.cwd(),
          background: true,
          show_window: bad,
        }),
      ).rejects.toThrow(/show_window must be a boolean/);
    }
    expect(h.calls).toEqual([]);
  });

  it('refuses show_window on a non-Windows host BEFORE any spawn', async () => {
    // The guard reads process.platform at call time, so the assertion follows
    // the host that runs it rather than hard-coding Windows.
    const isWin = process.platform === 'win32';
    const p = tool().handler({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: process.cwd(),
      background: true,
      show_window: true,
    });
    if (isWin) {
      await p;
      expect(lastSpawn().options.windowsHide).toBe(false);
    } else {
      await expect(p).rejects.toThrow(/show_window is Windows-only/);
      expect(h.calls).toEqual([]);
    }
  });

  it('keeps the denylist ahead of the visibility flag', async () => {
    // A visible window must not become a way to run a refused command.
    await expect(
      tool().handler({
        command: 'cmd',
        args: ['/c', 'rd /s x'],
        cwd: process.cwd(),
        background: true,
        show_window: true,
      }),
    ).rejects.toThrow(/denylist pattern/);
    expect(h.calls).toEqual([]);
  });

  it('reports a launcher stub exit without claiming its GUI child died', async () => {
    // The plan's item-4 requirement: a launcher that exits immediately is
    // reported as completed for the LAUNCHER, and the text must not imply the
    // GUI app it started has closed. The manager only ever knows the pid it
    // spawned, so it can neither track nor stop the child GUI app.
    const started = manager.start({
      command: 'write.exe',
      args: [],
      cwd: process.cwd(),
      showWindow: true,
    });
    expect(lastSpawn().options.windowsHide).toBe(false);
    const obs = await manager.observe(started.id, 0, 0, 0);
    // The fake child never exits, so the tracked process is still "running" —
    // the point is that no assertion here depends on a GUI child's state.
    expect(obs.status).toBe('running');
    await manager.stop(started.id);
  });
});
