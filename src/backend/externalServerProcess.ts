import type { ModelConfig } from '../config/types';
import { getLogger } from '../util/logger';
import type { StopSpawner } from './ExternalServerStopWatcher';
import { probeHttp } from './HealthCheck';

const log = getLogger();

/** How long to wait for a started server to accept connections before giving up. */
export const START_TIMEOUT_MS = 180_000;
/** How often to probe while waiting for a started server. */
export const START_POLL_MS = 2_000;
/** An explicit stop waits for the server to leave its port before reporting success. */
const STOP_TIMEOUT_MS = 90_000;

/**
 * The process control for a managed external server's own engine, split out of
 * `ExternalModelServers` (2026-11-27) so that class fits its size cap and keeps
 * only the residency decisions. Each function takes the spawn implementation it
 * uses, so a test can inject its own without the class. Deciding *whether* to
 * start or stop, and what the residency map says afterwards, stays in
 * `ExternalModelServers`.
 */

/** Launch `start_command` detached so it survives the extension host. */
export function launchStartCommand(
  spawnImpl: StopSpawner,
  model: ModelConfig,
  onError: (error: Error) => void,
): void {
  const [command, ...args] = model.start_command!;
  try {
    const resolvedArgs = args.map((arg) => {
      if (arg !== '{num_ctx}') return arg;
      const numCtx = model.num_ctx;
      if (numCtx === undefined || !Number.isInteger(numCtx) || numCtx <= 0) {
        throw new Error(`start_command uses "{num_ctx}", but "${model.name}" has no valid num_ctx`);
      }
      return String(numCtx);
    });
    const child = spawnImpl(command, resolvedArgs, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once?.('error', (error) => {
      log.error(`[ExternalModelServers] start command failed for "${model.name}"`, error);
      onError(error);
    });
    child.unref();
    log.info(`[ExternalModelServers] launched start command for "${model.name}"`);
  } catch (error) {
    throw new Error(`Could not launch start command for "${model.name}": ${describeError(error)}`);
  }
}

/** Poll the endpoint until it accepts connections or the timeout is reached. */
export async function waitUntilReachable(
  endpoint: string,
  failed: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if ((await probeHttp(endpoint)).reachable) return true;
    if (failed() || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
}

/**
 * Spawn `stop_command` detached and wait until the endpoint stops answering.
 * `reason` is the log wording for why the server is going away. A command that
 * cannot run (ENOENT, EACCES) fails asynchronously, so the wait stops on it
 * rather than running out `STOP_TIMEOUT_MS`.
 */
export async function stopServerAndAwaitPort(
  spawnImpl: StopSpawner,
  model: ModelConfig,
  reason: string,
): Promise<void> {
  const [command, ...args] = model.stop_command!;
  let launchError: Error | undefined;
  try {
    const child = spawnImpl(command, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.once?.('error', (error) => {
      launchError = error;
    });
    child.unref();
  } catch (error) {
    throw new Error(`Could not stop "${model.name}": ${describeError(error)}`);
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  for (;;) {
    if (launchError) throw new Error(`Could not stop "${model.name}": ${launchError.message}`);
    if (!(await probeHttp(model.endpoint!)).reachable) {
      log.info(`[ExternalModelServers] stopped "${model.name}" ${reason}`);
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `"${model.name}" was unloaded but its server did not stop within ${STOP_TIMEOUT_MS / 1000}s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
}

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
}
