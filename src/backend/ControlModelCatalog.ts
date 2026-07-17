import { createHash } from 'crypto';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { availableProfilesFor, deriveStaticCapabilities } from '../config/ConfigResolver';
import { getProviderDisplayName, isCloudProvider } from '../llm/CloudProviders';
import type { IBackendPool } from './BackendPool';

export const MODEL_CATALOG_CONTRACT_VERSION = 1;

export type ModelCatalogRoute = 'ensure' | 'chat';
export type ModelCatalogAction = 'dispatch' | 'ensure' | 'wait' | 'configure' | 'none';
export type ModelAvailability =
  | 'ready'
  | 'loadable'
  | 'loading'
  | 'busy'
  | 'degraded'
  | 'unavailable'
  | 'unknown';

export interface ControlModelCatalogEntry {
  id: string;
  baseModel: string;
  name: string;
  backend: string;
  provider: string;
  loaded: boolean;
  holds: number;
  servable: boolean;
  profiles: string[];
  capabilities: string[];
  route: ModelCatalogRoute;
  action: ModelCatalogAction;
  availability: ModelAvailability;
  reason?: string;
}

export interface ControlModelCatalog {
  contractVersion: typeof MODEL_CATALOG_CONTRACT_VERSION;
  catalogVersion: string;
  models: ControlModelCatalogEntry[];
}

interface CatalogState {
  config: ForgeConfig;
  pool: IBackendPool;
  holds: ReadonlyMap<string, number>;
  loadingModels: ReadonlySet<string>;
  lastAcquiredAt: ReadonlyMap<string, number>;
  evictionGraceMs: number;
  chatAvailable: boolean;
  now?: number;
}

function localAvailability(
  model: ModelConfig,
  state: CatalogState,
): Pick<ControlModelCatalogEntry, 'availability' | 'action' | 'reason'> {
  if (state.loadingModels.has(model.name)) {
    return { availability: 'loading', action: 'wait', reason: 'backend_loading' };
  }
  if (state.pool.isLoaded(model.name)) {
    return { availability: 'ready', action: 'ensure' };
  }
  if (model.provider === 'ollama') {
    return { availability: 'loadable', action: 'ensure' };
  }

  const now = state.now ?? Date.now();
  const loaded = state.pool.loadedModelNames();
  const evictable = loaded.filter(
    (name) =>
      (state.holds.get(name) ?? 0) === 0 &&
      now - (state.lastAcquiredAt.get(name) ?? 0) >= state.evictionGraceMs,
  );
  const occupied = loaded.length - evictable.length;
  if (occupied >= (state.config.max_simultaneous_models ?? 1)) {
    return { availability: 'busy', action: 'wait', reason: 'capacity_full' };
  }
  return { availability: 'loadable', action: 'ensure' };
}

function entryFor(model: ModelConfig, state: CatalogState): ControlModelCatalogEntry {
  const cloud = isCloudProvider(model.provider);
  const execution = cloud
    ? state.chatAvailable
      ? ({ availability: 'ready', action: 'dispatch' } as const)
      : ({
          availability: 'unavailable',
          action: 'configure',
          reason: 'chat_proxy_unavailable',
        } as const)
    : localAvailability(model, state);
  return {
    id: model.name,
    baseModel: model.name,
    name: model.name,
    backend: model.provider ?? 'llama.cpp',
    provider: getProviderDisplayName(model),
    loaded: state.pool.isLoaded(model.name),
    holds: state.holds.get(model.name) ?? 0,
    servable: !cloud,
    profiles: availableProfilesFor(state.config, model.name),
    capabilities: deriveStaticCapabilities(model),
    route: cloud ? 'chat' : 'ensure',
    ...execution,
  };
}

export function buildControlModelCatalog(state: CatalogState): ControlModelCatalog {
  const models = state.config.models.map((model) => entryFor(model, state));
  const revisionInput = JSON.stringify(models);
  const catalogVersion = createHash('sha256').update(revisionInput).digest('hex').slice(0, 16);
  return { contractVersion: MODEL_CATALOG_CONTRACT_VERSION, catalogVersion, models };
}
