import type { ForgeConfig, ModelConfig } from '../config/types';
import { expandAlias, resolveRequestModel, splitModelProfile } from '../config/ConfigResolver';
import { isCloudProvider, getCloudProviderLabel } from '../llm/CloudProviders';
import { isOllamaCloudModel } from '../llm/ModelRouteClassifier';

export interface DelegationTarget {
  requested: string;
  resolvedId: string;
  baseModel: string;
  model: ModelConfig;
  provider: 'llama.cpp' | 'ollama' | 'cli';
}

function isLocalOllamaEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return true;
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function providerLabel(provider: ModelConfig['provider']): string {
  if (isCloudProvider(provider)) return getCloudProviderLabel(provider);
  return provider ?? 'llama.cpp';
}

export function resolveDelegationTarget(config: ForgeConfig, requested: string): DelegationTarget {
  let model: ModelConfig;
  let resolvedId: string;
  try {
    model = resolveRequestModel(config, requested);
    // `model.name` is the fuzzy resolver's canonical match (ConfigResolver),
    // which may differ from the alias-only expansion below when `requested`
    // was a short_name/prefix/substring rather than an exact name or alias —
    // rebuild resolvedId from the canonical name so downstream BackendPool
    // keying (which only expands exact aliases) stays correct.
    const { profile } = splitModelProfile(expandAlias(config, requested));
    resolvedId = profile ? `${model.name}@${profile}` : model.name;
  } catch (err) {
    throw new Error(`Unknown delegation target "${requested}": ${(err as Error).message}`);
  }

  const base = model.name;
  const provider = model.provider ?? 'llama.cpp';

  if (provider === 'llama.cpp') {
    return { requested, resolvedId, baseModel: base, model, provider };
  }

  if (provider === 'ollama') {
    if (!isLocalOllamaEndpoint(model.endpoint)) {
      throw new Error(
        `Delegation target "${requested}" is Ollama cloud or non-local Ollama endpoint (${model.endpoint}); only local Ollama daemon targets are allowed.`,
      );
    }
    // Ollama cloud models route THROUGH the local daemon (localhost:11434) but
    // execute remotely; only their "-cloud"/":cloud" tag suffix marks them
    // (the model name is what gets sent to the daemon). The endpoint check
    // above cannot catch them.
    if (isOllamaCloudModel(model)) {
      throw new Error(
        `Delegation target "${requested}" is an Ollama cloud-routed model ("${model.name}"); only local Ollama daemon targets are allowed.`,
      );
    }
    return { requested, resolvedId, baseModel: base, model, provider };
  }

  if (provider === 'cli') {
    // Local by definition — the CLI handles its own subscription auth, never
    // Forge's backend pool. No capacity check needed: it spawns its own process.
    return { requested, resolvedId, baseModel: base, model, provider };
  }

  if (isCloudProvider(provider)) {
    throw new Error(
      `Delegation target "${requested}" uses ${providerLabel(provider)}; cloud providers are not allowed for local delegation.`,
    );
  }

  throw new Error(
    `Delegation target "${requested}" uses unsupported provider "${String(provider)}"; only local llama.cpp and local Ollama targets are allowed.`,
  );
}
