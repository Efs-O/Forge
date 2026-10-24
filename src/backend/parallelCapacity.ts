import { resolveSpawnModel } from '../config/ConfigResolver';
import type { ForgeConfig } from '../config/types';
import { DEFAULT_LLAMA_PARALLEL } from '../util/contextBudget';

/** Effective llama-server slots for a model, shared by the pool and mode command. */
export function effectiveParallelCapacity(config: ForgeConfig, modelName: string): number {
  const model = resolveSpawnModel(config, modelName);
  return model.n_parallel ?? config.llama_server.n_parallel ?? DEFAULT_LLAMA_PARALLEL;
}
