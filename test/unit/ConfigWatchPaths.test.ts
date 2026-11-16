import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchForgeConfigPaths } from '../../src/config/ConfigLoader';
import { FILE_SETTLE_MS, MAX_FILE_SETTLE_ROUNDS } from '../../src/config/fileSettle';

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

  /** A save lands, the debounce ends, and the quiet window is open. */
  function saveMidSettle(): {
    dir: string;
    reload: ReturnType<typeof vi.fn>;
    watch: { dispose(): void };
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-watch-close-'));
    const primary = path.join(dir, 'config.yaml');
    fs.writeFileSync(primary, 'active_model: test\n');
    const reload = vi.fn();
    const watch = watchForgeConfigPaths(primary, [], reload);
    watchers[0]!.change!({ fsPath: primary });
    vi.advanceTimersByTime(150); // the debounce is over; the quiet window is open
    expect(reload).not.toHaveBeenCalled();
    return { dir, reload, watch };
  }

  it('never reloads after dispose, however long the quiet window still runs', () => {
    vi.useFakeTimers();
    const { dir, reload, watch } = saveMidSettle();
    try {
      // The window closes inside the settle window — the save is a second away old.
      watch.dispose();
      // Past every round the settle loop could still ask for, drift included.
      vi.advanceTimersByTime(FILE_SETTLE_MS * (MAX_FILE_SETTLE_ROUNDS + 2) + 1000);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      watch.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does reload once when nothing disposed the watcher', () => {
    vi.useFakeTimers();
    const { dir, reload, watch } = saveMidSettle();
    try {
      vi.advanceTimersByTime(FILE_SETTLE_MS + 1000);
      expect(reload).toHaveBeenCalledExactlyOnceWith(null, expect.any(Error));
    } finally {
      watch.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
