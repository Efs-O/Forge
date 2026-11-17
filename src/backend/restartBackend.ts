import {
  expandAlias,
  mergeGroupsIntoModel,
  resolveModelName,
  splitModelProfile,
} from '../config/ConfigResolver';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { isManagedExternalModel } from './ExternalModelServers';
import { spawnsLlamaServer } from './ModelHeuristics';
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

/** Restart one model without touching the others: release its slot, then start
 *  it back the way a turn reaches it — a managed external server (Strata) goes
 *  through `prepareExternal`, never the llama-server spawn. */
export async function restartModelBackend(
  pool: IBackendPool,
  config: ForgeConfig,
  modelName: string,
): Promise<void> {
  await pool.release(modelName);
  await startBackend(pool, config, modelName);
}

/** The model entry behind `modelName`, resolved the way the request path
 *  resolves it: alias expanded, `@profile` split, then the deterministic
 *  resolver (exact name, alias, `short_name`, case, unique prefix/substring).
 *  Groups and engine folded in. Undefined when nothing resolves — an unknown
 *  or ambiguous name is no entry to decide from. */
function resolvedModel(config: ForgeConfig, modelName: string): ModelConfig | undefined {
  const base = splitModelProfile(expandAlias(config, modelName)).base;
  let canonical: string;
  try {
    canonical = resolveModelName(config, base);
  } catch {
    return undefined;
  }
  const raw = config.models.find((m) => m.name === canonical);
  return raw ? mergeGroupsIntoModel(config, raw) : undefined;
}

function isManaged(config: ForgeConfig, modelName: string): boolean {
  const model = resolvedModel(config, modelName);
  return model !== undefined && isManagedExternalModel(model);
}

/** How switching `llama_server.binary` touches `modelName`: `llama` when Forge
 *  spawns a llama-server for it — restarting that model proves the new binary;
 *  `other` when the model has a server Forge does not spawn (Strata, Ollama,
 *  cloud) — the switch defers to the next llama.cpp load; `unknown` when no
 *  configured model answers to the name. This is the question the
 *  `llamacpp_update` switch asks before its post-check restart. Resolved like
 *  the request path: `active_model` may be a shorthand, and a `provider` is
 *  routinely inherited from a group — a raw exact-name lookup misclassifies
 *  both (2026-11-17 review). */
export function llamaBinaryImpact(
  config: ForgeConfig,
  modelName: string,
): 'llama' | 'other' | 'unknown' {
  const model = resolvedModel(config, modelName);
  if (model === undefined) return 'unknown';
  return spawnsLlamaServer(model) ? 'llama' : 'other';
}

function externalStarter(pool: IBackendPool, modelName: string): () => Promise<void> {
  const prepare = pool.prepareExternal?.bind(pool);
  if (!prepare) throw new Error(`"${modelName}" is a managed server this pool cannot start`);
  return () => prepare(modelName);
}
