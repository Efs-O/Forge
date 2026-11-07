import type { SpawnOptions } from 'child_process';
import type { ModelConfig } from '../config/types';
import { getLogger } from '../util/logger';
import { deferredStopInvocation, STOP_GRACE_MS } from './deferredStop';

const log = getLogger();

export interface StopChild {
  unref(): void;
  kill?(): boolean;
  once?(event: 'error', listener: (error: Error) => void): unknown;
}

export type StopSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => StopChild;

export interface StopOnExitOptions {
  lastWindow: boolean;
  isBusy: (modelName: string) => boolean;
  /** Lifecycle lease directory the deferred watcher re-checks before stopping. */
  leaseDir: string;
}

/**
 * The detached deferred-stop watcher for one managed external server.
 *
 * Split out of `ExternalModelServers` (2026-11-07). It owns only the launch:
 * `deferredStopInvocation` decides the grace period and the lease re-check, the
 * child is detached and unreferenced so it outlives the extension host, and an
 * `error` on it is reported rather than thrown. Deciding *whether* to stop —
 * last window, not busy, server-reported busy cancelling the watcher — stays
 * with the unload path that owns residency, in `ExternalModelServers`.
 */
export function launchStopWatcher(
  spawnImpl: StopSpawner,
  model: ModelConfig,
  leaseDir: string,
): StopChild | undefined {
  const stopCommand = model.stop_command ?? [];
  if (!stopCommand[0]) return undefined; // Config validation makes this unreachable in production.
  const { command, args, env } = deferredStopInvocation(leaseDir, STOP_GRACE_MS, stopCommand);
  try {
    const child = spawnImpl(command, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env,
    });
    child.once?.('error', (error) =>
      log.error(`[ExternalModelServers] stop watcher failed for "${model.name}"`, error),
    );
    child.unref();
    log.info(
      `[ExternalModelServers] stop scheduled for "${model.name}" in ${STOP_GRACE_MS / 1000} s unless a Forge window reopens`,
    );
    return child;
  } catch (error) {
    log.error(`[ExternalModelServers] could not launch stop for "${model.name}"`, error);
    return undefined;
  }
}
