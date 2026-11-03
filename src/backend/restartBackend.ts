import { expandAlias, mergeGroupsIntoModel, splitModelProfile } from '../config/ConfigResolver';
import type { ForgeConfig } from '../config/types';
import { isManagedExternalModel } from './ExternalModelServers';
import type { IBackendPool } from './poolTypes';

/**
 * Start Backend: start `modelName` the way a turn reaches it. A managed external
 * server (Strata) has no `gguf_path`, so `acquire` — which spawns llama-server —
 * fails on it with "missing gguf_path". It goes through `prepareExternal`
 * instead, which starts its server; the model loads on the server's next request.
 */
export async function startBackend(
  pool: IBackendPool,
  config: ForgeConfig,
  modelName: string,
): Promise<void> {
  if (isManaged(config, modelName)) await externalStarter(pool, modelName)();
  else await pool.acquire(modelName);
}

/** Restart Backend: stop every backend, then `startBackend`. A managed model this
 *  pool cannot start is refused BEFORE the stop, so a refusal unloads nothing. */
export async function restartBackend(
  pool: IBackendPool,
  config: ForgeConfig,
  modelName: string,
  onStopped?: () => void,
): Promise<void> {
  const start = isManaged(config, modelName)
    ? externalStarter(pool, modelName)
    : () => pool.acquire(modelName);
  await pool.stopAll();
  onStopped?.();
  await start();
}

function isManaged(config: ForgeConfig, modelName: string): boolean {
  const base = splitModelProfile(expandAlias(config, modelName)).base;
  const raw = config.models.find((m) => m.name === base);
  return raw !== undefined && isManagedExternalModel(mergeGroupsIntoModel(config, raw));
}

function externalStarter(pool: IBackendPool, modelName: string): () => Promise<void> {
  const prepare = pool.prepareExternal?.bind(pool);
  if (!prepare) throw new Error(`"${modelName}" is a managed server this pool cannot start`);
  return () => prepare(modelName);
}
