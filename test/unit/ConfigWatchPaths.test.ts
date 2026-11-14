import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchForgeConfigPaths } from '../../src/config/ConfigLoader';

const { watchers } = vi.hoisted(() => ({
  watchers: [] as Array<{
    change?: (uri: { fsPath: string }) => void;
    create?: (uri: { fsPath: string }) => void;
  }>,
}));
vi.mock('vscode', async (original) => ({
  ...(await original<typeof import('vscode')>()),
  workspace: {
    createFileSystemWatcher: () => {
      const callbacks: (typeof watchers)[number] = {};
      watchers.push(callbacks);
      return {
        onDidChange: (callback: typeof callbacks.change) => {
          callbacks.change = callback;
        },
        onDidCreate: (callback: typeof callbacks.create) => {
          callbacks.create = callback;
        },
        dispose() {},
      };
    },
  },
}));
afterEach(() => {
  watchers.length = 0;
  vi.useRealTimers();
});

describe('config watcher event identity', () => {
  it('ignores another workspace and backup paths, but debounces its exact file', () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-watch-path-'));
    const primary = path.join(dir, 'config.yaml');
    const reload = vi.fn();
    const watch = watchForgeConfigPaths(primary, [], reload);
    try {
      watchers[0]!.change!({ fsPath: path.join(dir, 'other', 'config.yaml') });
      watchers[0]!.create!({ fsPath: `${primary}.bak` });
      vi.advanceTimersByTime(200);
      expect(reload).not.toHaveBeenCalled();
      watchers[0]!.change!({ fsPath: primary });
      watchers[0]!.create!({ fsPath: primary });
      // The debounce (150 ms) plus the window the files must stay quiet for (200 ms).
      vi.advanceTimersByTime(400);
      expect(reload).toHaveBeenCalledExactlyOnceWith(null, expect.any(Error));
    } finally {
      watch.dispose();
      fs.rmdirSync(dir);
    }
  });

  it('refuses to read a config that is still being written', () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-watch-settle-'));
    const primary = path.join(dir, 'config.yaml');
    // The first chunk of a save: a reader that stops here never sees the rest.
    fs.writeFileSync(primary, 'active_model: test\n');
    const reload = vi.fn();
    const watch = watchForgeConfigPaths(primary, [], reload);
    try {
      watchers[0]!.change!({ fsPath: primary });
      vi.advanceTimersByTime(150); // the debounce is over; the quiet window is open
      fs.writeFileSync(
        primary,
        'active_model: test\npermissions:\n  approval_timeout_minutes: 10\n',
      );
      vi.advanceTimersByTime(199);
      expect(reload).not.toHaveBeenCalled(); // the file moved, so the read was pushed back
      vi.advanceTimersByTime(400);
      expect(reload).toHaveBeenCalledExactlyOnceWith(null, expect.any(Error));
    } finally {
      watch.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
