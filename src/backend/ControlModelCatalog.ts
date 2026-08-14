import { createHash } from 'crypto';
import type { ForgeConfig, ModelConfig } from '../config/types';
import {
  availableProfilesFor,
  deriveStaticCapabilities,
  mergeGroupsIntoModel,
} from '../config/ConfigResolver';
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
  /** Short, memorable fuzzy-resolution identifier (step-1 schema field). Omitted when unset. */
  short_name?: string;
  /** Single group ("board") this model inherits from. Omitted when unset. */
  group?: string;
  /** Multiple groups this model inherits from, merge order. Omitted when unset. */
  groups?: string[];
  /** Free-tag category for the Model Manager UI. Omitted when unset. */
  category?: string;
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
  // The control catalog is consumed before any dispatch occurs, so it must use
  // the same group-resolved runtime facts as ChatClient and BackendPool. Using
  // the raw model here made entries that inherit `provider` from a group appear
  // as the default llama.cpp provider.
  const resolvedModel = mergeGroupsIntoModel(state.config, model);
  const cloud = isCloudProvider(resolvedModel.provider);
  // CLI agents (codex, claude-code) are driven in-process only — as sidebar
  // sessions, `ask_local_agent` delegation, or worker orchestration — never over
  // the HTTP control API. Neither /ensure (llama.cpp loader) nor /chat (cloud
  // proxy) can serve them, so the catalog must not advertise them as servable.
  const cli = resolvedModel.provider === 'cli';
  const execution = cli
    ? ({
        availability: 'unavailable',
        action: 'none',
        reason: 'cli_agent_in_process_only',
      } as const)
    : cloud
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
    backend: resolvedModel.provider ?? 'llama.cpp',
    provider: getProviderDisplayName(resolvedModel),
    loaded: state.pool.isLoaded(model.name),
    holds: state.holds.get(model.name) ?? 0,
    servable: !cloud && !cli,
    profiles: availableProfilesFor(state.config, model.name),
    capabilities: deriveStaticCapabilities(resolvedModel),
    route: cloud ? 'chat' : 'ensure',
    ...(model.short_name ? { short_name: model.short_name } : {}),
    ...(model.group ? { group: model.group } : {}),
    ...(model.groups ? { groups: model.groups } : {}),
    ...(model.category ? { category: model.category } : {}),
    ...execution,
  };
}

export function buildControlModelCatalog(state: CatalogState): ControlModelCatalog {
  const models = state.config.models.map((model) => entryFor(model, state));
  const revisionInput = JSON.stringify(models);
  const catalogVersion = createHash('sha256').update(revisionInput).digest('hex').slice(0, 16);
  return { contractVersion: MODEL_CATALOG_CONTRACT_VERSION, catalogVersion, models };
}
