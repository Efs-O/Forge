import * as fs from 'fs';

/**
 * Wait for a watched file to stop changing before anything reads it.
 *
 * A save is not one atomic write. An editor truncates the file and flushes it in
 * chunks, and the file-system watcher fires on the first chunk. The config reload
 * that follows can therefore read a half-written file — and a half-written YAML
 * file is not always a parse error, because a mapping simply ends where the file
 * does. The 2026-11-13 lab caught this for real: the owner changed
 * `permissions.approval_timeout_minutes` from 15 to 10, the reload read the file
 * mid-flush, the line came through as `approval_timeout_minutes: 1`, `1` is a
 * valid value under `permissionsSchema.ts`, and both windows then expired every
 * approval card after one minute for the next eight hours. VS Code's own history
 * for that file shows the saved content was `10` before and after, so nothing
 * wrong was ever saved: the read was torn, and nothing re-read it until the next
 * save. That is a defect for any setting, not just this one — a dropped model
 * entry or a flipped permission is the same accident.
 *
 * So: watch the bytes, not the event. Take a snapshot, wait, take another, and
 * only read once two snapshots agree. A file still being written never gets read.
 * Bounded, because a config load that hangs is worse than one that races.
 */

/** How long the watched files must be unchanged before they are considered stable. */
export const FILE_SETTLE_MS = 200;

/** How many times to wait out a file that keeps changing before reading it anyway. */
export const MAX_FILE_SETTLE_ROUNDS = 5;

/**
 * A comparable fingerprint of every watched file: size and modification time, or
 * `absent`. A torn read changes this line, because the writer is still appending.
 */
export function snapshotWatchedFiles(
  paths: readonly string[],
  stat: (path: string) => fs.Stats = (path) => fs.statSync(path),
): string {
  return [...paths]
    .map((filePath) => {
      try {
        const stats = stat(filePath);
        return `${filePath}|${String(stats.size)}|${Math.round(stats.mtimeMs)}`;
      } catch {
        return `${filePath}|absent`;
      }
    })
    .sort()
    .join('\n');
}

export interface FileSettleDeps {
  /** The files that must be quiet before `onLoad` runs. */
  paths: readonly string[];
  onLoad: () => void;
  /**
   * True once the caller has gone away — the window closed, the watcher was disposed.
   * Checked when each wait fires: a reload nobody is waiting for is dropped rather than
   * run, and the settle loop stops rather than rescheduling itself forever.
   */
  cancelled?: () => boolean;
  /** Injectable for tests: the wait itself, and the fingerprint of the files. */
  settleMs?: number;
  sleep?: (ms: number, run: () => void) => void;
  snapshot?: (paths: readonly string[]) => string;
  maxRounds?: number;
}

/**
 * Run `onLoad` once the watched files have been unchanged for one settle window.
 * A file that is still being written pushes the read back, up to `maxRounds`
 * times; after that the read happens anyway, because refusing to load a config
 * would leave the window without one at all. A caller that has already gone away
 * (`cancelled`) gets no read at all, and no further rounds.
 */
export function runWhenFilesSettled(deps: FileSettleDeps, round = 0): void {
  const settleMs = deps.settleMs ?? FILE_SETTLE_MS;
  const sleep = deps.sleep ?? ((ms, run) => setTimeout(run, ms));
  const snapshot = deps.snapshot ?? snapshotWatchedFiles;
  const maxRounds = deps.maxRounds ?? MAX_FILE_SETTLE_ROUNDS;
  const before = snapshot(deps.paths);
  sleep(settleMs, () => {
    // Checked before anything else: the caller may have closed while this window ran.
    if (deps.cancelled?.()) return;
    if (snapshot(deps.paths) !== before && round < maxRounds) {
      runWhenFilesSettled(deps, round + 1);
      return;
    }
    deps.onLoad();
  });
}
